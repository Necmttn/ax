import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { GithubPrKey, githubPrStage, ingestGithubPrs, resolveFetchCooldownMs } from "./github-pr-stage.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("GitHub PR stage", { requireFts: true });
const pr = { number: 42, title: "Change", state: "OPEN", createdAt: "2026-05-08T09:00:00Z" };

describe("githubPrStage", () => {
    test("declares the canonical key, dependencies, and tags", () => {
        expect(Schema.decodeUnknownSync(GithubPrKey)("github-pr")).toBe("github-pr");
        expect(githubPrStage.meta.key).toBe("github-pr");
        expect(githubPrStage.meta.deps).toEqual(["git"]);
        expect(githubPrStage.meta.tags).toEqual(["ingest"]);
    });
});

describe("ingestGithubPrs on real DuckDB", () => {
    dtest("returns zeros for an empty repository table", async () => {
        let totals: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-stage-empty-"), dylibPath, (write) =>
            Effect.gen(function* () {
                totals = yield* ingestGithubPrs(write);
            }),
        ));
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

    dtest("fetches and writes one discovered GitHub repository", async () => {
        const seen: unknown[] = [];
        let totals: unknown;
        let count = -1;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-stage-write-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("repository", [
                    { id: "github", root_path: "/tmp/github", remote_url: "https://github.com/o/r" },
                    { id: "gitlab", root_path: "/tmp/gitlab", remote_url: "https://gitlab.com/o/r" },
                ]);
                totals = yield* ingestGithubPrs(write, {
                    updatedSince: "2026-06-09",
                    fetchImpl: (input) => {
                        seen.push(input);
                        return Effect.succeed({ ok: true as const, prs: [pr] });
                    },
                });
                count = (yield* write.rows(Schema.Struct({ count: Schema.Number }),
                    "SELECT count(*)::INTEGER AS count FROM pull_request"))[0]!.count;
            }),
        ));
        expect(totals).toMatchObject({ repositoriesScanned: 1, repositoriesDegraded: 0, pullRequests: 1 });
        expect(seen).toEqual([{ cwd: "/tmp/github", limit: 200, updatedSince: "2026-06-09" }]);
        expect(count).toBe(1);
    });

    dtest("scopes repository paths and reports a degraded fetch", async () => {
        const seen: string[] = [];
        let totals: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-stage-scope-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("repository", [
                    { id: "a", root_path: "/tmp/a", remote_url: "https://github.com/o/a" },
                    { id: "b", root_path: "/tmp/b", remote_url: "https://github.com/o/b" },
                ]);
                totals = yield* ingestGithubPrs(write, {
                    repoPaths: ["/tmp/b"],
                    fetchImpl: (input) => {
                        seen.push(input.cwd);
                        return Effect.succeed({ ok: false as const, prs: [], detail: "timeout" });
                    },
                });
            }),
        ));
        expect(seen).toEqual(["/tmp/b"]);
        expect(totals).toMatchObject({ repositoriesScanned: 1, repositoriesDegraded: 1, pullRequests: 0 });
    });

    dtest("uses a successful fetch watermark for cooldown", async () => {
        const now = 1_750_000_000_000;
        let fetches = 0;
        let first: unknown;
        let second: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-stage-cooldown-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("repository", {
                    id: "github", root_path: "/tmp/github", remote_url: "https://github.com/o/r",
                });
                const deps = {
                    fetchCooldownMs: 15 * 60 * 1000,
                    now: () => now,
                    fetchImpl: () => {
                        fetches += 1;
                        return Effect.succeed({ ok: true as const, prs: [] });
                    },
                };
                first = yield* ingestGithubPrs(write, deps);
                second = yield* ingestGithubPrs(write, deps);
            }),
        ));
        expect(fetches).toBe(1);
        expect(first).toMatchObject({ repositoriesSkippedCooldown: 0 });
        expect(second).toMatchObject({ repositoriesSkippedCooldown: 1 });
    });
});

describe("resolveFetchCooldownMs", () => {
    test("uses the default and validates overrides", () => {
        expect(resolveFetchCooldownMs({})).toBe(15 * 60 * 1000);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "60" })).toBe(60_000);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "0" })).toBe(0);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "nope" })).toBe(15 * 60 * 1000);
        expect(resolveFetchCooldownMs({ AX_GITHUB_PR_FETCH_COOLDOWN_SECONDS: "-5" })).toBe(15 * 60 * 1000);
    });
});
