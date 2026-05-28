import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
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
});
