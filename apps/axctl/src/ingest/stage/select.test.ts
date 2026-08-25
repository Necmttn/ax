import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { StageRegistry, StageRegistryLive } from "./registry.ts";
import { firstValuePhaseStages, selectByKeys, selectByTag } from "./select.ts";
import { BaseStageStats, StageMeta, type StageDef } from "./types.ts";

const stage = (
    key: string,
    tags: string[],
    deps: string[] = [],
    firstValue?: boolean,
): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: tags as never, writes: [], ...(firstValue === undefined ? {} : { firstValue }) }),
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

describe("firstValuePhaseStages", () => {
    it("returns only firstValue-marked stages plus their transitive deps, in original order", () => {
        const stages = [
            stage("skills", ["ingest"]),
            stage("commands", ["ingest"]),
            stage("pricing", ["ingest"]),
            stage("claude", ["ingest"], ["skills", "commands", "pricing"], true),
            stage("git", ["ingest"]),
            stage("signals", ["derive"], ["claude"]),
        ];
        const out = firstValuePhaseStages(stages);
        expect(out.map((s) => s.meta.key)).toEqual(["skills", "commands", "pricing", "claude"]);
    });

    it("returns an empty array when no stage is marked firstValue", () => {
        const stages = [stage("skills", ["ingest"]), stage("git", ["ingest"], ["skills"])];
        expect(firstValuePhaseStages(stages)).toEqual([]);
    });

    it("walks multi-level transitive deps", () => {
        const stages = [
            stage("skills", ["ingest"]),
            stage("agent-def", ["ingest"], ["skills"]),
            stage("claude-config", ["ingest"], ["agent-def"]),
            stage("claude", ["ingest"], ["claude-config"], true),
        ];
        const out = firstValuePhaseStages(stages);
        expect(out.map((s) => s.meta.key)).toEqual(["skills", "agent-def", "claude-config", "claude"]);
    });

    it("ignores a dep that is outside the given stage set (already handled by selected-stage filters)", () => {
        // "pricing" is a dep of "claude" but was filtered out of `stages` upstream
        // (e.g. by --stages=), so it must not appear here or crash the walk.
        const stages = [
            stage("skills", ["ingest"]),
            stage("claude", ["ingest"], ["skills", "pricing"], true),
        ];
        const out = firstValuePhaseStages(stages);
        expect(out.map((s) => s.meta.key)).toEqual(["skills", "claude"]);
    });

    it("does not duplicate a stage that is both firstValue and a shared dep", () => {
        const stages = [
            stage("skills", ["ingest"]),
            stage("claude", ["ingest"], ["skills"], true),
            stage("codex", ["ingest"], ["skills"], true),
        ];
        const out = firstValuePhaseStages(stages);
        expect(out.map((s) => s.meta.key)).toEqual(["skills", "claude", "codex"]);
    });
});
