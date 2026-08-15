/**
 * Retro emitter (Phase B foundation).
 *
 * A retro is a four-field reflection on a single session:
 *   tried  - what the agent attempted
 *   worked - what landed
 *   failed - what didn't
 *   next   - the experiment to run next
 *
 * See docs/language.md "retro" for the canonical definition.
 *
 * Two emission paths exist:
 *
 *   1. Heuristic (this module's `retroFromSession`): purely deterministic
 *      summary built from session turn counts, tool-call telemetry,
 *      friction events, edits, and commits. Cheap, no LLM call. The MVP
 *      that ships today.
 *
 *   2. Agent-driven (Stop-hook recipe in docs/HOOKS.md): the agent emits
 *      `{tried, worked, failed, next}` JSON to a temp file at session-end;
 *      `ax retro emit --from-file` ingests it. Sharper signal, requires
 *      hook configuration.
 *
 * Both paths upsert the same `retro` table (UNIQUE on session). Later
 * derive stages cluster `failed` strings across sessions to surface real
 * recurring friction.
 */

import { Effect, Schema } from "effect";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheReadService, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { encodeJson } from "@ax/lib/decode";
import { edgeRowId, stableId } from "@ax/lib/stable-id";

export type RetroSource =
    | "claude_stop_hook"
    | "codex_rollout"
    | "heuristic"
    | "manual";

export interface RetroPayload {
    readonly tried: string;
    readonly worked: string | null;
    readonly failed: string | null;
    readonly next: string | null;
}

export interface RetroInput {
    readonly sessionId: string;        // record id or key
    readonly source: RetroSource;
    readonly payload: RetroPayload;
    readonly raw?: string | null;
    readonly repositoryKey?: string | null;
    readonly createdAt?: string;       // ISO; defaults to now()
}

// ---------------------------------------------------------------------------
// Heuristic emitter
// ---------------------------------------------------------------------------

interface SessionStatRow {
    readonly id: string;
    readonly project: string | null;
    readonly turns: number;
    readonly tool_calls: number;
    readonly tool_errors: number;
    readonly corrections: number;
    readonly distinct_tools: number;
    readonly distinct_files_edited: number;
    readonly top_tool: string | null;
    readonly top_tool_count: number;
    readonly top_failed_tool: string | null;
    readonly top_failed_tool_count: number;
    readonly top_file: string | null;
    readonly produced_commits: number;
    readonly friction_kinds: ReadonlyArray<string>;
    readonly repository: string | null;
}

const SessionStatSchema = Schema.Struct({
    id: Schema.String,
    project: Schema.NullOr(Schema.String),
    turns: Schema.BigInt,
    tool_calls: Schema.BigInt,
    tool_errors: Schema.BigInt,
    corrections: Schema.BigInt,
    distinct_tools: Schema.BigInt,
    distinct_files_edited: Schema.BigInt,
    top_tool: Schema.NullOr(Schema.String),
    top_tool_count: Schema.BigInt,
    top_failed_tool: Schema.NullOr(Schema.String),
    top_failed_tool_count: Schema.BigInt,
    top_file: Schema.NullOr(Schema.String),
    produced_commits: Schema.BigInt,
    friction_kinds: Schema.String,
    repository: Schema.NullOr(Schema.String),
});

const sessionStatsSql = `
    SELECT
        s.id, s.project, s.repository,
        (SELECT count(*) FROM turn t WHERE t.session = s.id) AS turns,
        (SELECT count(*) FROM tool_call tc WHERE tc.session = s.id) AS tool_calls,
        (SELECT count(*) FROM tool_call tc WHERE tc.session = s.id AND tc.has_error = true) AS tool_errors,
        (SELECT count(*) FROM corrected_by cb JOIN turn t ON t.id = cb.in_id WHERE t.session = s.id) AS corrections,
        (SELECT count(DISTINCT tc.name) FROM tool_call tc WHERE tc.session = s.id) AS distinct_tools,
        (SELECT count(DISTINCT e.out_id) FROM edited e JOIN turn t ON t.id = e.in_id WHERE t.session = s.id) AS distinct_files_edited,
        (SELECT tc.name FROM tool_call tc WHERE tc.session = s.id GROUP BY tc.name ORDER BY count(*) DESC LIMIT 1) AS top_tool,
        COALESCE((SELECT count(*) FROM tool_call tc WHERE tc.session = s.id GROUP BY tc.name ORDER BY count(*) DESC LIMIT 1), 0) AS top_tool_count,
        (SELECT tc.name FROM tool_call tc WHERE tc.session = s.id AND tc.has_error = true GROUP BY tc.name ORDER BY count(*) DESC LIMIT 1) AS top_failed_tool,
        COALESCE((SELECT count(*) FROM tool_call tc WHERE tc.session = s.id AND tc.has_error = true GROUP BY tc.name ORDER BY count(*) DESC LIMIT 1), 0) AS top_failed_tool_count,
        (SELECT f.path FROM edited e JOIN turn t ON t.id = e.in_id JOIN file f ON f.id = e.out_id WHERE t.session = s.id GROUP BY f.path ORDER BY count(*) DESC LIMIT 1) AS top_file,
        (SELECT count(*) FROM produced p WHERE p.in_id = s.id) AS produced_commits,
        COALESCE((SELECT to_json(list(DISTINCT fe.kind))::VARCHAR FROM friction_event fe WHERE fe.session = s.id), '[]') AS friction_kinds
    FROM session s WHERE s.id = ? LIMIT 1
`;

export const composeHeuristicRetro = (stat: SessionStatRow): RetroPayload => {
    const triedParts: string[] = [`${stat.turns} turn(s)`];
    if (stat.top_tool && stat.top_tool_count > 0) {
        triedParts.push(`top tool: ${stat.top_tool} ×${stat.top_tool_count}`);
    }
    if (stat.distinct_tools > 1) {
        triedParts.push(`${stat.distinct_tools} distinct tools`);
    }
    if (stat.top_file) {
        triedParts.push(`primary file: ${stat.top_file}`);
    }
    if (stat.distinct_files_edited > 1) {
        triedParts.push(`${stat.distinct_files_edited} files edited`);
    }
    const tried = triedParts.join(" · ");

    const worked: string | null = stat.produced_commits > 0
        ? `${stat.produced_commits} commit(s) landed`
        : stat.tool_calls > 0 && stat.tool_errors === 0
            ? `${stat.tool_calls} tool calls without error; no commit yet`
            : null;

    const failedParts: string[] = [];
    if (stat.top_failed_tool && stat.top_failed_tool_count > 0) {
        failedParts.push(`${stat.top_failed_tool} failed ×${stat.top_failed_tool_count}`);
    }
    if (stat.corrections > 0) {
        failedParts.push(`${stat.corrections} user correction(s)`);
    }
    if (stat.friction_kinds.length > 0) {
        failedParts.push(`friction kinds: ${stat.friction_kinds.slice(0, 4).join(", ")}`);
    }
    const failed = failedParts.length > 0 ? failedParts.join(" · ") : null;

    const next: string | null = stat.top_failed_tool && stat.top_failed_tool_count >= 3
        ? `package a pre-${stat.top_failed_tool} guard - ${stat.top_failed_tool_count} failures in this session is recurring`
        : stat.corrections >= 2
            ? `look for a guidance skill - ${stat.corrections} corrections suggest a recurring mistake`
            : null;

    return { tried, worked, failed, next };
};

/**
 * Accepts either a bare session key (UUID) or a full `session:`uuid``
 * record id. Builds the recordRef internally so the WHERE/FROM clause
 * uses SurrealDB record syntax, not a string comparison.
 */
export const retroFromSession = (
    read: CacheReadService,
    sessionKeyOrId: string,
): Effect.Effect<RetroInput | null, CacheReadError> =>
    Effect.gen(function* () {
        const key = sessionKeyOrId.startsWith("session:")
            ? sessionKeyOrId.slice("session:".length).replace(/`/g, "")
            : sessionKeyOrId;
        const result = yield* read.rows(SessionStatSchema, sessionStatsSql, [key]);
        const row = result[0];
        const stat: SessionStatRow | undefined = row ? {
            ...row,
            turns: Number(row.turns), tool_calls: Number(row.tool_calls), tool_errors: Number(row.tool_errors),
            corrections: Number(row.corrections), distinct_tools: Number(row.distinct_tools),
            distinct_files_edited: Number(row.distinct_files_edited), top_tool_count: Number(row.top_tool_count),
            top_failed_tool_count: Number(row.top_failed_tool_count), produced_commits: Number(row.produced_commits),
            friction_kinds: JSON.parse(row.friction_kinds) as string[],
        } : undefined;
        if (!stat) return null;
        const payload = composeHeuristicRetro(stat);
        return {
            sessionId: stat.id,
            source: "heuristic",
            payload,
            raw: encodeJson({ stat }),
            ...(stat.repository ? { repositoryKey: stat.repository } : {}),
        };
    });

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * The `retro` record key for a session key. One retro per session (the table is
 * UNIQUE on session), so callers that need to point AT the retro - e.g. a
 * proposal citing the review it came from - derive the id here rather than
 * re-implementing the truncation.
 */
export const retroRecordKey = (sessionId: string): string =>
    stableId("retro", [sessionId]);

export const upsertRetro = (
    write: CacheWriteService,
    input: RetroInput,
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        const id = retroRecordKey(input.sessionId);
        yield* write.put("retro", cacheRow({
            id, session: input.sessionId, source: input.source, tried: input.payload.tried,
            worked: input.payload.worked, failed: input.payload.failed, next: input.payload.next,
            raw: input.raw ? jsonParam({ raw: input.raw }) : null,
            repository: input.repositoryKey ?? null,
            created_at: tsParam(input.createdAt) ?? new Date(),
        }));
        yield* write.put("reviewed", cacheRow({
            id: edgeRowId("reviewed", input.sessionId, id), in_id: input.sessionId, out_id: id,
            created_at: new Date(),
        }));
    });
