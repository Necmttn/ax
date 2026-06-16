import { Context, Layer } from "effect";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";
import { skillsStage } from "../skills.ts";
import { commandsStage } from "../commands.ts";
import { agentDefStage } from "../agent-def.ts";
import { pricingStage } from "../model-pricing.ts";
import { claudeStage } from "../transcripts.ts";
import { codexStage } from "../codex.ts";
import { piStage } from "../pi.ts";
import { opencodeStage } from "../opencode.ts";
import { cursorStage } from "../cursor.ts";
import { subagentsStage } from "../derive-claude-subagents.ts";
import { invokedPositionsStage } from "../backfill-invoked-positions.ts";
import { spawnedStage } from "../derive-spawned.ts";
import { loadedSkillsStage } from "../derive-loaded-skills.ts";
import { gitStage } from "../git.ts";
import { githubPrStage } from "../github-pr-stage.ts";
import { signalsStage } from "../derive-signals.ts";
import { outcomesStage } from "../outcomes.ts";
import { turnContentBlocksStage } from "../turn-content-blocks.ts";
import { turnAnalysisStage } from "../turn-analysis.ts";
import { reactionEventsStage } from "../reaction-events.ts";
import { classifierResultsStage } from "../classifier-results.ts";
import { sessionHealthStage } from "../session-health.ts";
import { closureStage } from "../closure.ts";
import { deriveMetricsStage } from "../derive-metrics.ts";
import { proposalsStage } from "../derive-proposals.ts";
import { opportunitiesStage } from "../derive-opportunities.ts";
import { retroProposalsStage } from "../derive-retro-proposals.ts";
import { harnessStage } from "../harness.ts";
import { digestStage } from "../../digest/digest-stage.ts";
import { usageStage } from "../../usage/usage-stage.ts";

export type { StageDef } from "./types.ts";

/** Derived from ALL_STAGES - the single source of truth for the key union.
 *  No hand-maintained parallel list; key-uniqueness + deps-validity are
 *  enforced at test time in registry.test.ts. */
export type IngestStageKey = (typeof ALL_STAGES)[number]["meta"]["key"];

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
export const ALL_STAGES = [skillsStage, commandsStage, agentDefStage, pricingStage, claudeStage, codexStage, piStage, opencodeStage, cursorStage, subagentsStage, invokedPositionsStage, spawnedStage, loadedSkillsStage, gitStage, githubPrStage, signalsStage, outcomesStage, turnContentBlocksStage, turnAnalysisStage, reactionEventsStage, classifierResultsStage, sessionHealthStage, closureStage, deriveMetricsStage, proposalsStage, opportunitiesStage, retroProposalsStage, harnessStage, digestStage, usageStage] as const;

/** Production registry: the canonical list of stages provided by ax. Test code
 *  should prefer `StageRegistryLive([...])` with explicit fixtures. */
export const StageRegistryDefault: Layer.Layer<StageRegistry> = StageRegistryLive(ALL_STAGES);
