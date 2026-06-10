/**
 * `ax skills stats <name>`: one-skill stats payload - invocation counts at
 * 7/30/90 days + the 5 most recent distinct sessions. The CLI formats and
 * prints; this module owns the SQL, the types, and the dedupe transform.
 *
 * Issue #43 history: recent_sessions are ordered by ts DESC server-side,
 * include the session id so we can de-dup in TS, and capture cwd so we can
 * render a human-friendly project label rather than the raw Claude slug.
 *
 * Bindings: $name (skill name).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { dateField, numericField } from "@ax/lib/shared/row-fields";
import { sessionProjectLabel } from "@ax/lib/shared/project-slug";

export const SKILL_STATS_SQL = `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
        d7:    array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 7d)),
        d30:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 30d)),
        d90:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 90d)),
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
    recent_sessions: (
        SELECT
            in.session AS session_id,
            in.session.project AS project_slug,
            in.session.cwd AS cwd,
            ts
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 50
    )
};`;

export interface SkillStatsInvocations {
    readonly total: number;
    readonly d7: number;
    readonly d30: number;
    readonly d90: number;
    readonly last: string | null;
}

export interface SkillStatsRecentSession {
    readonly project: string;
    readonly ts: string | null;
}

export interface SkillStatsPayload {
    /** Full raw skill row (`$s`) - the CLI prettyPrints it verbatim, so we
     *  keep every column rather than projecting. */
    readonly skill: Record<string, unknown> | null;
    readonly invocations: SkillStatsInvocations;
    readonly recent_sessions: ReadonlyArray<SkillStatsRecentSession>;
}

/**
 * Dedupe + cap to the most recent `cap` distinct sessions, then label the
 * project via the shared `sessionProjectLabel` (prettified slug, falling back
 * to the cwd basename). cwd/project_slug may come back as arrays (per-edge
 * projection) - take the first scalar for display purposes.
 */
export const dedupeRecentSessions = (
    rows: ReadonlyArray<Record<string, unknown>>,
    cap = 5,
): SkillStatsRecentSession[] => {
    const seen = new Set<string>();
    const clean: SkillStatsRecentSession[] = [];
    for (const row of rows) {
        const sid = String(row.session_id ?? "");
        if (sid && seen.has(sid)) continue;
        if (sid) seen.add(sid);
        const cwdRaw = Array.isArray(row.cwd) ? row.cwd[0] : row.cwd;
        const slugRaw = Array.isArray(row.project_slug)
            ? row.project_slug[0]
            : row.project_slug;
        const project = sessionProjectLabel(
            typeof slugRaw === "string" ? slugRaw : null,
            typeof cwdRaw === "string" ? cwdRaw : null,
        );
        clean.push({ project, ts: dateField(row, "ts") });
        if (clean.length >= cap) break;
    }
    return clean;
};

export const fetchSkillStats = (
    name: string,
): Effect.Effect<SkillStatsPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<unknown[]>(SKILL_STATS_SQL, { name });
        // LET → null, RETURN → payload: take the last non-null statement result.
        const payload = (Array.isArray(result)
            ? [...result].reverse().find((r) => r != null)
            : result) as Record<string, unknown> | undefined;
        const skill = (payload?.skill ?? null) as Record<string, unknown> | null;
        const invocations = (payload?.invocations ?? {}) as Record<string, unknown>;
        const recentRaw = Array.isArray(payload?.recent_sessions)
            ? (payload.recent_sessions as Array<Record<string, unknown>>)
            : [];
        return {
            skill,
            invocations: {
                total: numericField(invocations, "total"),
                d7: numericField(invocations, "d7"),
                d30: numericField(invocations, "d30"),
                d90: numericField(invocations, "d90"),
                last: dateField(invocations, "last"),
            },
            recent_sessions: dedupeRecentSessions(recentRaw),
        };
    });
