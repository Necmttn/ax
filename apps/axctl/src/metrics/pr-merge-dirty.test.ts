import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import {
    advancePrMergeWatermark,
    computePrMergeDirtySessions,
    diffPrMergeStates,
    encodePrMergeState,
    mergeShaOfEncoded,
    prMergeWatermarkPath,
} from "./pr-merge-dirty.ts";

const savedForce = process.env.AX_REDERIVE_METRICS;
afterEach(() => {
    if (savedForce === undefined) delete process.env.AX_REDERIVE_METRICS;
    else process.env.AX_REDERIVE_METRICS = savedForce;
});

describe("encodePrMergeState / mergeShaOfEncoded", () => {
    test("round-trips the merge sha (raw, recoverable)", () => {
        expect(mergeShaOfEncoded(encodePrMergeState("abc123", "2026-06-01T00:00:00Z"))).toBe("abc123");
    });

    test("null sha encodes to an empty segment and decodes to null", () => {
        expect(encodePrMergeState(null, "2026-06-01T00:00:00Z")).toBe("|2026-06-01T00:00:00Z");
        expect(mergeShaOfEncoded("|2026-06-01T00:00:00Z")).toBe(null);
    });

    test("null merged_at keeps the sha intact", () => {
        expect(encodePrMergeState("abc123", null)).toBe("abc123|");
        expect(mergeShaOfEncoded("abc123|")).toBe("abc123");
    });
});

describe("diffPrMergeStates", () => {
    const enc = encodePrMergeState;

    test("identical snapshots → empty diff", () => {
        const snap = new Map([["pr1", enc("abc", "2026-06-01T00:00:00Z")]]);
        const diff = diffPrMergeStates(snap, new Map(snap));
        expect(diff.changedShas).toEqual([]);
        expect(diff.upserts).toEqual([]);
        expect(diff.deletes).toEqual([]);
    });

    test("newly merged PR (not stored) → upsert + its merge sha is dirty", () => {
        const diff = diffPrMergeStates(new Map(), new Map([["pr1", enc("abc", "2026-06-01T00:00:00Z")]]));
        expect(diff.changedShas).toEqual(["abc"]);
        expect(diff.upserts).toEqual([{ prKey: "pr1", encoded: "abc|2026-06-01T00:00:00Z" }]);
        expect(diff.deletes).toEqual([]);
    });

    test("merge sha changed → BOTH old and new shas are dirty", () => {
        const diff = diffPrMergeStates(
            new Map([["pr1", enc("old111", "2026-06-01T00:00:00Z")]]),
            new Map([["pr1", enc("new222", "2026-06-02T00:00:00Z")]]),
        );
        expect([...diff.changedShas].sort()).toEqual(["new222", "old111"]);
        expect(diff.upserts).toHaveLength(1);
    });

    test("merged_at changed with the same sha → one dirty sha, one upsert", () => {
        const diff = diffPrMergeStates(
            new Map([["pr1", enc("abc", "2026-06-01T00:00:00Z")]]),
            new Map([["pr1", enc("abc", "2026-06-03T00:00:00Z")]]),
        );
        expect(diff.changedShas).toEqual(["abc"]);
        expect(diff.upserts).toEqual([{ prKey: "pr1", encoded: "abc|2026-06-03T00:00:00Z" }]);
        expect(diff.deletes).toEqual([]);
    });

    test("PR lost its merge state → delete + the OLD sha is dirty", () => {
        const diff = diffPrMergeStates(new Map([["pr1", enc("abc", "2026-06-01T00:00:00Z")]]), new Map());
        expect(diff.changedShas).toEqual(["abc"]);
        expect(diff.upserts).toEqual([]);
        expect(diff.deletes).toEqual(["pr1"]);
    });

    test("a merged_at-only PR (sha null) still produces an upsert but no dirty sha", () => {
        const diff = diffPrMergeStates(new Map(), new Map([["pr1", enc(null, "2026-06-01T00:00:00Z")]]));
        expect(diff.changedShas).toEqual([]);
        expect(diff.upserts).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Effectful: computePrMergeDirtySessions
// ---------------------------------------------------------------------------

interface MockOpts {
    readonly prRows?: Array<Record<string, unknown>>;
    readonly storedRows?: Array<Record<string, unknown>>;
    readonly commitIds?: string[];
    readonly sessionIds?: string[];
}

const makeDb = (opts: MockOpts) => {
    const captured: string[] = [];
    const layer = Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            captured.push(sql);
            if (/FROM pull_request/.test(sql)) return Effect.succeed([opts.prRows ?? []] as unknown as T);
            if (/FROM ingest_file_state/.test(sql)) return Effect.succeed([opts.storedRows ?? []] as unknown as T);
            if (/FROM commit WHERE sha IN/.test(sql)) return Effect.succeed([opts.commitIds ?? []] as unknown as T);
            if (/FROM produced WHERE out IN/.test(sql)) return Effect.succeed([opts.sessionIds ?? []] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);
    return { layer, captured };
};

const run = (layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(computePrMergeDirtySessions().pipe(Effect.provide(layer)));

describe("computePrMergeDirtySessions", () => {
    test("unchanged snapshot → skipped, no commit/produced resolution queries", async () => {
        delete process.env.AX_REDERIVE_METRICS;
        const { layer, captured } = makeDb({
            prRows: [{ id: "pull_request:`pr1`", merge_sha: "abc", merged_at: "2026-06-01T00:00:00Z" }],
            storedRows: [{ path: prMergeWatermarkPath("pr1"), sha: "abc|2026-06-01T00:00:00Z" }],
        });
        const result = await run(layer);
        expect(result.skipped).toBe(true);
        expect(result.dirtySessionIds).toEqual([]);
        expect(result.changedPrs).toBe(0);
        expect(captured.some((s) => /FROM commit WHERE sha IN/.test(s))).toBe(false);
        expect(captured.some((s) => /FROM produced/.test(s))).toBe(false);
    });

    test("newly merged PR → dirty sessions resolved sha → commit → produced.in", async () => {
        delete process.env.AX_REDERIVE_METRICS;
        const { layer, captured } = makeDb({
            prRows: [{ id: "pull_request:`pr1`", merge_sha: "abc123", merged_at: "2026-06-01T00:00:00Z" }],
            storedRows: [],
            commitIds: ["commit:`c9`"],
            sessionIds: ["session:`oldSession`"],
        });
        const result = await run(layer);
        expect(result.skipped).toBe(false);
        expect(result.changedPrs).toBe(1);
        expect(result.dirtySessionIds).toEqual(["session:`oldSession`"]);
        // The sha lookup is bounded to the changed shas (IN-list, not a scan of all).
        const shaQuery = captured.find((s) => /FROM commit WHERE sha IN/.test(s));
        expect(shaQuery).toBeDefined();
        expect(shaQuery!).toContain('"abc123"');
        // The session resolution anchors on produced.out (indexed), no derefs.
        const prodQuery = captured.find((s) => /FROM produced WHERE out IN/.test(s));
        expect(prodQuery).toBeDefined();
        expect(prodQuery!).not.toContain("in.session");
    });

    test("changed sha absent from the commit graph → no dirty sessions, not skipped", async () => {
        delete process.env.AX_REDERIVE_METRICS;
        const { layer, captured } = makeDb({
            prRows: [{ id: "pull_request:`pr1`", merge_sha: "notIngested", merged_at: "2026-06-01T00:00:00Z" }],
            storedRows: [],
            commitIds: [],
        });
        const result = await run(layer);
        expect(result.skipped).toBe(false);
        expect(result.changedPrs).toBe(1);
        expect(result.dirtySessionIds).toEqual([]);
        // The diff still carries the upsert so the caller can advance the mark.
        expect(result.diff.upserts).toHaveLength(1);
        expect(captured.some((s) => /FROM produced/.test(s))).toBe(false);
    });

    test("AX_REDERIVE_METRICS=1 forces the diff against an empty snapshot", async () => {
        process.env.AX_REDERIVE_METRICS = "1";
        const { layer, captured } = makeDb({
            prRows: [{ id: "pull_request:`pr1`", merge_sha: "abc", merged_at: "2026-06-01T00:00:00Z" }],
            // Stored matches exactly - would be skipped without the force.
            storedRows: [{ path: prMergeWatermarkPath("pr1"), sha: "abc|2026-06-01T00:00:00Z" }],
            commitIds: [],
        });
        const result = await run(layer);
        expect(result.skipped).toBe(false);
        expect(result.changedPrs).toBe(1);
        // Forced ⇒ the stored snapshot read is skipped entirely.
        expect(captured.some((s) => /FROM ingest_file_state/.test(s))).toBe(false);
    });
});

describe("advancePrMergeWatermark", () => {
    const collect = () => {
        const stmts: string[] = [];
        const layer = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => {
                stmts.push(sql);
                return Effect.succeed([[]] as unknown as T);
            },
        } as never);
        return { layer, stmts };
    };

    test("UPSERTs the per-PR rows with the raw encoded merge state", async () => {
        const { layer, stmts } = collect();
        await Effect.runPromise(advancePrMergeWatermark({
            changedShas: ["abc"],
            upserts: [{ prKey: "pr1", encoded: "abc|2026-06-01T00:00:00Z" }],
            deletes: [],
        }).pipe(Effect.provide(layer)));
        const all = stmts.join("\n");
        expect(all).toContain("UPSERT ingest_file_state:");
        expect(all).toContain(`"${prMergeWatermarkPath("pr1")}"`);
        expect(all).toContain('"metrics:pr_merge"');
        expect(all).toContain('"abc|2026-06-01T00:00:00Z"');
    });

    test("deletes go by PRIMARY record id, never DELETE ... WHERE", async () => {
        const { layer, stmts } = collect();
        await Effect.runPromise(advancePrMergeWatermark({
            changedShas: ["abc"],
            upserts: [],
            deletes: ["pr1"],
        }).pipe(Effect.provide(layer)));
        const all = stmts.join("\n");
        expect(all).toMatch(/DELETE ingest_file_state:/);
        expect(all).not.toMatch(/DELETE[^;]*WHERE/);
    });

    test("empty diff → no statements issued", async () => {
        const { layer, stmts } = collect();
        await Effect.runPromise(advancePrMergeWatermark({
            changedShas: [],
            upserts: [],
            deletes: [],
        }).pipe(Effect.provide(layer)));
        expect(stmts).toEqual([]);
    });
});
