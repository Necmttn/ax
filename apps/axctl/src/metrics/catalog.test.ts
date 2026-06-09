import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { SIGNAL_CATALOG, findSignal, runRelationSignal } from "./catalog.ts";

// Minimal SurrealClient stub: every query returns an empty result set, so the
// bounded fragility-cascade computation dispatches and returns [].
const StubSurreal = Layer.succeed(SurrealClient, {
    query: <T>() => Effect.succeed([[]] as unknown as T),
} as never);

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(StubSurreal)));

describe("SIGNAL_CATALOG", () => {
    it("contains fragility_cascade as a relation signal", () => {
        const sig = SIGNAL_CATALOG.find((s) => s.id === "fragility_cascade");
        expect(sig).toBeDefined();
        expect(sig?.kind).toBe("relation");
    });
});

describe("findSignal", () => {
    it("returns the descriptor for a known id", () => {
        const sig = findSignal("fragility_cascade");
        expect(sig).toBeDefined();
        expect(sig?.id).toBe("fragility_cascade");
    });

    it("returns undefined for an unknown id", () => {
        expect(findSignal("nope")).toBeUndefined();
    });
});

describe("runRelationSignal", () => {
    it("dispatches fragility_cascade and yields edges", async () => {
        const edges = await run(runRelationSignal("fragility_cascade"));
        expect(Array.isArray(edges)).toBe(true);
        expect(edges).toEqual([]);
    });

    it("returns [] for an unknown signal id", async () => {
        const edges = await run(runRelationSignal("unknown"));
        expect(edges).toEqual([]);
    });
});
