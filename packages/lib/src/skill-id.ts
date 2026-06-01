import { legacySkillRecordKey as legacyKey, skillRecordKeyV2 } from "./ids.ts";

export function skillRecordKey(name: string): string {
    return skillRecordKeyV2(name);
}

export function legacySkillRecordKey(name: string): string {
    return legacyKey(name);
}

export function skillRecordLookupKeys(name: string): string[] {
    const modern = skillRecordKey(name);
    const legacy = legacySkillRecordKey(name);
    return modern === legacy ? [modern] : [modern, legacy];
}

/**
 * Resolve a skill name *as recorded on an invocation* to the canonical name
 * of a real catalog skill.
 *
 * The Skill tool records the invoked skill under inconsistent forms across
 * harness versions and providers:
 *  - bare:          `subagent-driven-development`
 *  - plugin-spaced: `superpowers:subagent-driven-development`
 *  - slash-command: `codex-rescue` / `codex:codex-rescue` for `codex:rescue`
 *
 * `ingestSkills` re-namespaces plugin skills to `<plugin>:<name>`, so a bare
 * invocation never matches and a ghost `scope='unknown'` row gets minted -
 * splitting one skill's usage across two rows. This maps an invoked name back
 * onto the catalog so the `invoked` edge attaches to the real skill.
 *
 * `catalog` is the set of real (on-disk) skill/command names. Returns the
 * matched canonical name, or `null` when there is no single confident match
 * (the caller then keeps a placeholder - a genuinely unknown skill).
 */
export function resolveSkillName(
    invoked: string,
    catalog: ReadonlySet<string>,
): string | null {
    if (catalog.has(invoked)) return invoked;
    const catalogList = [...catalog];

    const tryOne = (cand: string): string | null => {
        if (catalog.has(cand)) return cand;
        // Plugin re-namespacing: a bare `X` is the canonical `<plugin>:X`.
        // Only resolve when exactly one catalog skill ends with `:X` so an
        // ambiguous bare name stays a placeholder rather than mis-attaching.
        const suffix = catalogList.filter((real) => real.endsWith(`:${cand}`));
        return suffix.length === 1 ? (suffix[0] as string) : null;
    };

    // Build candidate forms, most-faithful first. A Set keeps insertion order
    // and dedups.
    const candidates = new Set<string>([invoked]);
    // `codex:codex-rescue` -> also try the segment after the first colon.
    const colon = invoked.indexOf(":");
    if (colon > 0 && colon < invoked.length - 1) {
        candidates.add(invoked.slice(colon + 1));
    }
    // A bare slash-command form folds its first hyphen back to the namespace
    // colon: `codex-rescue` -> `codex:rescue`.
    for (const cand of [...candidates]) {
        if (cand.includes(":")) continue;
        const hyphen = cand.indexOf("-");
        if (hyphen > 0 && hyphen < cand.length - 1) {
            candidates.add(`${cand.slice(0, hyphen)}:${cand.slice(hyphen + 1)}`);
        }
    }

    for (const cand of candidates) {
        const hit = tryOne(cand);
        if (hit) return hit;
    }
    return null;
}
