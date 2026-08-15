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
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { dateField } from "@ax/lib/shared/row-fields";

const checkedDays = (days: number): number => {
    if (!Number.isInteger(days) || days <= 0) {
        throw new RangeError(`days must be a positive integer (got ${days})`);
    }
    return days;
};

/** Skills with ≥1 invocation inside the window - the "still active" set. */
export const UNUSED_RECENT_SQL = (days: number): string => {
checkedDays(days);
return `
SELECT out_id AS skill_id, count(*) AS recent
FROM invoked
WHERE ts > CURRENT_TIMESTAMP - (? * INTERVAL '1 day')
GROUP BY out_id;`;
};

/** Bulk per-skill totals + last_used over the whole edge table. */
export const UNUSED_SUMMARY_SQL = `
SELECT
    out_id AS skill_id,
    count(*) AS total_inv,
    max(ts) AS last_used
FROM invoked
GROUP BY out_id;`;

/** Cheap id → (name, scope) lookup, merged in TS. Tombstoned skills
 *  (deleted_at set) are excluded here - their old `invoked` edges survive
 *  deletion, so without this filter they'd resurface in the unused listing.
 *  Mirrors the never-invoked branch below. */
export const UNUSED_SKILL_ROWS_SQL = `SELECT id, name, scope FROM skill WHERE deleted_at IS NULL;`;

/** Skills with literally zero invocations don't show up in the GROUP BY
 *  scan; pull them straight from the skill table so the "never used" rows
 *  still appear. */
export const UNUSED_NEVER_INVOKED_SQL = `
SELECT s.name, s.scope FROM skill s
WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM invoked i WHERE i.out_id = s.id);`;

const RecentRow = Schema.Struct({ skill_id: Schema.String, recent: NumberFromBigIntColumn });
const SummaryRow = Schema.Struct({ skill_id: Schema.String, total_inv: NumberFromBigIntColumn, last_used: TimestampColumn });
const SkillRow = Schema.Struct({ id: Schema.String, name: Schema.String, scope: Schema.String });
const NeverRow = Schema.Struct({ name: Schema.String, scope: Schema.String });

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
export const normalizeLastUsed = (v: unknown): string | null => dateField({ v }, "v");

/** Display label for a normalized `last_used`: the ISO timestamp, or the
 *  shared "never" sentinel when the skill was never invoked. Lives at the
 *  query-module altitude so every consumer renders the same label instead
 *  of reconstructing it. */
export const formatLastUsed = (lastUsed: string | null): string => lastUsed ?? "never";

export interface UnusedScanRows {
    readonly recent: ReadonlyArray<Record<string, unknown>>;
    readonly summary: ReadonlyArray<Record<string, unknown>>;
    readonly skills: ReadonlyArray<Record<string, unknown>>;
    readonly neverInvoked: ReadonlyArray<Record<string, unknown>>;
}

/** Anti-join the recent-active set out of the bulk summary, drop orphan
 *  invocation groups (no skill row - matches the original FROM-skill
 *  behaviour; tombstoned skills fall out here too since the skill-rows scan
 *  excludes them), append never-invoked skills, sort by total then name. */
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

export const fetchUnusedSkills = Effect.fn("queries.fetchUnusedSkills")(
    function* (params: UnusedSkillsParams) {
        const [recent, summary, skills, neverInvoked] = yield* Effect.all(
            [
                cacheRows(RecentRow, { sql: UNUSED_RECENT_SQL(params.days), params: [checkedDays(params.days)] }, "unused skills recent"),
                cacheRows(SummaryRow, { sql: UNUSED_SUMMARY_SQL, params: [] }, "unused skills summary"),
                cacheRows(SkillRow, { sql: UNUSED_SKILL_ROWS_SQL, params: [] }, "unused skills catalog"),
                cacheRows(NeverRow, { sql: UNUSED_NEVER_INVOKED_SQL, params: [] }, "unused skills never"),
            ],
            { concurrency: 4 },
        );
        return mergeUnusedRows({
            recent,
            summary,
            skills,
            neverInvoked,
        });
    },
);
