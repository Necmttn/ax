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

export function graphHealthSql(limit: number): string {
    return `RETURN {
    duplicate_file_identity: (${withoutTerminator(duplicateFileIdentitySql(limit))}),
    repository_sibling: (${withoutTerminator(repositorySiblingSql(limit))}),
    missing_produced_scope: (${withoutTerminator(missingProducedScopeSql(limit))}),
    legacy_skill_collision: (${withoutTerminator(legacySkillCollisionSql(limit))})
};`;
}
