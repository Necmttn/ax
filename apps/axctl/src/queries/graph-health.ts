/**
 * The `graph-health` insight view: six integrity scans over the published
 * snapshot, in ONE statement.
 *
 * `CacheRead.rows` returns flat rows, with no way to nest a result set per
 * check inside a single statement's output. So the six checks UNION ALL into
 * one flat table with a discriminator, the same resolution `schemaCoverageSql`
 * uses:
 *
 *   check       which scan produced the row (e.g. `duplicate_file_identity`)
 *   subject     what the scan groups by, rendered as text
 *   row_count   how many rows share that subject (1 for the "missing" scans)
 *   ids         the offending row ids, as a JSON array in a VARCHAR
 *
 * `ids` is VARCHAR-encoded JSON rather than a native LIST because the bun:ffi
 * client cannot decode a LIST column (see the ARRAYS note in
 * schema.duckdb.sql); `to_json(array_agg(...))` is what every other ported
 * query in this repo uses for the same reason.
 *
 * EMPTY IS THE HEALTHY ANSWER. Each scan only emits rows for what is WRONG, so
 * a healthy graph returns zero rows - the view is a defect list, not a report
 * card, exactly as the original was.
 */

function checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer (got ${limit})`);
    }
    return limit;
}

function withoutTerminator(sql: string): string {
    return sql.replace(/;\s*$/, "");
}

/** Two or more `file` rows claiming the same (repository, path) identity. */
export function duplicateFileIdentitySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    'duplicate_file_identity' AS check,
    COALESCE(repository, '(none)') || ' :: ' || COALESCE(path, '(none)') AS subject,
    CAST(count(*) AS DOUBLE) AS row_count,
    to_json(array_agg(id)) AS ids
FROM file
GROUP BY repository, path
HAVING count(*) > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

/** Two or more `repository` rows sharing an identity key. */
export function repositorySiblingSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    'repository_sibling' AS check,
    COALESCE(initial_commit, '(none)') || ' :: ' || COALESCE(remote_url, '(none)') AS subject,
    CAST(count(*) AS DOUBLE) AS row_count,
    to_json(array_agg(id)) AS ids
FROM repository
WHERE initial_commit IS NOT NULL OR remote_url IS NOT NULL
GROUP BY initial_commit, remote_url
HAVING count(*) > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

/** `produced` edges that lost their repo/checkout/time scope. */
export function missingProducedScopeSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    'missing_produced_scope' AS check,
    in_id || ' -> ' || out_id AS subject,
    CAST(1 AS DOUBLE) AS row_count,
    to_json([id]) AS ids
FROM produced
WHERE repository IS NULL OR checkout IS NULL OR ts IS NULL
LIMIT ${safeLimit};`.trim();
}

/**
 * Distinct skill names that collide once `:` is encoded as `__` - the legacy
 * record-id encoding for plugin-namespaced skills (see skill-id.ts).
 */
export function legacySkillCollisionSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT
    'legacy_skill_collision' AS check,
    replace(name, ':', '__') AS subject,
    CAST(count(*) AS DOUBLE) AS row_count,
    to_json(array_agg(name)) AS ids
FROM skill
GROUP BY replace(name, ':', '__')
HAVING count(*) > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

/**
 * One relation table's duplicate edges. `in`/`out` are `in_id`/`out_id` in the
 * DuckDB schema - `in` and `out` are reserved words there, and every ported
 * query in this repo uses the `_id` form.
 */
function duplicateRelationTableSql(
    table: string,
    groupFields: readonly string[],
    limit: number,
): string {
    const group = groupFields.join(", ");
    const subject = groupFields.map((f) => `COALESCE(CAST(${f} AS VARCHAR), '(none)')`).join(" || ' :: ' || ");
    return `
SELECT
    'duplicate_relation_edges' AS check,
    '${table}: ' || ${subject} AS subject,
    CAST(count(*) AS DOUBLE) AS row_count,
    to_json(array_agg(id)) AS ids
FROM ${table}
GROUP BY ${group}
HAVING count(*) > 1
ORDER BY row_count DESC
LIMIT ${limit}`;
}

const DUPLICATE_RELATION_TABLES: ReadonlyArray<{ readonly table: string; readonly fields: readonly string[] }> = [
    { table: "invoked", fields: ["in_id", "out_id", "args"] },
    { table: "edited", fields: ["in_id", "out_id", "tool"] },
    { table: "concerns", fields: ["in_id", "out_id", "kind"] },
    { table: "produced", fields: ["in_id", "out_id", "checkout"] },
    { table: "touched", fields: ["in_id", "out_id", "checkout"] },
    { table: "proposed", fields: ["in_id", "out_id"] },
    { table: "corrected_by", fields: ["in_id", "out_id"] },
];

export function duplicateRelationEdgesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return DUPLICATE_RELATION_TABLES
        .map(({ table, fields }) => `(${duplicateRelationTableSql(table, fields, safeLimit)})`)
        .join("\nUNION ALL\n");
}

/**
 * Provider-native rows that lost their links. The third arm is a
 * `NOT EXISTS` against `agent_session.provider`.
 */
export function providerEventIntegritySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
(SELECT
    'provider_event_integrity' AS check,
    'events_missing_session: ' || id AS subject,
    CAST(1 AS DOUBLE) AS row_count,
    to_json([id]) AS ids
FROM agent_event
WHERE agent_session IS NULL OR provider IS NULL
LIMIT ${safeLimit})
UNION ALL
(SELECT
    'provider_event_integrity' AS check,
    'sessions_missing_provider: ' || id AS subject,
    CAST(1 AS DOUBLE) AS row_count,
    to_json([id]) AS ids
FROM agent_session
WHERE provider IS NULL OR provider_session_id IS NULL
LIMIT ${safeLimit})
UNION ALL
(SELECT
    'provider_event_integrity' AS check,
    'providers_without_sessions: ' || COALESCE(p.name, p.id) AS subject,
    CAST(1 AS DOUBLE) AS row_count,
    to_json([p.id]) AS ids
FROM agent_provider p
WHERE NOT EXISTS (SELECT 1 FROM agent_session s WHERE s.provider = p.id)
LIMIT ${safeLimit})`.trim();
}

export function graphHealthSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return [
        `(${withoutTerminator(duplicateFileIdentitySql(safeLimit))})`,
        `(${withoutTerminator(repositorySiblingSql(safeLimit))})`,
        `(${withoutTerminator(missingProducedScopeSql(safeLimit))})`,
        `(${withoutTerminator(legacySkillCollisionSql(safeLimit))})`,
        duplicateRelationEdgesSql(safeLimit),
        providerEventIntegritySql(safeLimit),
    ].join("\nUNION ALL\n") + ";";
}
