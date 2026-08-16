import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    advancePrMergeWatermark,
    computePrMergeDirtySessions,
    diffPrMergeStates,
    encodePrMergeState,
    mergeShaOfEncoded,
} from "./pr-merge-dirty.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("PR merge dirty", {
    requireFts: true,
});

const savedForce = process.env.AX_REDERIVE_METRICS;
afterEach(() => {
    if (savedForce === undefined) delete process.env.AX_REDERIVE_METRICS;
    else process.env.AX_REDERIVE_METRICS = savedForce;
});

describe("PR merge state", () => {
    test("encodes and decodes merge state", () => {
        expect(mergeShaOfEncoded(encodePrMergeState("abc123", "2026-06-01T00:00:00Z"))).toBe("abc123");
        expect(mergeShaOfEncoded(encodePrMergeState(null, "2026-06-01T00:00:00Z"))).toBeNull();
        expect(mergeShaOfEncoded(encodePrMergeState("abc123", null))).toBe("abc123");
    });

    test("detects new, changed, and deleted merge states", () => {
        const oldState = encodePrMergeState("old", "2026-06-01T00:00:00Z");
        const newState = encodePrMergeState("new", "2026-06-02T00:00:00Z");
        const changed = diffPrMergeStates(new Map([["pr1", oldState]]), new Map([["pr1", newState]]));
        expect([...changed.changedShas].sort()).toEqual(["new", "old"]);
        expect(changed.upserts).toEqual([{ prKey: "pr1", encoded: newState }]);
        expect(diffPrMergeStates(new Map([["pr1", oldState]]), new Map()).deletes).toEqual(["pr1"]);
    });
});

describe("real DuckDB PR watermark", () => {
    dtest("writes and deletes a watermark after dependent rows resolve", async () => {
        let result: Record<string, unknown> = {};
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-watermark-delete-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const mergedAt = new Date("2026-06-01T00:00:00.000Z");
                yield* write.put("session", { id: "session-1", source: "claude", started_at: mergedAt });
                yield* write.put("pull_request", {
                    id: "pr1", repository: "repo", number: 1, title: "PR 1", state: "merged",
                    merge_sha: "abc123", merged_at: mergedAt,
                });
                yield* write.put("commit", { id: "commit-1", sha: "abc123", repo: "repo", message: "merge", ts: mergedAt });
                yield* write.put("produced", { id: "produced-1", in_id: "session-1", out_id: "commit-1", ts: mergedAt });

                const first = yield* computePrMergeDirtySessions(write);
                yield* advancePrMergeWatermark(write, first.diff);
                const written = yield* write.rows(
                    Schema.Struct({ count: Schema.BigInt }),
                    "SELECT count(*) AS count FROM ingest_file_state WHERE source_kind = 'metrics:pr_merge'",
                );

                yield* write.exec("DELETE FROM pull_request WHERE id = ?", ["pr1"]);
                const second = yield* computePrMergeDirtySessions(write);
                yield* advancePrMergeWatermark(write, second.diff);
                const deleted = yield* write.rows(
                    Schema.Struct({ count: Schema.BigInt }),
                    "SELECT count(*) AS count FROM ingest_file_state WHERE source_kind = 'metrics:pr_merge'",
                );
                result = {
                    dirty: first.dirtySessionIds,
                    written: written[0]?.count,
                    deletes: second.diff.deletes,
                    deleted: deleted[0]?.count,
                };
            }),
        ));
        expect(result).toEqual({ dirty: ["session-1"], written: 1n, deletes: ["pr1"], deleted: 0n });
    });

    dtest("defers a watermark until the merge commit exists", async () => {
        let result: Record<string, unknown> = {};
        await runWithPlatform(publishCacheFixture(tempDir("ax-pr-watermark-defer-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("pull_request", {
                    id: "pr2",
                    repository: "repo",
                    number: 2,
                    title: "PR 2",
                    state: "merged",
                    merge_sha: "missing",
                    merged_at: new Date("2026-06-01T00:00:00.000Z"),
                });
                const dirty = yield* computePrMergeDirtySessions(write);
                yield* advancePrMergeWatermark(write, dirty.diff);
                const rows = yield* write.rows(
                    Schema.Struct({ count: Schema.BigInt }),
                    "SELECT count(*) AS count FROM ingest_file_state WHERE source_kind = 'metrics:pr_merge'",
                );
                result = { deferred: dirty.deferredPrs, upserts: dirty.diff.upserts.length, rows: rows[0]?.count };
            }),
        ));
        expect(result).toEqual({ deferred: 1, upserts: 0, rows: 0n });
    });
});
