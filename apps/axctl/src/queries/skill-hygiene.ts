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

const SQL = `
SELECT out AS sid, count() AS invocations FROM invoked GROUP BY sid;
SELECT id, name, dir_path FROM skill;
SELECT VALUE in FROM plays_role WHERE source IN ["frontmatter", "brief", "user"];
`;

// ---------------------------------------------------------------------------
// Helper: stringify any SurrealDB record id or value
// ---------------------------------------------------------------------------

const rid = (v: unknown): string => String(v);

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const fetchSkillHygiene = Effect.fn("queries.fetchSkillHygiene")(function* (
    input: SkillHygieneInput,
) {
    const db = yield* SurrealClient;
    const [counts, skills, classified] = yield* db.query<[
        Array<{ sid: unknown; invocations: number }>,
        Array<{ id: unknown; name: string; dir_path: string | null }>,
        Array<unknown>,
    ]>(SQL);

    // Build lookup structures from the flat result sets
    const classifiedIds = new Set((classified ?? []).map(rid));
    const byId = new Map(
        (skills ?? []).map((s) => [rid(s.id), { name: s.name, dir_path: s.dir_path }]),
    );

    // Join, filter, collect
    const rows: SkillHygieneRow[] = [];
    for (const c of counts ?? []) {
        const sid = rid(c.sid);
        const skill = byId.get(sid);
        if (!skill) continue;                                  // no matching skill row
        if (skill.dir_path === "(synthetic)") continue;        // tool shims, not real skills
        if (classifiedIds.has(sid)) continue;                  // already tagged
        if (c.invocations < input.minInvocations) continue;   // below threshold
        rows.push({ name: skill.name, invocations: c.invocations });
    }

    rows.sort((a, b) => b.invocations - a.invocations);
    return rows.slice(0, input.limit);
});
