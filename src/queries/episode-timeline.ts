/**
 * Episode timeline: one parent session + every session it spawned, each
 * decorated with its phase summary, duration, top skills, and child count.
 *
 * Bindings: $parentRef (literal SurrealQL record id, e.g.
 * `session:⟨019e0ad4-c977-...⟩`). Interpolated directly by the caller after
 * validating the id format.
 */
/** Parent session record. */
export const EPISODE_PARENT_SQL = (parentRef: string): string => `
SELECT id, project, source, started_at, ended_at, cwd, model
FROM ${parentRef};`;

/** All children spawned by the parent. */
export const EPISODE_CHILDREN_SQL = (parentRef: string): string => `
SELECT
    out.id AS id,
    out.project AS project,
    out.source AS source,
    out.started_at AS started_at,
    out.ended_at AS ended_at,
    out.cwd AS cwd,
    out.model AS model
FROM spawned
WHERE in = ${parentRef}
ORDER BY out.started_at ASC
LIMIT 500;`;

/**
 * Invocations in the parent session itself. Fast via the
 * `invoked` -> `in.session` index.
 */
export const EPISODE_PARENT_INVOCATIONS_SQL = (parentRef: string): string => `
SELECT in.session AS session, out.name AS skill, ts
FROM invoked
WHERE in.session = ${parentRef} AND out.name IS NOT NONE
ORDER BY ts ASC
LIMIT 5000;`;

/**
 * Invocations in any of the supplied child sessions. The caller materialises
 * the child id list from the cheap `spawned WHERE in = parent` query and
 * splices a SurrealQL array literal here. Avoids the IN-subquery slowdown
 * that scans all 600k+ invoked rows.
 */
export const EPISODE_CHILD_INVOCATIONS_SQL = (
    childIdsLiteral: string,
): string => `
SELECT in.session AS session, out.name AS skill, ts
FROM invoked
WHERE in.session IN ${childIdsLiteral} AND out.name IS NOT NONE
ORDER BY ts ASC
LIMIT 20000;`;
