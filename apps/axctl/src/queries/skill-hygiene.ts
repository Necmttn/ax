/**
 * Skill-hygiene candidates query: unclassified skills with ≥N invocations.
 *
 * Uses three FLAT queries joined in JS - no record derefs inside aggregates.
 * The `invoked` edge table has ~87k rows; stacking `out.name` derefs inside
 * a GROUP BY aggregate caused a production hang. Lesson documented in CLAUDE.md.
 *
 *   (1) Aggregate invocation counts from `invoked`, grouped by `out` (skill id).
 *   (2) Fetch all skill rows (id, name, dir_path) - small table, full scan fine.
 *   (3) Fetch classified skill ids via plays_role (user/frontmatter/brief sources).
 *
 * JS join steps:
 *   - Build byId map from (2)
 *   - Build classifiedIds set from (3)
 *   - For each count row in (1): skip synthetic (dir_path == "(synthetic)"),
 *     skip classified, skip below threshold, then push to results.
 *   - Sort desc by invocations, apply limit.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { dedupeByContentHash } from "./skill-dedupe.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillHygieneRow {
    readonly name: string;
    readonly invocations: number;
}

export interface SkillHygieneInput {
    readonly minInvocations: number;
    readonly limit: number;
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
SELECT type::string(out) AS sid, count() AS invocations FROM invoked GROUP BY sid;
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
        Array<{ sid: string; invocations: number }>,
        Array<{ id: string; name: string; dir_path: string | null; content_hash: string | null }>,
        Array<string>,
    ]>(SQL);

    // Build lookup structures from the flat result sets
    const classifiedIds = new Set(classified ?? []);
    const byId = new Map(
        (skills ?? []).map((s) => [s.id, s]),
    );

    // Join each count row to its skill metadata (drop synthetic shims here).
    // Dedup is applied AFTER the join so a plugin-namespace twin is treated as
    // classified if EITHER member is classified, and its invocations sum.
    interface Cand extends SkillHygieneRow {
        readonly contentHash: string | null;
        readonly classified: boolean;
    }
    const cand: Cand[] = [];
    for (const c of counts ?? []) {
        const skill = byId.get(c.sid);
        if (!skill) continue;                                  // no matching skill row
        if (skill.dir_path === "(synthetic)") continue;        // tool shims, not real skills
        cand.push({
            name: skill.name,
            invocations: Number(c.invocations ?? 0),
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
            classified: kept.classified || dup.classified,
        }),
    );

    // Filter: drop classified twins and below-threshold candidates.
    const rows: SkillHygieneRow[] = [];
    for (const r of deduped) {
        if (r.classified) continue;                            // already tagged
        if (r.invocations < input.minInvocations) continue;    // below threshold
        rows.push({ name: r.name, invocations: r.invocations });
    }

    rows.sort((a, b) => b.invocations - a.invocations);
    return rows.slice(0, input.limit);
});
