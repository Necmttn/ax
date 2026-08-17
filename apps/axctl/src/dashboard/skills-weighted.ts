/**
 * P3.6: ax skills weighted - pure data layer.
 *
 * Fetches per-skill invocation counts and role weights via two-pass approach
 * (GROUP BY + role lookup merge in JS) and returns rows ranked by
 * score = invocations × role_weight_sum (min 1.0).
 *
 * Also runs a doctor query to count unclassified skills with ≥3 invocations.
 *
 * PORT NOTES (Surreal -> DuckDB): the invocation aggregate, tombstone set, and
 * synthetic-tool set all move onto `CacheRead`. The spar-session exclusion
 * (`session NOT IN $sparSessions`) no longer needs the Surreal
 * record-vs-string binding workaround `fetchSparSessionIds` was built for -
 * DuckDB `session` is a plain VARCHAR, so the bare ids it returns bind
 * directly as an ordinary `NOT IN (?, ...)` list. The recovery-latency pass's
 * `in.session` turn deref became a real `JOIN turn`.
 */
import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { cacheRows, cacheRowsOrFail } from "@ax/lib/duckdb/query";
import { withinDaysClause, type Clause } from "@ax/lib/duckdb/clause";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import { fetchSparSessionIds } from "../queries/spar-sessions.ts";
import { enrichRowsWithTelemetryLatency } from "../queries/telemetry-rollup.ts";
import { fetchSkillHygiene, SKILL_HYGIENE_MIN_INVOCATIONS } from "../queries/skill-hygiene.ts";
import { fetchSkillRoleWeights } from "./role-queries.ts";

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
    /**
     * Median duration_ms of sessions where this skill appears in a `recovered_by`
     * edge (i.e. was used to recover from a failure). Source: `otel_log_event`.
     * null when the skill has no recovery telemetry.
     */
    readonly median_recovery_ms: number | null;
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
// Query row shapes
// ---------------------------------------------------------------------------

const InvocationRow = Schema.Struct({
    skill_id: Schema.String,
    invocations: NumberFromBigIntColumn,
    session_count: NumberFromBigIntColumn,
});

const IdRow = Schema.Struct({ id: Schema.String });
const NamedSkillRow = Schema.Struct({ id: Schema.String, name: Schema.String });
const RecoveryEdgeRow = Schema.Struct({ skill: Schema.String, session: Schema.NullOr(Schema.String) });

/**
 * Pass 1: per-skill invocation aggregates from the `invoked` table. Excludes
 * spar-variant sessions (`sparSessionIds`, bare session ids) and, when
 * `windowDays` is set, invocations older than the window.
 *
 * Tombstone exclusion deliberately does NOT live in this WHERE clause - a
 * dropped skill row would require a JOIN against `skill` per invocation row,
 * which is exactly the per-edge deref shape that hung `ax skills weighted`
 * past 120s on 87k+ invoked rows (Pi dogfood, 2026-06-04). Instead the small
 * set of tombstoned skill ids is fetched once and filtered out in JS below.
 */
const buildInvocationClause = (windowDays: number | undefined, sparSessionIds: ReadonlyArray<string>): Clause => {
    const parts: Clause[] = [];
    if (windowDays !== undefined && windowDays > 0) parts.push(withinDaysClause("ts", windowDays));
    if (sparSessionIds.length > 0) {
        parts.push({
            sql: `AND session NOT IN (${sparSessionIds.map(() => "?").join(", ")})`,
            params: [...sparSessionIds],
        });
    }
    return { sql: parts.map((p) => p.sql).join(" "), params: parts.flatMap((p) => [...p.params]) };
};

export const fetchSkillsWeighted = (
    params: SkillsWeightedParams = {},
): Effect.Effect<SkillsWeightedResult, CacheReadError | JudgmentError, CacheRead | Judgment> =>
    Effect.gen(function* () {
        const limit = params.limit ?? SKILLS_WEIGHTED_DEFAULT_LIMIT;
        const doctorThreshold =
            params.doctorThreshold ?? SKILLS_WEIGHTED_DEFAULT_DOCTOR_THRESHOLD;
        const includeTools = params.includeTools ?? false;

        // Fetch spar variant session ids first (Judgment sqlite). They come back
        // as bare session keys, which is exactly what `invoked.session` holds.
        const sparSessionIds = yield* fetchSparSessionIds();

        const where = buildInvocationClause(params.windowDays, sparSessionIds);

        // Run passes + doctor + tombstone + synthetic-tool id queries concurrently.
        const [invRows, roleRes, doctorRes, deletedRows, toolRows, nameRows] = yield* Effect.all(
            [
                cacheRowsOrFail(InvocationRow, {
                    sql: `SELECT out_id AS skill_id, count(*) AS invocations, count(DISTINCT session) AS session_count
                          FROM invoked
                          WHERE TRUE ${where.sql}
                          GROUP BY out_id`,
                    params: where.params,
                }),
                fetchSkillRoleWeights(),
                // Doctor count: the SAME source of truth `ax skills classify` uses,
                // so the nudge count exactly matches what classify will brief (#481).
                fetchSkillHygiene({
                    minInvocations: SKILL_HYGIENE_MIN_INVOCATIONS,
                    includeSynthetic: includeTools,
                }),
                cacheRowsOrFail(IdRow, { sql: "SELECT id FROM skill WHERE deleted_at IS NOT NULL", params: [] }),
                cacheRowsOrFail(IdRow, { sql: `SELECT id FROM skill WHERE dir_path = '(synthetic)'`, params: [] }),
                cacheRowsOrFail(NamedSkillRow, { sql: "SELECT id, name FROM skill", params: [] }),
            ],
            { concurrency: 6 },
        );

        // skill id -> readable name (from the `name` field, not the mangled id).
        const skillNames = new Map<string, string>();
        for (const r of nameRows) {
            if (r.id && r.name) skillNames.set(r.id, r.name);
        }

        // Synthetic provider tools (codex/pi/etc.) - excluded from the ranking
        // unless includeTools. Empty set when the caller opts in.
        const toolSkills = includeTools ? new Set<string>() : new Set(toolRows.map((r) => r.id));

        // Tombstoned skill ids - excluded from ranking in JS (see
        // buildInvocationClause for why this isn't a per-row JOIN).
        const deletedSkills = new Set(deletedRows.map((r) => r.id));

        // ---------------------------------------------------------------------------
        // Merge: per-skill role accumulation
        // ---------------------------------------------------------------------------

        // Build role map: skill_id -> { roles: string[], weight_sum: number }
        const roleMap = new Map<
            string,
            { roles: string[]; weightSum: number }
        >();
        for (const r of roleRes) {
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
        for (const r of invRows) {
            const skillId = r.skill_id;
            if (!skillId) continue;
            // Drop ghost (reconcile soft-deleted) skills - the tombstone filter
            // that used to live in the pass-1 WHERE clause as a per-edge deref.
            if (deletedSkills.has(skillId)) continue;
            // Drop synthetic provider built-in tools unless includeTools.
            if (toolSkills.has(skillId)) continue;

            // Prefer the real `name` field; fall back to the row id itself
            // (DuckDB skill ids are plain content-hashed keys, not a Surreal
            // record-id form, so there is no decoration left to strip).
            const skillName = skillNames.get(skillId) ?? skillId;

            const invocations = r.invocations;
            const sessionCount = r.session_count;

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
                median_recovery_ms: null, // filled in by the recovery pass below
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
        // Recovery latency pass (lens E) - separate batched queries, no per-row derefs
        //
        // The `recovered_by` edge points turn -> skill. Resolving turn -> session is
        // a single JOIN over the whole edge table, kept SEPARATE from the main
        // weighted aggregate (deref-free) to avoid the stacked-join hang that hit
        // the invoked-edge query on 87k+ rows.
        // ---------------------------------------------------------------------------

        const read = yield* CacheRead;
        const recoveryEdges = yield* cacheRows(
            RecoveryEdgeRow,
            {
                sql: `SELECT rb.out_id AS skill, t.session AS session
                      FROM recovered_by rb JOIN turn t ON t.id = rb.in_id`,
                params: [],
            },
            "skills-weighted.recovery_edges",
        );

        // Build Map<skillId, sessionId[]>
        const skillToSessions = new Map<string, string[]>();
        for (const r of recoveryEdges) {
            if (!r.skill || !r.session) continue;
            const list = skillToSessions.get(r.skill);
            if (list) {
                list.push(r.session);
            } else {
                skillToSessions.set(r.skill, [r.session]);
            }
        }

        // Collect unique session ids across all recovery skills
        const allRecoverySessions = [...new Set(
            [...skillToSessions.values()].flat(),
        )];

        const latencyRows = yield* enrichRowsWithTelemetryLatency(
            read,
            allRecoverySessions,
            (sid) => sid,
            (session, latency) => ({ session, duration_ms: latency?.duration_ms ?? null }),
        );
        const latencyBySession = new Map(
            latencyRows.map((row) => [row.session, row.duration_ms] as const),
        );

        // Compute per-skill median recovery duration
        const skillMedianMs = new Map<string, number | null>();
        for (const [skillId, sessionIds] of skillToSessions) {
            const durations: number[] = [];
            for (const sid of sessionIds) {
                const duration = latencyBySession.get(sid);
                if (duration != null) {
                    durations.push(duration);
                }
            }
            if (durations.length === 0) {
                skillMedianMs.set(skillId, null);
            } else {
                durations.sort((a, b) => a - b);
                const mid = Math.floor(durations.length / 2);
                const median =
                    durations.length % 2 === 0
                        ? ((durations[mid - 1]! + durations[mid]!) / 2)
                        : durations[mid]!;
                skillMedianMs.set(skillId, median);
            }
        }

        // Merge onto topRows (immutable: create new row objects)
        const finalRows = topRows.map((row) => ({
            ...row,
            median_recovery_ms: skillMedianMs.get(row.skill_id) ?? null,
        }));

        // ---------------------------------------------------------------------------
        // Doctor
        // ---------------------------------------------------------------------------

        // doctorRes is now the fetchSkillHygiene row set (same as classify); its
        // length IS the unclassified-with-≥3-invocations count.
        const unclassifiedCount = doctorRes.length;

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
            rows: finalRows,
            doctor: {
                unclassified_count: unclassifiedCount,
                threshold: doctorThreshold,
                advice,
            },
        };
    });
