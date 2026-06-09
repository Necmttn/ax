import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { writePullRequests } from "./github-pr-write.ts";

/**
 * Build a mock SurrealClient that captures every issued SQL string and answers
 * the two read queries (commit lookup, produced-session lookup) with stub rows.
 */
const makeMockDb = (
    captured: string[],
    overrides?: { commitRows?: unknown; producedRows?: unknown },
): SurrealClientShape => ({
    query: <T extends unknown[]>(sql: string) =>
        Effect.sync(() => {
            captured.push(sql);
            if (sql.includes("FROM commit")) {
                return (overrides?.commitRows ?? [["commit:`abc123`"]]) as T;
            }
            if (sql.includes("FROM produced")) {
                return (overrides?.producedRows ?? [["session:`sess-1`"]]) as T;
            }
            return [[]] as T;
        }),
    upsert: () => Effect.void,
    relate: () => Effect.void,
    putFile: () => Effect.void,
    getFile: () => Effect.succeed(""),
    raw: {} as never,
});

const run = (input: Parameters<typeof writePullRequests>[0], db: SurrealClientShape) =>
    Effect.runPromise(
        writePullRequests(input).pipe(
            Effect.provide(Layer.succeed(SurrealClient, db)),
        ),
    );

/** A realistic gh `pr list --json` PR object (camelCase, merged). */
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
    url: "https://github.com/acme/repo/pull/42",
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

describe("writePullRequests", () => {
    test("writes pull_request, review_event, check_run, delivery_outcome for a merged PR", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql);

        const stats = await run(
            {
                repositoryId: "repository:`repo-key`",
                repositoryKey: "repo-key",
                prs: [mergedPrFixture],
            },
            db,
        );

        expect(stats).toEqual({
            pullRequests: 1,
            reviews: 1,
            checks: 1,
            deliveryOutcomes: 1,
        });

        const all = sql.join("\n");

        // pull_request upsert
        const prStmt = sql.find((s) => s.includes("UPSERT pull_request:"));
        expect(prStmt).toBeDefined();
        expect(prStmt!).toContain('state: "merged"');
        expect(prStmt!).toContain("number: 42");
        expect(prStmt!).toContain("additions: 120");
        expect(prStmt!).toContain("deletions: 30");
        expect(prStmt!).toContain("repository: repository:`repo-key`");
        // datetime emitted as a properly-quoted d"..." literal (escaping fix)
        expect(prStmt!).toContain('merged_at: d"2026-05-09T12:00:00.000Z"');

        // review_event upsert
        const reviewStmt = sql.find((s) => s.includes("UPSERT review_event:"));
        expect(reviewStmt).toBeDefined();
        expect(reviewStmt!).toContain("pull_request: pull_request:");
        expect(reviewStmt!).toContain("ts:");

        // check_run upsert with resolved commit
        const checkStmt = sql.find((s) => s.includes("UPSERT check_run:"));
        expect(checkStmt).toBeDefined();
        expect(checkStmt!).toContain("commit: commit:`abc123`");
        expect(checkStmt!).toContain('name: "ci/test"');
        expect(checkStmt!).toContain("status:");

        // delivery_outcome upsert
        const deliveryStmt = sql.find((s) => s.includes("UPSERT delivery_outcome:"));
        expect(deliveryStmt).toBeDefined();
        expect(deliveryStmt!).toContain("session: session:`sess-1`");
        expect(deliveryStmt!).toContain("pull_request: pull_request:");
        expect(deliveryStmt!).toContain("status:");
        // promotion_path must be set explicitly - SurrealDB v3 doesn't apply the
        // schema DEFAULT on CONTENT upserts, so an unset required field errors.
        expect(deliveryStmt!).toContain('promotion_path: "pr"');
        expect(deliveryStmt!).toContain("pr_size:");
        expect(deliveryStmt!).toContain("review_pain:");

        // merged + commit-in-graph → merged_to_main
        expect(deliveryStmt!).toContain('status: "merged_to_main"');

        // the read queries were issued
        expect(all).toContain("FROM commit");
        expect(all).toContain("FROM produced");
    });

    test("skips a PR with number: null (zero stats)", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql);

        const stats = await run(
            {
                repositoryId: "repository:`repo-key`",
                repositoryKey: "repo-key",
                prs: [{ ...mergedPrFixture, number: null }],
            },
            db,
        );

        expect(stats).toEqual({
            pullRequests: 0,
            reviews: 0,
            checks: 0,
            deliveryOutcomes: 0,
        });
        expect(sql.some((s) => s.includes("UPSERT pull_request:"))).toBe(false);
    });

    test("writes pull_request but no delivery_outcome when the commit is not in the graph", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql, { commitRows: [[]] });

        const stats = await run(
            {
                repositoryId: "repository:`repo-key`",
                repositoryKey: "repo-key",
                prs: [mergedPrFixture],
            },
            db,
        );

        expect(stats.pullRequests).toBe(1);
        expect(stats.reviews).toBe(1);
        expect(stats.checks).toBe(1);
        expect(stats.deliveryOutcomes).toBe(0);

        // commit not resolved → check_run.commit is NONE, no produced lookup
        const checkStmt = sql.find((s) => s.includes("UPSERT check_run:"));
        expect(checkStmt!).toContain("commit: NONE");
        expect(sql.some((s) => s.includes("FROM produced"))).toBe(false);
        expect(sql.some((s) => s.includes("UPSERT delivery_outcome:"))).toBe(false);
    });

    test("skips a review whose normalized state is null", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql);

        const stats = await run(
            {
                repositoryId: "repository:`repo-key`",
                repositoryKey: "repo-key",
                prs: [
                    {
                        ...mergedPrFixture,
                        // No state field → normalizeReviewEvent yields state: null
                        reviews: [{ author: { login: "r", type: "User" }, body: "hmm" }],
                    },
                ],
            },
            db,
        );

        expect(stats.reviews).toBe(0);
        expect(sql.some((s) => s.includes("UPSERT review_event:"))).toBe(false);
        // the rest of the PR still writes
        expect(stats.pullRequests).toBe(1);
        expect(stats.checks).toBe(1);
    });

    test("skips a check with both name and status null", async () => {
        const sql: string[] = [];
        const db = makeMockDb(sql);

        const stats = await run(
            {
                repositoryId: "repository:`repo-key`",
                repositoryKey: "repo-key",
                prs: [
                    {
                        ...mergedPrFixture,
                        // CheckRun with no name and no status → skipped
                        statusCheckRollup: [{ __typename: "CheckRun", conclusion: null }],
                    },
                ],
            },
            db,
        );

        expect(stats.checks).toBe(0);
        expect(sql.some((s) => s.includes("UPSERT check_run:"))).toBe(false);
        // the rest of the PR still writes
        expect(stats.pullRequests).toBe(1);
        expect(stats.reviews).toBe(1);
    });
});
