/**
 * Parser Toolkit - shared `session_token_usage` / `turn_token_usage`
 * statement builders. Token-usage rows are deliberately provider "extras"
 * OUTSIDE the NormalizedTranscriptBatch seam (see ADR-0012); this module
 * keeps the statement SHAPE single-sourced while each parser still decides
 * which raw usage fields feed it and how labels/metrics are encoded
 * (`surrealJsonOption` vs `surrealJsonTextOption` differ per provider, so
 * those arrive pre-rendered).
 */
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import {
    recordRef,
    surrealDate,
    surrealObject,
    surrealOptionInt,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import type { CostEstimate } from "./model-pricing.ts";
import { turnRecordKey } from "./record-keys.ts";

/** A float literal rounded to 8 decimals, or `NONE` for nullish/non-finite. */
export const surrealOptionFloat = (value: number | null | undefined): string =>
    value === null || value === undefined || !Number.isFinite(value)
        ? "NONE"
        : Number(value.toFixed(8)).toString();

export interface SessionTokenUsageCostFields {
    /** Key for the `model_ref` record link; `NONE` when null. */
    readonly modelRefKey: string | null;
    readonly estimate: CostEstimate;
}

export interface SessionTokenUsageStatementInput {
    readonly sessionId: string;
    readonly source: string;
    readonly model: string | null;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly cacheCreationInputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
    /** Provider-reported reasoning/thinking output tokens (codex). The field
     *  pair is omitted entirely when undefined, keeping providers without the
     *  signal byte-identical. */
    readonly reasoningOutputTokens?: number | null;
    readonly estimatedTokens: number;
    readonly contextWindow: number | null;
    /** When present, the model_ref + estimated-cost + pricing_source field
     *  block is emitted (codex); absent reproduces the cost-less pi shape. */
    readonly cost?: SessionTokenUsageCostFields;
    /** Pre-rendered SurrealQL literal for the `labels` column. */
    readonly labels: string;
    /** Pre-rendered SurrealQL literal for the `metrics` column. */
    readonly metrics: string;
    readonly ts: Date | string;
}

const costFieldPairs = (
    modelRefKey: string | null,
    cost: CostEstimate,
): readonly (readonly [string, string])[] => [
    ["model_ref", modelRefKey ? recordRef("agent_model", modelRefKey) : "NONE"],
    ["estimated_input_cost_usd", surrealOptionFloat(cost.inputUsd)],
    ["estimated_output_cost_usd", surrealOptionFloat(cost.outputUsd)],
    ["estimated_cache_creation_cost_usd", surrealOptionFloat(cost.cacheCreationUsd)],
    ["estimated_cache_read_cost_usd", surrealOptionFloat(cost.cacheReadUsd)],
    ["estimated_cost_usd", surrealOptionFloat(cost.totalUsd)],
    ["pricing_source", surrealOptionString(cost.pricingSource)],
];

/** One per-session `session_token_usage` UPSERT, field order locked to the
 *  pre-toolkit codex/pi builders. */
export const buildSessionTokenUsageStatement = (
    input: SessionTokenUsageStatementInput,
): string =>
    `UPSERT ${recordRef("session_token_usage", safeKeyPart(input.sessionId))} MERGE ${surrealObject([
        ["session", recordRef("session", input.sessionId)],
        ["source", surrealString(input.source)],
        ["workflow_epoch", "NONE"],
        ["model", surrealOptionString(input.model)],
        ["prompt_tokens", surrealOptionInt(input.promptTokens)],
        ["completion_tokens", surrealOptionInt(input.completionTokens)],
        ["cache_creation_input_tokens", surrealOptionInt(input.cacheCreationInputTokens)],
        ["cache_read_input_tokens", surrealOptionInt(input.cacheReadInputTokens)],
        ...(input.reasoningOutputTokens === undefined
            ? []
            : [["reasoning_output_tokens", surrealOptionInt(input.reasoningOutputTokens)] as const]),
        ["estimated_tokens", Math.trunc(input.estimatedTokens).toString(10)],
        ["transcript_bytes", "0"],
        ["context_window", surrealOptionInt(input.contextWindow)],
        ...(input.cost ? costFieldPairs(input.cost.modelRefKey, input.cost.estimate) : []),
        ["labels", input.labels],
        ["metrics", input.metrics],
        ["ts", surrealDate(input.ts)],
    ])};`;

export interface TurnTokenUsageStatementInput {
    readonly sessionId: string;
    readonly seq: number;
    readonly source: string;
    readonly model: string | null;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly cacheCreationInputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
    /** Provider-reported reasoning/thinking output tokens (codex). Field pair
     *  omitted entirely when undefined. */
    readonly reasoningOutputTokens?: number | null;
    readonly freshInputTokens: number | null;
    readonly estimatedTokens: number;
    /** Key for the `model_ref` record link (claude normalizes the model name
     *  first; codex links the raw session model). `NONE` when null. */
    readonly modelRefKey: string | null;
    readonly cost: CostEstimate;
    readonly usageSource: string;
    readonly usageQuality: string;
    /** Pre-rendered SurrealQL literal for the `raw` column; the field pair is
     *  omitted entirely when undefined (claude writes no raw column). */
    readonly raw?: string;
    readonly ts: Date | string;
}

/** One per-turn `turn_token_usage` UPSERT, field order locked to the
 *  pre-toolkit codex/claude builders. */
export const buildTurnTokenUsageStatement = (
    input: TurnTokenUsageStatementInput,
): string => {
    const turnKey = turnRecordKey(input.sessionId, input.seq);
    return `UPSERT ${recordRef("turn_token_usage", turnKey)} MERGE ${surrealObject([
        ["session", recordRef("session", input.sessionId)],
        ["turn", recordRef("turn", turnKey)],
        ["seq", Math.trunc(input.seq).toString(10)],
        ["source", surrealString(input.source)],
        ["model", surrealOptionString(input.model)],
        ["prompt_tokens", surrealOptionInt(input.promptTokens)],
        ["completion_tokens", surrealOptionInt(input.completionTokens)],
        ["cache_creation_input_tokens", surrealOptionInt(input.cacheCreationInputTokens)],
        ["cache_read_input_tokens", surrealOptionInt(input.cacheReadInputTokens)],
        ...(input.reasoningOutputTokens === undefined
            ? []
            : [["reasoning_output_tokens", surrealOptionInt(input.reasoningOutputTokens)] as const]),
        ["fresh_input_tokens", surrealOptionInt(input.freshInputTokens)],
        ["estimated_tokens", Math.trunc(input.estimatedTokens).toString(10)],
        ...costFieldPairs(input.modelRefKey, input.cost),
        ["usage_source", surrealString(input.usageSource)],
        ["usage_quality", surrealString(input.usageQuality)],
        ...(input.raw === undefined ? [] : [["raw", input.raw] as const]),
        ["ts", surrealDate(input.ts)],
    ])};`;
};
