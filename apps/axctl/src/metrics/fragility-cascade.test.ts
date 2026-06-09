import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeFragilityCascade, type CascadeEdge } from "./fragility-cascade.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("computeFragilityCascade", () => {
    test("origin→downstream edges weighted by distinct downstream fixers", async () => {
        const rows = [
            { origin: "session:`A`", downstream: "session:`B`", file: "file:`f1`" },
            { origin: "session:`A`", downstream: "session:`B`", file: "file:`f2`" },
            { origin: "session:`A`", downstream: "session:`C`", file: "file:`f1`" },
        ];
        const edges = await Effect.runPromise(computeFragilityCascade().pipe(Effect.provide(db(rows))));
        const a = edges.filter((e: CascadeEdge) => e.origin === "session:`A`");
        expect(a.every((e) => e.weight === 2)).toBe(true); // distinct downstreams {B,C}=2
        expect(new Set(a.map((e) => e.downstream))).toEqual(new Set(["session:`B`", "session:`C`"]));
        expect(a.length).toBe(2); // deduped to distinct (origin,downstream) pairs
    });
    test("empty graph → no edges", async () => {
        const edges = await Effect.runPromise(computeFragilityCascade().pipe(Effect.provide(db([]))));
        expect(edges).toEqual([]);
    });
    test("drops rows with null/missing origin", async () => {
        const rows = [{ origin: "null", downstream: "session:`B`", file: "file:`f`" }];
        const edges = await Effect.runPromise(computeFragilityCascade().pipe(Effect.provide(db(rows))));
        expect(edges).toEqual([]);
    });
});
