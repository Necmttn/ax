/**
 * `ax skills stats <name>`: one-skill stats payload - invocation counts at
 * 7/30/90 days + the 5 most recent distinct sessions. The CLI formats and
 * prints; this module owns the SQL, the types, and the dedupe transform.
 *
 * Issue #43 history: recent_sessions are ordered by ts DESC server-side,
 * include the session id so we can de-dup in TS, and capture cwd so we can
 * render a human-friendly project label rather than the raw Claude slug.
 *
 * `fetchSkillStats` reads the DuckDB CacheRead seam below - skill row,
 * invocations aggregate, and recent_sessions, each an indexed lookup keyed off
 * the resolved skill id.
 *
 * This file has no exported SQL-text blob: a prior `SKILL_STATS_SQL` constant
 * was removed after its only readers turned out to be its own text
 * assertions - the claimed live consumer via skill-detail.ts's sibling
 * constant was never true (see skill-detail.ts).
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { dateField } from "@ax/lib/shared/row-fields";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";

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

const SkillRowSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    scope: Schema.String,
    dir_path: Schema.String,
    description: Schema.NullOr(Schema.String),
    content_hash: Schema.String,
    bytes: Schema.NullOr(NumberFromBigIntColumn),
    ingested_at: TimestampColumn,
    last_seen_at: Schema.NullOr(TimestampColumn),
    deleted_at: Schema.NullOr(TimestampColumn),
});

/** The CLI prettyPrints the raw skill row verbatim - select every column. */
const SKILL_ROW_SQL = `
SELECT id, name, scope, dir_path, description, content_hash, bytes, ingested_at, last_seen_at, deleted_at
FROM skill WHERE name = ?;
`;

const InvocationSummarySchemaRow = Schema.Struct({
    total: NumberFromBigIntColumn,
    d7: NumberFromBigIntColumn,
    d30: NumberFromBigIntColumn,
    d90: NumberFromBigIntColumn,
    last: Schema.NullOr(TimestampColumn),
});

/** d7/d30/d90 FILTER thresholds bind first (in text order), the skill id last. */
const INVOCATION_SUMMARY_SQL = `
SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')) AS d7,
    COUNT(*) FILTER (WHERE ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')) AS d30,
    COUNT(*) FILTER (WHERE ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')) AS d90,
    MAX(ts) AS last
FROM invoked
WHERE out_id = ?;
`;

const RecentSessionSchemaRow = Schema.Struct({
    session_id: Schema.NullOr(Schema.String),
    project_slug: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});

const RECENT_SESSIONS_SQL = `
SELECT i.session AS session_id, s.project AS project_slug, s.cwd AS cwd, i.ts AS ts
FROM invoked i
LEFT JOIN session s ON s.id = i.session
WHERE i.out_id = ?
ORDER BY i.ts DESC
LIMIT 50;
`;

const EMPTY_SKILL_STATS_INVOCATIONS = { total: 0, d7: 0, d30: 0, d90: 0, last: null };

export const fetchSkillStats = Effect.fn("queries.fetchSkillStats")(
    function* (name: string) {
        const skillRows = yield* cacheRows(
            SkillRowSchema,
            { sql: SKILL_ROW_SQL, params: [name] },
            "skill stats skill row",
        );
        const skill = skillRows[0] ?? null;

        if (!skill) {
            return {
                skill: null,
                invocations: EMPTY_SKILL_STATS_INVOCATIONS,
                recent_sessions: [],
            } satisfies SkillStatsPayload;
        }

        const [invocationRows, recentRows] = yield* Effect.all([
            cacheRows(
                InvocationSummarySchemaRow,
                { sql: INVOCATION_SUMMARY_SQL, params: [7, 30, 90, skill.id] },
                "skill stats invocations",
            ),
            cacheRows(
                RecentSessionSchemaRow,
                { sql: RECENT_SESSIONS_SQL, params: [skill.id] },
                "skill stats recent sessions",
            ),
        ], { concurrency: 2 });

        const invocations = invocationRows[0];

        return {
            skill,
            invocations: invocations
                ? {
                    total: invocations.total,
                    d7: invocations.d7,
                    d30: invocations.d30,
                    d90: invocations.d90,
                    last: dateField(invocations, "last"),
                }
                : EMPTY_SKILL_STATS_INVOCATIONS,
            recent_sessions: dedupeRecentSessions(recentRows),
        } satisfies SkillStatsPayload;
    },
);
