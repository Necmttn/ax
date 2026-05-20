import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runPipeline, topoLayers, type StageSpec } from "./pipeline.ts";

/** Minimal specs - `run` records the order it executed in. */
const spec = (key: string, deps: string[]): StageSpec => ({
    key,
    deps,
    run: () => Effect.succeed(undefined),
});

describe("topoLayers", () => {
    test("independent stages land in the same layer", () => {
        const layers = topoLayers([spec("a", []), spec("b", [])]);
        expect(layers.length).toBe(1);
        expect(new Set(layers[0])).toEqual(new Set(["a", "b"]));
    });

    test("a dependency pushes a stage to a later layer", () => {
        const layers = topoLayers([spec("a", []), spec("b", ["a"])]);
        expect(layers).toEqual([["a"], ["b"]]);
    });

    test("claude + codex parallel, subagents after both", () => {
        const layers = topoLayers([
            spec("claude", []),
            spec("codex", []),
            spec("subagents", ["claude", "codex"]),
        ]);
        expect(new Set(layers[0])).toEqual(new Set(["claude", "codex"]));
        expect(layers[1]).toEqual(["subagents"]);
    });

    test("a cycle throws", () => {
        expect(() => topoLayers([spec("a", ["b"]), spec("b", ["a"])])).toThrow(
            /cycle/i,
        );
    });

    test("a dep on an unselected stage throws", () => {
        expect(() => topoLayers([spec("b", ["a"])])).toThrow(/unknown dep/i);
    });

    test("diamond deps: d lands in layer 2, not layer 1", () => {
        const layers = topoLayers([
            spec("a", []),
            spec("b", ["a"]),
            spec("c", ["a"]),
            spec("d", ["b", "c"]),
        ]);
        expect(layers[0]).toEqual(["a"]);
        expect(new Set(layers[1])).toEqual(new Set(["b", "c"]));
        expect(layers[2]).toEqual(["d"]);
    });

    test("empty input → empty layers", () => {
        expect(topoLayers([])).toEqual([]);
    });
});

describe("runPipeline", () => {
    test("runs every selected stage exactly once, deps before dependents", async () => {
        const order: string[] = [];
        const mk = (key: string, deps: string[]): StageSpec => ({
            key,
            deps,
            run: () => Effect.sync(() => { order.push(key); }),
        });
        await Effect.runPromise(
            runPipeline([mk("a", []), mk("b", ["a"]), mk("c", ["a"])]),
        );
        expect(order[0]).toBe("a");
        expect(new Set(order)).toEqual(new Set(["a", "b", "c"]));
        expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
        expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    });
});
