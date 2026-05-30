import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { SurrealClient, RecordId } from "../lib/db.ts";
import { AxConfig } from "../lib/config.ts";
import type { DbError } from "../lib/errors.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { surrealLiteral } from "../lib/json.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import {
    extractFileWithSessionId,
    upsertTurnsForSubagents,
    writeToolCallStatementsForSubagents,
    writeToolFileEvidenceForSubagents,
    relateInvocationsForSubagents,
    relateToolCallSkillsForSubagents,
    writePlanSnapshotsForSubagents,
} from "./transcripts.ts";
import { resolveSkillName } from "../lib/skill-id.ts";
import { recordLiteral } from "../lib/ids.ts";

interface SubagentManifest {
    readonly agentId: string;
    readonly parentSessionId: string;
    readonly subagentSessionId: string;
    readonly project: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly file: string;
}

export interface DeriveClaudeSubagentsOpts {
    readonly onProgress?: (counts: Record<string, number>) => Effect.Effect<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

/**
 * Walk every project dir, find `<sessionId>/subagents/agent-*.jsonl`, parse
 * minimum metadata. Doesn't open the full file - just first + last line for
 * sessionId / agentId / timestamps so the scan stays cheap.
 */
async function discover(transcriptsDir: string): Promise<SubagentManifest[]> {
    const out: SubagentManifest[] = [];
    let projectDirs: string[];
    try {
        projectDirs = await readdir(transcriptsDir);
    } catch {
        return out;
    }
    for (const projectDir of projectDirs) {
        const fullProject = join(transcriptsDir, projectDir);
        let entries: string[];
        try {
            entries = await readdir(fullProject);
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.endsWith(".jsonl")) continue;
            const subagentDir = join(fullProject, entry, "subagents");
            let agentFiles: string[];
            try {
                agentFiles = await readdir(subagentDir);
            } catch {
                continue;
            }
            for (const agentFile of agentFiles) {
                if (!agentFile.endsWith(".jsonl")) continue;
                if (!agentFile.startsWith("agent-")) continue;
                const fullPath = join(subagentDir, agentFile);
                const manifest = await parseManifest(fullPath, projectDir);
                if (manifest) out.push(manifest);
            }
        }
    }
    return out;
}

async function parseManifest(
    filePath: string,
    projectDir: string,
): Promise<SubagentManifest | null> {
    let text: string;
    try {
        text = await Bun.file(filePath).text();
    } catch {
        return null;
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const first = decodeJsonOrNull(lines[0] ?? "");
    if (!isRecord(first)) return null;
    const agentId = stringField(first, "agentId");
    const parentSessionId = stringField(first, "sessionId");
    if (!agentId || !parentSessionId) return null;
    const last = decodeJsonOrNull(lines[lines.length - 1] ?? "");
    const startedAt = stringField(first, "timestamp");
    const endedAt = isRecord(last) ? stringField(last, "timestamp") : null;
    return {
        agentId,
        parentSessionId,
        subagentSessionId: `claude-subagent-${agentId}`,
        project: projectDir,
        startedAt,
        endedAt,
        file: filePath,
    };
}

export interface DeriveClaudeSubagentsStats {
    readonly discovered: number;
    readonly missingParent: number;
    readonly written: number;
    readonly skippedExisting: number;
    /** Subagents that inherited repository/checkout/cwd from their parent during this run. */
    readonly repositoryInherited: number;
    /** Existing subagent rows that were backfilled with repository/checkout/cwd from parent. */
    readonly repositoryBackfilled: number;
    readonly activity: {
        readonly turns: number;
        readonly invocations: number;
        readonly toolCalls: number;
        readonly edits: number;
        readonly planSnapshots: number;
    };
}

/**
 * Create one session record + one `spawned` edge per discovered subagent
 * transcript, and ingest the subagent's own turns/tool calls. Idempotent:
 * re-running upserts the session and re-RELATEs.
 */
export const deriveClaudeSubagents = (
    opts: DeriveClaudeSubagentsOpts = {},
): Effect.Effect<
    DeriveClaudeSubagentsStats,
    DbError,
    SurrealClient | AxConfig
> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        if (opts.onProgress) yield* opts.onProgress({ phase: 1 });
        const manifests = yield* Effect.promise(() => discover(cfg.paths.transcriptsDir));
        if (opts.onProgress) {
            yield* opts.onProgress({
                phase: 2,
                totalSubagents: manifests.length,
            });
        }

        // Real skill/command catalog, snapshotted once - lets us resolve each
        // invoked name onto the canonical row (see resolveSkillName) instead
        // of minting ghost `scope='unknown'` rows for subagent invocations.
        const catalogRows = (yield* db.query<[Array<{ name?: string }>]>(
            `SELECT name FROM skill WHERE dir_path != "(unknown)";`,
        ))?.[0] ?? [];
        const skillCatalog: ReadonlySet<string> = new Set(
            catalogRows
                .map((row) => row.name)
                .filter((name): name is string => typeof name === "string" && name.length > 0),
        );

        let written = 0;
        let missingParent = 0;
        let skippedExisting = 0;
        let repositoryInherited = 0;
        let repositoryBackfilled = 0;
        let turnsTotal = 0;
        let invocationsTotal = 0;
        let toolCallsTotal = 0;
        let editsTotal = 0;
        let planSnapshotsTotal = 0;

        for (const [index, m] of manifests.entries()) {
            if (opts.onProgress && (index < 5 || index % 10 === 0)) {
                yield* opts.onProgress({
                    phase: 2,
                    currentSubagent: index + 1,
                    totalSubagents: manifests.length,
                    subagents: written + missingParent + skippedExisting,
                    written,
                    missingParent,
                    skippedExisting,
                    turns: turnsTotal,
                    invocations: invocationsTotal,
                    toolCalls: toolCallsTotal,
                    edits: editsTotal,
                    planSnapshots: planSnapshotsTotal,
                });
            }
            // Confirm parent exists - subagent without its parent is orphaned data.
            // Also fetch repository/checkout/cwd so we can inherit them below.
            const parentRid = `session:⟨${m.parentSessionId}⟩`;
            const check = yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT id, repository, checkout, cwd FROM ${parentRid};`,
            );
            if ((check?.[0]?.length ?? 0) === 0) {
                missingParent += 1;
                continue;
            }
            const parentRow = check[0]![0]!;

            // Run the Claude extractor against the subagent jsonl using the
            // synthetic session id. This produces turns/invocations/tool_calls
            // attributed to the subagent session, so the dashboard can show
            // *what* it did (Bash, Read, Edit calls etc).
            const extracted = yield* Effect.promise(() =>
                extractFileWithSessionId(m.file, m.project ?? "", m.subagentSessionId),
            );

            // Inherit repository/checkout from parent unconditionally (the extractor
            // never sets them). Inherit cwd from parent only if extractor produced none.
            const parentRepository = parentRow["repository"] ?? undefined;
            const parentCheckout = parentRow["checkout"] ?? undefined;
            const parentCwd = typeof parentRow["cwd"] === "string" && parentRow["cwd"].length > 0
                ? parentRow["cwd"]
                : undefined;

            if (!extracted) {
                // No usable content; still record the session+edge so the link
                // shows in the parent's "spawned" list.
                const subagentRid = new RecordId("session", m.subagentSessionId);
                yield* db.upsert(subagentRid, {
                    project: m.project ?? undefined,
                    source: "claude-subagent",
                    started_at: m.startedAt ? new Date(m.startedAt) : undefined,
                    ended_at: m.endedAt ? new Date(m.endedAt) : undefined,
                    raw_file: m.file ?? undefined,
                    repository: parentRepository,
                    checkout: parentCheckout,
                    cwd: parentCwd,
                });
                if (parentRepository !== undefined) repositoryInherited += 1;
            } else {
                // Force source=claude-subagent at the upsert level (the extractor
                // doesn't track source; it's set on the DB row).
                const subagentRid = new RecordId("session", m.subagentSessionId);
                // cwd: use extracted value if present, else inherit from parent
                const cwdValue = (extracted.session.cwd != null && extracted.session.cwd !== "")
                    ? extracted.session.cwd
                    : parentCwd;
                yield* db.upsert(subagentRid, {
                    project: extracted.session.project ?? m.project ?? undefined,
                    cwd: cwdValue,
                    source: "claude-subagent",
                    started_at: extracted.session.started_at
                        ? new Date(extracted.session.started_at)
                        : m.startedAt
                            ? new Date(m.startedAt)
                            : undefined,
                    ended_at: extracted.session.ended_at
                        ? new Date(extracted.session.ended_at)
                        : m.endedAt
                            ? new Date(m.endedAt)
                            : undefined,
                    raw_file: m.file ?? undefined,
                    repository: parentRepository,
                    checkout: parentCheckout,
                });
                if (parentRepository !== undefined) repositoryInherited += 1;

                yield* upsertTurnsForSubagents(extracted.turns);
                yield* writeToolCallStatementsForSubagents(extracted.toolCalls);
                yield* writeToolFileEvidenceForSubagents(extracted.toolCalls);
                const resolvedInvocations = extracted.invocations.map((inv) => ({
                    ...inv,
                    skill: resolveSkillName(inv.skill, skillCatalog) ?? inv.skill,
                }));
                yield* relateInvocationsForSubagents(resolvedInvocations);
                const resolvedSkillRelations = extracted.skillRelations.map((rel) => ({
                    ...rel,
                    skillName: resolveSkillName(rel.skillName, skillCatalog) ?? rel.skillName,
                }));
                yield* relateToolCallSkillsForSubagents(resolvedSkillRelations);
                yield* writePlanSnapshotsForSubagents(extracted.planSnapshots);

                turnsTotal += extracted.turns.length;
                invocationsTotal += extracted.invocations.length;
                toolCallsTotal += extracted.toolCalls.length;
                editsTotal += extracted.edits.length;
                planSnapshotsTotal += extracted.planSnapshots.length;
            }

            // Idempotent RELATE: dedupe first by exact (in,out) pair.
            const subagentRef = `session:⟨${m.subagentSessionId}⟩`;
            yield* db.query(
                `DELETE spawned WHERE in = ${parentRid} AND out = ${subagentRef} AND tool = "Agent";`,
            );
            yield* db.query(
                `RELATE ${parentRid} -> spawned -> ${subagentRef} SET ts = d${surrealLiteral(m.startedAt ?? new Date().toISOString())}, tool = "Agent", nickname = ${surrealLiteral(m.agentId.slice(0, 12))};`,
            );
            written += 1;

            if (opts.onProgress && (index < 5 || (index + 1) % 10 === 0 || index + 1 === manifests.length)) {
                yield* opts.onProgress({
                    phase: 2,
                    currentSubagent: index + 1,
                    totalSubagents: manifests.length,
                    subagents: written + missingParent + skippedExisting,
                    written,
                    missingParent,
                    skippedExisting,
                    turns: turnsTotal,
                    invocations: invocationsTotal,
                    toolCalls: toolCallsTotal,
                    edits: editsTotal,
                    planSnapshots: planSnapshotsTotal,
                });
            }
        }

        // ---------------------------------------------------------------------------
        // Backfill: fix existing claude-subagent rows that are missing repository.
        // For each such row, find its parent via the spawned RELATION and copy
        // repository/checkout/cwd. Idempotent: WHERE clause guards against
        // overwriting rows that already have a value.
        // ---------------------------------------------------------------------------
        const backfillRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, <-spawned<-session[0].repository AS parent_repository, <-spawned<-session[0].checkout AS parent_checkout, <-spawned<-session[0].cwd AS parent_cwd FROM session WHERE source = "claude-subagent" AND repository IS NONE;`,
        ))?.[0] ?? [];

        for (const row of backfillRows) {
            const id = row["id"];
            const parentRepo = row["parent_repository"];
            const parentCk = row["parent_checkout"] ?? undefined;
            const parentCwdBf = typeof row["parent_cwd"] === "string" && row["parent_cwd"].length > 0
                ? row["parent_cwd"]
                : undefined;
            if (id == null || parentRepo == null) continue;
            if (!(id instanceof RecordId)) continue;
            if (!(parentRepo instanceof RecordId)) continue;
            // Record-typed fields require record literals, not bindings, for correct comparison.
            // parentRepo.id is the bare key from the graph traversal result.
            const repoLiteral = recordLiteral("repository", String(parentRepo.id));
            yield* db.query(
                `UPDATE ${id} SET repository = ${repoLiteral}, checkout = $checkout, cwd = $cwd WHERE repository IS NONE;`,
                { checkout: parentCk, cwd: parentCwdBf },
            );
            repositoryBackfilled += 1;
        }

        return {
            discovered: manifests.length,
            missingParent,
            written,
            skippedExisting,
            repositoryInherited,
            repositoryBackfilled,
            activity: {
                turns: turnsTotal,
                invocations: invocationsTotal,
                toolCalls: toolCallsTotal,
                edits: editsTotal,
                planSnapshots: planSnapshotsTotal,
            },
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const SubagentsKey = Schema.Literal("subagents");
export type SubagentsKey = typeof SubagentsKey.Type;

/**
 * Subagents stage - derives parent↔child session links.
 *
 * Depends on: {@link ClaudeKey}, {@link CodexKey}
 * Consumed by: (none - terminal)
 * Tags: derive
 */
export class SubagentsStats extends BaseStageStats.extend<SubagentsStats>("SubagentsStats")({
    subagentLinksWritten: Schema.Number,
}) {}

export const subagentsStage: StageDef<SubagentsStats, SurrealClient | AxConfig> = {
    meta: StageMeta.make({ key: "subagents", deps: ["claude", "codex"], tags: ["derive"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveClaudeSubagents();
            return SubagentsStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${result.written} subagent links`,
                subagentLinksWritten: result.written,
            });
        }),
};
