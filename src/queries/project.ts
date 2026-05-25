/**
 * Project page: everything we know about a single `session.project` value.
 *
 * All queries take a `$project` binding (raw string, e.g.
 * `-Users-necmttn-Projects-myapp`). SurrealDB string-equality bindings work
 * fine here - no record-id binding pitfalls.
 *
 * Performance notes:
 *   - `session.project` and `tool_call.session.project` lookups: the
 *     project field is indexed via the session table; queries scoped by it
 *     stay bounded.
 *   - For invocations we filter via `in.session.project`, which the
 *     `invoked` table can index-walk through `in.session`.
 */
import { defineQuery, defineSingleQuery } from "./query.ts";
import { isRecord, stringField, dateField, recordIdString } from "../lib/shared/row-fields.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";
import type {
    ProjectTopSkill,
    ProjectFailure,
    ProjectRecentSession,
    ProjectEpisode,
} from "../lib/shared/dashboard-types.ts";

/** Overview: session counts, span, source breakdown. */
export const PROJECT_OVERVIEW_SQL = `
SELECT
    project,
    count() AS session_count,
    array::group(source) AS sources,
    time::min(started_at) AS first_session_at,
    time::max(started_at) AS last_session_at
FROM session
WHERE project = $project
GROUP BY project;`;

/** Top skills used in this project. */
export const PROJECT_TOP_SKILLS_SQL = `
SELECT
    out.name AS skill,
    count() AS count,
    time::max(ts) AS last_used
FROM invoked
WHERE in.session.project = $project AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 25;`;

/**
 * Failed-tool roll-up scoped to the project. Mirrors the global
 * /tool-failures shape so the SPA can share the row component.
 */
export const PROJECT_TOP_FAILURES_SQL = `
SELECT
    (command_norm ?? name) AS label,
    count() AS failure_count,
    array::len(array::distinct(session.id)) AS distinct_sessions,
    time::max(ts) AS last_seen
FROM tool_call
WHERE session.project = $project
  AND failure = true
  AND (command_norm ?? name) IS NOT NONE
GROUP BY label
ORDER BY failure_count DESC
LIMIT 15;`;

/** 20 most recent sessions for the project. */
export const PROJECT_RECENT_SESSIONS_SQL = `
SELECT
    id,
    source,
    started_at,
    ended_at,
    model,
    cwd
FROM session
WHERE project = $project
ORDER BY started_at DESC
LIMIT 20;`;

/** Episodes (parent sessions with subagents) inside this project. */
export const PROJECT_EPISODES_SQL = `
SELECT
    in AS parent,
    in.started_at AS started_at,
    count() AS child_count,
    array::len(array::distinct(nickname)) AS distinct_nicknames
FROM spawned
WHERE in.project = $project
GROUP BY parent, started_at
ORDER BY child_count DESC
LIMIT 10;`;

// ---------------------------------------------------------------------------
// Typed Query seam
// ---------------------------------------------------------------------------

interface ProjectParams {
    readonly project: string;
}

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

/** Overview row: session counts + source breakdown. Single row or null. */
export interface ProjectOverviewRow {
    readonly project: string;
    readonly session_count: number;
    readonly first_session_at: string | null;
    readonly last_session_at: string | null;
    readonly sources: ReadonlyArray<{ readonly source: string; readonly count: number }>;
}

export const projectOverviewQuery = defineSingleQuery<
    ProjectParams,
    Record<string, unknown>,
    ProjectOverviewRow | null
>({
    name: "project.overview",
    sql: () => PROJECT_OVERVIEW_SQL,
    bindings: (p) => ({ project: p.project }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const sources = stringArray(raw.sources);
        const sourceCounts = new Map<string, number>();
        for (const s of sources) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
        return {
            project: stringField(raw, "project") ?? "",
            session_count: numField(raw, "session_count"),
            first_session_at: dateField(raw, "first_session_at"),
            last_session_at: dateField(raw, "last_session_at"),
            sources: Array.from(sourceCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([source, count]) => ({ source, count })),
        };
    },
});

export const projectTopSkillsQuery = defineQuery<
    ProjectParams,
    Record<string, unknown>,
    ProjectTopSkill | null
>({
    name: "project.top_skills",
    sql: () => PROJECT_TOP_SKILLS_SQL,
    bindings: (p) => ({ project: p.project }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const skill = stringField(raw, "skill");
        if (!skill) return null;
        return {
            skill,
            count: numField(raw, "count"),
            last_used: dateField(raw, "last_used"),
        };
    },
});

export const projectTopFailuresQuery = defineQuery<
    ProjectParams,
    Record<string, unknown>,
    ProjectFailure | null
>({
    name: "project.top_failures",
    sql: () => PROJECT_TOP_FAILURES_SQL,
    bindings: (p) => ({ project: p.project }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const label = stringField(raw, "label");
        if (!label) return null;
        return {
            label,
            failure_count: numField(raw, "failure_count"),
            distinct_sessions: numField(raw, "distinct_sessions"),
            last_seen: dateField(raw, "last_seen"),
        };
    },
});

export const projectRecentSessionsQuery = defineQuery<
    ProjectParams,
    Record<string, unknown>,
    ProjectRecentSession | null
>({
    name: "project.recent_sessions",
    sql: () => PROJECT_RECENT_SESSIONS_SQL,
    bindings: (p) => ({ project: p.project }),
    mapRow: (raw) => {
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
    },
});

export const projectEpisodesQuery = defineQuery<
    ProjectParams,
    Record<string, unknown>,
    ProjectEpisode | null
>({
    name: "project.episodes",
    sql: () => PROJECT_EPISODES_SQL,
    bindings: (p) => ({ project: p.project }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const parent = recordIdString(raw.parent);
        if (!parent) return null;
        return {
            parent_session_id: toBareSessionId(parent),
            started_at: dateField(raw, "started_at"),
            child_count: numField(raw, "child_count"),
            distinct_nicknames: numField(raw, "distinct_nicknames"),
        };
    },
});
