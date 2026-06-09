import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { GithubPrKey, githubPrStage, ingestGithubPrs } from "./github-pr-stage.ts";

/**
 * Build a mock SurrealClient that captures every issued SQL string. The
 * `repoRows` override answers the `FROM repository` discovery SELECT; the writer's
 * `FROM commit` / `FROM produced` reads get stub rows; everything else is `[[]]`.
 */
const makeMockDb = (
    captured: string[],
    overrides?: { repoRows?: unknown; commitRows?: unknown; producedRows?: unknown },
): SurrealClientShape => ({
    query: <T extends unknown[]>(sql: string) =>
        Effect.sync(() => {
            captured.push(sql);
            if (sql.includes("FROM repository")) {
                return (overrides?.repoRows ?? [[]]) as T;
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
            { fetchImpl: () => Effect.succeed([mergedPrFixture]) },
            db,
        );

        expect(totals.repositoriesScanned).toBe(1);
        expect(totals.pullRequests).toBe(1);
        expect(totals.reviews).toBe(1);
        expect(totals.checks).toBe(1);
        expect(totals.deliveryOutcomes).toBe(1);

        // The writer ran with the resolved repository ref.
        const prStmt = sql.find((s) => s.includes("UPSERT pull_request:"));
        expect(prStmt).toBeDefined();
        expect(prStmt!).toContain("repository: repository:`r1`");

        // No repoPaths → the discovery SELECT is unfiltered.
        const selUnscoped = sql.find((s) => s.includes("FROM repository"));
        expect(selUnscoped).toBeDefined();
        expect(selUnscoped!).not.toContain("root_path IN [");
    });

    test("scopes the repository SELECT to repoPaths when provided", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, {
            repoRows: [
                [{ id: "repository:`r1`", root_path: "/tmp/x", remote_url: "https://github.com/o/r" }],
            ],
        });

        await run(
            { repoPaths: ["/tmp/x"], fetchImpl: () => Effect.succeed([mergedPrFixture]) },
            db,
        );

        const sel = sql.find((s) => s.includes("FROM repository"));
        expect(sel).toBeDefined();
        expect(sel!).toContain("root_path IN [");
        expect(sel!).toContain('"/tmp/x"');
    });
});
