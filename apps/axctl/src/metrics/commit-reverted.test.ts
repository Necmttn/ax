import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { advanceRevertedWatermark, computeRevertedCommits } from "./commit-reverted.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("commit reverted", { requireFts: true });

describe("computeRevertedCommits with real DuckDB", () => {
    dtest("marks the feature commit and skips an unchanged graph", async () => {
        let result: Record<string, unknown> = {};
        await runWithPlatform(publishCacheFixture(tempDir("ax-commit-reverted-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const featureAt = new Date("2026-01-01T00:00:00.000Z");
                const fixAt = new Date("2026-01-08T00:00:00.000Z");
                yield* write.put("file", { id: "file-1", repo: "repo", path: "login.ts" });
                yield* write.put("commit", {
                    id: "feature", sha: "feature", repo: "repo", message: "add login", ts: featureAt,
                });
                yield* write.put("commit", {
                    id: "fix", sha: "fix", repo: "repo", message: "fix login bug", ts: fixAt,
                });
                yield* write.putMany("touched", [
                    { id: "touch-feature", in_id: "feature", out_id: "file-1", ts: featureAt },
                    { id: "touch-fix", in_id: "fix", out_id: "file-1", ts: fixAt },
                ]);

                const first = yield* computeRevertedCommits(write);
                const stored = yield* write.rows(
                    Schema.Struct({ reverted: Schema.NullOr(Schema.Boolean) }),
                    `SELECT reverted FROM "commit" WHERE id = ?`,
                    ["feature"],
                );
                yield* advanceRevertedWatermark(write, first.fingerprint);
                const second = yield* computeRevertedCommits(write);
                result = { first, reverted: stored[0]?.reverted, second };
            }),
        ));

        expect(result.first).toMatchObject({ revertedCount: 1, changedKeys: ["feature"], skipped: false });
        expect(result.reverted).toBe(true);
        expect(result.second).toMatchObject({ revertedCount: 1, changedKeys: [], skipped: true });
    });
});
