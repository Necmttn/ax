// Pure derivation of the /u hero stat row. No JSX, no IO - unit-tested in
// hero.test.ts. stats.cost_usd is the spend TOTAL over window_days
// (apps/axctl/src/profile/render.ts: stats.cost_usd = cost.total_cost_usd
// for sinceDays: windowDays), so it is normalised to a 30-day month here to
// keep the headline comparable to aistack's monthly figure.
import type { ProfileV1 } from "./community";

export function monthlyUsd(total: number, windowDays: number): number {
    if (windowDays <= 0) return total;
    return (total * 30) / windowDays;
}

export interface Hero {
    readonly monthlyUsd?: number; // omitted on --no-cost profiles
    readonly models: number;
    readonly skills: number;
    readonly sessions: number;
    readonly provenance: string;
}

export function buildHero(p: ProfileV1): Hero {
    const sessions = p.stats.sessions;
    return {
        monthlyUsd: p.stats.cost_usd !== undefined
            ? monthlyUsd(p.stats.cost_usd, p.window_days)
            : undefined,
        models: p.stats.models.length,
        skills: p.rig.skills.length,
        sessions,
        provenance: p.stats.cost_usd !== undefined
            ? `measured from ${sessions.toLocaleString("en-US")} session${sessions === 1 ? "" : "s"} over ${p.window_days}d · not a screenshot`
            : `measured from ${sessions.toLocaleString("en-US")} session${sessions === 1 ? "" : "s"} over ${p.window_days}d`,
    };
}
