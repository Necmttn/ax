/**
 * Role read queries - the pure data layer behind `ax skills by-role`,
 * `ax skills roles`, `ax roles`, their MCP tools, and the dashboard's role views.
 *
 * THE FIRST READ SURFACE THAT SPANS BOTH v2 ENGINES, so it is worth saying
 * plainly where each half of an answer comes from:
 *
 *   plays_role, role     -> the SQLite judgment sidecar (`Judgment`). A role tag
 *                           and a role's weight are DECISIONS; no re-derive can
 *                           reproduce them, and none may erase them.
 *   skill.name, invoked  -> the DuckDB cache (`CacheRead`). Both are derived from
 *                           what is on disk and in the transcripts.
 *
 * The two halves live in two separate databases, so the join happens HERE:
 * read the tags, collect the skill ids they name, and resolve names and
 * counts in ONE cache query each. Never a query per row - a tag list is
 * small, but a per-row round trip does not scale.
 *
 * A TAG WHOSE SKILL IS GONE IS SHOWN, NOT DROPPED. The cache is rebuildable and
 * the sidecar is not, so "a tag on a skill the cache no longer holds" is a real
 * state (see `@ax/lib/sqlite/integrity`, which counts them). Dropping the row
 * would hide a decision the user made; inventing a name would be a lie. The id is
 * what is known, so the id is what comes back, with an empty name.
 */

import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";

/** Everything these fetchers can fail with: one engine's errors or the other's. */
export type RoleQueryError = CacheReadError | JudgmentError;

const ClassifiedSkillIdRow = Schema.Struct({ skill_id: Schema.String });
const SkillRoleWeightRow = Schema.Struct({
    skill_id: Schema.String,
    role_name: Schema.String,
    effective_weight: Schema.Number,
});

export const fetchClassifiedSkillIds = (): Effect.Effect<readonly string[], JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const rows = yield* judgment.rows(
            ClassifiedSkillIdRow,
            `SELECT DISTINCT in_id AS skill_id FROM plays_role
             WHERE source IN ('frontmatter', 'brief', 'user')`,
        );
        return rows.map((row) => row.skill_id);
    });

export const fetchSkillRoleWeights = (): Effect.Effect<
    ReadonlyArray<typeof SkillRoleWeightRow.Type>,
    JudgmentError,
    Judgment
> => Effect.gen(function* () {
    const judgment = yield* Judgment;
    return yield* judgment.rows(
        SkillRoleWeightRow,
        `SELECT pr.in_id AS skill_id, r.name AS role_name,
                max(coalesce(pr.weight, r.weight, 1.0), 1.0) AS effective_weight
         FROM plays_role pr JOIN role r ON r.id = pr.out_id
         WHERE pr.source IN ('frontmatter', 'brief', 'user')`,
    );
});

const NamedSkillRow = Schema.Struct({ id: Schema.String, name: Schema.String });
const NamedRoleEdgeRow = Schema.Struct({ skill_id: Schema.String, role_name: Schema.String });

/** Resolve role decisions for skill names without copying sidecar SQL into callers. */
export const fetchSkillRoleEdgesByNames = (
    skillNames: ReadonlyArray<string>,
): Effect.Effect<
    ReadonlyArray<{ readonly skill_name: string; readonly role_name: string }>,
    RoleQueryError,
    CacheRead | Judgment
> => Effect.gen(function* () {
    if (skillNames.length === 0) return [];
    const read = yield* CacheRead;
    const judgment = yield* Judgment;
    const skills = yield* read.rows(
        NamedSkillRow,
        `SELECT id, name FROM skill WHERE name IN (${placeholders(skillNames.length)})`,
        [...skillNames],
    );
    if (skills.length === 0) return [];
    const ids = skills.map((skill) => skill.id);
    const roles = yield* judgment.rows(
        NamedRoleEdgeRow,
        `SELECT pr.in_id AS skill_id, r.name AS role_name
         FROM plays_role pr JOIN role r ON r.id = pr.out_id
         WHERE pr.in_id IN (${placeholders(ids.length)})
           AND pr.source IN ('frontmatter', 'brief', 'user')`,
        ids,
    );
    const names = new Map(skills.map((skill) => [skill.id, skill.name] as const));
    return roles.flatMap((role) => {
        const skillName = names.get(role.skill_id);
        return skillName ? [{ skill_name: skillName, role_name: role.role_name }] : [];
    });
});

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
// Shared cross-engine helpers
// ---------------------------------------------------------------------------

/** `?, ?, ?` for `n` bound values. The ids themselves always bind - DuckDB row
 *  ids are plain strings, so nothing is ever spliced into the SQL text. */
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

const SkillNameRow = Schema.Struct({ id: Schema.String, name: Schema.String });

/** Cache names for the given skill ids, in ONE query. Ids the cache no longer
 *  holds are simply absent from the map. */
const skillNamesById = (
    read: { readonly rows: typeof CacheRead.Service.rows },
    ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, string>, CacheReadError> =>
    ids.length === 0
        ? Effect.succeed(new Map<string, string>())
        : read
              .rows(SkillNameRow, `SELECT id, name FROM skill WHERE id IN (${placeholders(ids.length)})`, ids)
              .pipe(Effect.map((rows) => new Map(rows.map((r) => [r.id, r.name] as const))));

const InvocationCountRow = Schema.Struct({
    out_id: Schema.String,
    invocations: NumberFromBigIntColumn,
});

/**
 * Invocation counts for the given skill ids, in ONE grouped query.
 *
 * `count(*)` is a BIGINT, so it decodes through `NumberFromBigIntColumn` rather
 * than `Schema.Number` - the FFI client keeps 64-bit widths as `bigint`, and a
 * field typed `Schema.Number` against a BIGINT column is a decode failure, not a
 * silent round.
 */
const invocationCounts = (
    read: { readonly rows: typeof CacheRead.Service.rows },
    ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, number>, CacheReadError> =>
    ids.length === 0
        ? Effect.succeed(new Map<string, number>())
        : read
              .rows(
                  InvocationCountRow,
                  `SELECT out_id, count(*) AS invocations FROM invoked WHERE out_id IN (${placeholders(
                      ids.length,
                  )}) GROUP BY out_id`,
                  ids,
              )
              .pipe(Effect.map((rows) => new Map(rows.map((r) => [r.out_id, r.invocations] as const))));

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

const TagByRoleRow = Schema.Struct({
    in_id: Schema.String,
    source: Schema.String,
    confidence: Schema.Number,
    rationale: Schema.NullOr(Schema.String),
});

export const fetchSkillsByRole = (
    params: FetchSkillsByRoleParams,
): Effect.Effect<FetchSkillsByRoleResult, RoleQueryError, CacheRead | Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const read = yield* CacheRead;
        const limit = params.limit ?? SKILLS_BY_ROLE_DEFAULT_LIMIT;

        const tags = yield* judgment.rows(
            TagByRoleRow,
            `SELECT pr.in_id AS in_id, pr.source AS source, pr.confidence AS confidence,
                    pr.rationale AS rationale
             FROM plays_role pr
             JOIN role r ON r.id = pr.out_id
             WHERE r.name = ?`,
            [params.role],
        );

        const skillIds = tags.map((t) => t.in_id);
        const names = yield* skillNamesById(read, skillIds);
        const counts = yield* invocationCounts(read, skillIds);

        // Ranked HERE rather than in SQL, because the ranking key lives in the
        // other database. A role's tag list is bounded by the number of installed
        // skills, so this sorts tens of rows, not a table. The name tie-break
        // makes the order total - `ORDER BY invocations DESC` alone left ties to
        // the engine, and two engines would not have agreed.
        const mapped: SkillByRoleRow[] = tags
            .map((t) => ({
                skill_id: t.in_id,
                skill_name: names.get(t.in_id) ?? "",
                source: t.source,
                confidence: t.confidence,
                rationale: t.rationale,
                invocations: counts.get(t.in_id) ?? 0,
            }))
            .sort((a, b) => b.invocations - a.invocations || a.skill_name.localeCompare(b.skill_name))
            .slice(0, limit);

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

const SkillIdRow = Schema.Struct({ id: Schema.String });

const RoleForSkillTagRow = Schema.Struct({
    role_name: Schema.String,
    role_weight: Schema.Number,
    source: Schema.String,
    confidence: Schema.Number,
    edge_weight_override: Schema.NullOr(Schema.Number),
    rationale: Schema.NullOr(Schema.String),
    since: Schema.NullOr(Schema.String),
});

export const fetchRolesForSkill = (
    params: FetchRolesForSkillParams,
): Effect.Effect<FetchRolesForSkillResult, RoleQueryError, CacheRead | Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const read = yield* CacheRead;

        // Existence is a CACHE question: a skill exists because it is installed
        // on disk, not because someone tagged it. Keeping this check means
        // `ax skills roles never-installed` still says "unknown skill" rather
        // than "no roles", which are different answers.
        const skill = yield* read.first(SkillIdRow, "SELECT id FROM skill WHERE name = ? LIMIT 1", [
            params.skill,
        ]);
        if (skill._tag === "None") return { rows: [], skillExists: false };

        // Tags are keyed by the skill's cache ID, not its name - a rename in the
        // catalogue must not orphan the decision.
        const rows = yield* judgment.rows(
            RoleForSkillTagRow,
            `SELECT r.name AS role_name, r.weight AS role_weight, pr.source AS source,
                    pr.confidence AS confidence, pr.weight AS edge_weight_override,
                    pr.rationale AS rationale, pr.since AS since
             FROM plays_role pr
             JOIN role r ON r.id = pr.out_id
             WHERE pr.in_id = ?
             ORDER BY r.name ASC`,
            [skill.value.id],
        );

        return { rows: [...rows], skillExists: true };
    });

// ---------------------------------------------------------------------------
// fetchAllRoles
// ---------------------------------------------------------------------------

export interface FetchAllRolesResult {
    readonly rows: readonly RoleRow[];
}

const AllRolesRow = Schema.Struct({
    name: Schema.String,
    weight: Schema.Number,
    skill_count: Schema.Number,
});

/**
 * The whole role vocabulary with tag counts.
 *
 * PURE JUDGMENT: both halves live in the sidecar, so this needs no cache and no
 * snapshot at all. That is what lets `ax roles` answer on a machine that has
 * never run an ingest - see roles-daemonless.test.ts, which runs it with no
 * DB reachable at all.
 *
 * `LEFT JOIN`, so a role that exists but has been tagged on nothing reports 0
 * rather than vanishing - the v1 correlated subquery had that property and it is
 * easy to lose when a subquery becomes a join.
 */
export const fetchAllRoles = (): Effect.Effect<FetchAllRolesResult, RoleQueryError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const rows = yield* judgment.rows(
            AllRolesRow,
            `SELECT r.name AS name, r.weight AS weight, count(DISTINCT pr.in_id) AS skill_count
             FROM role r
             LEFT JOIN plays_role pr ON pr.out_id = r.id
             GROUP BY r.id, r.name, r.weight
             ORDER BY skill_count DESC, r.name ASC`,
        );
        return { rows: [...rows] };
    });
