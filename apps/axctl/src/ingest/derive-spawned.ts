import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { surrealLiteral } from "@ax/lib/json";
import { normalizeDelegationToolCall, type NormalizedDelegationSpawn } from "./delegation.ts";
import type { AgentProviderName } from "./provider-events.ts";

type SpawnSource = NormalizedDelegationSpawn;

const SPAWN_SOURCES_SQL = `
SELECT
    id,
    session,
    name,
    ts,
    output_excerpt,
    input_json
FROM tool_call
WHERE name = "spawn_agent" OR name = "Task"
ORDER BY ts ASC;`;

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    if (v && typeof v === "object" && "toJSON" in v) {
        const j = (v as { toJSON: () => unknown }).toJSON();
        if (typeof j === "string" && j.length > 0) return j;
    }
    return null;
};

const recordIdToString = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object" && "toString" in v) {
        const s = String(v);
        return s.length > 0 ? s : null;
    }
    return null;
};

const providerForSpawnTool = (toolName: string): AgentProviderName =>
    toolName === "Task" ? "claude" : "codex";

/**
 * Pull spawn-like tool calls and extract (parent, child) session pairs.
 * Codex `spawn_agent`: output_excerpt = `{"agent_id":"<uuid>","nickname":"..."}`.
 * Claude `Task` (future): currently not captured by ingest -- the Task tool
 * call rows aren't being written. Logged as a follow-up; for now this
 * derivation handles codex.
 */
const collectSources = (
    rows: ReadonlyArray<Record<string, unknown>>,
): SpawnSource[] => {
    const out: SpawnSource[] = [];
    for (const raw of rows) {
        const id = recordIdToString(raw.id);
        const session = recordIdToString(raw.session);
        const name = stringField(raw, "name");
        const ts = dateField(raw, "ts");
        const output = stringField(raw, "output_excerpt");
        const inputJson = stringField(raw, "input_json");
        if (!id || !session || !name || !ts) continue;
        out.push(normalizeDelegationToolCall({
            provider: providerForSpawnTool(name),
            toolCallId: id,
            parentSessionId: session,
            ts,
            toolName: name,
            outputExcerpt: output,
            inputJson,
        }));
    }
    return out;
};

export interface DeriveSpawnedStats {
    readonly toolCalls: number;
    readonly resolved: number;
    readonly unresolved: number;
    readonly missingChildSession: number;
    readonly written: number;
}

/**
 * Walk every spawn tool call, find the corresponding child session record by
 * agent UUID, and RELATE parent->child via `spawned`. Idempotent: existing
 * edges are upserted by the same (in,out) pair via UNIQUE-ish dedup.
 */
export const deriveSpawned = (): Effect.Effect<
    DeriveSpawnedStats,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            SPAWN_SOURCES_SQL,
        );
        const sources = collectSources(rows?.[0] ?? []);
        const resolved = sources.filter((s) => s.childSessionId !== null);
        const unresolved = sources.length - resolved.length;

        // Verify each child session record exists. Codex stores subagent
        // transcripts as separate jsonl files, ingested as sibling sessions.
        // A missing record means the transcript hasn't been ingested yet
        // (e.g. cold start, or codex sessions dir was excluded).
        let written = 0;
        let missing = 0;
        for (const src of resolved) {
            if (!src.childSessionId) continue;
            // `parent_session_id` already comes back from SurrealDB as the
            // serialised record id `session:⟨…⟩`. Use it raw, NOT quoted.
            const parentId = src.parentSessionId;
            const childId = `session:⟨${src.childSessionId}⟩`;
            // Check existence before RELATE - SurrealDB strict mode rejects
            // edges that point at non-existent records.
            const check = yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT id FROM ${childId};`,
            );
            const exists = (check?.[0]?.length ?? 0) > 0;
            if (!exists) {
                missing += 1;
                continue;
            }
            const callId = src.toolCallId; // already in tool_call:⟨…⟩ form
            const toolLit = surrealLiteral(src.toolName);
            const nickLit =
                src.nickname === null ? "NONE" : surrealLiteral(src.nickname);
            // agent_type + description come from the spawn-call args (codex). They
            // drive `ax dispatches` (SPAWNED_SQL filters agent_type != NONE), so
            // without them codex dispatches never surface in the table.
            const agentTypeLit =
                src.agentType === null ? "NONE" : surrealLiteral(src.agentType);
            const descriptionLit =
                src.description === null ? "NONE" : surrealLiteral(src.description);
            // Idempotent: dedupe by (in,out,tool_call) before inserting.
            yield* db.query(
                `DELETE spawned WHERE in = ${parentId} AND out = ${childId} AND tool_call = ${callId};`,
            );
            yield* db.query(
                `RELATE ${parentId} -> spawned -> ${childId} SET ts = d${surrealLiteral(src.ts)}, tool = ${toolLit}, tool_call = ${callId}, nickname = ${nickLit}, agent_type = ${agentTypeLit}, description = ${descriptionLit};`,
            );
            written += 1;
        }

        return {
            toolCalls: sources.length,
            resolved: resolved.length,
            unresolved,
            missingChildSession: missing,
            written,
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const SpawnedKey = Schema.Literal("spawned");
export type SpawnedKey = typeof SpawnedKey.Type;

/**
 * Spawned stage - derives spawn edges from transcript rows.
 *
 * Depends on: {@link ClaudeKey}, {@link CodexKey}
 * Consumed by: (none - terminal)
 * Tags: derive
 */
export class SpawnedStats extends BaseStageStats.extend<SpawnedStats>("SpawnedStats")({
    spawnEdgesWritten: Schema.Number,
}) {}

export const spawnedStage: StageDef<SpawnedStats, SurrealClient> = {
    meta: StageMeta.make({ key: "spawned", deps: ["claude", "codex"], tags: ["derive"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveSpawned();
            return SpawnedStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${result.written} spawn edges`,
                spawnEdgesWritten: result.written,
            });
        }),
};
