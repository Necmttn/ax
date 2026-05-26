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

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef, surrealDate, surrealJsonOption, surrealObject, surrealOptionString, surrealString } from "../lib/shared/surql.ts";
import { recordKeyPart, safeKeyPart } from "../lib/shared/derive-keys.ts";

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
    readonly id: string | { tb: string; id: string };
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
    readonly repository: string | { tb: string; id: string } | null;
}

const sessionStatsSql = (sessionRef: string) => `
    SELECT
        id,
        project,
        repository,
        (SELECT count() FROM turn WHERE session = $parent.id GROUP ALL)[0].count ?? 0 AS turns,
        (SELECT count() FROM tool_call WHERE session = $parent.id GROUP ALL)[0].count ?? 0 AS tool_calls,
        (SELECT count() FROM tool_call WHERE session = $parent.id AND has_error = true GROUP ALL)[0].count ?? 0 AS tool_errors,
        (SELECT count() FROM corrected_by WHERE in.session = $parent.id GROUP ALL)[0].count ?? 0 AS corrections,
        array::len(array::distinct((SELECT VALUE name FROM tool_call WHERE session = $parent.id))) AS distinct_tools,
        array::len(array::distinct((SELECT VALUE out FROM edited WHERE in.session = $parent.id))) AS distinct_files_edited,
        ((SELECT name, count() AS c FROM tool_call WHERE session = $parent.id GROUP BY name ORDER BY c DESC LIMIT 1)[0].name) AS top_tool,
        ((SELECT name, count() AS c FROM tool_call WHERE session = $parent.id GROUP BY name ORDER BY c DESC LIMIT 1)[0].c ?? 0) AS top_tool_count,
        ((SELECT name, count() AS c FROM tool_call WHERE session = $parent.id AND has_error = true GROUP BY name ORDER BY c DESC LIMIT 1)[0].name) AS top_failed_tool,
        ((SELECT name, count() AS c FROM tool_call WHERE session = $parent.id AND has_error = true GROUP BY name ORDER BY c DESC LIMIT 1)[0].c ?? 0) AS top_failed_tool_count,
        ((SELECT out.path AS p, count() AS c FROM edited WHERE in.session = $parent.id GROUP BY p ORDER BY c DESC LIMIT 1)[0].p) AS top_file,
        (SELECT count() FROM produced WHERE in = $parent.id GROUP ALL)[0].count ?? 0 AS produced_commits,
        array::distinct((SELECT VALUE kind FROM friction_event WHERE session = $parent.id)) AS friction_kinds
    FROM ${sessionRef} LIMIT 1;
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
    sessionKeyOrId: string,
): Effect.Effect<RetroInput | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const key = sessionKeyOrId.startsWith("session:")
            ? sessionKeyOrId.slice("session:".length).replace(/`/g, "")
            : sessionKeyOrId;
        const sessionRef = recordRef("session", key);
        const result = yield* db.query<[SessionStatRow[]]>(
            sessionStatsSql(sessionRef),
        );
        const stat = (result?.[0] ?? [])[0];
        if (!stat) return null;
        const payload = composeHeuristicRetro(stat);
        const sessionKey = recordKeyPart(stat.id, "session");
        if (!sessionKey) return null;
        const repositoryKey = stat.repository ? recordKeyPart(stat.repository, "repository") : null;
        return {
            sessionId: sessionKey,
            source: "heuristic",
            payload,
            raw: JSON.stringify({ stat }),
            ...(repositoryKey ? { repositoryKey } : {}),
        };
    });

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export const buildRetroStatement = (input: RetroInput): string => {
    const key = safeKeyPart(input.sessionId).slice(0, 96);
    const sessionRef = recordRef("session", input.sessionId);
    return `UPSERT ${recordRef("retro", key)} MERGE ${surrealObject([
        ["session", sessionRef],
        ["source", surrealString(input.source)],
        ["tried", surrealString(input.payload.tried)],
        ["worked", surrealOptionString(input.payload.worked)],
        ["failed", surrealOptionString(input.payload.failed)],
        ["next", surrealOptionString(input.payload.next)],
        ["raw", surrealJsonOption(input.raw ? { raw: input.raw } : undefined)],
        ["repository", input.repositoryKey ? recordRef("repository", input.repositoryKey) : "NONE"],
        ["created_at", input.createdAt ? surrealDate(input.createdAt) : "time::now()"],
    ])};`;
};

export const upsertRetro = (
    input: RetroInput,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* db.query(buildRetroStatement(input));
    });
