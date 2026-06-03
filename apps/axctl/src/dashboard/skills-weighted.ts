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
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Pass 1: per-skill invocation aggregates from the invoked edge table.
 * GROUP BY out gives us count + distinct sessions. We avoid correlated
 * subqueries per row (perf lesson from cmdTaste issue #31).
 */
function buildInvocationSql(windowDays: number | undefined): string {
    // Exclude tombstoned skills (reconcile soft-delete) so ranking drops ghosts.
    const conds = ["out.deleted_at IS NONE"];
    if (windowDays !== undefined && windowDays > 0) {
        conds.push(`ts >= time::now() - ${windowDays}d`);
    }
    const whereClause = `WHERE ${conds.join(" AND ")}`;
    return `
SELECT
    out AS skill_id,
    count() AS invocations,
    array::len(array::distinct(in.session)) AS session_count
FROM invoked
${whereClause}
GROUP BY skill_id;`.trim();
}

/**
 * Pass 2: per-skill role names + weights from plays_role edges.
 * Returns one row per skill that has at least one plays_role edge with the
 * qualifying sources. Skills with no rows get weight 1.0 in the merge step.
 */
const ROLE_WEIGHT_SQL = `
SELECT
    in AS skill_id,
    out.name AS role_name,
    math::max([weight ?? out.weight, 1.0]) AS effective_weight
FROM plays_role
WHERE source IN ["frontmatter", "brief", "user"];`.trim();

/**
 * Doctor query: count unclassified skills with >= 3 invocations.
 * Mirrors the predicate from src/cli/skills-classify.ts.
 */
const UNCLASSIFIED_COUNT_SQL = `
SELECT count() AS n FROM skill
WHERE
    NOT (SELECT id FROM plays_role WHERE in = $parent.id AND source IN ["frontmatter", "brief", "user"])[0]
    AND array::len((SELECT id FROM invoked WHERE out = $parent.id)) >= 3;`.trim();

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export const fetchSkillsWeighted = (
    params: SkillsWeightedParams = {},
): Effect.Effect<SkillsWeightedResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = params.limit ?? 25;
        const doctorThreshold = params.doctorThreshold ?? 5;

        // Run both passes + doctor query concurrently.
        const [invRes, roleRes, doctorRes] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(
                    buildInvocationSql(params.windowDays),
                ),
                db.query<[Array<Record<string, unknown>>]>(ROLE_WEIGHT_SQL),
                db.query<[Array<Record<string, unknown>>]>(UNCLASSIFIED_COUNT_SQL),
            ],
            { concurrency: 3 },
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

            // Derive a human-readable name from the record id string.
            // SurrealDB returns skill_id as e.g. "skill:⟨caveman⟩" or
            // "skill:caveman". Strip the prefix/brackets.
            const skillName = skillId
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
