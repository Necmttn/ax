/**
 * Infrastructure for the ax community leaderboard, as code (alchemy).
 *
 * Provisions:
 *   - KVNamespace          : holds the compiled leaderboard / skill / hook / state JSON
 *   - Worker               : compiles + serves it; nightly cron + /webhook (apps/community-worker)
 *   - RepositoryWebhook    : GitHub push webhook -> Worker, so a new registration
 *                            recompiles the board the instant it merges
 *
 * Replaces the nightly `community-nightly.yml` GitHub Action (kept as a manual
 * fallback). The site reads the board cross-origin from the Worker's custom
 * domain (see apps/site/app/lib/community.ts).
 *
 * Deploy:  bun alchemy deploy        (from repo root)
 * Destroy: bun alchemy destroy
 *
 * Required env (reuses existing credentials):
 *   GITHUB_TOKEN            - PAT with admin:repo_hook + contents:read on Necmttn/ax
 *   COMMUNITY_WEBHOOK_SECRET - shared HMAC secret (bound to the Worker AND the webhook)
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID - standard alchemy CF auth
 */
import alchemy from "alchemy";
import { KVNamespace, Worker } from "alchemy/cloudflare";
import { RepositoryWebhook } from "alchemy/github";
import { FileSystemStateStore } from "alchemy/state";

const OWNER = "Necmttn";
const REPO = "ax";
const HOSTNAME = "ax-community.necmttn.com";

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing required env ${name} (see alchemy.run.ts header)`);
    return v;
}

const githubToken = requireEnv("GITHUB_TOKEN");
const webhookSecret = requireEnv("COMMUNITY_WEBHOOK_SECRET");

// State lives in a STABLE, machine-global dir - never inside the (often
// throwaway) git worktree this is deployed from. The default `.alchemy/` under
// cwd vanished with a removed worktree once, which made redeploys try to
// recreate the already-live KV/Worker/webhook. `adopt: true` below lets a
// fresh state reconcile with existing resources rather than colliding.
const app = await alchemy("ax-community", {
    stateStore: (scope) =>
        new FileSystemStateStore(scope, { rootDir: `${requireEnv("HOME")}/.ax/alchemy-state` }),
});

const board = await KVNamespace("community-board", {
    title: "ax-community-board",
    adopt: true,
});

export const worker = await Worker("ax-community-compile", {
    name: "ax-community-compile",
    adopt: true,
    entrypoint: "./apps/community-worker/src/worker.ts",
    bindings: {
        BOARD: board,
        GH_TOKEN: alchemy.secret(githubToken),
        WEBHOOK_SECRET: alchemy.secret(webhookSecret),
        GITHUB_OWNER: OWNER,
        GITHUB_REPO: REPO,
    },
    // Nightly refresh of every builder's latest gist numbers (gist republishes
    // never touch the repo, so the webhook alone can't catch them).
    crons: ["17 3 * * *"],
    // workers.dev stays on as a stable fallback URL alongside the custom domain.
    url: true,
    domains: [HOSTNAME],
});

await RepositoryWebhook("ax-community-hook", {
    owner: OWNER,
    repository: REPO,
    url: `https://${HOSTNAME}/webhook`,
    // RepositoryWebhook.secret/token are plain strings (unlike Worker
    // bindings, which take alchemy.secret()); they're stored in alchemy state,
    // which is gitignored.
    secret: webhookSecret,
    events: ["push"],
    contentType: "application/json",
    token: githubToken,
});

console.log(`community worker: https://${HOSTNAME}  (workers.dev: ${worker.url})`);

await app.finalize();
