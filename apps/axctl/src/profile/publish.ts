/**
 * Publish operations: gist payload + create/patch, staleness, and the
 * one-time fork -> remote commit -> PR registration into the main repo
 * (community/users/<login>.json). Everything goes through GitHubEnv; no
 * local clone is ever made (git-data API: blob -> tree -> commit -> ref).
 */
import { Effect } from "effect";
import { GitHubApiError, GitHubEnv } from "./github-env.ts";
import type { ProfileV1 } from "./schema.ts";

export const REGISTRY_REPO = "Necmttn/ax";

export interface GistRef {
    readonly gistId: string;
    readonly owner: string;
}

export function profileGistPayload(profile: ProfileV1): {
    readonly description: string;
    readonly public: boolean;
    readonly files: Record<string, { readonly content: string }>;
} {
    return {
        description: `ax profile - ${profile.github}`,
        public: true,
        files: { "ax-profile.json": { content: `${JSON.stringify(profile, null, 2)}\n` } },
    };
}

/** hoursTtl staleness vs an injected `now` (no Date.now in logic). */
export function isStale(publishedAt: string, hoursTtl: number, now: string): boolean {
    const pub = Date.parse(publishedAt);
    const ref = Date.parse(now);
    if (!Number.isFinite(pub) || !Number.isFinite(ref)) return true;
    return ref - pub > hoursTtl * 3_600_000;
}

const asRecord = (u: unknown): Record<string, unknown> =>
    typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {};

export const createProfileGist = Effect.fn("profile.createProfileGist")(
    function* (profile: ProfileV1) {
        const gh = yield* GitHubEnv;
        const out = asRecord(yield* gh.api("POST", "/gists", profileGistPayload(profile)));
        const owner = asRecord(out.owner);
        return {
            gistId: String(out.id ?? ""),
            owner: typeof owner.login === "string" ? owner.login : "",
        } satisfies GistRef;
    },
);

export const patchProfileGist = Effect.fn("profile.patchProfileGist")(
    function* (gistId: string, profile: ProfileV1) {
        const gh = yield* GitHubEnv;
        yield* gh.api("PATCH", `/gists/${gistId}`, profileGistPayload(profile));
    },
);

export const deleteProfileGist = Effect.fn("profile.deleteProfileGist")(
    function* (gistId: string) {
        const gh = yield* GitHubEnv;
        yield* gh.api("DELETE", `/gists/${gistId}`);
    },
);

export type RegistrationResult =
    | { readonly status: "already-registered" }
    | { readonly status: "pr-opened"; readonly prUrl: string };

/**
 * One-time registration: community/users/<login>.json via the user's fork.
 * Idempotent: skips when the file already exists upstream. The branch is
 * deterministic (ax-profile-<login>) so re-runs collide loudly instead of
 * spamming PRs.
 */
export const ensureRegistration = Effect.fn("profile.ensureRegistration")(
    function* (input: { readonly login: string; readonly gistId: string; readonly joined: string }) {
        const gh = yield* GitHubEnv;
        const { login, gistId, joined } = input;
        const filePath = `community/users/${login}.json`;

        const exists = yield* gh.api("GET", `/repos/${REGISTRY_REPO}/contents/${filePath}`).pipe(
            Effect.map(() => true),
            Effect.catchTag("GitHubApiError", (e: GitHubApiError) =>
                e.status === 404 ? Effect.succeed(false) : Effect.fail(e),
            ),
        );
        if (exists) return { status: "already-registered" } as const;

        const fork = asRecord(yield* gh.api("POST", `/repos/${REGISTRY_REPO}/forks`, {}));
        const forkFullName = typeof fork.full_name === "string" ? fork.full_name : `${login}/ax`;

        const baseRef = asRecord(yield* gh.api("GET", `/repos/${forkFullName}/git/ref/heads/main`));
        const baseSha = String(asRecord(baseRef.object).sha ?? "");

        const content = `${JSON.stringify({ github: login, gist_id: gistId, joined }, null, 2)}\n`;
        const blob = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/blobs`, {
                content,
                encoding: "utf-8",
            }),
        );

        const baseCommit = asRecord(yield* gh.api("GET", `/repos/${forkFullName}/git/commits/${baseSha}`));
        const baseTreeSha = String(asRecord(baseCommit.tree).sha ?? "");

        const tree = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/trees`, {
                base_tree: baseTreeSha,
                tree: [{ path: filePath, mode: "100644", type: "blob", sha: blob.sha }],
            }),
        );

        const commit = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/commits`, {
                message: `community: register ax profile for @${login}`,
                tree: tree.sha,
                parents: [baseSha],
            }),
        );

        const branch = `ax-profile-${login}`;
        yield* gh.api("POST", `/repos/${forkFullName}/git/refs`, {
            ref: `refs/heads/${branch}`,
            sha: commit.sha,
        });

        const pr = asRecord(
            yield* gh.api("POST", `/repos/${REGISTRY_REPO}/pulls`, {
                title: `community: register ax profile for @${login}`,
                head: `${login}:${branch}`,
                base: "main",
                body: `One-time ax profile registration. Gist: https://gist.github.com/${login}/${gistId}\n\nOpened by \`ax profile publish\`.`,
            }),
        );

        return { status: "pr-opened", prUrl: String(pr.html_url ?? "") } as const;
    },
);
