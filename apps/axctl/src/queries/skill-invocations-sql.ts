/**
 * Single source of truth for the skill-lookup + invocations SQL scaffold
 * shared by `SKILL_STATS_SQL` (skill-stats.ts) and the two detail variants
 * (skill-detail.ts). Issue #247: these three queries used to duplicate the
 * `LET $s ... RETURN { skill, invocations: {...} }` block side-by-side, so a
 * change to the `invoked` edge model had to be applied in three places.
 *
 * The composer renders the shared scaffold; each query module passes its own
 * day windows (stats adds d90) and extra RETURN blocks (recent / daily /
 * evidence / recent_sessions). The basic/full detail split that protects the
 * TUI hot path stays in skill-detail.ts - this module only owns the shared
 * fragment.
 *
 * Bindings: $name (skill name) - same contract as before.
 */

export interface SkillInvocationsSqlOptions {
    /** Rolling-count day windows rendered as `d<N>` keys (e.g. [7, 30, 90]). */
    readonly windows: ReadonlyArray<number>;
    /**
     * Extra top-level RETURN blocks, each pre-rendered with its key and
     * 4-space indent (e.g. `    recent: (...)`), WITHOUT a trailing comma -
     * the composer joins them.
     */
    readonly blocks: ReadonlyArray<string>;
}

/**
 * Compose the skill+invocations query. Rendered text is byte-compatible with
 * the previous hand-written constants (characterization tests assert on the
 * exact substrings, incl. the aligned `d7:    array::len(...)` padding).
 */
export const skillWithInvocationsSql = ({
    windows,
    blocks,
}: SkillInvocationsSqlOptions): string => {
    const windowLines = windows
        .map(
            (days) =>
                `        ${`d${days}:`.padEnd(6)} array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - ${days}d)),`,
        )
        .join("\n");
    return `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
${windowLines}
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
${blocks.join(",\n")}
};`;
};
