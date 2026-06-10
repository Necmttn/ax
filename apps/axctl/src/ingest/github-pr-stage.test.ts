import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { GithubPrKey, githubPrStage, ingestGithubPrs, resolveFetchCooldownMs } from "./github-pr-stage.ts";

/**
 * Build a mock SurrealClient that captures every issued SQL string. The
 * `repoRows` override answers the `FROM repository` discovery SELECT; the writer's
 * `FROM commit` / `FROM produced` reads get stub rows; everything else is `[[]]`.
 */
const makeMockDb = (
    captured: string[],
    overrides?: { repoRows?: unknown; commitRows?: unknown; producedRows?: unknown; watermarkRows?: unknown },
): SurrealClientShape => ({
    query: <T extends unknown[]>(sql: string) =>
        Effect.sync(() => {
            captured.push(sql);
            if (sql.includes("FROM repository")) {
                return (overrides?.repoRows ?? [[]]) as T;
            }
            if (sql.includes("FROM ingest_file_state")) {
                return (overrides?.watermarkRows ?? [[]]) as T;
            }
            if (sql.includes("FROM commit")) {
                return (overrides?.commitRows ?? [["commit:`c1`"]]) as T;
            }
            if (sql.includes("FROM produced")) {
                return (overrides?.producedRows ?? [["session:`s1`"]]) as T;
            }
            return [[]] as T;
        }),
    upsert: () => Effect.void,
    relate: () => Effect.void,
    putFile: () => Effect.void,
    getFile: () => Effect.succeed(""),
    raw: {} as never,
});

const run = (
    deps: Parameters<typeof ingestGithubPrs>[0],
    db: SurrealClientShape,
) =>
    Effect.runPromise(
        ingestGithubPrs(deps).pipe(Effect.provide(Layer.succeed(SurrealClient, db))),
    );

/** A realistic gh `pr list --json` PR object (merged, 1 review, 1 check). */
const mergedPrFixture = {
    number: 42,
    title: "Add the thing",
    state: "MERGED",
    mergedAt: "2026-05-09T12:00:00.000Z",
    createdAt: "2026-05-08T09:00:00.000Z",
    baseRefName: "main",
    headRefName: "feat/the-thing",
    headRefOid: "head999",
    mergeCommit: { oid: "abc123" },
    author: { login: "necmttn", type: "User" },
    url: "https://github.com/o/r/pull/42",
    additions: 120,
    deletions: 30,
    changedFiles: 6,
    commits: [{}, {}, {}],
    labels: [{ name: "feature" }],
    reviews: [
        {
            author: { login: "reviewer1", type: "User" },
            state: "APPROVED",
            body: "lgtm",
            submittedAt: "2026-05-09T10:00:00.000Z",
        },
    ],
    statusCheckRollup: [
        {
            __typename: "CheckRun",
            name: "ci/test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://ci.example/1",
            startedAt: "2026-05-09T09:30:00.000Z",
            completedAt: "2026-05-09T09:45:00.000Z",
        },
    ],
};

describe("githubPrStage", () => {
    test("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(GithubPrKey)("github-pr")).toBe("github-pr");
        expect(githubPrStage.meta.key).toBe("github-pr");
        expect(githubPrStage.meta.deps).toEqual(["git"]);
        expect(githubPrStage.meta.tags).toEqual(["ingest"]);
    });
});

describe("ingestGithubPrs", () => {
    test("returns zeros when no repositories have a remote + path", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, { repoRows: [[]] });

        // No deps → real fetchPullRequests, but it's never called (no repos).
        const totals = await run(undefined, db);

        expect(totals).toEqual({
            repositoriesScanned: 0,
            repositoriesDegraded: 0,
            repositoriesSkippedCooldown: 0,
            pullRequests: 0,
            reviews: 0,
            checks: 0,
            deliveryOutcomes: 0,
        });
    });

    test("composes fetch → normalize → write for a discovered repo", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, {
            repoRows: [
                [{ id: "repository:`r1`", root_path: "/tmp/x", remote_url: "https://github.com/o/r" }],
            ],
            commitRows: [["commit:`c1`"]],
            producedRows: [["session:`s1`"]],
        });

        const totals = await run(
            { fetchImpl: () => Effect.succeed({ ok: true, prs: [mergedPrFixture] }) },
            db,
        );

        expect(totals.repositoriesScanned).toBe(1);
        expect(totals.repositoriesDegraded).toBe(0);
        expect(totals.pullRequests).toBe(1);
        expect(totals.reviews).toBe(1);
        expect(totals.checks).toBe(1);
        expect(totals.deliveryOutcomes).toBe(1);

        // The writer ran with the resolved repository ref.
        const prStmt = sql.find((s) => s.includes("UPSERT pull_request:"));
        expect(prStmt).toBeDefined();
        expect(prStmt!).toContain("repository: repository:`r1`");

        // No repoPaths → the discovery SELECT is path-unfiltered but does
        // exclude non-GitHub remotes (gh would fail on every one, every run).
        const selUnscoped = sql.find((s) => s.includes("FROM repository"));
        expect(selUnscoped).toBeDefined();
        expect(selUnscoped!).not.toContain("root_path IN [");
        expect(selUnscoped!).toContain('remote_url CONTAINS "github"');
    });

    test("scopes the repository SELECT to repoPaths when provided", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, {
            repoRows: [
                [{ id: "repository:`r1`", root_path: "/tmp/x", remote_url: "https://github.com/o/r" }],
            ],
        });

        await run(
            { repoPaths: ["/tmp/x"], fetchImpl: () => Effect.succeed({ ok: true, prs: [mergedPrFixture] }) },
            db,
        );

        const sel = sql.find((s) => s.includes("FROM repository"));
        expect(sel).toBeDefined();
        expect(sel!).toContain("root_path IN [");
        expect(sel!).toContain('"/tmp/x"');
        // A worktree path never equals the canonical root_path, so the filter
        // also resolves the repository via the checkout table.
        expect(sel!).toContain("SELECT VALUE repository FROM checkout WHERE path IN [");
    });

    test("forwards updatedSince to the fetcher (since-bounded gh search)", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, {
            repoRows: [
                [{ id: "repository:`r1`", root_path: "/tmp/x", remote_url: "https://github.com/o/r" }],
            ],
        });
        const seen: Array<{ cwd: string; updatedSince?: string | undefined }> = [];

        await run(
            {
                updatedSince: "2026-06-09",
                fetchImpl: (input) => {
                    seen.push({ cwd: input.cwd, updatedSince: input.updatedSince });
                    return Effect.succeed({ ok: true, prs: [] });
                },
            },
            db,
        );

        expect(seen).toEqual([{ cwd: "/tmp/x", updatedSince: "2026-06-09" }]);
    });

    test("a failed fetch counts as degraded and writes nothing for that repo", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, {
            repoRows: [
                [
                    { id: "repository:`bad`", root_path: "/tmp/bad", remote_url: "https://github.com/o/bad" },
                    { id: "repository:`ok`", root_path: "/tmp/ok", remote_url: "https://github.com/o/ok" },
                ],
            ],
            commitRows: [["commit:`c1`"]],
            producedRows: [["session:`s1`"]],
        });

        const totals = await run(
            {
                fetchImpl: (input) =>
                    input.cwd === "/tmp/bad"
                        ? Effect.succeed({ ok: false, prs: [], detail: "gh pr list timed out after 30000ms" })
                        : Effect.succeed({ ok: true, prs: [mergedPrFixture] }),
            },
            db,
        );

        expect(totals.repositoriesScanned).toBe(2);
        expect(totals.repositoriesDegraded).toBe(1);
        expect(totals.pullRequests).toBe(1); // only the healthy repo wrote
        const prStmts = sql.filter((s) => s.includes("UPSERT pull_request:"));
        expect(prStmts.every((s) => s.includes("repository:`ok`"))).toBe(true);
    });
});

describe("fetch cooldown", () => {
    const repoRows = [
        [{ id: "repository:`r1`", root_path: "/tmp/x", remote_url: "https://github.com/o/r" }],
    ];
    const NOW = 1_750_000_000_000;
    const COOLDOWN = 15 * 60 * 1000;

    test("skips a repo whose last successful fetch is within the cooldown", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, {
            repoRows,
            watermarkRows: [[{ path: "__github_pr_fetch__//tmp/x", mtime_ms: NOW - 60_000 }]],
        });
        let fetchCalls = 0;

        const totals = await run(
            {
                fetchCooldownMs: COOLDOWN,
                now: () => NOW,
                fetchImpl: () => {
                    fetchCalls += 1;
                    return Effect.succeed({ ok: true, prs: [] });
                },
            },
            db,
        );

        expect(fetchCalls).toBe(0);
        expect(totals.repositoriesScanned).toBe(1);
        expect(totals.repositoriesSkippedCooldown).toBe(1);
    });

    test("fetches when the watermark is older than the cooldown, and advances it", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, {
            repoRows,
            watermarkRows: [[{ path: "__github_pr_fetch__//tmp/x", mtime_ms: NOW - COOLDOWN - 1 }]],
        });
        let fetchCalls = 0;

        const totals = await run(
            {
                fetchCooldownMs: COOLDOWN,
                now: () => NOW,
                fetchImpl: () => {
                    fetchCalls += 1;
                    return Effect.succeed({ ok: true, prs: [] });
                },
            },
            db,
        );

        expect(fetchCalls).toBe(1);
        expect(totals.repositoriesSkippedCooldown).toBe(0);
        const wm = sql.find((s) => s.includes("UPSERT ingest_file_state:") && s.includes("github-pr:fetch"));
        expect(wm).toBeDefined();
        expect(wm!).toContain(`mtime_ms: ${NOW}`);
        expect(wm!).toContain('"__github_pr_fetch__//tmp/x"');
    });

    test("a degraded fetch does NOT advance the watermark (retries next run)", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, { repoRows });

        const totals = await run(
            {
                fetchCooldownMs: COOLDOWN,
                now: () => NOW,
                fetchImpl: () => Effect.succeed({ ok: false, prs: [], detail: "gh pr list timed out" }),
            },
            db,
        );

        expect(totals.repositoriesDegraded).toBe(1);
        const wm = sql.find((s) => s.includes("UPSERT ingest_file_state:"));
        expect(wm).toBeUndefined();
    });

    test("cooldown disabled (0/absent) → no watermark read, every repo fetched", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, { repoRows });
        let fetchCalls = 0;

        await run(
            {
                fetchImpl: () => {
                    fetchCalls += 1;
                    return Effect.succeed({ ok: true, prs: [] });
                },
            },
            db,
        );

        expect(fetchCalls).toBe(1);
        expect(sql.some((s) => s.includes("SELECT path, mtime_ms FROM ingest_file_state"))).toBe(false);
    });

    test("resolveFetchCooldownMs: default 15m, env seconds override, 0 disables, junk falls back", () => {
        expect(resolveFetchCooldownMs({})).toBe(15 * 60 * 1000);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "60" })).toBe(60_000);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "0" })).toBe(0);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "nope" })).toBe(15 * 60 * 1000);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "-5" })).toBe(15 * 60 * 1000);
    });
});
