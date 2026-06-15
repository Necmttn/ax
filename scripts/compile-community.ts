// scripts/compile-community.ts
/**
 * Nightly community compile (profiles spec §3b): walk community/users/,
 * fetch each registered gist's ax-profile.json, validate through the
 * canonical ProfileV1 decoder, drop invalid/absurd rows (reported, never
 * silent), and emit deterministic compiled JSON:
 *   community/leaderboard.json   - boards: tokens, sessions, streak, cost
 *   community/skill-stats.json   - { "<source>:<name>": { users, runs } }
 *   community/hook-stats.json    - { "<hook>": { users } }
 *   community/state/<year>.json  - anonymized distributions
 * Fetcher is injectable for tests; the CLI entry uses fetch() with an ETag
 * cache so unchanged gists cost a 304.
 */
import { decodeProfile, type ProfileV1 } from "../apps/axctl/src/profile/schema.ts";

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
    const profiles: Array<{ login: string; p: ProfileV1 }> = [];
    const dropped: CompiledOutput["dropped"] = [];

    for (const user of [...users].sort((a, b) => a.github.localeCompare(b.github))) {
        const fetched = await fetchGist(user.gist_id, user.github);
        if (fetched === null) {
            dropped.push({ login: user.github, reason: "fetch-failed" });
            continue;
        }
        let p: ProfileV1;
        try {
            p = decodeProfile(fetched.profile);
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

    const board = (value: (p: ProfileV1) => number | undefined): BoardRow[] =>
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

// ---------------------------------------------------------------------------
// CLI entry: read users dir, fetch via HTTP with ETag cache, write outputs.
// ---------------------------------------------------------------------------

/**
 * Fetch the gist's ax-profile.json via the PUBLIC raw URL, unauthenticated.
 * Deliberately NOT api.github.com: the Actions GITHUB_TOKEN is an
 * installation token with no gist scope, so authenticated /gists/:id calls
 * 404 in CI (live finding, first compile run). The raw CDN endpoint needs
 * no auth, has no meaningful rate limit, and never truncates.
 */
const liveFetcher = (cache: Record<string, { etag: string; profile: unknown }>): GistFetcher =>
    async (gistId, owner) => {
        try {
            const cached = cache[gistId];
            const res = await fetch(
                `https://gist.githubusercontent.com/${owner}/${gistId}/raw/ax-profile.json`,
                { headers: { ...(cached ? { "if-none-match": cached.etag } : {}) } },
            );
            if (res.status === 304 && cached) return { profile: cached.profile, etag: cached.etag };
            if (!res.ok) return null;
            const profile: unknown = await res.json();
            const etag = res.headers.get("etag");
            if (etag) cache[gistId] = { etag, profile };
            return { profile, etag };
        } catch {
            return null;
        }
    };

// GitHub login charset: 1–39 alphanumeric/hyphen chars; gist IDs are hex.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const GIST_ID_RE = /^[a-f0-9]+$/i;

if (import.meta.main) {
    const usersDir = "community/users";
    const glob = new Bun.Glob("*.json");
    const users: RegisteredUser[] = [];
    for await (const name of glob.scan({ cwd: usersDir })) {
        const raw: unknown = JSON.parse(await Bun.file(`${usersDir}/${name}`).text());
        const r = raw as Record<string, unknown>;
        const github = String(r.github);
        const gist_id = String(r.gist_id);
        if (!GITHUB_LOGIN_RE.test(github)) {
            console.log(`[warn] skipping ${name}: invalid github login "${github}"`);
            continue;
        }
        if (!GIST_ID_RE.test(gist_id)) {
            console.log(`[warn] skipping ${name}: invalid gist_id "${gist_id}"`);
            continue;
        }
        users.push({ github, gist_id, joined: String(r.joined) });
    }

    const cachePath = "community/.gist-etag-cache.json";
    let cache: Record<string, { etag: string; profile: unknown }> = {};
    try {
        cache = JSON.parse(await Bun.file(cachePath).text());
    } catch {
        // first run / corrupt cache: full fetch
    }

    const out = await compileCommunity(users, liveFetcher(cache), { now: new Date().toISOString() });

    const year = new Date().getUTCFullYear();
    await Bun.write("community/leaderboard.json", `${JSON.stringify(out.leaderboard, null, 2)}\n`);
    await Bun.write("community/skill-stats.json", `${JSON.stringify(out.skillStats, null, 2)}\n`);
    await Bun.write("community/hook-stats.json", `${JSON.stringify(out.hookStats, null, 2)}\n`);
    await Bun.write(`community/state/${year}.json`, `${JSON.stringify(out.state, null, 2)}\n`);
    await Bun.write(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

    console.log(`compiled ${users.length - out.dropped.length}/${users.length} profiles.`);
    for (const d of out.dropped) console.log(`  dropped ${d.login}: ${d.reason}`);
}
