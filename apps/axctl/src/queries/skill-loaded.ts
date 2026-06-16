/**
 * Skill auto-load activations: read the `loaded` edge (written by the
 * `loaded-skills` ingest stage) so the activation signal it captures is
 * surfaced. These are skills pulled in by a subagent's `skills:` frontmatter -
 * activated WITHOUT a Skill-tool call, so they never appear in `invoked`-based
 * usage views. This is the read counterpart that makes that signal visible
 * (e.g. a skill reading `used=0` in `ax skills bloat` may be loaded heavily).
 *
 * Deref-free, two FLAT queries joined in JS (sibling idiom, skill-bloat.ts):
 *   (1) Aggregate activation counts from `loaded`, grouped by `out` (skill id).
 *   (2) Fetch skill rows (id, name, content_hash) for name resolution + dedup.
 *
 * Plugin-namespace twins are collapsed by content_hash (same SKILL.md = two
 * skill rows), summing activations and keeping the canonical (bare) name.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { dedupeByContentHash } from "./skill-dedupe.ts";

export interface SkillLoadedRow {
    readonly name: string;
    readonly activations: number;
}

export interface SkillLoadedInput {
    readonly limit: number;
}

interface LoadedRowWithHash extends SkillLoadedRow {
    readonly contentHash: string | null;
}

const SQL = `
SELECT type::string(out) AS sid, count() AS activations FROM loaded GROUP BY sid;
SELECT type::string(id) AS id, name, content_hash FROM skill;
`;

export const fetchSkillLoaded = Effect.fn("queries.fetchSkillLoaded")(function* (
    input: SkillLoadedInput,
) {
    const db = yield* SurrealClient;
    const [counts, skills] = yield* db.query<[
        Array<{ sid: string; activations: number }>,
        Array<{ id: string; name: string; content_hash: string | null }>,
    ]>(SQL);

    const byId = new Map(
        (skills ?? []).map((s) => [s.id, s]),
    );

    const rows: LoadedRowWithHash[] = [];
    for (const c of counts ?? []) {
        const skill = byId.get(c.sid);
        if (!skill) continue;
        rows.push({
            name: skill.name,
            activations: Number(c.activations ?? 0),
            contentHash: skill.content_hash,
        });
    }

    const deduped = dedupeByContentHash(
        rows,
        (r) => r.contentHash,
        (r) => r.name,
        (r, name) => ({ ...r, name }),
        (kept, dup) => ({ ...kept, activations: kept.activations + dup.activations }),
    );

    deduped.sort((a, b) => b.activations - a.activations);
    return deduped.slice(0, input.limit).map(({ contentHash: _ch, ...row }) => row);
});
