const DAYS = 365;
export const WRAPPED_DAYS_LOOKBACK = DAYS;

export const WRAPPED_USAGE_SQL = `
SELECT
    array::len(array::distinct(session)) AS sessions,
    count() AS messages,
    array::len(array::distinct(time::format(ts, "%Y-%m-%d"))) AS active_days
FROM turn
WHERE ts > time::now() - ${DAYS}d
GROUP ALL;`;

export const WRAPPED_DAILY_ACTIVITY_SQL = `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    array::len(array::distinct(session)) AS sessions,
    count() AS turns
FROM turn
WHERE ts > time::now() - ${DAYS}d
  AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const WRAPPED_PEAK_HOUR_SQL = `
SELECT
    time::format(started_at, "%H") AS hour,
    count() AS count
FROM session
WHERE started_at > time::now() - ${DAYS}d
  AND started_at IS NOT NONE
GROUP BY hour
ORDER BY count DESC
LIMIT 1;`;

export const WRAPPED_MODEL_SQL = `
SELECT model, count() AS count
FROM session
WHERE started_at > time::now() - ${DAYS}d
  AND model IS NOT NONE
GROUP BY model
ORDER BY count DESC
LIMIT 1;`;

export const WRAPPED_SKILLS_SQL = `
SELECT out.name AS skill, count() AS count
FROM invoked
WHERE ts > time::now() - ${DAYS}d
  AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 50;`;

export const WRAPPED_TOOLS_SQL = `
SELECT
    (command_norm ?? name) AS tool,
    count() AS count,
    math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures
FROM tool_call
WHERE ts > time::now() - ${DAYS}d
  AND (command_norm ?? name) IS NOT NONE
GROUP BY tool
ORDER BY count DESC
LIMIT 50;`;

export const WRAPPED_REPOSITORY_SQL = `
SELECT repository, count() AS count
FROM session
WHERE started_at > time::now() - ${DAYS}d
  AND repository IS NOT NONE
GROUP BY repository
ORDER BY count DESC
LIMIT 50;`;

export const WRAPPED_SPAWNED_SQL = `
SELECT count() AS count
FROM spawned
WHERE ts > time::now() - ${DAYS}d
GROUP ALL;`;
