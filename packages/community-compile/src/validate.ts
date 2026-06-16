/**
 * Effect-free profile validation for the community compile core.
 *
 * The canonical decoder lives in `apps/axctl/src/profile/schema.ts` and uses
 * Effect `Schema` - which cannot bundle into a Cloudflare Worker (and the site
 * deliberately stays effect-free too). This validator mirrors the subset of
 * ProfileV1 that the leaderboard compile actually reads, throwing on any shape
 * the boards would choke on, so a hostile gist can never produce a row.
 *
 * Keep in lockstep with the fields consumed in `compile.ts` - nothing more.
 */

/** The slice of a published ax profile the leaderboard compile depends on. */
export interface CompiledProfile {
    readonly github: string;
    readonly stats: {
        readonly sessions: number;
        readonly streak_days: number;
        readonly tokens: { readonly total: number };
        readonly cost_usd?: number;
        readonly models: ReadonlyArray<{ readonly name: string }>;
        readonly harnesses: readonly string[];
    };
    readonly rig: {
        readonly skills: ReadonlyArray<{ readonly name: string; readonly source: string; readonly runs: number }>;
        readonly hooks: readonly string[];
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`invalid ${what}`);
    return v;
};
const str = (v: unknown, what: string): string => {
    if (typeof v !== "string") throw new Error(`invalid ${what}`);
    return v;
};

/**
 * Validate untrusted gist JSON into a CompiledProfile, or throw. Only the
 * fields the boards read are checked; everything else on the profile is
 * ignored. Throws (never returns partial) so the caller drops the row as
 * `invalid-profile`.
 */
export function validateProfile(value: unknown): CompiledProfile {
    if (!isRecord(value) || value.v !== 1) throw new Error("not a v1 ax profile");
    const stats = value.stats;
    const rig = value.rig;
    if (!isRecord(stats) || !isRecord(rig)) throw new Error("profile missing stats/rig");
    const tokens = stats.tokens;
    if (!isRecord(tokens)) throw new Error("profile missing tokens");
    if (!Array.isArray(stats.models) || !Array.isArray(stats.harnesses)) throw new Error("invalid stats arrays");
    if (!Array.isArray(rig.skills) || !Array.isArray(rig.hooks)) throw new Error("invalid rig arrays");

    const github = str(value.github, "github");
    const sessions = num(stats.sessions, "sessions");
    const streak_days = num(stats.streak_days, "streak_days");
    const total = num(tokens.total, "tokens.total");
    const cost_usd = stats.cost_usd === undefined ? undefined : num(stats.cost_usd, "cost_usd");

    for (const h of stats.harnesses) str(h, "harness");
    for (const h of rig.hooks) str(h, "hook");

    const models = stats.models.map((m) => {
        if (!isRecord(m)) throw new Error("invalid model row");
        return { name: str(m.name, "model.name") };
    });
    const skills = rig.skills.map((s) => {
        if (!isRecord(s)) throw new Error("invalid skill row");
        return { name: str(s.name, "skill.name"), source: str(s.source, "skill.source"), runs: num(s.runs, "skill.runs") };
    });

    return {
        github,
        stats: {
            sessions,
            streak_days,
            tokens: { total },
            ...(cost_usd === undefined ? {} : { cost_usd }),
            models,
            harnesses: stats.harnesses as string[],
        },
        rig: { skills, hooks: rig.hooks as string[] },
    };
}
