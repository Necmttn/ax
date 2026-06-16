/**
 * Skill token-budget (bloat) query: installed skills whose body exceeds a
 * token budget.
 *
 * Motivation: the SkillOpt paper (arxiv 2605.23904) finds deployed self-tuned
 * skills converge to ~300-2,000 tokens - compactness is a feature, length is
 * not effort. This lens flags skills that have drifted past the upper band so
 * they can be trimmed. Tokens are estimated from the stored `bytes` column at
 * ~4 bytes/token (the same crude ratio used across the context-budget view);
 * no file reads required.
 *
 * Deref-free, two FLAT queries joined in JS (sibling idiom, skill-hygiene.ts -
 * stacking record derefs inside aggregates over the ~87k-row `invoked` edge
 * hangs production):
 *   (1) Fetch all skill rows (id, name, bytes, dir_path) - small table.
 *   (2) Aggregate invocation counts from `invoked`, grouped by `out` (skill id),
 *       to prioritise bloated-AND-used skills.
 *
 * JS join: estimate tokens from bytes, drop synthetic + null-bytes + under-budget,
 * attach invocation count, sort by estimated tokens desc, apply limit.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { dedupeByContentHash } from "./skill-dedupe.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillBloatRow {
    readonly name: string;
    readonly bytes: number;
    readonly estTokens: number;
    /** estTokens - budgetTokens (always > 0 for returned rows) */
    readonly overBy: number;
    /** all-time invocations (0 when the skill has never been invoked) */
    readonly invocations: number;
}

export interface SkillBloatInput {
    /** token ceiling; skills estimated above this are flagged */
    readonly budgetTokens: number;
    readonly limit: number;
}

// Crude bytes->tokens ratio, shared with the context-budget view.
const BYTES_PER_TOKEN = 4;
export const estimateTokens = (bytes: number): number =>
    Math.round(bytes / BYTES_PER_TOKEN);

// ---------------------------------------------------------------------------
// SQL - deref-free, two flat statements
// ---------------------------------------------------------------------------

const SQL = `
SELECT type::string(id) AS id, name, bytes, dir_path, content_hash FROM skill;
SELECT type::string(out) AS sid, count() AS invocations FROM invoked GROUP BY sid;
`;

// Internal row carrying the content hash needed for plugin-namespace dedup.
interface BloatRowWithHash extends SkillBloatRow {
    readonly contentHash: string | null;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const fetchSkillBloat = Effect.fn("queries.fetchSkillBloat")(function* (
    input: SkillBloatInput,
) {
    const db = yield* SurrealClient;
    const [skills, counts] = yield* db.query<[
        Array<{ id: string; name: string; bytes: number | null; dir_path: string | null; content_hash: string | null }>,
        Array<{ sid: string; invocations: number }>,
    ]>(SQL);

    const invById = new Map(
        (counts ?? []).map((c) => [c.sid, Number(c.invocations ?? 0)]),
    );

    const rows: BloatRowWithHash[] = [];
    for (const s of skills ?? []) {
        if (s.dir_path === "(synthetic)") continue;        // tool shims, not real skills
        if (s.bytes == null) continue;                     // un-ingested body size
        const bytes = Number(s.bytes);
        const estTokens = estimateTokens(bytes);
        if (estTokens <= input.budgetTokens) continue;     // within budget
        rows.push({
            name: s.name,
            bytes,
            estTokens,
            overBy: estTokens - input.budgetTokens,
            invocations: invById.get(s.id) ?? 0,
            contentHash: s.content_hash,
        });
    }

    // Collapse plugin-namespace twins (same file -> two skill rows): keep the
    // bare name, sum invocations across the twins so usage isn't split.
    const deduped = dedupeByContentHash(
        rows,
        (r) => r.contentHash,
        (r) => r.name,
        (r, name) => ({ ...r, name }),
        (kept, dup) => ({ ...kept, invocations: kept.invocations + dup.invocations }),
    );

    deduped.sort((a, b) => b.estTokens - a.estTokens);
    return deduped.slice(0, input.limit).map(({ contentHash: _ch, ...row }) => row);
});
