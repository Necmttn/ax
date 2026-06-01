function checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer (got ${limit})`);
    }
    return limit;
}

function withoutTerminator(sql: string): string {
    return sql.replace(/;\s*$/, "");
}

export function duplicateFileIdentitySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT * FROM (
SELECT repository, path, count() AS row_count, array::group(id) AS ids
FROM file
GROUP BY repository, path
)
WHERE row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

export function repositorySiblingSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT * FROM (
SELECT initial_commit, remote_url, count() AS row_count, array::group(id) AS ids
FROM repository
WHERE initial_commit IS NOT NONE OR remote_url IS NOT NONE
GROUP BY initial_commit, remote_url
)
WHERE row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

export function missingProducedScopeSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT id, in, out, repository, checkout, ts
FROM produced
WHERE repository IS NONE OR checkout IS NONE OR ts IS NONE
LIMIT ${safeLimit};`.trim();
}

export function legacySkillCollisionSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT * FROM (
SELECT string::replace(name, ":", "__") AS legacy_key, count() AS row_count, array::group(name) AS names
FROM skill
GROUP BY legacy_key
)
WHERE row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

function duplicateRelationTableSql(
    table: string,
    groupFields: readonly string[],
    limit: number,
): string {
    const group = groupFields.join(", ");
    const fields = groupFields.join(", ");
    return `(SELECT * FROM (
SELECT ${fields}, count() AS row_count, array::group(id) AS ids
FROM ${table}
GROUP BY ${group}
)
WHERE row_count > 1
ORDER BY row_count DESC
LIMIT ${limit})`;
}

export function duplicateRelationEdgesSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `{
    invoked: ${duplicateRelationTableSql("invoked", ["in", "out", "args"], safeLimit)},
    edited: ${duplicateRelationTableSql("edited", ["in", "out", "tool"], safeLimit)},
    concerns: ${duplicateRelationTableSql("concerns", ["in", "out", "kind"], safeLimit)},
    produced: ${duplicateRelationTableSql("produced", ["in", "out", "checkout"], safeLimit)},
    touched: ${duplicateRelationTableSql("touched", ["in", "out", "checkout"], safeLimit)},
    proposed: ${duplicateRelationTableSql("proposed", ["in", "out"], safeLimit)},
    corrected_by: ${duplicateRelationTableSql("corrected_by", ["in", "out"], safeLimit)}
}`;
}

export function providerEventIntegritySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `{
    events_missing_session: (
        SELECT id, agent_session, provider, seq, type
        FROM agent_event
        WHERE agent_session IS NONE OR provider IS NONE
        LIMIT ${safeLimit}
    ),
    sessions_missing_provider: (
        SELECT id, provider, provider_session_id, ax_session
        FROM agent_session
        WHERE provider IS NONE OR provider_session_id IS NONE
        LIMIT ${safeLimit}
    ),
    providers_without_sessions: (
        SELECT id, name
        FROM agent_provider
        WHERE count(<-agent_session.provider) = 0
        LIMIT ${safeLimit}
    )
}`;
}

export function graphHealthSql(limit: number): string {
    return `RETURN {
    duplicate_file_identity: (${withoutTerminator(duplicateFileIdentitySql(limit))}),
    repository_sibling: (${withoutTerminator(repositorySiblingSql(limit))}),
    missing_produced_scope: (${withoutTerminator(missingProducedScopeSql(limit))}),
    legacy_skill_collision: (${withoutTerminator(legacySkillCollisionSql(limit))}),
    duplicate_relation_edges: ${duplicateRelationEdgesSql(limit)},
    provider_event_integrity: ${providerEventIntegritySql(limit)}
};`;
}
