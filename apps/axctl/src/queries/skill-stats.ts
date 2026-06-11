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
import { dateField, countField } from "@ax/lib/shared/row-fields";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import { skillWithInvocationsSql } from "./skill-invocations-sql.ts";

export const SKILL_STATS_SQL = skillWithInvocationsSql({
    windows: [7, 30, 90],
    blocks: [
        `    recent_sessions: (
        SELECT
            in.session AS session_id,
            in.session.project AS project_slug,
            in.session.cwd AS cwd,
            ts
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 50
    )`,
    ],
});

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
 * Dedupe + cap to the most recent `cap` distinct sessions, then prettify the
 * project label (cwd basename when available, else the prettified slug).
 * cwd/project_slug may come back as arrays (per-edge projection) - take the
 * first scalar for display purposes.
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
        let project: string;
        if (typeof cwdRaw === "string" && cwdRaw.length > 0) {
            // Mirrors path.basename without pulling node:path here.
            const parts = cwdRaw.split("/").filter((p) => p.length > 0);
            project = parts.length > 0 ? parts[parts.length - 1] : cwdRaw;
        } else {
            project = prettifyProjectSlug(slugRaw);
        }
        clean.push({ project, ts: dateField(row, "ts") });
        if (clean.length >= cap) break;
    }
    return clean;
};

export const fetchSkillStats = Effect.fn("queries.fetchSkillStats")(
    function* (name: string) {
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
                total: countField(invocations, "total"),
                d7: countField(invocations, "d7"),
                d30: countField(invocations, "d30"),
                d90: countField(invocations, "d90"),
                last: dateField(invocations, "last"),
            },
            recent_sessions: dedupeRecentSessions(recentRaw),
        } satisfies SkillStatsPayload;
    },
);
