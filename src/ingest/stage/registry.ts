import { Context, Layer, Schema } from "effect";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";
import { SkillsKey, skillsStage } from "../skills.ts";
import { CommandsKey, commandsStage } from "../commands.ts";
import { ClaudeKey, claudeStage } from "../transcripts.ts";
import { CodexKey, codexStage } from "../codex.ts";
import { SubagentsKey, subagentsStage } from "../derive-claude-subagents.ts";
import { SpawnedKey, spawnedStage } from "../derive-spawned.ts";
import { GitKey, gitStage } from "../git.ts";
import { SignalsKey, signalsStage } from "../derive-signals.ts";
import { OutcomesKey, outcomesStage } from "../outcomes.ts";

export type { StageDef } from "./types.ts";

/** Composed union of every known Ingest Stage key. Each stage file exports its
 *  own `Schema.Literal("<key>")`; this union is reassembled by re-exporting
 *  them here. Adding a stage = one import + one entry in the union below. */
export const IngestStageKey = Schema.Union([SkillsKey, CommandsKey, ClaudeKey, CodexKey, SubagentsKey, SpawnedKey, GitKey, SignalsKey, OutcomesKey]);
export type IngestStageKey = typeof IngestStageKey.Type;

export interface StageRegistryShape {
    readonly all: () => ReadonlyArray<StageDef<BaseStageStats, unknown>>;
    readonly byKey: (key: string) => StageDef<BaseStageStats, unknown> | undefined;
    readonly byTag: (tag: IngestStageTag) => ReadonlyArray<StageDef<BaseStageStats, unknown>>;
}

export class StageRegistry extends Context.Service<StageRegistry, StageRegistryShape>()(
    "ax/StageRegistry",
) {}

/** Provide a registry by passing the typed list of co-located stage definitions. */
export const StageRegistryLive = (
    stages: ReadonlyArray<StageDef<BaseStageStats, unknown>>,
): Layer.Layer<StageRegistry> =>
    Layer.succeed(StageRegistry, {
        all: () => stages,
        byKey: (key) => stages.find((s) => s.meta.key === key),
        byTag: (tag) => stages.filter((s) => s.meta.tags.includes(tag)),
    });

/** The canonical list of stages provided by `StageRegistryDefault`. */
export const ALL_STAGES = [skillsStage, commandsStage, claudeStage, codexStage, subagentsStage, spawnedStage, gitStage, signalsStage, outcomesStage] as const;

/** Production registry: the canonical list of stages provided by ax. Test code
 *  should prefer `StageRegistryLive([...])` with explicit fixtures. */
export const StageRegistryDefault: Layer.Layer<StageRegistry> = StageRegistryLive(ALL_STAGES);
