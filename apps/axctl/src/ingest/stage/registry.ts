import { Context, Layer, Schema } from "effect";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";
import { SkillsKey, skillsStage } from "../skills.ts";
import { CommandsKey, commandsStage } from "../commands.ts";
import { AgentDefKey, agentDefStage } from "../agent-def.ts";
import { PricingKey, pricingStage } from "../model-pricing.ts";
import { ClaudeKey, claudeStage } from "../transcripts.ts";
import { CodexKey, codexStage } from "../codex.ts";
import { PiKey, piStage } from "../pi.ts";
import { OpenCodeKey, opencodeStage } from "../opencode.ts";
import { CursorKey, cursorStage } from "../cursor.ts";
import { SubagentsKey, subagentsStage } from "../derive-claude-subagents.ts";
import { InvokedPositionsKey, invokedPositionsStage } from "../backfill-invoked-positions.ts";
import { SpawnedKey, spawnedStage } from "../derive-spawned.ts";
import { GitKey, gitStage } from "../git.ts";
import { GithubPrKey, githubPrStage } from "../github-pr-stage.ts";
import { SignalsKey, signalsStage } from "../derive-signals.ts";
import { OutcomesKey, outcomesStage } from "../outcomes.ts";
import { TurnContentBlocksKey, turnContentBlocksStage } from "../turn-content-blocks.ts";
import { TurnAnalysisKey, turnAnalysisStage } from "../turn-analysis.ts";
import { ReactionEventsKey, reactionEventsStage } from "../reaction-events.ts";
import { ClassifierResultsKey, classifierResultsStage } from "../classifier-results.ts";
import { SessionHealthKey, sessionHealthStage } from "../session-health.ts";
import { ClosureKey, closureStage } from "../closure.ts";
import { DeriveMetricsKey, deriveMetricsStage } from "../derive-metrics.ts";
import { ProposalsKey, proposalsStage } from "../derive-proposals.ts";
import { OpportunitiesKey, opportunitiesStage } from "../derive-opportunities.ts";
import { RetroProposalsKey, retroProposalsStage } from "../derive-retro-proposals.ts";
import { HarnessKey, harnessStage } from "../harness.ts";
import { DigestKey, digestStage } from "../../digest/digest-stage.ts";
import { UsageKey, usageStage } from "../../usage/usage-stage.ts";

export type { StageDef } from "./types.ts";

/** Composed union of every known Ingest Stage key. Each stage file exports its
 *  own `Schema.Literal("<key>")`; this union is reassembled by re-exporting
 *  them here. Adding a stage = one import + one entry in the union below. */
export const IngestStageKey = Schema.Union([SkillsKey, CommandsKey, AgentDefKey, PricingKey, ClaudeKey, CodexKey, PiKey, OpenCodeKey, CursorKey, SubagentsKey, InvokedPositionsKey, SpawnedKey, GitKey, GithubPrKey, SignalsKey, OutcomesKey, TurnContentBlocksKey, TurnAnalysisKey, ReactionEventsKey, ClassifierResultsKey, SessionHealthKey, ClosureKey, DeriveMetricsKey, ProposalsKey, OpportunitiesKey, RetroProposalsKey, HarnessKey, DigestKey, UsageKey]);
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
export const ALL_STAGES = [skillsStage, commandsStage, agentDefStage, pricingStage, claudeStage, codexStage, piStage, opencodeStage, cursorStage, subagentsStage, invokedPositionsStage, spawnedStage, gitStage, githubPrStage, signalsStage, outcomesStage, turnContentBlocksStage, turnAnalysisStage, reactionEventsStage, classifierResultsStage, sessionHealthStage, closureStage, deriveMetricsStage, proposalsStage, opportunitiesStage, retroProposalsStage, harnessStage, digestStage, usageStage] as const;

/** Production registry: the canonical list of stages provided by ax. Test code
 *  should prefer `StageRegistryLive([...])` with explicit fixtures. */
export const StageRegistryDefault: Layer.Layer<StageRegistry> = StageRegistryLive(ALL_STAGES);
