import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { writePullRequests } from "./github-pr-write.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("GitHub PR writer", { requireFts: true });

const mergedPr = {
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
    reviews: [{
        author: { login: "reviewer1", type: "User" },
        state: "APPROVED",
        body: "lgtm",
        submittedAt: "2026-05-09T10:00:00.000Z",
    }],
    statusCheckRollup: [{
        __typename: "CheckRun",
        name: "ci/test",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://ci.example/1",
        startedAt: "2026-05-09T09:30:00.000Z",
        completedAt: "2026-05-09T09:45:00.000Z",
    }],
};

const input = (prs: readonly unknown[]) => ({ repositoryId: "repo-key", repositoryKey: "repo-key", prs });

describe("writePullRequests on real DuckDB", () => {
    dtest("writes a merged PR and its linked delivery records", async () => {
        let stats: unknown;
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-write-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("repository", { id: "repo-key", root_path: "/repo" });
                yield* write.put("session", { id: "sess-1", source: "claude", started_at: new Date("2026-05-08T00:00:00Z") });
                yield* write.put("commit", {
                    id: "commit-1", repository: "repo-key", repo: "/repo", sha: "abc123",
                    ts: new Date("2026-05-09T12:00:00Z"),
                });
                yield* write.put("produced", { id: "produced-1", in_id: "sess-1", out_id: "commit-1" });
                stats = yield* writePullRequests(write, input([mergedPr]));
                row = (yield* write.rows(Schema.Struct({
                    state: Schema.String,
                    additions: Schema.Number,
                    delivery_status: Schema.String,
                    promotion_path: Schema.String,
                    check_commit: Schema.String,
                }), `SELECT p.state, p.additions::INTEGER AS additions,
                    (SELECT status FROM delivery_outcome LIMIT 1) AS delivery_status,
                    (SELECT promotion_path FROM delivery_outcome LIMIT 1) AS promotion_path,
                    (SELECT commit FROM check_run LIMIT 1) AS check_commit
                    FROM pull_request p LIMIT 1`))[0];
            }),
        ));
        expect(stats).toEqual({ pullRequests: 1, reviews: 1, checks: 1, deliveryOutcomes: 1 });
        expect(row).toEqual({
            state: "merged",
            additions: 120,
            delivery_status: "merged_to_main",
            promotion_path: "pr",
            check_commit: "commit-1",
        });
    });

    dtest("does not write delivery data when no commit matches", async () => {
        let stats: unknown;
        let rows: readonly unknown[] = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-unlinked-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("repository", { id: "repo-key", root_path: "/repo" });
                stats = yield* writePullRequests(write, input([mergedPr]));
                rows = yield* write.rows(Schema.Struct({ commit: Schema.NullOr(Schema.String) }),
                    "SELECT commit FROM check_run");
            }),
        ));
        expect(stats).toEqual({ pullRequests: 1, reviews: 1, checks: 1, deliveryOutcomes: 0 });
        expect(rows).toEqual([{ commit: null }]);
    });

    dtest("skips invalid PR, review, and check records", async () => {
        let invalidPr: unknown;
        let partialPr: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-invalid-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("repository", { id: "repo-key", root_path: "/repo" });
                invalidPr = yield* writePullRequests(write, input([{ ...mergedPr, number: null }]));
                partialPr = yield* writePullRequests(write, input([{
                    ...mergedPr,
                    reviews: [{ author: { login: "r" }, body: "no state" }],
                    statusCheckRollup: [{}],
                }]));
            }),
        ));
        expect(invalidPr).toEqual({ pullRequests: 0, reviews: 0, checks: 0, deliveryOutcomes: 0 });
        expect(partialPr).toEqual({ pullRequests: 1, reviews: 0, checks: 0, deliveryOutcomes: 0 });
    });
});
