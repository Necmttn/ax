import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { INGEST_STAGE_DEPS, deriveOnlyKeys, runPipeline, selectStages, topoLayers, type StageSpec } from "./pipeline.ts";

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

describe("runPipeline DAG scheduling", () => {
    test("a dep-free long stage does not block downstream stages whose deps are met", async () => {
        // Models the real bug: git (deps=[]) ran in layer 0 with skills+commands
        // and blocked claude/codex (layer 1) until git finished. With DAG
        // scheduling, claude starts as soon as skills+commands complete, even
        // while git is still running.
        const started: string[] = [];
        const finished: string[] = [];
        let releaseGit: () => void = () => {};
        const gitDone = new Promise<void>((resolve) => { releaseGit = resolve; });

        const mk = (key: string, deps: string[], run: () => Promise<void>): StageSpec => ({
            key,
            deps,
            run: () => Effect.promise(async () => {
                started.push(key);
                await run();
                finished.push(key);
            }),
        });

        const program = runPipeline([
            mk("skills", [], async () => {}),
            mk("commands", [], async () => {}),
            mk("git", [], async () => { await gitDone; }),
            mk("claude", ["skills", "commands"], async () => {}),
        ]);
        const promise = Effect.runPromise(program);
        // Let claude run once its deps clear, even though git is still pending.
        await new Promise((r) => setTimeout(r, 50));
        expect(finished).toContain("claude");
        expect(finished).not.toContain("git");
        releaseGit();
        await promise;
        expect(new Set(finished)).toEqual(new Set(["skills", "commands", "git", "claude"]));
    });
});

describe("INGEST_STAGE_DEPS", () => {
    test("has all 16 canonical stages", () => {
        expect(Object.keys(INGEST_STAGE_DEPS).sort()).toEqual(
            [
                "claude", "closure", "codex", "commands", "git", "harness",
                "invoked-positions", "opportunities", "outcomes", "proposals",
                "retro-proposals", "session-health", "signals", "skills",
                "spawned", "subagents",
            ].sort(),
        );
    });
    test("subagents depends on claude + codex", () => {
        expect(new Set(INGEST_STAGE_DEPS.subagents)).toEqual(
            new Set(["claude", "codex"]),
        );
    });
    test("deriveOnlyKeys are the DB-only re-derive stages", () => {
        expect(new Set(deriveOnlyKeys())).toEqual(
            new Set([
                "signals", "outcomes", "session-health", "closure", "proposals", "opportunities", "retro-proposals",
            ]),
        );
    });
});

describe("selectStages", () => {
    test("explicit keys: only those stages, deps NOT auto-added", () => {
        const sel = selectStages(["signals"]);
        expect(sel).toEqual(["signals"]);
    });
    test("unknown key throws with the valid list", () => {
        expect(() => selectStages(["bogus"])).toThrow(/bogus/);
    });
    test("topoLayers tolerates a dep outside the selection", () => {
        const layers = topoLayers([
            { key: "signals", deps: ["claude"], run: () => Effect.succeed(undefined) },
        ]);
        expect(layers).toEqual([["signals"]]);
    });
});
