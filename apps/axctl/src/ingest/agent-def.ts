/**
 * @stage agent-def
 * @rationale Subagent definition files (`~/.claude/agents/*.md` + per-repo
 *   `.claude/agents/*.md`) are config the agent declares but the graph was
 *   previously blind to (only scope-read, no table). Indexing them as a
 *   first-class reconciled entity - same lifecycle as skills - lets the
 *   dashboard list agents, their declared skills, and their model, and lets
 *   reconcile tombstone agents deleted off disk instead of ghosting forever.
 * @inputs ~/.claude/agents/*.md, <repo>/.claude/agents/*.md
 * @outputs `agent_def` rows (soft-tombstoned on disappearance)
 * @order 12
 *
 * @see scripts/extract-stage-rationale.ts for the full annotation contract.
 */
import { Effect, FileSystem, Path, Schema } from "effect";
import { RecordId, SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { skillRecordKey } from "@ax/lib/skill-id";
import { AppLayer } from "@ax/lib/layers";
import { DbError } from "@ax/lib/errors";
import { findGitRoot } from "../project/git.ts";
import { reconcileByScope } from "../config-core/reconcile.ts";
import { AgentSourceRegistry, AgentSourceRegistryLive } from "../agents/registry.ts";
import type { AgentRecord } from "../agents/source.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const AGENT_DEF_TABLE = "agent_def";

/** Stable record id for an agent by name (reuses skill-id keying for `:` etc.). */
const agentRecordId = (name: string): RecordId =>
    new RecordId(AGENT_DEF_TABLE, skillRecordKey(name));

/** Upsert one agent record + stamp `last_seen_at`. Dedups by name (user wins). */
const upsertAgent = (
    db: SurrealClientShape,
    rec: AgentRecord,
): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
        const id = agentRecordId(rec.name);
        yield* db.upsert(id, {
            name: rec.name,
            scope: rec.scope,
            dir_path: rec.dirPath,
            description: rec.description ?? undefined,
            model: rec.model ?? undefined,
            content_hash: rec.contentHash,
            skills: [...rec.skills],
            bytes: rec.bytes,
        });
        // Touch last_seen_at via the same query reconcile uses, so a fresh row
        // gets a non-NONE last_seen_at immediately (not only on the next run).
        yield* db.query(
            `UPDATE ${AGENT_DEF_TABLE} SET last_seen_at = time::now() WHERE name = $name AND deleted_at IS NONE`,
            { name: rec.name },
        );
    });

/**
 * Discover all agent records across registered sources (user + project),
 * dedup by name (first source wins → user precedence). Parse failures are
 * surfaced as `DbError` so the stage's fixed error channel holds.
 */
export const collectAgents = (): Effect.Effect<
    AgentRecord[],
    DbError,
    FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const reg = yield* AgentSourceRegistry;
        const repoRoot = (yield* Effect.promise(() => findGitRoot(process.cwd()))) ?? undefined;
        const byName = new Map<string, AgentRecord>();
        for (const source of reg.all()) {
            const recs = yield* source.discover(repoRoot).pipe(
                Effect.mapError(
                    (e) =>
                        new DbError({
                            operation: "query",
                            message: `agent discover failed: ${e._tag === "ConfigParseError" ? e.reason : String(e)}`,
                            ...(e._tag === "ConfigParseError" ? { sql: e.file } : {}),
                        }),
                ),
            );
            for (const rec of recs) {
                if (!byName.has(rec.name)) byName.set(rec.name, rec);
            }
        }
        return [...byName.values()];
    });

export const ingestAgentDefs = (): Effect.Effect<
    { count: number; tombstoned: number; resurrected: number },
    DbError,
    SurrealClient | FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const agents = yield* collectAgents();

        yield* Effect.forEach(agents, (rec) => upsertAgent(db, rec), {
            concurrency: 8,
            discard: true,
        });

        // Reconcile per scope (user/project) so the stage never tombstones agents
        // outside the scopes it just discovered.
        const byScope = new Map<string, string[]>();
        for (const a of agents) {
            const arr = byScope.get(a.scope) ?? [];
            arr.push(a.name);
            byScope.set(a.scope, arr);
        }
        const report = yield* reconcileByScope(AGENT_DEF_TABLE, byScope);

        yield* Effect.logDebug("agent_def upserted", {
            count: agents.length,
            tombstoned: report.tombstoned,
            resurrected: report.resurrected,
        });
        return {
            count: agents.length,
            tombstoned: report.tombstoned,
            resurrected: report.resurrected,
        };
    });

if (import.meta.main) {
    // NOTE: needs Bun fs/path layers too; see INTEGRATION NOTES. AppLayer alone
    // is insufficient for a standalone run - this main is illustrative.
    await Effect.runPromise(
        ingestAgentDefs().pipe(
            Effect.provide(AppLayer),
            Effect.provide(AgentSourceRegistryLive),
            Effect.scoped,
        ) as Effect.Effect<{ count: number; tombstoned: number; resurrected: number }>,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const AgentDefKey = Schema.Literal("agent-def");
export type AgentDefKey = typeof AgentDefKey.Type;

export class AgentDefStats extends BaseStageStats.extend<AgentDefStats>("AgentDefStats")({
    agentsUpserted: Schema.Number,
    tombstoned: Schema.Number,
    resurrected: Schema.Number,
}) {}

/**
 * Agent-def stage - seeds `agent_def` rows from `~/.claude/agents/*.md` and the
 * per-repo `<repo>/.claude/agents/*.md`, then soft-reconciles (tombstone gone,
 * resurrect returned).
 *
 * Depends on: (none - leaf)
 * Tags: ingest
 * Requires (beyond SurrealClient): FileSystem, Path, AgentSourceRegistry - see
 *   INTEGRATION NOTES for the runtime layer wiring.
 */
export const agentDefStage: StageDef<
    AgentDefStats,
    SurrealClient | FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> = {
    meta: StageMeta.make({ key: "agent-def", deps: [], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const { count, tombstoned, resurrected } = yield* ingestAgentDefs();
            return AgentDefStats.make({
                durationMs: Date.now() - t0,
                summary: `upserted ${count} agent_def rows (${tombstoned} tombstoned, ${resurrected} resurrected)`,
                agentsUpserted: count,
                tombstoned,
                resurrected,
            });
        }),
};
