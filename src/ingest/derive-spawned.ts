import { Effect, Schema } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { surrealLiteral } from "../lib/json.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";

interface SpawnSource {
    readonly tool_call_id: string;
    readonly parent_session_id: string;
    readonly ts: string;
    readonly child_id: string | null;
    readonly nickname: string | null;
    readonly tool_name: string;
}

const SPAWN_SOURCES_SQL = `
SELECT
    id,
    session,
    name,
    ts,
    output_excerpt
FROM tool_call
WHERE name = "spawn_agent" OR name = "Task"
ORDER BY ts ASC;`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

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
        if (!id || !session || !name || !ts) continue;
        const parsed = output ? decodeJsonOrNull(output) : null;
        if (!isRecord(parsed)) {
            out.push({
                tool_call_id: id,
                parent_session_id: session,
                ts,
                child_id: null,
                nickname: null,
                tool_name: name,
            });
            continue;
        }
        // codex spawn_agent: agent_id is the child session id
        const child = stringField(parsed, "agent_id");
        const nickname = stringField(parsed, "nickname");
        out.push({
            tool_call_id: id,
            parent_session_id: session,
            ts,
            child_id: child,
            nickname,
            tool_name: name,
        });
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
        const resolved = sources.filter((s) => s.child_id !== null);
        const unresolved = sources.length - resolved.length;

        // Verify each child session record exists. Codex stores subagent
        // transcripts as separate jsonl files, ingested as sibling sessions.
        // A missing record means the transcript hasn't been ingested yet
        // (e.g. cold start, or codex sessions dir was excluded).
        let written = 0;
        let missing = 0;
        for (const src of resolved) {
            if (!src.child_id) continue;
            // `parent_session_id` already comes back from SurrealDB as the
            // serialised record id `session:⟨…⟩`. Use it raw, NOT quoted.
            const parentId = src.parent_session_id;
            const childId = `session:⟨${src.child_id}⟩`;
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
            const callId = src.tool_call_id; // already in tool_call:⟨…⟩ form
            const toolLit = surrealLiteral(src.tool_name);
            const nickLit =
                src.nickname === null ? "NONE" : surrealLiteral(src.nickname);
            // Idempotent: dedupe by (in,out,tool_call) before inserting.
            yield* db.query(
                `DELETE spawned WHERE in = ${parentId} AND out = ${childId} AND tool_call = ${callId};`,
            );
            yield* db.query(
                `RELATE ${parentId} -> spawned -> ${childId} SET ts = d${surrealLiteral(src.ts)}, tool = ${toolLit}, tool_call = ${callId}, nickname = ${nickLit};`,
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
