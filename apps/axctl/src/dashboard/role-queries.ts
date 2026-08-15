/**
 * P3.7: Role read queries - pure data layer.
 *
 * Exports three Effect fetchers:
 *   fetchSkillsByRole   - skills that play a given role
 *   fetchRolesForSkill  - roles a given skill plays
 *   fetchAllRoles       - full role vocabulary with skill counts
 */

import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";

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
): Effect.Effect<FetchSkillsByRoleResult, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;
        const limit = params.limit ?? SKILLS_BY_ROLE_DEFAULT_LIMIT;

        const sql = `
SELECT
    sk.id AS skill_id, sk.name AS skill_name, pr.source, pr.confidence, pr.rationale,
    count(i.id) AS invocations
FROM plays_role pr
JOIN skill sk ON sk.id = pr.in_id
JOIN role r ON r.id = pr.out_id
LEFT JOIN invoked i ON i.out_id = sk.id
WHERE r.name = ?
GROUP BY sk.id, sk.name, pr.source, pr.confidence, pr.rationale
ORDER BY invocations DESC
LIMIT ?`.trim();

        const Row = Schema.Struct({ skill_id: Schema.String, skill_name: Schema.String, source: Schema.String, confidence: Schema.Number, rationale: Schema.NullOr(Schema.String), invocations: NumberFromBigIntColumn });
        const rows = yield* db.rows(Row, sql, [params.role, limit]);

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
): Effect.Effect<FetchRolesForSkillResult, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;

        // Check skill existence first (follows P3.4 pattern)
        const IdRow = Schema.Struct({ id: Schema.String });
        const existsResult = yield* db.rows(IdRow, "SELECT id FROM skill WHERE name = ? LIMIT 1", [params.skill]);
        const exists = existsResult.length > 0;

        if (!exists) {
            return { rows: [], skillExists: false };
        }

        const sql = `
SELECT
    r.name AS role_name, r.weight AS role_weight, pr.source, pr.confidence,
    pr.weight AS edge_weight_override, pr.rationale, pr.since
FROM plays_role pr
JOIN skill sk ON sk.id = pr.in_id
JOIN role r ON r.id = pr.out_id
WHERE sk.name = ?
ORDER BY role_name ASC;`.trim();

        const Row = Schema.Struct({ role_name: Schema.String, role_weight: Schema.Number, source: Schema.String, confidence: Schema.Number, edge_weight_override: Schema.NullOr(Schema.Number), rationale: Schema.NullOr(Schema.String), since: TimestampColumn });
        const rows = yield* db.rows(Row, sql, [params.skill]);

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
            since: r.since.toISOString(),
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
    CacheReadError,
    CacheRead
> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;

        const sql = `
SELECT
    r.name, r.weight, count(pr.id) AS skill_count
FROM role r
LEFT JOIN plays_role pr ON pr.out_id = r.id
GROUP BY r.id, r.name, r.weight
ORDER BY skill_count DESC;`.trim();

        const Row = Schema.Struct({ name: Schema.String, weight: Schema.Number, skill_count: NumberFromBigIntColumn });
        const rows = yield* db.rows(Row, sql);

        const mapped: RoleRow[] = rows.map((r) => ({
            name: String(r.name ?? ""),
            weight: Number(r.weight ?? 1.0),
            skill_count: Number(r.skill_count ?? 0),
        }));

        return { rows: mapped };
    });
