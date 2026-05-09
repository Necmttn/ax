export const INSIGHT_VIEWS = [
    "repositories",
    "friction",
    "tools",
    "sessions",
] as const;

export type InsightView = (typeof INSIGHT_VIEWS)[number];

export function isInsightView(value: string): value is InsightView {
    return (INSIGHT_VIEWS as readonly string[]).includes(value);
}

function checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer (got ${limit})`);
    }
    return limit;
}

export function repositoryOverviewSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    name,
    remote_url,
    root_path,
    initial_commit,
    default_branch,
    created_at,
    updated_at,
    (updated_at ?? created_at) AS last_seen,
    array::len(->has_checkout->checkout) AS checkout_count,
    ->has_checkout->checkout.path AS checkout_paths,
    ->has_checkout->checkout.branch AS checkout_branches
FROM repository
ORDER BY last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function recentFrictionSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    ts,
    kind,
    text,
    labels,
    metrics,
    raw,
    session,
    session.project AS project,
    session.cwd AS cwd,
    turn,
    turn.seq AS turn_seq
FROM friction_event
ORDER BY ts DESC
LIMIT ${safeLimit};`.trim();
}

export function toolFailuresSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    name,
    command_norm,
    command_tool,
    exit_code,
    count() AS failure_count,
    time::max(ts) AS last_seen,
    math::sum(IF status = "error" THEN 1 ELSE 0 END) AS status_error_count
FROM tool_call
WHERE has_error = true
GROUP BY name, command_norm, command_tool, exit_code
ORDER BY failure_count DESC, last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function sessionEvidenceSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    id,
    project,
    cwd,
    model,
    started_at,
    ended_at,
    repository,
    checkout,
    (ended_at ?? started_at) AS last_seen,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id)) AS tool_call_count,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id AND has_error = true)) AS tool_failure_count,
    array::len((SELECT id FROM friction_event WHERE session = $parent.id)) AS friction_event_count,
    array::len((SELECT id FROM plan_snapshot WHERE session = $parent.id)) AS plan_snapshot_count
FROM session
ORDER BY last_seen DESC
LIMIT ${safeLimit};`.trim();
}

export function insightSqlForView(view: InsightView, limit: number): string {
    switch (view) {
        case "repositories":
            return repositoryOverviewSql(limit);
        case "friction":
            return recentFrictionSql(limit);
        case "tools":
            return toolFailuresSql(limit);
        case "sessions":
            return sessionEvidenceSql(limit);
    }
}
