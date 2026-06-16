// scripts/compile-community.ts
/**
 * Nightly community compile (profiles spec §3b) - Bun CLI wrapper around the
 * runtime-agnostic core in `@ax/community-compile`. Walks community/users/,
 * fetches each registered gist's ax-profile.json (ETag-cached), compiles, and
 * writes the deterministic JSON outputs:
 *   community/leaderboard.json   - boards: tokens, sessions, streak, cost
 *   community/skill-stats.json   - { "<source>:<name>": { users, runs } }
 *   community/hook-stats.json    - { "<hook>": { users } }
 *   community/state/<year>.json  - anonymized distributions
 *
 * NOTE: the live community compile now runs on the alchemy-provisioned
 * Cloudflare Worker (apps/community-worker) - webhook on new registration +
 * nightly cron. This script + community-nightly.yml are retained as a manual
 * fallback. The compile logic is shared (`@ax/community-compile`), so both
 * paths stay byte-identical.
 */
import {
    compileCommunity,
    type GistFetcher,
    type RegisteredUser,
} from "@ax/community-compile";

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
