import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { recommend, type RecommendInput, type RecommendItem } from "./recommend.ts";
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
});
