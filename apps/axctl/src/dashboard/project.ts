import { Effect } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { dateField, isRecord, recordIdString, stringField } from "@ax/lib/shared/row-fields";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import type {
    ProjectEpisode,
    ProjectFailure,
    ProjectPagePayload,
    ProjectRecentSession,
    ProjectTopSkill,
} from "@ax/lib/shared/dashboard-types";

// Local DuckDB translations of queries/project.ts's SurrealQL constants -
// that file is unported (2b's ownership); copy the shape, never import the
// SurrealQL text or its query-seam wrappers.

const PROJECT_OVERVIEW_SQL = `
    SELECT
        project,
        count(*) AS session_count,
        MIN(started_at) AS first_session_at,
        MAX(started_at) AS last_session_at,
        COALESCE(to_json(list(source) FILTER (WHERE source IS NOT NULL))::VARCHAR, '[]') AS sources_raw
    FROM session
    WHERE project = ?
    GROUP BY project
    LIMIT 1
`;

// `in.session.project` (deref: invoked -> turn -> session) simplifies to a
// direct join on `invoked.session`, which is denormalized onto the edge row
// for exactly this reason (see packages/schema/src/schema.duckdb.sql). A
// skill with a NULL dir_path is kept (only an exact "(synthetic)" match is
// excluded), matching the original's NOT IN subquery semantics.
const PROJECT_TOP_SKILLS_SQL = `
    SELECT sk.name AS skill, count(*) AS count, MAX(iv.ts) AS last_used
    FROM invoked iv
    JOIN session s ON s.id = iv.session
    JOIN skill sk ON sk.id = iv.out_id
    WHERE s.project = ?
      AND sk.name IS NOT NULL
      AND COALESCE(sk.dir_path, '') != '(synthetic)'
    GROUP BY skill
    ORDER BY count DESC
    LIMIT 25
`;

const PROJECT_TOP_FAILURES_SQL = `
    SELECT
        COALESCE(tc.command_norm, tc.name) AS label,
        count(*) AS failure_count,
        COUNT(DISTINCT tc.session) AS distinct_sessions,
        MAX(tc.ts) AS last_seen
    FROM tool_call tc
    JOIN session s ON s.id = tc.session
    WHERE s.project = ?
      AND tc.has_error = true
      AND COALESCE(tc.command_norm, tc.name) IS NOT NULL
    GROUP BY label
    ORDER BY failure_count DESC
    LIMIT 15
`;

const PROJECT_RECENT_SESSIONS_SQL = `
    SELECT id, source, started_at, ended_at, model, cwd
    FROM session
    WHERE project = ?
    -- `id` breaks the tie deliberately. Sessions that started inside the same
    -- timestamp resolution are common (a parent and the subagent it spawns), and
    -- with `started_at` alone the row order is whatever the scan happens to
    -- produce - it differed between macOS and Linux CI on the same fixture. An
    -- ordering that reshuffles between refreshes is a real defect in a "recent
    -- sessions" list, not just a flaky assertion.
    ORDER BY started_at DESC, id DESC
    LIMIT 20
`;

const PROJECT_EPISODES_SQL = `
    SELECT
        sp.in_id AS parent,
        s.started_at AS started_at,
        count(*) AS child_count,
        count(DISTINCT sp.nickname) AS distinct_nicknames
    FROM spawned sp
    JOIN session s ON s.id = sp.in_id
    WHERE s.project = ?
    GROUP BY sp.in_id, s.started_at
    ORDER BY child_count DESC
    LIMIT 10
`;

const numField = (row: Record<string, unknown>, key: string): number => {
    const v = Number(row[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
};

const stringArray = (v: unknown): ReadonlyArray<string> => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
        if (typeof x === "string" && x.length > 0) out.push(x);
    }
    return out;
};

/** JSON-text-in-VARCHAR parse; degrades to `[]` on malformed/absent JSON. */
const parseJsonArray = (raw: unknown): unknown[] => {
    if (typeof raw !== "string") return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

/**
 * Defensive raw-row reader: a failed query degrades to `[]` (matches the
 * `cacheRows` contract). Mirrors the identical helper in session-canvas.ts /
 * triage.ts / workflow.ts / wrapped.ts.
 */
const rawRows = (
    read: CacheReadService,
    sql: string,
    params?: ReadonlyArray<DuckDbParam>,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, never> =>
    read.raw(sql, params).pipe(
        Effect.map((result) => result.rows),
        Effect.catch((error) => {
            console.error(`project query failed: ${sql.slice(0, 60)}...`, error);
            return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
        }),
    );

export const fetchProject = (
    project: string,
): Effect.Effect<ProjectPagePayload | null, never, CacheRead> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const params = [project];

        const [overviewRows, topSkillRows, failureRows, recentSessionRows, episodeRows] =
            yield* Effect.all([
                rawRows(read, PROJECT_OVERVIEW_SQL, params),
                rawRows(read, PROJECT_TOP_SKILLS_SQL, params),
                rawRows(read, PROJECT_TOP_FAILURES_SQL, params),
                rawRows(read, PROJECT_RECENT_SESSIONS_SQL, params),
                rawRows(read, PROJECT_EPISODES_SQL, params),
            ]);

        const overviewRaw = overviewRows[0];
        if (!overviewRaw || !isRecord(overviewRaw)) return null;

        const sources = stringArray(parseJsonArray(overviewRaw.sources_raw));
        const sourceCounts = new Map<string, number>();
        for (const s of sources) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);

        const top_skills: ProjectTopSkill[] = topSkillRows
            .map((raw): ProjectTopSkill | null => {
                if (!isRecord(raw)) return null;
                const skill = stringField(raw, "skill");
                if (!skill) return null;
                return { skill, count: numField(raw, "count"), last_used: dateField(raw, "last_used") };
            })
            .filter((x): x is ProjectTopSkill => x !== null);

        const failures: ProjectFailure[] = failureRows
            .map((raw): ProjectFailure | null => {
                if (!isRecord(raw)) return null;
                const label = stringField(raw, "label");
                if (!label) return null;
                return {
                    label,
                    failure_count: numField(raw, "failure_count"),
                    distinct_sessions: numField(raw, "distinct_sessions"),
                    last_seen: dateField(raw, "last_seen"),
                };
            })
            .filter((x): x is ProjectFailure => x !== null);

        const recent_sessions: ProjectRecentSession[] = recentSessionRows
            .map((raw): ProjectRecentSession | null => {
                if (!isRecord(raw)) return null;
                const id = recordIdString(raw.id);
                if (!id) return null;
                return {
                    session_id: toBareSessionId(id),
                    source: stringField(raw, "source"),
                    started_at: dateField(raw, "started_at"),
                    ended_at: dateField(raw, "ended_at"),
                    model: stringField(raw, "model"),
                };
            })
            .filter((x): x is ProjectRecentSession => x !== null);

        const top_episodes: ProjectEpisode[] = episodeRows
            .map((raw): ProjectEpisode | null => {
                if (!isRecord(raw)) return null;
                const parent = recordIdString(raw.parent);
                if (!parent) return null;
                return {
                    parent_session_id: toBareSessionId(parent),
                    started_at: dateField(raw, "started_at"),
                    child_count: numField(raw, "child_count"),
                    distinct_nicknames: numField(raw, "distinct_nicknames"),
                };
            })
            .filter((x): x is ProjectEpisode => x !== null);

        return {
            project,
            session_count: numField(overviewRaw, "session_count"),
            first_session_at: dateField(overviewRaw, "first_session_at"),
            last_session_at: dateField(overviewRaw, "last_session_at"),
            sources: Array.from(sourceCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([source, count]) => ({ source, count })),
            top_skills,
            failures,
            recent_sessions,
            top_episodes,
        };
    });
