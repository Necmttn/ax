import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { recommend, formatRecommendations, selectByIndices, parseIndexInput, type RecommendItem } from "./recommend.ts";
import { SurrealClient } from "../lib/db.ts";

const layerWith = (rows: ReadonlyArray<unknown>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.succeed([rows] as unknown as T),
    } as never);

describe("recommend", () => {
    test("ranks by confidence × recency × frequency", async () => {
        const rows = [
            { dedupe_sig: "lowfreq", title: "x", form: "guidance", hypothesis: "h", confidence: "low",
              frequency: 1, updated_at: "2026-01-01T00:00:00Z" },
            { dedupe_sig: "hot", title: "y", form: "guidance", hypothesis: "h", confidence: "high",
              frequency: 10, updated_at: "2026-05-20T00:00:00Z" },
            { dedupe_sig: "old", title: "z", form: "guidance", hypothesis: "h", confidence: "medium",
              frequency: 5, updated_at: "2025-12-01T00:00:00Z" },
        ];
        const out = await Effect.runPromise(
            recommend({ limit: 5 }).pipe(Effect.provide(layerWith(rows))),
        );
        expect(out.map((r: RecommendItem) => r.shortId)).toEqual(["hot", "old", "lowfreq"]);
    });

    test("honors --limit", async () => {
        const rows = Array.from({ length: 12 }).map((_, i) => ({
            dedupe_sig: `s${i}`, title: "t", form: "guidance", hypothesis: "h",
            confidence: "medium", frequency: i, updated_at: "2026-05-20T00:00:00Z",
        }));
        const out = await Effect.runPromise(
            recommend({ limit: 3 }).pipe(Effect.provide(layerWith(rows))),
        );
        expect(out.length).toBe(3);
    });

    test("filters by form", async () => {
        const rows = [
            { dedupe_sig: "a", form: "skill", title: "t", hypothesis: "h", confidence: "high", frequency: 1, updated_at: "2026-05-20T00:00:00Z" },
            { dedupe_sig: "b", form: "guidance", title: "t", hypothesis: "h", confidence: "high", frequency: 1, updated_at: "2026-05-20T00:00:00Z" },
        ];
        const out = await Effect.runPromise(
            recommend({ limit: 5, forms: ["guidance"] }).pipe(Effect.provide(layerWith(rows))),
        );
        expect(out.map((r) => r.shortId)).toEqual(["b"]);
    });

    test("treats malformed updated_at as fully stale (no NaN sort)", async () => {
        const rows = [
            { dedupe_sig: "bad", title: "t", form: "guidance", hypothesis: "h",
              confidence: "high", frequency: 5, updated_at: "" },
            { dedupe_sig: "good", title: "t", form: "guidance", hypothesis: "h",
              confidence: "low", frequency: 1, updated_at: new Date().toISOString() },
        ];
        const out = await Effect.runPromise(
            recommend({ limit: 5 }).pipe(Effect.provide(layerWith(rows))),
        );
        // Sanity: both rows should appear, neither should produce NaN score.
        expect(out.every((r) => Number.isFinite(r.score))).toBe(true);
        expect(out.length).toBe(2);
    });

    test("high-confidence freq=0 outranks low-confidence freq=2 with same recency", async () => {
        const now = new Date().toISOString();
        const rows = [
            { dedupe_sig: "new-hot", title: "t", form: "guidance", hypothesis: "h",
              confidence: "high", frequency: 0, updated_at: now },
            { dedupe_sig: "old-cold", title: "t", form: "guidance", hypothesis: "h",
              confidence: "low", frequency: 2, updated_at: now },
        ];
        const out = await Effect.runPromise(
            recommend({ limit: 5 }).pipe(Effect.provide(layerWith(rows))),
        );
        expect(out[0]!.shortId).toBe("new-hot");
    });
});

describe("formatRecommendations", () => {
    test("guidance items wrap suggested text in marker pair", () => {
        const items: RecommendItem[] = [{
            shortId: "e7f3", title: "Use ripgrep", form: "guidance",
            hypothesis: "12 corrections", confidence: "high", frequency: 3,
            score: 1, updatedAt: "2026-05-20T00:00:00Z",
        }];
        const out = formatRecommendations(items);
        expect(out).toContain("<!--ax:e7f3-->");
        expect(out).toContain("<!--/ax:e7f3-->");
        expect(out).toContain("Use ripgrep");
    });

    test("skill items show frontmatter sketch instead of marker", () => {
        const items: RecommendItem[] = [{
            shortId: "s1", title: "Pre-Bash guard", form: "skill",
            hypothesis: "Bash failed 7×", confidence: "medium", frequency: 7,
            score: 1, updatedAt: "2026-05-20T00:00:00Z",
        }];
        const out = formatRecommendations(items);
        expect(out).toContain("ax_id: s1");
    });
});

describe("selectByIndices", () => {
    test("returns picked items in input order", () => {
        const items: RecommendItem[] = [
            { shortId: "a", title: "A", form: "guidance", hypothesis: "h", confidence: "high", frequency: 1, score: 1, updatedAt: "" },
            { shortId: "b", title: "B", form: "guidance", hypothesis: "h", confidence: "high", frequency: 1, score: 1, updatedAt: "" },
            { shortId: "c", title: "C", form: "guidance", hypothesis: "h", confidence: "high", frequency: 1, score: 1, updatedAt: "" },
        ];
        expect(selectByIndices(items, [0, 2]).map((i) => i.shortId)).toEqual(["a", "c"]);
        expect(selectByIndices(items, [99])).toEqual([]);
    });
});

describe("parseIndexInput", () => {
    test("parses space-separated and range syntaxes", () => {
        expect(parseIndexInput("1 3", 5)).toEqual([0, 2]);
        expect(parseIndexInput("1-3", 5)).toEqual([0, 1, 2]);
        expect(parseIndexInput("1, 2, 4-5", 5)).toEqual([0, 1, 3, 4]);
    });

    test("clamps out-of-range indices and skips junk tokens", () => {
        expect(parseIndexInput("1 99 abc", 3)).toEqual([0]);
    });
});
