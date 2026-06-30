import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
    ALL_STAGES,
    StageRegistry,
    StageRegistryLive,
    type StageDef,
} from "./registry.ts";
import { BaseStageStats, StageMeta } from "./types.ts";

const fakeStage: StageDef = {
    meta: StageMeta.make({ key: "skills", deps: [], tags: ["ingest"] }),
    run: (_ctx) =>
        Effect.succeed(
            BaseStageStats.make({ durationMs: 0, summary: "noop" }),
        ),
};

describe("StageRegistry", () => {
    it("exposes the registered stages by key", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            const all = reg.all();
            expect(all).toHaveLength(1);
            expect(reg.byKey("skills")?.meta.key).toBe("skills");
        });
        const Live = StageRegistryLive([fakeStage]);
        await Effect.runPromise(program.pipe(Effect.provide(Live)));
    });

    it("filters by tag", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            const ingestStages = reg.byTag("ingest");
            expect(ingestStages.map((s) => s.meta.key)).toEqual(["skills"]);
        });
        const Live = StageRegistryLive([fakeStage]);
        await Effect.runPromise(program.pipe(Effect.provide(Live)));
    });

    it("registers local agent provider ingest stages after codex", () => {
        const keys = ALL_STAGES.map((stage) => stage.meta.key);
        expect(keys.slice(keys.indexOf("codex"), keys.indexOf("codex") + 5)).toEqual([
            "codex",
            "pi",
            "omp",
            "opencode",
            "cursor",
        ]);
    });

    it("runs turn-analysis after outcomes so feedback graph has ngram/outcome context", () => {
        const keys = ALL_STAGES.map((stage) => stage.meta.key);
        expect(keys.indexOf("turn-analysis")).toBeGreaterThan(keys.indexOf("outcomes"));
        expect(keys.indexOf("reaction-events")).toBeGreaterThan(keys.indexOf("turn-analysis"));
        expect(keys.indexOf("classifier-results")).toBeGreaterThan(keys.indexOf("turn-analysis"));
        expect(keys.indexOf("session-health")).toBeGreaterThan(keys.indexOf("turn-analysis"));
    });

    it("parses turn content blocks after provider ingests and before feedback analysis", () => {
        const keys = ALL_STAGES.map((stage) => stage.meta.key);
        expect(keys.indexOf("turn-content-blocks")).toBeGreaterThan(keys.indexOf("cursor"));
        expect(keys.indexOf("turn-analysis")).toBeGreaterThan(keys.indexOf("turn-content-blocks"));
    });

    it("registers claude-config after agent-def with catalog deps", () => {
        const keys = ALL_STAGES.map((stage) => stage.meta.key);
        const stage = ALL_STAGES.find((s) => s.meta.key === "claude-config");
        expect(stage?.meta.deps).toEqual(["skills", "commands", "agent-def"]);
        expect(stage?.meta.tags).toEqual(["ingest"]);
        expect(keys.indexOf("claude-config")).toBe(keys.indexOf("agent-def") + 1);
    });

    it("all stage keys are unique (no duplicates)", () => {
        const keys = ALL_STAGES.map((s) => s.meta.key);
        const uniqueKeys = new Set(keys);
        expect(uniqueKeys.size).toBe(keys.length);
    });

    it("all stage deps reference valid stage keys (deps-validity guard)", () => {
        const keySet = new Set(ALL_STAGES.map((s) => s.meta.key));
        const invalid: Array<{ stage: string; dep: string }> = [];
        for (const s of ALL_STAGES) {
            for (const dep of s.meta.deps) {
                if (!keySet.has(dep)) {
                    invalid.push({ stage: s.meta.key, dep });
                }
            }
        }
        expect(invalid).toEqual([]);
    });
});
