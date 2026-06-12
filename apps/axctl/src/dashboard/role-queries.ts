/**
 * P3.7: Role read queries - pure data layer.
 *
 * Exports three Effect fetchers:
 *   fetchSkillsByRole   - skills that play a given role
 *   fetchRolesForSkill  - roles a given skill plays
 *   fetchAllRoles       - full role vocabulary with skill counts
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface SkillByRoleRow {
    readonly skill_id: string;
    readonly skill_name: string;
    readonly source: string;
    readonly confidence: number;
    readonly rationale: string | null;
    readonly invocations: number;
}

export interface RoleForSkillRow {
    readonly role_name: string;
    readonly role_weight: number;
    readonly source: string;
    readonly confidence: number;
    readonly edge_weight_override: number | null;
    readonly rationale: string | null;
    readonly since: string | null;
}

export interface RoleRow {
    readonly name: string;
    readonly weight: number;
    readonly skill_count: number;
}

// ---------------------------------------------------------------------------
// fetchSkillsByRole
// ---------------------------------------------------------------------------

export interface FetchSkillsByRoleParams {
    readonly role: string;
    readonly limit?: number;
}

/** Shared default row cap for `fetchSkillsByRole` (CLI + MCP). */
export const SKILLS_BY_ROLE_DEFAULT_LIMIT = 50;

/**
 * Transport-agnostic raw input for `fetchSkillsByRole`. The CLI flag parser and
 * the MCP zod handler decode into this then call
 * {@link normalizeSkillsByRoleParams} so the limit default lives in one place.
 *
 * `limit` positivity stays in the transports (CLI `requirePositiveInt`, MCP
 * zod `.positive()`); this only fills the default.
 */
export interface SkillsByRoleQueryArgs {
    readonly role: string;
    readonly limit?: number | undefined;
}

export const normalizeSkillsByRoleParams = (
    args: SkillsByRoleQueryArgs,
): FetchSkillsByRoleParams => ({
    role: args.role,
    limit:
        typeof args.limit === "number" && Number.isFinite(args.limit)
            ? args.limit
            : SKILLS_BY_ROLE_DEFAULT_LIMIT,
});

export interface FetchSkillsByRoleResult {
    readonly rows: readonly SkillByRoleRow[];
    readonly found: boolean;
}

export const fetchSkillsByRole = (
    params: FetchSkillsByRoleParams,
): Effect.Effect<FetchSkillsByRoleResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = params.limit ?? SKILLS_BY_ROLE_DEFAULT_LIMIT;

        const sql = `
SELECT
    in AS skill_id,
    in.name AS skill_name,
    source,
    confidence,
    rationale,
    (SELECT count() FROM invoked WHERE out = $parent.in)[0].count ?? 0 AS invocations
FROM plays_role
WHERE out.name = $role
ORDER BY invocations DESC
LIMIT ${limit};`.trim();

        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql, {
            role: params.role,
        });

        const rows = (result?.[0] ?? []) as Array<Record<string, unknown>>;

        const mapped: SkillByRoleRow[] = rows.map((r) => ({
            skill_id: String(r.skill_id ?? ""),
            skill_name: String(r.skill_name ?? ""),
            source: String(r.source ?? ""),
            confidence: Number(r.confidence ?? 0),
            rationale: r.rationale != null ? String(r.rationale) : null,
            invocations: Number(r.invocations ?? 0),
        }));

        return { rows: mapped, found: mapped.length > 0 };
    });

// ---------------------------------------------------------------------------
// fetchRolesForSkill
// ---------------------------------------------------------------------------

export interface FetchRolesForSkillParams {
    readonly skill: string;
}

export interface FetchRolesForSkillResult {
    readonly rows: readonly RoleForSkillRow[];
    readonly skillExists: boolean;
}

export const fetchRolesForSkill = (
    params: FetchRolesForSkillParams,
): Effect.Effect<FetchRolesForSkillResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // Check skill existence first (follows P3.4 pattern)
        const existsResult = yield* db.query<[Array<unknown>]>(
            "SELECT id FROM skill WHERE name = $name LIMIT 1;",
            { name: params.skill },
        );
        const exists =
            Array.isArray(existsResult?.[0]) && existsResult[0].length > 0;

        if (!exists) {
            return { rows: [], skillExists: false };
        }

        const sql = `
SELECT
    out.name AS role_name,
    out.weight AS role_weight,
    source,
    confidence,
    weight AS edge_weight_override,
    rationale,
    since
FROM plays_role
WHERE in.name = $skill
ORDER BY role_name ASC;`.trim();

        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql, {
            skill: params.skill,
        });

        const rows = (result?.[0] ?? []) as Array<Record<string, unknown>>;

        const mapped: RoleForSkillRow[] = rows.map((r) => ({
            role_name: String(r.role_name ?? ""),
            role_weight: Number(r.role_weight ?? 1.0),
            source: String(r.source ?? ""),
            confidence: Number(r.confidence ?? 0),
            edge_weight_override:
                r.edge_weight_override != null
                    ? Number(r.edge_weight_override)
                    : null,
            rationale: r.rationale != null ? String(r.rationale) : null,
            since: r.since != null ? String(r.since) : null,
        }));

        return { rows: mapped, skillExists: true };
    });

// ---------------------------------------------------------------------------
// fetchAllRoles
// ---------------------------------------------------------------------------

export interface FetchAllRolesResult {
    readonly rows: readonly RoleRow[];
}

export const fetchAllRoles = (): Effect.Effect<
    FetchAllRolesResult,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        const sql = `
SELECT
    name,
    weight,
    (SELECT count() FROM plays_role WHERE out = $parent.id)[0].count ?? 0 AS skill_count
FROM role
ORDER BY skill_count DESC;`.trim();

        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);

        const rows = (result?.[0] ?? []) as Array<Record<string, unknown>>;

        const mapped: RoleRow[] = rows.map((r) => ({
            name: String(r.name ?? ""),
            weight: Number(r.weight ?? 1.0),
            skill_count: Number(r.skill_count ?? 0),
        }));

        return { rows: mapped };
    });
