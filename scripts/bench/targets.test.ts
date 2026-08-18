import { describe, expect, test } from "bun:test";
import {
    DEFAULT_TARGETS,
    evaluateGates,
    formatMetricTable,
    loadTargets,
} from "./targets.ts";

const underBudget = {
    loadS: 1,
    ftsS: 2,
    snapshotS: 0.5,
    bm25S: 0.01,
    aggS: 0.02,
    traversalInvokedS: 0.01,
    traversalSpawnedS: 0.01,
    cacheBytes: 1024,
};

describe("DEFAULT_TARGETS", () => {
    test("matches the #758 / backlog regression table", () => {
        expect(DEFAULT_TARGETS.loadS).toBe(15);
        expect(DEFAULT_TARGETS.ftsS).toBe(30);
        expect(DEFAULT_TARGETS.snapshotS).toBe(5);
        expect(DEFAULT_TARGETS.bm25S).toBe(0.15);
        expect(DEFAULT_TARGETS.aggS).toBe(0.2);
        expect(DEFAULT_TARGETS.traversalS).toBe(0.05);
        expect(DEFAULT_TARGETS.cacheBytes).toBe(1024 * 1024 * 1024);
    });
});

describe("evaluateGates", () => {
    test("passes when every metric is under its target", () => {
        const result = evaluateGates(underBudget);
        expect(result.ok).toBe(true);
        expect(result.breaches).toEqual([]);
    });

    test("fails when BM25 median exceeds 150ms", () => {
        const result = evaluateGates({ ...underBudget, bm25S: 0.2 });
        expect(result.ok).toBe(false);
        expect(result.breaches.map((b) => b.metric)).toContain("BM25 top-20");
    });

    test("fails when either edge-traversal query exceeds 50ms", () => {
        const invoked = evaluateGates({ ...underBudget, traversalInvokedS: 0.06 });
        const spawned = evaluateGates({ ...underBudget, traversalSpawnedS: 0.06 });
        expect(invoked.ok).toBe(false);
        expect(spawned.ok).toBe(false);
        expect(invoked.breaches.map((b) => b.metric)).toContain(
            "edge-traversal invoked",
        );
        expect(spawned.breaches.map((b) => b.metric)).toContain(
            "edge-traversal spawned",
        );
    });

    test("fails when the cache file exceeds 1GB", () => {
        const result = evaluateGates({
            ...underBudget,
            cacheBytes: 1024 * 1024 * 1024 + 1,
        });
        expect(result.ok).toBe(false);
        expect(result.breaches.map((b) => b.metric)).toContain("cache file");
    });
});

describe("formatMetricTable", () => {
    test("prints measured vs target for every gated metric", () => {
        const table = formatMetricTable(evaluateGates(underBudget));
        expect(table).toContain("full re-derive write path");
        expect(table).toContain("FTS rebuild");
        expect(table).toContain("snapshot copy");
        expect(table).toContain("BM25 top-20");
        expect(table).toContain("aggregate join");
        expect(table).toContain("edge-traversal invoked");
        expect(table).toContain("edge-traversal spawned");
        expect(table).toContain("cache file");
        expect(table).toContain("PASS");
        expect(table).toContain("15s");
        expect(table).toContain("150ms");
    });

    test("marks a breach as FAIL", () => {
        const table = formatMetricTable(
            evaluateGates({ ...underBudget, loadS: 20 }),
        );
        expect(table).toContain("FAIL");
        expect(table).toContain("full re-derive write path");
    });
});

describe("loadTargets", () => {
    test("lets AX_BENCH_MAX_BM25_MS tighten the BM25 gate", () => {
        const targets = loadTargets({ AX_BENCH_MAX_BM25_MS: "0" });
        expect(targets.bm25S).toBe(0);
        const result = evaluateGates(underBudget, targets);
        expect(result.ok).toBe(false);
        expect(result.breaches.map((b) => b.metric)).toContain("BM25 top-20");
    });
});
