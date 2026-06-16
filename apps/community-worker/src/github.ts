/**
 * GitHub-facing helpers for the community compile worker: read the registered
 * users out of `community/users/` in the repo (the source of truth, same files
 * the GH-action path globs off disk) and fetch each profile gist.
 *
 * Both run inside the Cloudflare Worker - plain `fetch`, no Bun/node APIs.
 */
import type { GistFetcher, RegisteredUser } from "@ax/community-compile";

// GitHub login charset: 1–39 alphanumeric/hyphen chars; gist IDs are hex.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const GIST_ID_RE = /^[a-f0-9]+$/i;

interface ContentsEntry {
    readonly name: string;
    readonly type: string;
    readonly download_url: string | null;
}

const ghHeaders = (token: string): HeadersInit => ({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "ax-community-compile-worker",
    "x-github-api-version": "2022-11-28",
});

/**
 * List the registered users from `community/users/*.json` on the given ref.
 * Reads the directory via the contents API, then fetches each file's raw JSON.
 * Invalid logins / gist ids are skipped (defensive - the merge gate already
 * validates, but the worker never trusts upstream blindly).
 */
export async function listRegisteredUsers(
    token: string,
    owner: string,
    repo: string,
    ref = "main",
): Promise<RegisteredUser[]> {
    const listRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/community/users?ref=${ref}`,
        { headers: ghHeaders(token) },
    );
    if (!listRes.ok) throw new Error(`contents list failed (${listRes.status})`);
    const entries = (await listRes.json()) as ContentsEntry[];

    const users: RegisteredUser[] = [];
    for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".json") || entry.download_url === null) continue;
        try {
            const res = await fetch(entry.download_url, { headers: { "user-agent": "ax-community-compile-worker" } });
            if (!res.ok) continue;
            const r = (await res.json()) as Record<string, unknown>;
            const github = String(r.github);
            const gist_id = String(r.gist_id);
            if (!GITHUB_LOGIN_RE.test(github) || !GIST_ID_RE.test(gist_id)) continue;
            users.push({ github, gist_id, joined: String(r.joined) });
        } catch {
            // skip a single unreadable registration; compile continues
        }
    }
    return users;
}

/**
 * Fetch the gist's ax-profile.json via the public raw CDN, unauthenticated
 * (same endpoint the GH-action path uses - no gist scope needed, no rate
 * limit). No ETag cache here: the worker recompiles infrequently (webhook on
 * registration + nightly cron), so a full re-fetch each run is cheap.
 */
export const gistFetcher: GistFetcher = async (gistId, owner) => {
    try {
        const res = await fetch(
            `https://gist.githubusercontent.com/${owner}/${gistId}/raw/ax-profile.json`,
            { headers: { "user-agent": "ax-community-compile-worker" } },
        );
        if (!res.ok) return null;
        return { profile: await res.json(), etag: null };
    } catch {
        return null;
    }
};
