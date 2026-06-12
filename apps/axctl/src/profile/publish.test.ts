// apps/axctl/src/profile/publish.test.ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { GitHubEnvTest } from "./github-env.ts";
import {
    createProfileGist,
    ensureRegistration,
    isStale,
    patchProfileGist,
    profileGistPayload,
    REGISTRY_REPO,
} from "./publish.ts";
import type { ProfileV1 } from "./schema.ts";

const profile = {
    v: 1, github: "necmttn", generated_at: "2026-06-12T19:00:00Z", window_days: 30,
    stats: {
        sessions: 1, active_days: 1, streak_days: 1,
        tokens: { prompt: 1, completion: 1, total: 2 },
        models: [], harnesses: ["claude"],
    },
    rig: { skills: [], hooks: [], routing_table: false },
} as unknown as ProfileV1;

const run = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff);

describe("profileGistPayload", () => {
    test("one file, public, stable filename", () => {
        const p = profileGistPayload(profile);
        expect(p.public).toBe(true);
        expect(Object.keys(p.files)).toEqual(["ax-profile.json"]);
        expect(JSON.parse(p.files["ax-profile.json"]!.content).github).toBe("necmttn");
    });
});

describe("isStale", () => {
    test("fresh within ttl", () => {
        expect(isStale("2026-06-12T18:00:00Z", 6, "2026-06-12T19:00:00Z")).toBe(false);
    });
    test("stale past ttl", () => {
        expect(isStale("2026-06-12T10:00:00Z", 6, "2026-06-12T19:00:00Z")).toBe(true);
    });
    test("garbage timestamp counts as stale", () => {
        expect(isStale("nope", 6, "2026-06-12T19:00:00Z")).toBe(true);
    });
});

describe("createProfileGist / patchProfileGist", () => {
    test("create POSTs /gists and returns ref", async () => {
        const t = GitHubEnvTest({
            responses: { "POST /gists": { id: "g1", owner: { login: "necmttn" } } },
        });
        const ref = await run(createProfileGist(profile).pipe(Effect.provide(t.layer)));
        expect(ref).toEqual({ gistId: "g1", owner: "necmttn" });
        expect(t.calls[0]!.method).toBe("POST");
        const body = t.calls[0]!.body as { public: boolean; files: Record<string, unknown> };
        expect(body.public).toBe(true);
        expect(Object.keys(body.files)).toContain("ax-profile.json");
    });

    test("patch PATCHes /gists/:id", async () => {
        const t = GitHubEnvTest({ responses: { "PATCH /gists/g1": { id: "g1" } } });
        await run(patchProfileGist("g1", profile).pipe(Effect.provide(t.layer)));
        expect(t.calls[0]).toMatchObject({ method: "PATCH", path: "/gists/g1" });
    });
});

describe("ensureRegistration", () => {
    test("skips when registration file already exists upstream", async () => {
        const t = GitHubEnvTest({
            responses: {
                [`GET /repos/${REGISTRY_REPO}/contents/community/users/necmttn.json`]: { sha: "x" },
            },
        });
        const r = await run(
            ensureRegistration({ login: "necmttn", gistId: "g1", joined: "2026-06-12" })
                .pipe(Effect.provide(t.layer)),
        );
        expect(r).toEqual({ status: "already-registered" });
        expect(t.calls).toHaveLength(1);
    });

    test("full flow: fork, branch ref, blob/tree/commit, ref, PR", async () => {
        const login = "necmttn";
        const fork = `${login}/ax`;
        const t = GitHubEnvTest({
            responses: {
                // No GET contents key - test layer 404s missing keys = "not registered"
                [`POST /repos/${REGISTRY_REPO}/forks`]: { full_name: fork },
                [`GET /repos/${fork}/git/ref/heads/main`]: { object: { sha: "base" } },
                [`POST /repos/${fork}/git/blobs`]: { sha: "blob1" },
                [`GET /repos/${fork}/git/commits/base`]: { tree: { sha: "tree0" } },
                [`POST /repos/${fork}/git/trees`]: { sha: "tree1" },
                [`POST /repos/${fork}/git/commits`]: { sha: "commit1" },
                [`POST /repos/${fork}/git/refs`]: { ref: "refs/heads/ax-profile-necmttn" },
                [`POST /repos/${REGISTRY_REPO}/pulls`]: { html_url: "https://github.com/Necmttn/ax/pull/999" },
            },
        });
        const r = await run(
            ensureRegistration({ login, gistId: "g1", joined: "2026-06-12" })
                .pipe(Effect.provide(t.layer)),
        );
        expect(r).toEqual({ status: "pr-opened", prUrl: "https://github.com/Necmttn/ax/pull/999" });
        const paths = t.calls.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain(`POST /repos/${REGISTRY_REPO}/forks`);
        expect(paths).toContain(`POST /repos/${login}/ax/git/blobs`);
        expect(paths).toContain(`POST /repos/${REGISTRY_REPO}/pulls`);

        const callBody = (path: string): unknown =>
            t.calls.find((c) => c.path === path)?.body;
        const expectedContent = `${JSON.stringify(
            { github: login, gist_id: "g1", joined: "2026-06-12" },
            null,
            2,
        )}\n`;
        expect(callBody(`/repos/${fork}/git/blobs`)).toEqual({
            content: expectedContent,
            encoding: "utf-8",
        });
        expect(callBody(`/repos/${fork}/git/trees`)).toMatchObject({
            tree: [
                {
                    path: "community/users/necmttn.json",
                    mode: "100644",
                    type: "blob",
                    sha: "blob1",
                },
            ],
        });
        expect(callBody(`/repos/${fork}/git/commits`)).toMatchObject({ parents: ["base"] });
        expect(callBody(`/repos/${REGISTRY_REPO}/pulls`)).toMatchObject({
            head: "necmttn:ax-profile-necmttn",
            base: "main",
        });
    });

    test("uppercase login registers under the lowercase filename and branch", async () => {
        // Live finding: "Necmttn" produced Necmttn.json, which the registry
        // validator scope regex rejects and the site lookup (lowercased) 404s.
        const fork = "Necmttn/ax";
        const t = GitHubEnvTest({
            responses: {
                [`POST /repos/${REGISTRY_REPO}/forks`]: { full_name: fork },
                [`GET /repos/${fork}/git/ref/heads/main`]: { object: { sha: "base" } },
                [`POST /repos/${fork}/git/blobs`]: { sha: "blob1" },
                [`GET /repos/${fork}/git/commits/base`]: { tree: { sha: "tree0" } },
                [`POST /repos/${fork}/git/trees`]: { sha: "tree1" },
                [`POST /repos/${fork}/git/commits`]: { sha: "commit1" },
                [`POST /repos/${fork}/git/refs`]: { ref: "refs/heads/ax-profile-necmttn" },
                [`POST /repos/${REGISTRY_REPO}/pulls`]: { html_url: "https://github.com/Necmttn/ax/pull/1000" },
            },
        });
        await run(
            ensureRegistration({ login: "Necmttn", gistId: "g1", joined: "2026-06-12" })
                .pipe(Effect.provide(t.layer)),
        );
        const contentsCheck = t.calls.find((c) => c.method === "GET" && c.path.includes("/contents/"));
        expect(contentsCheck?.path).toBe(`/repos/${REGISTRY_REPO}/contents/community/users/necmttn.json`);
        const trees = t.calls.find((c) => c.path === `/repos/${fork}/git/trees`)?.body as {
            tree: Array<{ path: string }>;
        };
        expect(trees.tree[0]!.path).toBe("community/users/necmttn.json");
        const refs = t.calls.find((c) => c.path === `/repos/${fork}/git/refs`)?.body as { ref: string };
        expect(refs.ref).toBe("refs/heads/ax-profile-necmttn");
    });

    test("non-404 error on contents check fails registration without forking", async () => {
        const t = GitHubEnvTest({
            responses: {
                [`GET /repos/${REGISTRY_REPO}/contents/community/users/necmttn.json`]: {
                    __error: { status: 500, message: "boom" },
                },
            },
        });
        const outcome = await run(
            ensureRegistration({ login: "necmttn", gistId: "g1", joined: "2026-06-12" }).pipe(
                Effect.map(() => "ok" as const),
                Effect.catchTag("GitHubApiError", (e) => Effect.succeed(`err:${e.status}`)),
                Effect.provide(t.layer),
            ),
        );
        expect(outcome).toBe("err:500");
        const paths = t.calls.map((c) => `${c.method} ${c.path}`);
        expect(paths).not.toContain(`POST /repos/${REGISTRY_REPO}/forks`);
    });
});
