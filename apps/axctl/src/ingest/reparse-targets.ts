/**
 * reparse-targets: the user-facing name for "ignore the skip-unchanged
 * watermark and read these inputs again".
 *
 * Ingest is incremental - a transcript whose `(mtime,size)` still matches its
 * `ingest_file_state` mark is skipped entirely. That is right for steady-state
 * runs and WRONG after a parser change: the new parser never sees the old
 * files, so a fix that recovers previously-unparsed evidence (#743's blocked
 * hook fires) appears to do nothing on existing history.
 *
 * Each stage already honors an `AX_REDERIVE_*` env var for exactly this, but an
 * env var nobody can discover from `--help` is not a feature. This module is
 * the one place that maps a target NAME to its env var, so `ax ingest
 * --reparse=claude` and the underlying force switch cannot drift apart.
 */

/** Target name -> the env var whose "1" value forces that input to be re-read. */
export const REPARSE_TARGET_ENV = {
    claude: "AX_REDERIVE_CLAUDE",
    subagents: "AX_REDERIVE_SUBAGENTS",
    codex: "AX_REDERIVE_CODEX",
    pi: "AX_REDERIVE_PI",
    omp: "AX_REDERIVE_OMP",
    cursor: "AX_REDERIVE_CURSOR",
    git: "AX_REDERIVE_GIT",
    closure: "AX_REDERIVE_CLOSURE",
    pricing: "AX_REDERIVE_PRICING",
    metrics: "AX_REDERIVE_METRICS",
    analysis: "AX_REDERIVE_ANALYSIS",
    content: "AX_REDERIVE_CONTENT",
    "otel-spool": "AX_REDERIVE_OTEL_SPOOL",
} as const satisfies Record<string, string>;

export type ReparseTarget = keyof typeof REPARSE_TARGET_ENV;

/** Every target name, in the order `--help` and error text should list them. */
export const REPARSE_TARGETS = Object.keys(REPARSE_TARGET_ENV) as ReparseTarget[];

/** The wildcard accepted in place of a target list. */
export const REPARSE_ALL = "all";

/** Marks the whole ingest run as a memory-heavy reparse. */
export const REPARSE_ACTIVE_ENV = "AX_REPARSE_ACTIVE";

export interface ReparseSelection {
    /** Env vars to set to "1", deduped, in {@link REPARSE_TARGETS} order. */
    readonly envVars: ReadonlyArray<string>;
    /** Target names that matched, for the "re-reading X, Y" progress line. */
    readonly targets: ReadonlyArray<ReparseTarget>;
    /** Names that matched nothing - the caller turns these into a usage error. */
    readonly unknown: ReadonlyArray<string>;
}

/**
 * Resolve a `--reparse` value ("claude,git", "all", or "" for the bare flag,
 * which means all) into env vars.
 *
 * Unknown names are REPORTED, never silently dropped: a typo'd `--reparse=cluade`
 * that quietly ran a normal incremental ingest would look exactly like the bug
 * the user is trying to clear.
 */
export const resolveReparseTargets = (raw: string | undefined): ReparseSelection => {
    const requested = (raw ?? "")
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0);

    if (requested.length === 0 || requested.includes(REPARSE_ALL)) {
        return {
            envVars: REPARSE_TARGETS.map((t) => REPARSE_TARGET_ENV[t]),
            targets: REPARSE_TARGETS,
            unknown: [],
        };
    }

    const matched = new Set<ReparseTarget>();
    const unknown: string[] = [];
    for (const name of requested) {
        if ((REPARSE_TARGETS as string[]).includes(name)) matched.add(name as ReparseTarget);
        else unknown.push(name);
    }
    const targets = REPARSE_TARGETS.filter((t) => matched.has(t));
    return {
        envVars: targets.map((t) => REPARSE_TARGET_ENV[t]),
        targets,
        unknown,
    };
};

/**
 * Apply a selection by setting each env var to "1" on the given environment
 * (defaults to `process.env`). Stages read these when they build their
 * watermark, so this must run BEFORE the ingest starts.
 */
export const applyReparseSelection = (
    selection: ReparseSelection,
    env: Record<string, string | undefined> = process.env,
): void => {
    for (const name of selection.envVars) env[name] = "1";
    env[REPARSE_ACTIVE_ENV] = "1";
};
