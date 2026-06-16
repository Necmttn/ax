/**
 * Community compile core (profiles spec §3b), effect-free + runtime-agnostic so
 * it bundles into a Cloudflare Worker as cleanly as it runs under Bun.
 *
 * Given a registered-user list and an injectable gist fetcher, fetch each
 * profile gist, validate it through the effect-free decoder, drop invalid /
 * impersonating / absurd rows (reported, never silent), and emit deterministic
 * compiled JSON:
 *   leaderboard - boards: tokens, sessions, streak, cost
 *   skillStats  - { "<source>:<name>": { users, runs } }
 *   hookStats   - { "<hook>": { users } }
 *   state       - anonymized distributions
 *
 * The fetcher is injectable so callers choose transport (raw CDN + ETag cache
 * under Bun, plain fetch in the Worker) and tests stay pure.
 */
import { validateProfile, type CompiledProfile } from "./validate.ts";

export type { CompiledProfile } from "./validate.ts";

export interface RegisteredUser {
    readonly github: string;
    readonly gist_id: string;
    readonly joined: string;
}

export type GistFetcher = (
    gistId: string,
    owner: string,
) => Promise<{ profile: unknown; etag: string | null } | null>;

export interface BoardRow {
    readonly login: string;
    readonly value: number;
}

export interface CompiledOutput {
    readonly leaderboard: {
        readonly compiled_at: string;
        readonly window_days: number;
        readonly boards: {
            readonly tokens: BoardRow[];
            readonly sessions: BoardRow[];
            readonly streak: BoardRow[];
            readonly cost: BoardRow[];
        };
    };
    readonly skillStats: Record<string, { users: number; runs: number }>;
    readonly hookStats: Record<string, { users: number }>;
    readonly state: {
        readonly year: number;
        readonly users: number;
        readonly harness_mix: Record<string, number>;
        readonly skill_adoption: Record<string, number>;
        readonly model_share: Record<string, number>;
    };
    readonly dropped: Array<{ login: string; reason: "fetch-failed" | "invalid-profile" | "absurd-values" | "github-mismatch" }>;
}

const MAX_TOKENS = 100e9;
const MAX_SESSIONS = 50_000;

const sortBoard = (rows: BoardRow[]): BoardRow[] =>
    [...rows].sort((a, b) => b.value - a.value || a.login.localeCompare(b.login));

/**
 * Canonical "<source>:<name>" key for skill-stats. Plugin-namespaced skills
 * keep their plugin id INSIDE the name ("superpowers:brainstorming", source
 * "superpowers" - see rig.ts publicSkillName), so a naive `${source}:${name}`
 * doubled the prefix to "superpowers:superpowers:brainstorming". Dedupe it.
 */
export function skillStatKey(source: string, name: string): string {
    return name === source || name.startsWith(`${source}:`) ? name : `${source}:${name}`;
}

const sortedRecord = <V>(entries: Array<[string, V]>): Record<string, V> =>
    Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

export async function compileCommunity(
    users: ReadonlyArray<RegisteredUser>,
    fetchGist: GistFetcher,
    opts: { readonly now: string },
): Promise<CompiledOutput> {
    const profiles: Array<{ login: string; p: CompiledProfile }> = [];
    const dropped: CompiledOutput["dropped"] = [];

    for (const user of [...users].sort((a, b) => a.github.localeCompare(b.github))) {
        const fetched = await fetchGist(user.gist_id, user.github);
        if (fetched === null) {
            dropped.push({ login: user.github, reason: "fetch-failed" });
            continue;
        }
        let p: CompiledProfile;
        try {
            p = validateProfile(fetched.profile);
        } catch {
            dropped.push({ login: user.github, reason: "invalid-profile" });
            continue;
        }
        // Impersonation guard: the profile's github field must match the
        // registered login (case-insensitive; logins are canonical).
        if (p.github.toLowerCase() !== user.github.toLowerCase()) {
            dropped.push({ login: user.github, reason: "github-mismatch" });
            continue;
        }
        if (p.stats.tokens.total > MAX_TOKENS || p.stats.sessions > MAX_SESSIONS) {
            dropped.push({ login: user.github, reason: "absurd-values" });
            continue;
        }
        profiles.push({ login: user.github, p });
    }

    const board = (value: (p: CompiledProfile) => number | undefined): BoardRow[] =>
        sortBoard(
            profiles.flatMap(({ login, p }) => {
                const v = value(p);
                return v === undefined ? [] : [{ login, value: v }];
            }),
        );

    const skillAgg = new Map<string, { users: number; runs: number }>();
    const hookAgg = new Map<string, { users: number }>();
    const harnessMix = new Map<string, number>();
    const modelUsers = new Map<string, number>();
    for (const { p } of profiles) {
        for (const s of p.rig.skills) {
            const key = skillStatKey(s.source, s.name);
            const cur = skillAgg.get(key) ?? { users: 0, runs: 0 };
            skillAgg.set(key, { users: cur.users + 1, runs: cur.runs + s.runs });
        }
        for (const h of p.rig.hooks) {
            const cur = hookAgg.get(h) ?? { users: 0 };
            hookAgg.set(h, { users: cur.users + 1 });
        }
        for (const h of p.stats.harnesses) {
            harnessMix.set(h, (harnessMix.get(h) ?? 0) + 1);
        }
        for (const m of p.stats.models) {
            modelUsers.set(m.name, (modelUsers.get(m.name) ?? 0) + 1);
        }
    }

    return {
        leaderboard: {
            compiled_at: opts.now,
            window_days: 30,
            boards: {
                tokens: board((p) => p.stats.tokens.total),
                sessions: board((p) => p.stats.sessions),
                streak: board((p) => p.stats.streak_days),
                cost: board((p) => p.stats.cost_usd),
            },
        },
        skillStats: sortedRecord([...skillAgg.entries()]),
        hookStats: sortedRecord([...hookAgg.entries()]),
        state: {
            year: Number(opts.now.slice(0, 4)),
            users: profiles.length,
            harness_mix: sortedRecord([...harnessMix.entries()]),
            skill_adoption: sortedRecord([...skillAgg.entries()].map(([k, v]) => [k, v.users])),
            model_share: sortedRecord([...modelUsers.entries()]),
        },
        dropped,
    };
}
