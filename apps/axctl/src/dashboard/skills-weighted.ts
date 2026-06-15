/**
 * P3.6: ax skills weighted - pure data layer.
 *
 * Fetches per-skill invocation counts and role weights via two-pass approach
 * (SurrealDB v3 GROUP BY + role lookup merge in JS) and returns rows ranked
 * by score = invocations × role_weight_sum (min 1.0).
 *
 * Also runs a doctor query to count unclassified skills with ≥3 invocations.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { fetchSparSessionIds } from "../queries/spar-sessions.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeightedSkillRow {
    readonly skill_id: string;
    readonly skill_name: string;
    readonly invocations: number;
    readonly session_count: number;
    readonly roles: readonly string[];
    readonly weight: number;
    readonly score: number;
}

export interface DoctorResult {
    readonly unclassified_count: number;
    readonly threshold: number;
    readonly advice: string | null;
}

export interface SkillsWeightedResult {
    readonly rows: readonly WeightedSkillRow[];
    readonly doctor: DoctorResult;
}

export interface SkillsWeightedParams {
    readonly windowDays?: number;
    readonly limit?: number;
    readonly doctorThreshold?: number;
    /**
     * Include synthetic provider built-in tools (codex/pi/opencode/cursor tool
     * calls, written as skill rows with `dir_path = '(synthetic)'`). Default
     * false: these are tool invocations, not skills, and otherwise dominate and
     * bury the real skill ranking.
     */
    readonly includeTools?: boolean;
}

/** Shared defaults for the weighted-skills ranking (CLI + MCP). */
export const SKILLS_WEIGHTED_DEFAULT_LIMIT = 25;
export const SKILLS_WEIGHTED_DEFAULT_DOCTOR_THRESHOLD = 5;

/**
 * Transport-agnostic raw input. The CLI flag parser and the MCP zod handler
 * decode into this then call {@link normalizeSkillsWeightedParams} so the
 * limit/doctor-threshold/includeTools defaults live in one place.
 *
 * Positivity validation of `limit`, `windowDays`, and `doctorThreshold` stays
 * in the transports (CLI `requirePositiveInt`/`requireOptionalPositiveInt`
 * exit 2; MCP zod `.positive()` rejects at the edge); this only fills defaults
 * + presence rules.
 */
export interface SkillsWeightedQueryArgs {
    readonly windowDays?: number | undefined;
    readonly limit?: number | undefined;
    readonly doctorThreshold?: number | undefined;
    readonly includeTools?: boolean | undefined;
}

export const normalizeSkillsWeightedParams = (
    args: SkillsWeightedQueryArgs,
): SkillsWeightedParams => ({
    ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
    limit:
        typeof args.limit === "number" && Number.isFinite(args.limit)
            ? args.limit
            : SKILLS_WEIGHTED_DEFAULT_LIMIT,
    doctorThreshold:
        typeof args.doctorThreshold === "number" &&
        Number.isFinite(args.doctorThreshold)
            ? args.doctorThreshold
            : SKILLS_WEIGHTED_DEFAULT_DOCTOR_THRESHOLD,
    includeTools: args.includeTools ?? false,
});

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Pass 1: per-skill invocation aggregates from the invoked edge table.
 * GROUP BY out gives us count + distinct sessions. We avoid correlated
 * subqueries per row (perf lesson from cmdTaste issue #31).
 *
 * Tombstone exclusion deliberately does NOT live in this WHERE clause.
 * `out.deleted_at IS NONE` dereferences the skill record for every invoked
 * edge; combined with the `in.session` deref in the SELECT, the planner walks
 * both graph edges per row and the query hangs past 120s on a populated graph
 * (87k+ invoked edges - the timeout the Pi dogfood hit, 2026-06-04). Instead we
 * fetch the small set of tombstoned skill ids once (DELETED_SKILLS_SQL) and
 * filter them out in JS during the merge.
 */
function buildInvocationSql(windowDays: number | undefined): string {
    const conditions: string[] = [];
    if (windowDays !== undefined && windowDays > 0) {
        conditions.push(`ts >= time::now() - ${windowDays}d`);
    }
    // Exclude spar variant sessions using a flat NOT IN against the denormalized
    // `session` field on `invoked` (no graph deref - safe on 87k+ edges).
    // $sparSessions is bound as a RecordId[] (NOT a string[]) so the comparison
    // is record-vs-record: `record<session> NOT IN [<string>...]` is always TRUE
    // (excludes nothing) - the string IN-list silently matches nothing
    // (see apps/axctl/src/context/file-context.ts:647-651). Verified on the live
    // DB: RecordId[] excludes correctly; string[] excludes 0 of 31,734 rows.
    // When $sparSessions is empty, NOT IN [] excludes nothing (intended).
    conditions.push(`session NOT IN $sparSessions`);
    const whereClause = `WHERE ${conditions.join("\n  AND ")}\n`;
    return `
SELECT
    out AS skill_id,
    count() AS invocations,
    array::len(array::distinct(in.session)) AS session_count
FROM invoked
${whereClause}GROUP BY skill_id;`.trim();
}

/**
 * Tombstoned (reconcile soft-deleted) skill ids. The skill table is small, so
 * this direct field-filter scan is cheap - no graph derefs. Used to drop ghost
 * skills from the ranking in JS instead of via a per-edge WHERE deref.
 */
const DELETED_SKILLS_SQL = `SELECT VALUE id FROM skill WHERE deleted_at IS NOT NONE;`;

/**
 * Pass 2: per-skill role names + weights from plays_role edges.
 * Returns one row per skill that has at least one plays_role edge with the
 * qualifying sources. Skills with no rows get weight 1.0 in the merge step.
 */
const ROLE_WEIGHT_SQL = `
SELECT
    in AS skill_id,
    out.name AS role_name,
    math::max([weight ?? out.weight ?? 1.0, 1.0]) AS effective_weight
FROM plays_role
WHERE source IN ["frontmatter", "brief", "user"];`.trim();

/**
 * skill id -> display name. The record id is mangled (`skill:v2__<name>__<hash>`),
 * so derive the readable label from the `name` field instead. Small table,
 * direct scan, no derefs.
 */
const SKILL_NAMES_SQL = `SELECT id, name FROM skill`;

/**
 * Doctor query: count unclassified skills with >= 3 invocations.
 * Mirrors the predicate from src/cli/skills-classify.ts.
 *
 * NON-correlated by construction: the original per-skill subqueries
 * (`... WHERE in = $parent.id`) ran two graph lookups for every skill row,
 * making this O(skills × edges) - it hung `ax skills weighted` past 120s on a
 * populated graph (Pi dogfood, 2026-06-04). Here the invocation GROUP BY and
 * the classified-skill set each evaluate once, then a single set-difference.
 */
/**
 * Synthetic provider built-in tool skill ids. These rows are written by the
 * codex/pi/opencode/cursor ingest with `dir_path = '(synthetic)'` so tool usage
 * is trackable, but they are tool calls, not skills. The skill table is small,
 * so this direct field-filter scan is cheap - no graph derefs. Used both as a
 * subquery (doctor) and to drop tools from the ranking in JS.
 */
const SYNTHETIC_SKILLS_SQL = `SELECT VALUE id FROM skill WHERE dir_path = "(synthetic)"`;

function buildUnclassifiedSql(includeTools: boolean): string {
    // Exclude synthetic provider tools from the doctor count too, unless the
    // caller asked for them - otherwise "N unclassified skills" is dominated by
    // codex/pi tool calls that can never carry a role.
    const toolClause = includeTools
        ? ""
        : `\n    AND sid NOT IN (${SYNTHETIC_SKILLS_SQL})`;
    return `
SELECT count() AS n FROM (
    SELECT out AS sid, count() AS c FROM invoked GROUP BY sid
)
WHERE c >= 3
    AND sid NOT IN (SELECT VALUE in FROM plays_role WHERE source IN ["frontmatter", "brief", "user"])${toolClause}
GROUP ALL;`.trim();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export const fetchSkillsWeighted = (
    params: SkillsWeightedParams = {},
): Effect.Effect<SkillsWeightedResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = params.limit ?? SKILLS_WEIGHTED_DEFAULT_LIMIT;
        const doctorThreshold =
            params.doctorThreshold ?? SKILLS_WEIGHTED_DEFAULT_DOCTOR_THRESHOLD;
        const includeTools = params.includeTools ?? false;

        // Fetch spar variant session ids first (flat, deref-free).
        // RecordId[] (NOT string[]) - bound as $sparSessions so the NOT IN
        // comparison is record-vs-record and actually excludes spar traffic.
        const sparSessions = yield* fetchSparSessionIds();

        // Run passes + doctor + tombstone + synthetic-tool id queries concurrently.
        const [invRes, roleRes, doctorRes, deletedRes, toolRes, nameRes] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(
                    buildInvocationSql(params.windowDays),
                    { sparSessions: [...sparSessions] },
                ),
                db.query<[Array<Record<string, unknown>>]>(ROLE_WEIGHT_SQL),
                db.query<[Array<Record<string, unknown>>]>(
                    buildUnclassifiedSql(includeTools),
                ),
                db.query<[Array<unknown>]>(DELETED_SKILLS_SQL),
                db.query<[Array<unknown>]>(SYNTHETIC_SKILLS_SQL),
                db.query<[Array<Record<string, unknown>>]>(SKILL_NAMES_SQL),
            ],
            { concurrency: 6 },
        );

        // skill id -> readable name (from the `name` field, not the mangled id).
        const skillNames = new Map<string, string>();
        for (const r of (nameRes?.[0] ?? []) as Array<Record<string, unknown>>) {
            const sid = String(r.id ?? "");
            const nm = typeof r.name === "string" ? r.name : "";
            if (sid && nm) skillNames.set(sid, nm);
        }

        // Synthetic provider tools (codex/pi/etc.) - excluded from the ranking
        // unless includeTools. Empty set when the caller opts in.
        const toolSkills = includeTools
            ? new Set<string>()
            : new Set(
                  ((toolRes?.[0] ?? []) as unknown[]).map((id) => String(id)),
              );

        // Tombstoned skill ids - excluded from ranking in JS (see
        // buildInvocationSql for why this isn't a per-edge WHERE deref).
        const deletedSkills = new Set(
            ((deletedRes?.[0] ?? []) as unknown[]).map((id) => String(id)),
        );

        // ---------------------------------------------------------------------------
        // Merge: per-skill role accumulation
        // ---------------------------------------------------------------------------

        // Build role map: skill_id -> { roles: string[], weight_sum: number }
        const roleMap = new Map<
            string,
            { roles: string[]; weightSum: number }
        >();
        for (const r of (roleRes?.[0] ?? []) as Array<Record<string, unknown>>) {
            const sid = String(r.skill_id ?? "");
            if (!sid) continue;
            const roleName = String(r.role_name ?? "");
            const ew = Number(r.effective_weight ?? 1.0);
            const entry = roleMap.get(sid);
            if (entry) {
                if (roleName && !entry.roles.includes(roleName)) {
                    entry.roles.push(roleName);
                }
                entry.weightSum += ew;
            } else {
                roleMap.set(sid, {
                    roles: roleName ? [roleName] : [],
                    weightSum: ew,
                });
            }
        }

        // Build rows from invocation aggregates
        const rows: WeightedSkillRow[] = [];
        for (const r of (invRes?.[0] ?? []) as Array<Record<string, unknown>>) {
            const skillId = String(r.skill_id ?? "");
            if (!skillId) continue;
            // Drop ghost (reconcile soft-deleted) skills - the tombstone filter
            // that used to live in the pass-1 WHERE clause as a per-edge deref.
            if (deletedSkills.has(skillId)) continue;
            // Drop synthetic provider built-in tools unless includeTools.
            if (toolSkills.has(skillId)) continue;

            // Prefer the real `name` field; fall back to stripping the record id
            // (handles "skill:⟨caveman⟩" / "skill:caveman"; the mangled
            // "skill:v2__name__hash" form has no clean name to derive, hence the map).
            const skillName =
                skillNames.get(skillId) ??
                skillId
                    .replace(/^skill:⟨/, "")
                    .replace(/⟩$/, "")
                    .replace(/^skill:/, "");

            const invocations = Number(r.invocations ?? 0);
            const sessionCount = Number(r.session_count ?? 0);

            const roleEntry = roleMap.get(skillId);
            const roles = roleEntry?.roles ?? [];
            // Weight = sum of role weights, floor at 1.0.
            const weightSum = roleEntry ? Math.max(roleEntry.weightSum, 1.0) : 1.0;
            const score = invocations * weightSum;

            rows.push({
                skill_id: skillId,
                skill_name: skillName,
                invocations,
                session_count: sessionCount,
                roles,
                weight: weightSum,
                score,
            });
        }

        // Sort by score DESC, then invocations DESC as tiebreaker
        rows.sort((a, b) => {
            const ds = b.score - a.score;
            if (ds !== 0) return ds;
            return b.invocations - a.invocations;
        });

        const topRows = rows.slice(0, limit);

        // ---------------------------------------------------------------------------
        // Doctor
        // ---------------------------------------------------------------------------

        const unclassifiedCount = Number(
            (doctorRes?.[0] as Array<Record<string, unknown>> | undefined)?.[0]?.n ?? 0,
        );

        const advice =
            unclassifiedCount >= doctorThreshold
                ? [
                      `${unclassifiedCount} skill${unclassifiedCount === 1 ? "" : "s"} (≥3 invocations) have no role classification.`,
                      "Their score uses neutral weight 1.0 - ranking may be noisy.",
                      "To classify:    axctl skills classify",
                      "Then:           edit .ax/tasks/classify-*.md  →  axctl skills lint",
                  ].join("\n")
                : null;

        return {
            rows: topRows,
            doctor: {
                unclassified_count: unclassifiedCount,
                threshold: doctorThreshold,
                advice,
            },
        };
    });
