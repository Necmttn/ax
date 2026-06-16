/**
 * Skill-hygiene candidates query: unclassified skills with ≥N invocations.
 *
 * Uses three FLAT queries joined in JS - no record derefs inside aggregates.
 * The `invoked` edge table has ~87k rows; stacking `out.name` derefs inside
 * a GROUP BY aggregate caused a production hang. Lesson documented in CLAUDE.md.
 *
 *   (1) Aggregate invocation + distinct-session counts from `invoked`, grouped
 *       by `out` (skill id). A single `in.session` deref is safe; the production
 *       hang was STACKED derefs (out.deleted_at + in.session) on 87k+ edges.
 *   (2) Fetch all skill rows (id, name, dir_path, content_hash) - small table.
 *   (3) Fetch classified skill ids via plays_role (user/frontmatter/brief sources).
 *
 * JS join steps:
 *   - Build byId map from (2)
 *   - Build classifiedIds set from (3)
 *   - For each count row in (1): skip synthetic (dir_path == "(synthetic)"),
 *     attach metadata + classified flag.
 *   - Collapse plugin-namespace twins by content_hash (same SKILL.md ingested as
 *     a user/bare row AND a project/namespaced row): sum invocations + sessions,
 *     keep the canonical (bare) name, treat the twin as classified if EITHER
 *     member is. See skill-dedupe.ts.
 *   - Drop classified + below-threshold, sort desc by invocations, apply limit.
 *
 * This is the SINGLE source of truth for "unclassified skill with ≥N
 * invocations". `ax skills classify` (default mode) and `ax skills weighted`'s
 * doctor count both consume it, so they can never disagree (regression: a
 * correlated `NOT (subquery)[0]` predicate in classify returned NONE - not
 * false - for unclassified skills, silently excluding every one of them, so
 * classify reported "none found" while weighted reported a positive count).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { dedupeByContentHash } from "./skill-dedupe.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Invocation threshold below which a skill is too rarely used to be worth a
 * classify brief. Shared by `ax skills classify` (default mode) and `ax skills
 * weighted`'s doctor count so the two surfaces agree on "unclassified".
 */
export const SKILL_HYGIENE_MIN_INVOCATIONS = 3;

export interface SkillHygieneRow {
    readonly name: string;
    readonly invocations: number;
    readonly sessions: number;
}

export interface SkillHygieneInput {
    readonly minInvocations: number;
    /** Max rows to return. Omit (or pass a non-positive value) for no cap. */
    readonly limit?: number;
    /**
     * Include synthetic provider built-in tools (codex/pi/opencode/cursor tool
     * calls, `dir_path = "(synthetic)"`). Default false - they can never carry a
     * role, so they only inflate the count. weighted's `--include-tools` maps onto
     * this so the doctor count and `skills classify` agree.
     */
    readonly includeSynthetic?: boolean;
}

// ---------------------------------------------------------------------------
// SQL - deref-free, three flat statements
// ---------------------------------------------------------------------------

// Record ids are coerced to strings IN SQL via type::string() (sibling idiom,
// dispatch-analytics.ts) - the SDK can return RecordId objects, and String()
// on those yields garbage that misses every JS map lookup.
// GROUP BY on the function-aliased field (sid) verified against the live
// SurrealDB 3 instance (127.0.0.1:8521) on 2026-06-12.
// Invocation counts are deliberately ALL-TIME (lifetime hygiene signal; no
// sinceDays window).
const SQL = `
SELECT type::string(out) AS sid, count() AS invocations, array::len(array::distinct(in.session)) AS sessions FROM invoked GROUP BY sid;
SELECT type::string(id) AS id, name, dir_path, content_hash FROM skill;
SELECT VALUE type::string(in) FROM plays_role WHERE source IN ["frontmatter", "brief", "user"];
`;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const fetchSkillHygiene = Effect.fn("queries.fetchSkillHygiene")(function* (
    input: SkillHygieneInput,
) {
    const db = yield* SurrealClient;
    const [counts, skills, classified] = yield* db.query<[
        Array<{ sid: string; invocations: number; sessions: number }>,
        Array<{ id: string; name: string; dir_path: string | null; content_hash: string | null }>,
        Array<string>,
    ]>(SQL);

    // Build lookup structures from the flat result sets
    const classifiedIds = new Set(classified ?? []);
    const byId = new Map(
        (skills ?? []).map((s) => [s.id, s]),
    );

    // Join each count row to its skill metadata (drop synthetic shims here unless
    // asked to keep them). Dedup is applied AFTER the join so a plugin-namespace
    // twin is treated as classified if EITHER member is, and its counts sum.
    interface Cand extends SkillHygieneRow {
        readonly contentHash: string | null;
        readonly classified: boolean;
    }
    const cand: Cand[] = [];
    for (const c of counts ?? []) {
        const skill = byId.get(c.sid);
        if (!skill) continue;                                  // no matching skill row
        if (!input.includeSynthetic && skill.dir_path === "(synthetic)") continue; // tool shims, not real skills
        cand.push({
            name: skill.name,
            invocations: Number(c.invocations ?? 0),
            sessions: Number(c.sessions ?? 0),
            contentHash: skill.content_hash,
            classified: classifiedIds.has(c.sid),
        });
    }

    const deduped = dedupeByContentHash(
        cand,
        (r) => r.contentHash,
        (r) => r.name,
        (r, name) => ({ ...r, name }),
        (kept, dup) => ({
            ...kept,
            invocations: kept.invocations + dup.invocations,
            sessions: kept.sessions + dup.sessions,
            classified: kept.classified || dup.classified,
        }),
    );

    // Filter: drop classified twins and below-threshold candidates.
    const rows: SkillHygieneRow[] = [];
    for (const r of deduped) {
        if (r.classified) continue;                            // already tagged
        if (r.invocations < input.minInvocations) continue;    // below threshold
        rows.push({ name: r.name, invocations: r.invocations, sessions: r.sessions });
    }

    rows.sort((a, b) => b.invocations - a.invocations);
    return input.limit && input.limit > 0 ? rows.slice(0, input.limit) : rows;
});
