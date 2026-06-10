/**
 * `ax skills unused`: skills with no invocations inside a recency window.
 *
 * PERF (issue #31): an earlier form ran a correlated subquery per skill
 * (`SELECT count() FROM invoked WHERE out = $parent.id AND ts > N`). On the
 * largest skill (~500k invoked edges) the index walk took ~1.5s × 137 skills.
 * Now we (a) compute the recent-active set in one full-scan GROUP BY over
 * `invoked`, (b) compute total_inv + last_used in bulk, (c) anti-join in TS.
 * Net round-trip: ~2 cheap queries.
 *
 * Issue #34: `out.name AS name` over a GROUP BY scan returns the per-edge
 * name array (~500k entries for codex:exec_command); String() of that is a
 * 17 MB single line. So we aggregate over the edge table only and look up
 * skill rows by id in a separate cheap query, merging in TS.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { dateField } from "@ax/lib/shared/row-fields";

const checkedDays = (days: number): number => {
    if (!Number.isInteger(days) || days <= 0) {
        throw new RangeError(`days must be a positive integer (got ${days})`);
    }
    return days;
};

/** Skills with ≥1 invocation inside the window - the "still active" set. */
export const UNUSED_RECENT_SQL = (days: number): string => `
SELECT out AS skill_id, count() AS recent
FROM invoked
WHERE ts > time::now() - ${checkedDays(days)}d
GROUP BY out;`;

/** Bulk per-skill totals + last_used over the whole edge table. */
export const UNUSED_SUMMARY_SQL = `
SELECT
    out AS skill_id,
    count() AS total_inv,
    math::max(ts) AS last_used
FROM invoked
GROUP BY out;`;

/** Cheap id → (name, scope) lookup, merged in TS. */
export const UNUSED_SKILL_ROWS_SQL = `SELECT id, name, scope FROM skill;`;

/** Skills with literally zero invocations don't show up in the GROUP BY
 *  scan; pull them straight from the skill table so the "never used" rows
 *  still appear. */
export const UNUSED_NEVER_INVOKED_SQL = `
SELECT name, scope FROM skill WHERE array::len(<-invoked) = 0 AND deleted_at IS NONE;`;

export interface UnusedSkillRow {
    readonly name: string;
    readonly scope: string;
    readonly total_inv: number;
    /** ISO timestamp of last use; `null` = never used. */
    readonly last_used: string | null;
}

/**
 * SurrealDB's math::max returns -Infinity for empty groups; normalise that
 * (and null/undefined) to `null`. Datetimes arrive as string, Date, or a
 * DateTime-like `{toJSON}` object depending on path - delegated to the shared
 * `dateField` extractor (string passthrough, Date/`{toJSON}` → ISO, anything
 * else → null).
 */
export const normalizeLastUsed = (v: unknown): string | null => {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    return dateField({ v }, "v");
};

export interface UnusedScanRows {
    readonly recent: ReadonlyArray<Record<string, unknown>>;
    readonly summary: ReadonlyArray<Record<string, unknown>>;
    readonly skills: ReadonlyArray<Record<string, unknown>>;
    readonly neverInvoked: ReadonlyArray<Record<string, unknown>>;
}

/** Anti-join the recent-active set out of the bulk summary, drop orphan
 *  invocation groups (no skill row - matches the original FROM-skill
 *  behaviour), append never-invoked skills, sort by total then name. */
export const mergeUnusedRows = (input: UnusedScanRows): UnusedSkillRow[] => {
    const recentIds = new Set<string>(
        input.recent.map((r) => String(r.skill_id ?? "")),
    );
    const skillById = new Map<string, { name: string; scope: string }>();
    for (const s of input.skills) {
        skillById.set(String(s.id ?? ""), {
            name: String(s.name ?? ""),
            scope: String(s.scope ?? ""),
        });
    }
    const unused: UnusedSkillRow[] = [];
    for (const r of input.summary) {
        const id = String(r.skill_id ?? "");
        if (recentIds.has(id)) continue;
        const meta = skillById.get(id);
        if (!meta || !meta.name) continue;
        unused.push({
            name: meta.name,
            scope: meta.scope,
            total_inv: Number(r.total_inv ?? 0),
            last_used: normalizeLastUsed(r.last_used),
        });
    }
    for (const r of input.neverInvoked) {
        unused.push({
            name: String(r.name ?? ""),
            scope: String(r.scope ?? ""),
            total_inv: 0,
            last_used: null,
        });
    }
    unused.sort(
        (a, b) => a.total_inv - b.total_inv || a.name.localeCompare(b.name),
    );
    return unused;
};

export interface UnusedSkillsParams {
    readonly days: number;
}

export const fetchUnusedSkills = (
    params: UnusedSkillsParams,
): Effect.Effect<ReadonlyArray<UnusedSkillRow>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [recentRes, summaryRes, skillRes, noInvRes] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(UNUSED_RECENT_SQL(params.days)),
                db.query<[Array<Record<string, unknown>>]>(UNUSED_SUMMARY_SQL),
                db.query<[Array<Record<string, unknown>>]>(UNUSED_SKILL_ROWS_SQL),
                db.query<[Array<Record<string, unknown>>]>(UNUSED_NEVER_INVOKED_SQL),
            ],
            { concurrency: 4 },
        );
        return mergeUnusedRows({
            recent: recentRes?.[0] ?? [],
            summary: summaryRes?.[0] ?? [],
            skills: skillRes?.[0] ?? [],
            neverInvoked: noInvRes?.[0] ?? [],
        });
    });
