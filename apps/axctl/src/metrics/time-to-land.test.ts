import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeTimeToLand } from "./time-to-land.ts";
import { SurrealClient } from "@ax/lib/db";

// Two-query join: route `FROM pull_request` vs `FROM produced`.
const db = (produced: Array<Record<string, unknown>>, prs: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/FROM pull_request/.test(sql)) return Effect.succeed([prs] as unknown as T);
            if (/FROM produced/.test(sql)) return Effect.succeed([produced] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("computeTimeToLand", () => {
    test("ms from the commit's ts to the merged_at of the PR matching its sha", async () => {
        const produced = [{ session: "session:`s1`", commit_ts: "2026-01-01T00:00:00Z", sha: "abc" }];
        const prs = [{ merge_sha: "abc", merged_at: "2026-01-01T01:00:00Z" }];
        const out = await Effect.runPromise(computeTimeToLand(["session:`s1`"]).pipe(Effect.provide(db(produced, prs))));
        expect(out.get("session:`s1`")).toBe(3600000); // 1h
    });

    test("takes the fastest commit→merge latency across multiple produced commits", async () => {
        const produced = [
            { session: "session:`s1`", commit_ts: "2026-01-01T00:00:00Z", sha: "early" },
            { session: "session:`s1`", commit_ts: "2026-01-01T00:00:00Z", sha: "late" },
        ];
        const prs = [
            { merge_sha: "late", merged_at: "2026-01-01T05:00:00Z" },
            { merge_sha: "early", merged_at: "2026-01-01T02:00:00Z" },
        ];
        const out = await Effect.runPromise(computeTimeToLand(["session:`s1`"]).pipe(Effect.provide(db(produced, prs))));
        expect(out.get("session:`s1`")).toBe(2 * 3600000); // fastest = 2h
    });

    test("never negative: a merge timestamped before the commit (clock skew) is dropped", async () => {
        const produced = [
            { session: "session:`s1`", commit_ts: "2026-01-01T02:00:00Z", sha: "skew" },
            { session: "session:`s1`", commit_ts: "2026-01-01T00:00:00Z", sha: "ok" },
        ];
        const prs = [
            { merge_sha: "skew", merged_at: "2026-01-01T01:00:00Z" }, // before its commit → dropped
            { merge_sha: "ok", merged_at: "2026-01-01T03:00:00Z" },
        ];
        const out = await Effect.runPromise(computeTimeToLand(["session:`s1`"]).pipe(Effect.provide(db(produced, prs))));
        expect(out.get("session:`s1`")).toBe(3 * 3600000); // the skewed pair never wins
    });

    test("only-skewed pairs → null, not a negative", async () => {
        const produced = [{ session: "session:`s2`", commit_ts: "2026-01-01T02:00:00Z", sha: "skew" }];
        const prs = [{ merge_sha: "skew", merged_at: "2026-01-01T01:00:00Z" }];
        const out = await Effect.runPromise(computeTimeToLand(["session:`s2`"]).pipe(Effect.provide(db(produced, prs))));
        expect(out.get("session:`s2`")).toBe(null);
    });

    test("no merged PR matching a produced sha → null", async () => {
        const produced = [{ session: "session:`s9`", commit_ts: "2026-01-01T00:00:00Z", sha: "x" }];
        const out = await Effect.runPromise(computeTimeToLand(["session:`s9`"]).pipe(Effect.provide(db(produced, []))));
        expect(out.get("session:`s9`")).toBe(null);
    });

    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(computeTimeToLand([]).pipe(Effect.provide(db([], []))));
        expect(out.size).toBe(0);
    });
});
