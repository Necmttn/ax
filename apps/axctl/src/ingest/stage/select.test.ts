import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { StageRegistry, StageRegistryLive } from "./registry.ts";
import { selectByKeys, selectByTag } from "./select.ts";
import { BaseStageStats, StageMeta, type StageDef } from "./types.ts";

const stage = (key: string, tags: string[], deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: tags as never }),
    run: () => Effect.succeed(BaseStageStats.make({ durationMs: 0, summary: key })),
});

const fixture = [
    stage("skills", ["ingest"]),
    stage("claude", ["ingest"], ["skills"]),
    stage("signals", ["derive"], ["claude"]),
];

describe("selectByKeys", () => {
    it("returns matching stages in registry order", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            return selectByKeys(reg, ["claude", "signals"]);
        });
        const Live = StageRegistryLive(fixture);
        const out = await Effect.runPromise(program.pipe(Effect.provide(Live)));
        expect(out.map((s) => s.meta.key)).toEqual(["claude", "signals"]);
    });

    it("throws on unknown key", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            return selectByKeys(reg, ["bogus"]);
        });
        const Live = StageRegistryLive(fixture);
        await expect(
            Effect.runPromise(program.pipe(Effect.provide(Live))),
        ).rejects.toThrow(/unknown stage\(s\): bogus/);
    });
});

describe("selectByTag", () => {
    it("filters by tag", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            return selectByTag(reg, "derive");
        });
        const Live = StageRegistryLive(fixture);
        const out = await Effect.runPromise(program.pipe(Effect.provide(Live)));
        expect(out.map((s) => s.meta.key)).toEqual(["signals"]);
    });
});
