function checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer (got ${limit})`);
    }
    return limit;
}

export function duplicateFileIdentitySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT repository, path, count() AS row_count, array::group(id) AS ids
FROM file
GROUP BY repository, path
HAVING row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

export function repositorySiblingSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT initial_commit, remote_url, count() AS row_count, array::group(id) AS ids
FROM repository
WHERE initial_commit IS NOT NONE OR remote_url IS NOT NONE
GROUP BY initial_commit, remote_url
HAVING row_count > 1
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
SELECT string::replace(name, ":", "__") AS legacy_key, count() AS row_count, array::group(name) AS names
FROM skill
GROUP BY legacy_key
HAVING row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

export function graphHealthSql(limit: number): string {
    return `RETURN {
    duplicate_file_identity: (${duplicateFileIdentitySql(limit)}),
    repository_sibling: (${repositorySiblingSql(limit)}),
    missing_produced_scope: (${missingProducedScopeSql(limit)}),
    legacy_skill_collision: (${legacySkillCollisionSql(limit)})
};`;
}
