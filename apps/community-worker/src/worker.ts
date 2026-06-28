/**
 * ax community compile Worker.
 *
 * Replaces the nightly GitHub Action: compiles registered profile gists into
 * the public leaderboard and serves it, on two triggers -
 *   - POST /webhook : GitHub `push` webhook. When a registration under
 *     community/users/ lands (a new builder joins), recompile immediately -
 *     the board updates the moment someone joins, not 24h later.
 *   - scheduled     : nightly cron refresh, because a builder republishing
 *     their gist (`ax profile publish`) PATCHes the gist and never touches the
 *     repo, so the webhook alone would never pick up their newest numbers.
 *
 * Compiled JSON is written to KV and served read-only over GET (CORS-open;
 * it is public data). The compile core is shared with the Bun fallback via
 * `@ax/community-compile`, so both paths produce byte-identical output.
 *
 * Provisioned by `alchemy.run.ts` (KV + Worker + GitHub RepositoryWebhook).
 */
import { compileCommunity } from "@ax/community-compile";
import { gistFetcher, listRegisteredUsers } from "./github.ts";

export interface Env {
    /** KV namespace holding the compiled JSON blobs. */
    BOARD: KVNamespace;
    /** GitHub token for reading community/users/ (reuses an existing PAT). */
    GH_TOKEN: string;
    /** Shared secret for HMAC-validating the GitHub webhook payload. */
    WEBHOOK_SECRET: string;
    /** Repo coordinates (plain-text bindings; default to this repo). */
    GITHUB_OWNER?: string;
    GITHUB_REPO?: string;
}

// KV key per compiled artifact. `meta` carries compiled_at for observability.
const KV_KEYS = {
    "/leaders": "leaderboard",
    "/skills": "skill-stats",
    "/hooks": "hook-stats",
    "/patterns": "pattern-stats",
    "/state": "state",
    "/meta": "meta",
} as const;

const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
} as const;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...CORS, ...extra },
    });

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

        if (request.method === "GET") {
            const key = (KV_KEYS as Record<string, string>)[url.pathname];
            if (key === undefined) {
                return json({ ok: true, endpoints: Object.keys(KV_KEYS) });
            }
            const body = await env.BOARD.get(key);
            if (body === null) return json({ error: "not compiled yet" }, 503);
            // Public, slow-moving data: cache 5m at the edge + browser.
            return new Response(body, {
                headers: { "content-type": "application/json", "cache-control": "public, max-age=300", ...CORS },
            });
        }

        if (request.method === "POST" && url.pathname === "/webhook") {
            const raw = await request.text();
            const ok = await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WEBHOOK_SECRET);
            if (!ok) return json({ error: "bad signature" }, 401);

            const event = request.headers.get("x-github-event");
            if (event === "ping") return json({ ok: true, pong: true });
            if (event !== "push") return json({ ok: true, ignored: event });

            // Only recompile when a registration changed - ignore code pushes.
            let payload: PushPayload;
            try {
                payload = JSON.parse(raw) as PushPayload;
            } catch {
                return json({ error: "bad payload" }, 400);
            }
            if (!touchesRegistrations(payload)) {
                return json({ ok: true, skipped: "no registration change" });
            }
            const result = await recompile(env);
            return json({ ok: true, trigger: "webhook", ...result });
        }

        return json({ error: "not found" }, 404);
    },

    async scheduled(_event: ScheduledController, env: Env): Promise<void> {
        await recompile(env);
    },
};

// ---------------------------------------------------------------------------

async function recompile(env: Env): Promise<{ users: number; compiled: number; dropped: number }> {
    const owner = env.GITHUB_OWNER ?? "Necmttn";
    const repo = env.GITHUB_REPO ?? "ax";
    const users = await listRegisteredUsers(env.GH_TOKEN, owner, repo);
    const now = new Date().toISOString();
    const out = await compileCommunity(users, gistFetcher, { now });

    await Promise.all([
        env.BOARD.put("leaderboard", JSON.stringify(out.leaderboard)),
        env.BOARD.put("skill-stats", JSON.stringify(out.skillStats)),
        env.BOARD.put("hook-stats", JSON.stringify(out.hookStats)),
        env.BOARD.put("pattern-stats", JSON.stringify(out.patternStats)),
        env.BOARD.put("state", JSON.stringify(out.state)),
        env.BOARD.put("meta", JSON.stringify({ compiled_at: now, users: users.length, dropped: out.dropped })),
    ]);
    return { users: users.length, compiled: users.length - out.dropped.length, dropped: out.dropped.length };
}

// --- webhook helpers --------------------------------------------------------

interface PushCommit {
    readonly added?: readonly string[];
    readonly modified?: readonly string[];
    readonly removed?: readonly string[];
}
interface PushPayload {
    readonly commits?: readonly PushCommit[];
    readonly head_commit?: PushCommit | null;
}

/** True if any commit in the push touched a community/users/ registration. */
function touchesRegistrations(payload: PushPayload): boolean {
    const commits = [...(payload.commits ?? []), ...(payload.head_commit ? [payload.head_commit] : [])];
    for (const c of commits) {
        for (const path of [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) {
            if (path.startsWith("community/users/")) return true;
        }
    }
    return false;
}

const encoder = new TextEncoder();

/**
 * Verify GitHub's `x-hub-signature-256` HMAC over the raw body. Constant-time
 * compare; fails closed on any missing input.
 */
async function verifySignature(body: string, header: string | null, secret: string): Promise<boolean> {
    if (!header || !secret) return false;
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return timingSafeEqual(`sha256=${hex}`, header);
}

/** Length-then-content constant-time string compare. */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
