import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
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
WHERE name = 'spawn_agent' OR name = 'Task'
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
const SpawnSourceRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    name: Schema.String,
    ts: TimestampColumn,
    output_excerpt: Schema.NullOr(Schema.String),
    input_json: Schema.NullOr(Schema.String),
});

export const deriveSpawned = (write: CacheWriteService): Effect.Effect<
    DeriveSpawnedStats,
    CacheWriteError
> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(SpawnSourceRow, SPAWN_SOURCES_SQL);
        const sources = collectSources(rows.map((row) => ({
            ...row,
            ts: row.ts,
            output_excerpt: row.output_excerpt ?? undefined,
            input_json: row.input_json ?? undefined,
        })));
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
            const parentId = src.parentSessionId;
            const childId = src.childSessionId;
            const check = yield* write.rows(Schema.Struct({ id: Schema.String }), "SELECT id FROM session WHERE id = ?", [childId]);
            const exists = check.length > 0;
            if (!exists) {
                missing += 1;
                continue;
            }
            const callId = src.toolCallId;
            yield* write.put("spawned", cacheRow({
                id: stableId("spawned", [parentId, childId, callId]),
                in_id: parentId,
                out_id: childId,
                ts: tsParam(src.ts),
                tool: src.toolName,
                tool_call: callId,
                nickname: src.nickname,
                agent_type: src.agentType,
                description: src.description,
                agent_name: null,
                tool_use_id: null,
            }));
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

export const spawnedStage: StageDef<SpawnedStats, never, CacheWriteError> = {
    meta: StageMeta.make({ key: "spawned", deps: ["claude", "codex"], tags: ["derive"] }),
    run: (_ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveSpawned(write);
            return SpawnedStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${result.written} spawn edges`,
                spawnEdgesWritten: result.written,
            });
        }),
};
