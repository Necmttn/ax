import { Effect, FileSystem, Path, PlatformError, Schema, Stream } from "effect";
import { RecordId, SurrealClient, filePointer } from "@ax/lib/db";
import { SkillName } from "@ax/lib/brands";
import { AxConfig } from "@ax/lib/config";
import { surrealJsonOption } from "@ax/lib/shared/surql";
import { AppLayer } from "@ax/lib/layers";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import { annotateStageProgress, stageFileFailureAnnotator } from "./stage/runner.ts";
import type { StageDef } from "./stage/registry.ts";
import {
    type PlanSnapshotWrite,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import {
    agentEventRecordKey,
    type AgentEventParentEdgeWrite,
    type AgentEventWrite,
} from "./provider-events.ts";
import { parseCodexFunctionOutput } from "./tool-calls.ts";
import { extractCodexCompaction, type CompactionWrite } from "./compaction.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { providerDelegationSignalAvailability } from "./delegation.ts";
import {
    normalizeProviderPlanSnapshot,
    providerPlanSignalAvailability,
    toPlanSnapshotWrite,
} from "./plans.ts";
import { toolCallRecordKey } from "./record-keys.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";
import {
    buildNormalizedTranscriptStatements,
    type NormalizedTranscriptBatch,
} from "./normalized/transcripts.ts";
// Codex token counts arrive as numbers OR numeric strings - the toolkit's
// integer probe (`intField`) is this parser's `numberField`.
import {
    intField as numberField,
    isRecord,
    jsonText,
    parseJsonl,
    parseMaybeJson,
    RESPONSES_TEXT_TYPES,
    stringField,
    textFromContent,
} from "./normalized/toolkit.ts";
import { classifyUserText, FULL_CONTEXT_RULES } from "./normalized/message-kind.ts";
import {
    applyCommandFields,
    makeToolCallWrite,
    type MutableToolCallWrite,
} from "./normalized/tool-call-write.ts";
import {
    buildSessionTokenUsageStatement,
    buildTurnTokenUsageStatement,
} from "./token-usage-writers.ts";
import { decodeCodexTranscriptLine } from "./line-schemas.ts";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import { isNotFound, skipNotFound } from "@ax/lib/shared/fs-error";
import { tokenQualityLabels } from "./token-quality.ts";
import { estimateCost } from "./model-pricing.ts";
import { codexSourceForThread } from "./source-origin.ts";
import { walkJsonlFilesStrict } from "./walk-jsonl.ts";
import type { FileFailureSnapshot } from "./file-isolation.ts";
import { runJsonlProviderFiles } from "./jsonl-work-unit.ts";
import {
    clearIndexUnhealthyMarker,
    makeAgentEventSeqRebuild,
    withAgentEventSeqHeal,
    writeIndexUnhealthyMarker,
} from "./agent-event-index-heal.ts";
import { canonicalCwdInRepoScope, readCodexSessionCwd } from "./codex-scope.ts";

const DEFAULT_CODEX_RAW_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CODEX_PROGRESS_EVERY = 10;
export const DEFAULT_CODEX_FLUSH_EVERY = 500;
const DEFAULT_CODEX_CONCURRENCY = 1;
const DEFAULT_CODEX_PAYLOAD_MAX_BYTES = 1200;
const CODEX_PROGRESS_LINE_EVERY = 100;
const SAFE_FALLBACK_TS = "1970-01-01T00:00:00.000Z";

interface CodexSession {
    id: string;
    cwd: string | null;
    cli_version: string | null;
    model_provider: string | null;
    model: string | null;
    /** Last-seen turn_context reasoning effort: minimal|low|medium|high|xhigh. */
    reasoning_effort: string | null;
    /** session_meta.thread_source: "user" (main) | "subagent" (spawned agent). */
    thread_source: string | null;
    /** session_meta.parent_thread_id - the spawning parent session (subagents only). */
    parent_thread_id: string | null;
    started_at: string;
    ended_at: string;
}

function validIsoTimestamp(input: string | null): string | null {
    if (input === null || input.trim().length === 0) return null;
    const date = new Date(input);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface CodexTurn {
    session: string;
    seq: number;
    ts: string;
    role: string;
    message_kind: string;
    intent_kind: string;
    text: string | null;
    text_excerpt: string | null;
    has_tool_use: boolean;
}

interface CodexInvocation {
    session: string;
    seq: number;
    ts: string;
    skill: SkillName; // namespaced as "codex:<tool>"
    args: unknown;
}

interface CodexTokenUsage {
    session: string;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheReadInputTokens: number | null;
    /** total_token_usage.reasoning_output_tokens - codex thinking spend. */
    reasoningOutputTokens: number | null;
    estimatedTokens: number;
    contextWindow: number | null;
    totalTokenUsage: Record<string, unknown>;
    lastTokenUsage: Record<string, unknown> | null;
    tokenCountEvents: number;
    ts: string;
}

export interface CodexTurnTokenUsage {
    session: string;
    seq: number;
    ts: string;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheCreationInputTokens: number | null;
    cacheReadInputTokens: number | null;
    /** Per-turn reasoning tokens (delta or last_token_usage). */
    reasoningOutputTokens: number | null;
    freshInputTokens: number | null;
    estimatedTokens: number;
    usageSource: string;
    usageQuality: string;
    raw: Record<string, unknown>;
}

function outputText(input: unknown): string | null {
    return typeof input === "string" ? input : jsonText(input);
}

function codexMessageRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
    if (isRecord(payload.message)) return payload.message;
    if (stringField(payload, "type") === "message") return payload;
    return null;
}

function codexMessageKind(role: string, itemType: string | null, textExcerpt: string | null): string {
    if (role === "system" || role === "developer") return "system_or_developer";
    if (role === "user") {
        return classifyUserText(textExcerpt, FULL_CONTEXT_RULES);
    }
    if (role === "assistant") return "assistant";
    if (itemType === "function_call") return "tool_call";
    return itemType ?? role;
}

export function shouldSnapshotCodexRaw(
    sizeBytes: number,
    maxBytes = DEFAULT_CODEX_RAW_MAX_BYTES,
): boolean {
    return sizeBytes <= maxBytes;
}

export function codexProgressEvery(raw: string | undefined): number {
    if (!raw) return DEFAULT_CODEX_PROGRESS_EVERY;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_PROGRESS_EVERY;
}

export function codexFlushEvery(raw: string | undefined): number {
    if (!raw) return DEFAULT_CODEX_FLUSH_EVERY;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_FLUSH_EVERY;
}

export function codexConcurrency(raw: string | undefined): number {
    if (!raw) return DEFAULT_CODEX_CONCURRENCY;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_CONCURRENCY;
}

export function codexPayloadMaxBytes(raw = process.env.AX_CODEX_PAYLOAD_MAX_BYTES): number {
    if (!raw) return DEFAULT_CODEX_PAYLOAD_MAX_BYTES;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CODEX_PAYLOAD_MAX_BYTES;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}

function jsonBytes(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? "null");
    } catch {
        return Buffer.byteLength(String(value));
    }
}

function compactText(text: string): string {
    return text.length <= 1200 ? text : `${text.slice(0, 1200)}…`;
}

function compactPayload(value: unknown, maxBytes: number): unknown {
    if (value === null || value === undefined) return value;
    const bytes = jsonBytes(value);
    if (bytes <= maxBytes) return value;

    if (typeof value === "string") {
        return {
            truncated: true,
            bytes,
            excerpt: compactText(value),
        };
    }

    if (isRecord(value)) {
        return {
            truncated: true,
            bytes,
            type: stringField(value, "type"),
            name: stringField(value, "name"),
            call_id: stringField(value, "call_id"),
        };
    }

    return {
        truncated: true,
        bytes,
        excerpt: compactText(String(value)),
    };
}

function compactCodexToolCall(call: MutableToolCallWrite, maxBytes: number): MutableToolCallWrite {
    return {
        ...call,
        inputJson: compactPayload(call.inputJson, maxBytes),
        outputJson: compactPayload(call.outputJson, maxBytes),
        rawJson: compactPayload(call.rawJson, maxBytes),
    };
}

function compactCodexFunctionOutputEventRaw(
    payload: Record<string, unknown>,
    maxBytes: number,
): Record<string, unknown> {
    return {
        type: stringField(payload, "type") ?? "function_call_output",
        call_id: stringField(payload, "call_id"),
        output: compactPayload(payload.output, maxBytes),
    };
}

type ToolResultFields = {
    outputJson: unknown;
    outputExcerpt: string | null;
    errorText: string | null;
    exitCode: number | null;
    durationMs: number | null;
    hasError: boolean;
};

function codexOutputFields(output: unknown): ToolResultFields {
    const text = outputText(output);
    const parsed = parseCodexFunctionOutput(text);
    const excerpt = parsed.outputExcerpt.length > 0 ? parsed.outputExcerpt : null;

    return {
        outputJson: output ?? null,
        outputExcerpt: excerpt,
        errorText: parsed.hasError ? excerpt : null,
        exitCode: parsed.exitCode,
        durationMs: parsed.durationMs,
        hasError: parsed.hasError,
    };
}

function codexTokenUsageFromPayload(
    payload: Record<string, unknown>,
    ts: string,
    currentSession: CodexSession,
    tokenCountEvents: number,
): CodexTokenUsage | null {
    const info = isRecord(payload.info) ? payload.info : null;
    if (!info) return null;
    const totalTokenUsage = isRecord(info.total_token_usage) ? info.total_token_usage : null;
    if (!totalTokenUsage) return null;

    const promptTokens = numberField(totalTokenUsage, "input_tokens");
    const completionTokens = numberField(totalTokenUsage, "output_tokens");
    const cacheReadInputTokens = numberField(totalTokenUsage, "cached_input_tokens");
    const reasoningOutputTokens = numberField(totalTokenUsage, "reasoning_output_tokens");
    const estimatedTokens = numberField(totalTokenUsage, "total_tokens") ??
        (promptTokens ?? 0) + (completionTokens ?? 0);
    const lastTokenUsage = isRecord(info.last_token_usage) ? info.last_token_usage : null;

    return {
        session: currentSession.id,
        model: concreteCodexModel(currentSession),
        promptTokens,
        completionTokens,
        cacheReadInputTokens,
        reasoningOutputTokens,
        estimatedTokens,
        contextWindow: numberField(info, "model_context_window"),
        totalTokenUsage,
        lastTokenUsage,
        tokenCountEvents,
        ts,
    };
}

const positiveDelta = (current: number | null, previous: number | null): number | null => {
    if (current === null) return null;
    if (previous === null) return current;
    return Math.max(0, current - previous);
};

const tokenMetricsFromRecord = (usage: Record<string, unknown>) => {
    const promptTokens = numberField(usage, "input_tokens");
    const completionTokens = numberField(usage, "output_tokens");
    const cacheReadInputTokens = numberField(usage, "cached_input_tokens");
    const cacheCreationInputTokens = numberField(usage, "cache_creation_input_tokens");
    const reasoningOutputTokens = numberField(usage, "reasoning_output_tokens");
    const estimatedTokens = numberField(usage, "total_tokens") ??
        (promptTokens ?? 0) + (completionTokens ?? 0);
    const freshInputTokens = promptTokens === null
        ? null
        : Math.max(0, promptTokens - (cacheReadInputTokens ?? 0) - (cacheCreationInputTokens ?? 0));
    return {
        promptTokens,
        completionTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        reasoningOutputTokens,
        freshInputTokens,
        estimatedTokens,
    };
};

function codexTurnTokenUsageFromPayload(
    usage: CodexTokenUsage,
    seq: number,
    previousTotalUsage: Record<string, unknown> | null,
): CodexTurnTokenUsage | null {
    if (seq <= 0) return null;
    if (usage.lastTokenUsage) {
        const metrics = tokenMetricsFromRecord(usage.lastTokenUsage);
        return {
            session: usage.session,
            seq,
            ts: usage.ts,
            model: usage.model,
            ...metrics,
            usageSource: "codex_token_count.last_token_usage",
            usageQuality: "provider_turn",
            raw: usage.lastTokenUsage,
        };
    }

    const current = tokenMetricsFromRecord(usage.totalTokenUsage);
    const previous = previousTotalUsage ? tokenMetricsFromRecord(previousTotalUsage) : null;
    const promptTokens = positiveDelta(current.promptTokens, previous?.promptTokens ?? null);
    const completionTokens = positiveDelta(current.completionTokens, previous?.completionTokens ?? null);
    const cacheCreationInputTokens = positiveDelta(current.cacheCreationInputTokens, previous?.cacheCreationInputTokens ?? null);
    const cacheReadInputTokens = positiveDelta(current.cacheReadInputTokens, previous?.cacheReadInputTokens ?? null);
    const reasoningOutputTokens = positiveDelta(current.reasoningOutputTokens, previous?.reasoningOutputTokens ?? null);
    const estimatedTokens = positiveDelta(current.estimatedTokens, previous?.estimatedTokens ?? null) ?? current.estimatedTokens;
    const freshInputTokens = promptTokens === null
        ? null
        : Math.max(0, promptTokens - (cacheCreationInputTokens ?? 0) - (cacheReadInputTokens ?? 0));
    return {
        session: usage.session,
        seq,
        ts: usage.ts,
        model: usage.model,
        promptTokens,
        completionTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        reasoningOutputTokens,
        freshInputTokens,
        estimatedTokens,
        usageSource: previousTotalUsage
            ? "codex_token_count.total_token_usage_delta"
            : "codex_token_count.total_token_usage_first",
        usageQuality: previousTotalUsage ? "derived_delta" : "first_total",
        raw: usage.totalTokenUsage,
    };
}

const concreteCodexModel = (session: CodexSession): string | null => {
    if (session.model) return session.model;
    const provider = session.model_provider;
    if (!provider || /^(openai|anthropic|google|xai|openrouter|azure)$/i.test(provider)) return null;
    return provider;
};

function applyToolResult(call: MutableToolCallWrite, result: ToolResultFields): void {
    call.outputJson = result.outputJson;
    call.outputExcerpt = result.outputExcerpt;
    call.errorText = result.errorText;
    call.exitCode = result.exitCode;
    call.durationMs = result.durationMs;
    call.hasError = result.hasError;
}

export interface CodexExtract {
    session: CodexSession;
    sourcePath: string | null;
    warnings: string[];
    turns: CodexTurn[];
    turnTokenUsages: CodexTurnTokenUsage[];
    invocations: CodexInvocation[];
    toolCalls: ToolCallWrite[];
    providerEvents: AgentEventWrite[];
    parentEdges: AgentEventParentEdgeWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    planSnapshots: PlanSnapshotWrite[];
    compactions: CompactionWrite[];
    tokenUsage: CodexTokenUsage | null;
}

interface MutableCodexExtract {
    session: CodexSession | null;
    sourcePath: string | null;
    warnings: string[];
    turns: CodexTurn[];
    turnTokenUsages: CodexTurnTokenUsage[];
    invocations: CodexInvocation[];
    toolCalls: MutableToolCallWrite[];
    providerEvents: AgentEventWrite[];
    parentEdges: AgentEventParentEdgeWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    planSnapshots: PlanSnapshotWrite[];
    compactions: CompactionWrite[];
    tokenUsage: CodexTokenUsage | null;
}

function createCodexExtractor(
    filePath: string,
    payloadMaxBytes = DEFAULT_CODEX_PAYLOAD_MAX_BYTES,
) {
    let session: CodexSession | null = null;
    const turns: CodexTurn[] = [];
    const turnTokenUsages: CodexTurnTokenUsage[] = [];
    const invocations: CodexInvocation[] = [];
    const toolCalls: MutableToolCallWrite[] = [];
    const providerEvents: AgentEventWrite[] = [];
    const parentEdges: AgentEventParentEdgeWrite[] = [];
    const skillRelations: ToolCallSkillRelationWrite[] = [];
    const planSnapshots: PlanSnapshotWrite[] = [];
    const compactions: CompactionWrite[] = [];
    const warnings: string[] = [];
    let lastContextTokens: number | null = null;
    let tokenUsage: CodexTokenUsage | null = null;
    let tokenCountEvents = 0;
    let previousTotalTokenUsage: Record<string, unknown> | null = null;
    const toolCallsByCallId = new Map<string, MutableToolCallWrite>();
    const pendingToolResultsByCallId = new Map<string, ToolResultFields>();
    const planCreatedAtBySource = new Map<string, string>();
    const planSnapshotCountsBySource = new Map<string, number>();
    const anonymousFunctionCallCountsByTurn = new Map<number, number>();
    const pendingToolCallKeys = new Set<string>();
    const flushedToolCallKeys = new Set<string>();
    const providerEventKeysById = new Map<string, string>();
    const pendingProviderEventIds = new Set<string>();
    let lastProviderEventId: string | null = null;
    let seq = 0;
    let malformedLines = 0;

    const pushProviderEvent = (event: Omit<AgentEventWrite, "provider" | "providerSessionId" | "axSessionId">, currentSession: CodexSession): void => {
        const {
            parentProviderEventId: eventParentProviderEventId,
            parentProviderEventIds: eventParentProviderEventIds,
            ...eventWithoutParents
        } = event;
        const parentProviderEventIds = new Set(eventParentProviderEventIds ?? []);
        if (
            lastProviderEventId !== null &&
            lastProviderEventId !== event.providerEventId &&
            lastProviderEventId !== eventParentProviderEventId
        ) {
            parentProviderEventIds.add(lastProviderEventId);
        }
        const parentProviderEventId = eventParentProviderEventId ??
            (parentProviderEventIds.size === 1 ? [...parentProviderEventIds][0] : undefined);
        if (parentProviderEventId !== undefined) parentProviderEventIds.delete(parentProviderEventId);
        const finalEvent: AgentEventWrite = {
            provider: "codex",
            providerSessionId: currentSession.id,
            axSessionId: currentSession.id,
            ...eventWithoutParents,
            ...(parentProviderEventId !== undefined ? { parentProviderEventId } : {}),
            ...(parentProviderEventIds.size > 0 ? { parentProviderEventIds: [...parentProviderEventIds] } : {}),
        };
        const childEventKey = agentEventRecordKey(finalEvent);
        const finalParentIds = [
            ...(parentProviderEventId !== undefined ? [parentProviderEventId] : []),
            ...parentProviderEventIds,
        ];
        for (const parentId of finalParentIds) {
            if (pendingProviderEventIds.has(parentId)) continue;
            const parentEventKey = providerEventKeysById.get(parentId);
            if (!parentEventKey) continue;
            parentEdges.push({
                provider: "codex",
                providerSessionId: currentSession.id,
                parentEventKey,
                childEventKey,
                kind: finalEvent.parentKind ?? "parent",
                ts: finalEvent.ts,
            });
        }
        providerEvents.push(finalEvent);
        if (event.providerEventId) {
            lastProviderEventId = event.providerEventId;
            pendingProviderEventIds.add(event.providerEventId);
            providerEventKeysById.set(event.providerEventId, childEventKey);
        }
    };

    const nextAnonymousFunctionCallId = (): string => {
        const next = (anonymousFunctionCallCountsByTurn.get(seq) ?? 0) + 1;
        anonymousFunctionCallCountsByTurn.set(seq, next);
        return `anonymous_function_call_${seq.toString(10).padStart(6, "0")}_${next
            .toString(10)
            .padStart(3, "0")}`;
    };

    const nextPlanSnapshotSeq = (source: string): number => {
        const next = (planSnapshotCountsBySource.get(source) ?? 0) + 1;
        planSnapshotCountsBySource.set(source, next);
        return next;
    };

    const rememberPlanCreatedAt = (source: string, ts: string): string => {
        const existing = planCreatedAtBySource.get(source);
        if (existing) return existing;
        planCreatedAtBySource.set(source, ts);
        return ts;
    };

    const processFunctionCall = (
        payload: Record<string, unknown>,
        ts: string,
        currentSession: CodexSession,
    ): void => {
        const toolName = stringField(payload, "name");
        if (!toolName) return;

        const transcriptCallId = stringField(payload, "call_id");
        const callId = transcriptCallId ?? nextAnonymousFunctionCallId();
        // function_call carries JSON `arguments`; custom_tool_call (apply_patch)
        // carries the raw patch text in `input` - wrap it so apply-patch LOC
        // consumers find their `patch` field.
        const customInput = payload.arguments === undefined ? stringField(payload, "input") : null;
        const inputJson = customInput !== null ? { patch: customInput } : parseMaybeJson(payload.arguments);
        const toolCallKey = toolCallRecordKey({
            sessionId: currentSession.id,
            seq,
            callId,
        });
        const call: MutableToolCallWrite = makeToolCallWrite({
            provider: "codex",
            toolName,
            sessionId: currentSession.id,
            seq,
            callId,
            ts,
            cwd: currentSession.cwd,
            inputJson,
            rawJson: payload,
        });

        pushProviderEvent({
            providerEventId: callId,
            seq,
            ts,
            type: "function_call",
            role: "tool_call",
            text: null,
            textExcerpt: null,
            raw: payload,
            labels: {
                source: "codex_transcript",
                toolName,
                toolKind: call.toolKind,
            },
            metrics: { turnSeq: seq },
        }, currentSession);

        if (toolName === "exec_command") applyCommandFields(call, inputJson);

        toolCalls.push(call);
        toolCallsByCallId.set(callId, call);
        pendingToolCallKeys.add(toolCallKey);
        const pendingResult = pendingToolResultsByCallId.get(callId);
        if (pendingResult) {
            applyToolResult(call, pendingResult);
            pendingToolCallKeys.delete(toolCallKey);
            pendingToolResultsByCallId.delete(callId);
        }

        // Synthetic provider-tool skill name - branded at the true source.
        const skillName = SkillName.make(`codex:${toolName}`);
        invocations.push({
            session: currentSession.id,
            seq,
            ts,
            skill: skillName,
            args: payload.arguments ?? {},
        });
        skillRelations.push({
            toolCallKey,
            skillName,
            ts,
            reason: "Codex function call",
            labels: {
                provider: "codex",
                toolName,
                source: "transcript",
            },
            metrics: { turnSeq: seq },
        });

        if (toolName === "update_plan") {
            const normalized = normalizeProviderPlanSnapshot({
                provider: "codex",
                toolName,
                sessionId: currentSession.id,
                ts,
                input: payload.arguments,
            });
            if (normalized && normalized.items.length > 0) {
                const source = normalized.source;
                const snapshotSeq = nextPlanSnapshotSeq(source);
                const createdAt = rememberPlanCreatedAt(source, ts);

                planSnapshots.push(toPlanSnapshotWrite({
                    snapshot: normalized,
                    snapshotSeq,
                    createdAt,
                    toolCallKey,
                }));
            }
        }
    };

    const processFunctionOutput = (
        payload: Record<string, unknown>,
        ts: string,
        currentSession: CodexSession,
    ): void => {
        const callId = stringField(payload, "call_id");
        if (!callId) return;

        const result = codexOutputFields(payload.output);
        pushProviderEvent({
            providerEventId: `function_call_output:${callId}`,
            parentProviderEventId: callId,
            parentKind: "function_call_output",
            seq,
            ts,
            type: "function_call_output",
            role: "function_call_output",
            text: result.outputExcerpt,
            textExcerpt: result.outputExcerpt,
            raw: compactCodexFunctionOutputEventRaw(payload, payloadMaxBytes),
            labels: {
                source: "codex_transcript",
                callId,
                hasError: result.hasError,
            },
            metrics: {
                turnSeq: seq,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
            },
        }, currentSession);
        const call = toolCallsByCallId.get(callId);
        if (call) {
            applyToolResult(call, result);
            pendingToolCallKeys.delete(toolCallRecordKey({
                sessionId: call.sessionId,
                seq: call.seq,
                callId: call.callId ?? null,
            }));
        } else {
            pendingToolResultsByCallId.set(callId, result);
        }
    };

    const take = <T>(items: T[], predicate: (item: T) => boolean): T[] => {
        const taken: T[] = [];
        let write = 0;
        for (const item of items) {
            if (predicate(item)) {
                taken.push(item);
            } else {
                items[write] = item;
                write += 1;
            }
        }
        items.length = write;
        return taken;
    };

    const drain = (includePendingToolCalls = false): MutableCodexExtract => {
        const flushableToolCallKeys = new Set<string>();
        const drainedToolCalls = take(toolCalls, (call) => {
            const key = toolCallRecordKey({
                sessionId: call.sessionId,
                seq: call.seq,
                callId: call.callId ?? null,
            });
            if (flushedToolCallKeys.has(key)) return false;
            if (!includePendingToolCalls && pendingToolCallKeys.has(key)) return false;
            flushedToolCallKeys.add(key);
            pendingToolCallKeys.delete(key);
            flushableToolCallKeys.add(key);
            if (call.callId) toolCallsByCallId.delete(call.callId);
            return true;
        });
        const drainedTurns = turns.splice(0, turns.length);
        const drainedTurnTokenUsages = turnTokenUsages.splice(0, turnTokenUsages.length);
        const drainedProviderEvents = providerEvents.splice(0, providerEvents.length);
        for (const event of drainedProviderEvents) {
            if (event.providerEventId) pendingProviderEventIds.delete(event.providerEventId);
        }
        const drainedParentEdges = parentEdges.splice(0, parentEdges.length);
        const drainedInvocations = take(invocations, (invocation) =>
            flushableToolCallKeys.has(toolCallRecordKey({
                sessionId: invocation.session,
                seq: invocation.seq,
                callId: null,
            })) || drainedToolCalls.some((call) => call.sessionId === invocation.session && call.seq === invocation.seq),
        );
        const drainedRelations = take(skillRelations, (relation) =>
            flushableToolCallKeys.has(relation.toolCallKey),
        );
        const drainedSnapshots = take(planSnapshots, (snapshot) =>
            snapshot.toolCallKey === null || snapshot.toolCallKey === undefined || flushableToolCallKeys.has(snapshot.toolCallKey),
        );
        const drainedCompactions = compactions.splice(0, compactions.length);
        return {
            session,
            sourcePath: filePath,
            warnings: warnings.splice(0, warnings.length),
            turns: drainedTurns,
            turnTokenUsages: drainedTurnTokenUsages,
            invocations: drainedInvocations,
            toolCalls: drainedToolCalls,
            providerEvents: drainedProviderEvents,
            parentEdges: drainedParentEdges,
            skillRelations: drainedRelations,
            planSnapshots: drainedSnapshots,
            compactions: drainedCompactions,
            tokenUsage,
        };
    };

    return {
        processLine(line: string): void {
            if (!line.trim()) return;
            const rawEntry = parseJsonl(line);
            if (!rawEntry) {
                malformedLines += 1;
                return;
            }
            // Typed, tolerant view of the line head (see line-schemas.ts).
            // The `payload` varies per `type` and stays a raw probe.
            const entry = decodeCodexTranscriptLine(rawEntry);
            if (!entry) {
                malformedLines += 1;
                return;
            }
            const type = entry.type ?? null;
            const payload = isRecord(rawEntry.payload) ? rawEntry.payload : null;
            const rawTimestamp = entry.timestamp ?? null;
            const entryTimestamp = validIsoTimestamp(rawTimestamp);
            const entryId = type === "session_meta" && payload
                ? (stringField(payload, "id") ?? filePath)
                : `${type ?? "unknown"} in ${filePath}`;
            if (!entryTimestamp) {
                warnings.push(
                    `${rawTimestamp ? "invalid" : "missing"} entry timestamp for ${entryId}` +
                        (rawTimestamp ? `: ${rawTimestamp}` : ""),
                );
            }

            if (type === "session_meta" && payload) {
                const rawPayloadTimestamp = stringField(payload, "timestamp");
                const payloadTimestamp = validIsoTimestamp(rawPayloadTimestamp);
                if (rawPayloadTimestamp !== null && !payloadTimestamp) {
                    warnings.push(`invalid session payload timestamp for ${entryId}: ${rawPayloadTimestamp}`);
                }
                const startedAt = payloadTimestamp ?? entryTimestamp ?? SAFE_FALLBACK_TS;
                const endedAt = entryTimestamp ?? payloadTimestamp ?? startedAt;
                session = {
                    id: stringField(payload, "id") ?? filePath,
                    cwd: stringField(payload, "cwd"),
                    cli_version: stringField(payload, "cli_version"),
                    model_provider: stringField(payload, "model_provider"),
                    model: stringField(payload, "model"),
                    reasoning_effort: null,
                    thread_source: stringField(payload, "thread_source"),
                    parent_thread_id: stringField(payload, "parent_thread_id"),
                    started_at: startedAt,
                    ended_at: endedAt,
                };
                return;
            }
            if (!session) return;
            const ts = entryTimestamp ?? session.ended_at;
            session.ended_at = ts;

            if (type === "turn_context" && payload) {
                const collabSettings = isRecord(payload.collaboration_mode) &&
                    isRecord(payload.collaboration_mode.settings)
                    ? payload.collaboration_mode.settings
                    : null;
                const model = stringField(payload, "model")
                    ?? (collabSettings ? stringField(collabSettings, "model") : null);
                if (model) session.model = model;
                const effort = stringField(payload, "effort")
                    ?? (collabSettings ? stringField(collabSettings, "reasoning_effort") : null);
                if (effort) session.reasoning_effort = effort;
                return;
            }

            if (type === "event_msg" && payload && stringField(payload, "type") === "token_count") {
                tokenCountEvents += 1;
                const nextUsage = codexTokenUsageFromPayload(payload, ts, session, tokenCountEvents);
                if (nextUsage) {
                    const turnUsage = codexTurnTokenUsageFromPayload(nextUsage, seq, previousTotalTokenUsage);
                    if (turnUsage) turnTokenUsages.push(turnUsage);
                    previousTotalTokenUsage = nextUsage.totalTokenUsage;
                    tokenUsage = nextUsage;
                    lastContextTokens = (nextUsage.lastTokenUsage ? numberField(nextUsage.lastTokenUsage, "input_tokens") : null) ?? lastContextTokens;
                }
                return;
            }

            if (type === "compacted" && payload && session) {
                seq += 1;
                const compactionEventId = `compacted:${seq}`;
                const eventKey = agentEventRecordKey({
                    provider: "codex",
                    providerSessionId: session.id,
                    providerEventId: compactionEventId,
                    seq,
                });
                pushProviderEvent({
                    providerEventId: compactionEventId,
                    seq,
                    ts,
                    type: "compaction",
                    role: null,
                    text: null,
                    textExcerpt: null,
                    raw: { replacement_count: Array.isArray(payload.replacement_history) ? payload.replacement_history.length : 0 },
                    labels: { source: "codex_transcript" },
                    metrics: { strategy: "history_replacement", turnSeq: seq },
                }, session);
                const write = extractCodexCompaction(payload, {
                    sessionId: session.id,
                    providerSessionId: session.id,
                    seq,
                    ts: new Date(ts),
                    agentEventKey: eventKey,
                    tokensBefore: lastContextTokens,
                    boundaryRef: `seq_${seq}`,
                });
                if (write) compactions.push(write);
                return;
            }

            if (type === "response_item" && payload) {
                seq += 1;
                const itemType = stringField(payload, "type");
                const message = codexMessageRecord(payload);
                // apply_patch arrives as custom_tool_call (a freeform tool),
                // not function_call - treat both as tool calls or codex edits
                // never reach the tool_call table.
                const isToolCall = itemType === "function_call" || itemType === "custom_tool_call";
                const role =
                    isToolCall
                        ? "tool_call"
                        : itemType === "message"
                          ? (stringField(message ?? {}, "role") ?? "assistant")
                          : (itemType ?? "unknown");

                const text = textFromContent(message?.content, {
                    acceptedTypes: RESPONSES_TEXT_TYPES,
                    emptyStringIsNull: false,
                });
                const textExcerpt = text === null ? null : text.slice(0, 500);
                const kind = codexMessageKind(role, itemType, textExcerpt);
                turns.push({
                    session: session.id,
                    seq,
                    ts,
                    role,
                    message_kind: kind,
                    intent_kind: classifyTurnIntent({ role, messageKind: kind, source: "codex", text }),
                    text,
                    text_excerpt: textExcerpt,
                    has_tool_use: isToolCall,
                });

                if (isToolCall) {
                    processFunctionCall(payload, ts, session);
                } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
                    processFunctionOutput(payload, ts, session);
                } else {
                    pushProviderEvent({
                        providerEventId: stringField(payload, "id") ?? stringField(payload, "item_id"),
                        seq,
                        ts,
                        type: itemType ?? "response_item",
                        role,
                        text,
                        textExcerpt,
                        raw: payload,
                        labels: {
                            source: "codex_transcript",
                            messageKind: kind,
                            intentKind: classifyTurnIntent({ role, messageKind: kind, source: "codex", text }),
                        },
                        metrics: {
                            turnSeq: seq,
                            contentBlocks: Array.isArray(message?.content) ? message.content.length : 0,
                        },
                    }, session);
                }
            }
        },
        finish(): CodexExtract | null {
            const remaining = drain(true);
            if (!session) return null;
            return {
                session,
                sourcePath: remaining.sourcePath,
                warnings: remaining.warnings,
                turns: remaining.turns,
                turnTokenUsages: remaining.turnTokenUsages,
                invocations: remaining.invocations,
                toolCalls: remaining.toolCalls,
                providerEvents: remaining.providerEvents,
                parentEdges: remaining.parentEdges,
                skillRelations: remaining.skillRelations,
                planSnapshots: remaining.planSnapshots,
                compactions: remaining.compactions,
                tokenUsage: remaining.tokenUsage,
            };
        },
        drain,
        /** Lines that failed the JSONL boundary decode (unparseable JSON or a
         *  non-record payload). Counted, never thrown. */
        malformedLines(): number {
            return malformedLines;
        },
    };
}

export function extractCodexJsonlLines(lines: Iterable<string>): CodexExtract | null {
    const extractor = createCodexExtractor("codex-test.jsonl");
    for (const line of lines) {
        extractor.processLine(line);
    }
    return extractor.finish();
}

export function __testExtractCodexJsonlLines(lines: Iterable<string>): CodexExtract | null {
    return extractCodexJsonlLines(lines);
}

export function __testStreamCodexJsonlLines(lines: Iterable<string>, every: number): CodexExtract[] {
    const extractor = createCodexExtractor("codex-test.jsonl");
    const batches: CodexExtract[] = [];
    let seen = 0;
    for (const line of lines) {
        extractor.processLine(line);
        seen += 1;
        if (seen % every === 0) {
            const batch = extractor.drain(false);
            if (batch.session && (
                batch.turns.length > 0 ||
                batch.turnTokenUsages.length > 0 ||
                batch.invocations.length > 0 ||
                batch.toolCalls.length > 0 ||
                batch.providerEvents.length > 0 ||
                batch.parentEdges.length > 0 ||
                batch.skillRelations.length > 0 ||
                batch.planSnapshots.length > 0 ||
                batch.tokenUsage !== null
            )) {
                batches.push({ ...batch, session: batch.session });
            }
        }
    }
    const final = extractor.drain(true);
    if (final.session && (
        final.turns.length > 0 ||
        final.turnTokenUsages.length > 0 ||
        final.invocations.length > 0 ||
        final.toolCalls.length > 0 ||
        final.providerEvents.length > 0 ||
        final.parentEdges.length > 0 ||
        final.skillRelations.length > 0 ||
        final.planSnapshots.length > 0 ||
        final.tokenUsage !== null
    )) {
        batches.push({ ...final, session: final.session });
    }
    return batches;
}

type CodexExtractor = ReturnType<typeof createCodexExtractor>;

interface CodexStreamHooks<E = never, R = never> {
    /** Flush boundary in lines; `extractor.drain(false)` handed to `onFlush`. */
    readonly flushEvery: number;
    /** Drains a bounded batch to storage mid-file (memory bound). */
    readonly onFlush: (batch: MutableCodexExtract) => Effect.Effect<void, E, R>;
    /** Progress tick at the `CODEX_PROGRESS_LINE_EVERY` cadence (phase 1) and
     *  again right after each flush (phase 2); `phase` distinguishes them. */
    readonly onProgress?: (phase: number) => Effect.Effect<void, E, R>;
    /** Fired AFTER every processed line with the running count, so a caller can
     *  keep its own `lineCount` live mid-stream (the progress emitter reads it).
     *  Synchronous + cheap; kept off the `E`/`R` channels deliberately. */
    readonly onLine?: (lineCount: number) => void;
}

/**
 * Stream a codex jsonl file through `FileSystem.stream` → `splitLines`, feeding
 * each line into `extractor.processLine` AND threading the flush/progress
 * cadence into the per-line Effect (so a 30 MB session drains in bounded
 * batches instead of buffering whole and flushing once). The terminal
 * `drain(true)` + final flush stays with the CALLER. Returns the line count.
 *
 * A vanished file (NotFound) propagates as a typed `PlatformError` so the
 * caller can skip it; non-NotFound failures propagate too.
 */
const streamCodexFile = <E = never, R = never>(
    filePath: string,
    extractor: CodexExtractor,
    hooks: CodexStreamHooks<E, R>,
): Effect.Effect<number, PlatformError.PlatformError | E, FileSystem.FileSystem | R> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let lineCount = 0;
        yield* fs.stream(filePath).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
                Effect.gen(function* () {
                    extractor.processLine(line);
                    lineCount += 1;
                    if (hooks.onLine) hooks.onLine(lineCount);
                    if (lineCount % CODEX_PROGRESS_LINE_EVERY === 0) {
                        if (hooks.onProgress) yield* hooks.onProgress(1);
                    }
                    if (lineCount % hooks.flushEvery === 0) {
                        yield* hooks.onFlush(extractor.drain(false));
                        if (hooks.onProgress) yield* hooks.onProgress(2);
                    }
                }),
            ),
        );
        return lineCount;
    });

/**
 * Test seam: stream a file the SAME way production does (flush cadence threaded
 * via {@link streamCodexFile}) and return the finished extract. NotFound
 * propagates so the vanished-file skip contract is testable.
 */
export const __testStreamCodexFile = (
    filePath: string,
    flushEvery = DEFAULT_CODEX_FLUSH_EVERY,
): Effect.Effect<CodexExtract | null, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const extractor = createCodexExtractor(filePath);
        yield* streamCodexFile(filePath, extractor, {
            flushEvery,
            // The test extractor accumulates across drains; finish() drains the
            // rest, so the mid-file drain here is a no-op for the final result -
            // we only need the cadence to FIRE so `lineCount % flushEvery`
            // exercises the streaming path identically to production.
            onFlush: () => Effect.void,
        });
        return extractor.finish();
    });

/**
 * Test seam for the flush-cadence honesty test: collects every batch that the
 * streaming reader drains mid-file PLUS the terminal `drain(true)`, proving
 * (a) multiple flushes fire on a file larger than `flushEvery`, and
 * (b) the concatenated batches are output-equivalent to a single pass.
 */
export const __testStreamCodexFileBatches = (
    filePath: string,
    flushEvery: number,
): Effect.Effect<MutableCodexExtract[], PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const extractor = createCodexExtractor(filePath);
        const batches: MutableCodexExtract[] = [];
        const keep = (batch: MutableCodexExtract): boolean =>
            batch.session !== null && (
                batch.turns.length > 0 ||
                batch.turnTokenUsages.length > 0 ||
                batch.invocations.length > 0 ||
                batch.toolCalls.length > 0 ||
                batch.providerEvents.length > 0 ||
                batch.parentEdges.length > 0 ||
                batch.skillRelations.length > 0 ||
                batch.planSnapshots.length > 0 ||
                batch.tokenUsage !== null
            );
        yield* streamCodexFile(filePath, extractor, {
            flushEvery,
            onFlush: (batch) =>
                Effect.sync(() => {
                    if (keep(batch)) batches.push(batch);
                }),
        });
        const final = extractor.drain(true);
        if (keep(final)) batches.push(final);
        return batches;
    });

/** Outcome of {@link __testStreamCodexFileGuarded}: which arm of the production
 *  NotFound guard was taken. `"skipped"` = benign vanished-file skip (nothing
 *  persisted); `"completed"` = stream finished; a Failure exit = NotFound (or any
 *  other PlatformError) propagated because partial state was already persisted. */
export type CodexGuardedOutcome = "completed" | "skipped";

/**
 * Test seam mirroring the PRODUCTION mid-stream NotFound guard exactly (the
 * `ingestCodex` per-file block can't run without a DB, so we replicate just the
 * guard around the shared {@link streamCodexFile}). `onFlush` simulates a DB
 * write by flipping `persistedAny` (== production's `sessionUpserted`). A
 * NotFound is only swallowed as `"skipped"` when NOTHING was persisted yet
 * (`lineCount === 0 && !persistedAny`); a NotFound AFTER a flush wrote partial
 * rows propagates as a Failure - proving partial state is never silently skipped.
 */
export const __testStreamCodexFileGuarded = (
    filePath: string,
    flushEvery: number,
): Effect.Effect<CodexGuardedOutcome, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const extractor = createCodexExtractor(filePath);
        let lineCount = 0;
        let persistedAny = false;
        return yield* streamCodexFile(filePath, extractor, {
            flushEvery,
            // Simulate the production `writeBatch`: the first non-empty flush
            // upserts the session, flipping the "persisted anything" flag.
            onFlush: (batch) =>
                Effect.sync(() => {
                    if (batch.session) persistedAny = true;
                }),
            onLine: (count) => {
                lineCount = count;
            },
        }).pipe(
            Effect.as("completed" as CodexGuardedOutcome),
            Effect.catchTag("PlatformError", (e) =>
                isNotFound(e) && lineCount === 0 && !persistedAny
                    ? Effect.succeed("skipped" as CodexGuardedOutcome)
                    : Effect.fail(e),
            ),
        );
    });

export const __testCompactCodexToolCall = compactCodexToolCall;

const buildCodexTokenUsageStatements = (
    usage: CodexTokenUsage | null,
    source: "codex" | "codex-subagent" = "codex",
): string[] => {
    if (!usage) return [];
    const cost = estimateCost({
        modelKey: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        estimatedTokens: usage.estimatedTokens,
    });
    return [
        // TODO(burn-buckets): codex batching makes per-session series unavailable here; backfill via derive stage
        buildSessionTokenUsageStatement({
            sessionId: usage.session,
            source,
            model: usage.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            reasoningOutputTokens: usage.reasoningOutputTokens,
            estimatedTokens: usage.estimatedTokens,
            contextWindow: usage.contextWindow,
            cost: { modelRefKey: usage.model, estimate: cost },
            labels: surrealJsonOption(tokenQualityLabels({
                source: "codex_token_count",
                tokenSourceQuality: "explicit",
                tokenSourceDetail: "codex_token_count.total_token_usage",
                model: usage.model,
                modelSourceDetail: usage.model ? "codex_session.model_provider" : "missing_codex_model_provider",
            })),
            metrics: surrealJsonOption({
                total_token_usage: usage.totalTokenUsage,
                last_token_usage: usage.lastTokenUsage,
                token_count_events: usage.tokenCountEvents,
            }),
            ts: usage.ts,
        }),
    ];
};

const buildCodexTurnTokenUsageStatements = (
    usages: readonly CodexTurnTokenUsage[],
    source: "codex" | "codex-subagent" = "codex",
): string[] =>
    usages.map((usage) =>
        buildTurnTokenUsageStatement({
            sessionId: usage.session,
            seq: usage.seq,
            source,
            model: usage.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            freshInputTokens: usage.freshInputTokens,
            estimatedTokens: usage.estimatedTokens,
            reasoningOutputTokens: usage.reasoningOutputTokens,
            modelRefKey: usage.model,
            cost: estimateCost({
                modelKey: usage.model,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                cacheCreationInputTokens: usage.cacheCreationInputTokens,
                cacheReadInputTokens: usage.cacheReadInputTokens,
                estimatedTokens: usage.estimatedTokens,
            }),
            usageSource: usage.usageSource,
            usageQuality: usage.usageQuality,
            raw: surrealJsonOption(usage.raw),
            ts: usage.ts,
        })
    );

const toCodexNormalizedBatch = (
    batch: MutableCodexExtract,
    payloadMaxBytes: number,
): NormalizedTranscriptBatch => ({
    providers: batch.session
        ? [{
            name: "codex",
            displayName: "Codex",
            version: batch.session.cli_version,
            capabilities: {
                transcripts: true,
                toolCalls: true,
                planSignals: providerPlanSignalAvailability.codex,
                delegationSignals: providerDelegationSignalAvailability.codex,
            },
        }]
        : [],
    sessions: batch.session
        ? [{
            id: batch.session.id,
            provider: "codex",
            providerSessionId: batch.session.id,
            cwd: batch.session.cwd,
            project: batch.session.cwd,
            model: concreteCodexModel(batch.session),
            sourcePath: batch.sourcePath,
            raw: {
                source: "codex_transcript",
                cliVersion: batch.session.cli_version,
                modelProvider: batch.session.model_provider,
                model: batch.session.model,
            },
            labels: { source: "transcript" },
            metrics: {
                turns: batch.turns.length,
                toolCalls: batch.toolCalls.length,
                providerEvents: batch.providerEvents.length,
            },
            startedAt: batch.session.started_at,
            endedAt: batch.session.ended_at,
        }]
        : [],
    // Without a session header, NO provider/session/event statements are
    // emitted; token and evidence statements can still be flushed.
    events: batch.session ? batch.providerEvents : [],
    turns: batch.turns.map((turn) => ({
        sessionId: turn.session,
        seq: turn.seq,
        ts: turn.ts,
        role: turn.role,
        messageKind: turn.message_kind,
        intentKind: turn.intent_kind,
        text: turn.text,
        textExcerpt: turn.text_excerpt,
        hasToolUse: turn.has_tool_use,
        hasError: false,
        agentEvent: null,
    })),
    // Payload compaction applies ONLY to the persisted tool_call rows...
    toolCalls: batch.toolCalls.map((call) => compactCodexToolCall(call, payloadMaxBytes)),
    // ...while file evidence is extracted from the UNcompacted calls.
    toolFileEvidence: extractToolFileEvidence(batch.toolCalls),
    agentEventParentEdges: batch.parentEdges,
    syntheticSkillInvocations: batch.invocations.map((invocation) => ({
        sessionId: invocation.session,
        seq: invocation.seq,
        ts: invocation.ts,
        skillName: invocation.skill,
        args: invocation.args,
        skillScope: "codex-tool",
        skillContentHash: "codex",
    })),
    toolCallSkillRelations: batch.skillRelations,
    planSnapshots: batch.planSnapshots,
    compactions: batch.compactions,
});

const buildCodexBatchStatements = (
    batch: MutableCodexExtract,
    payloadMaxBytes: number,
    clearExisting = true,
): string[] => [
    ...buildNormalizedTranscriptStatements(
        toCodexNormalizedBatch(batch, payloadMaxBytes),
        { clearExisting },
    ),
    ...buildCodexTokenUsageStatements(batch.tokenUsage, codexSourceForThread(batch.session?.thread_source)),
    ...buildCodexTurnTokenUsageStatements(batch.turnTokenUsages, codexSourceForThread(batch.session?.thread_source)),
];

export const __testBuildCodexBatchStatements = buildCodexBatchStatements;

const queryCodexStatements = (statements: readonly string[]) =>
    executeStatements(statements, { chunkSize: 500, label: "codex" });

interface CodexIngestOpts {
    sinceDays: number | undefined;
    runId: string | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
    /** Cumulative skipped-file snapshots from the failure collector (see
     *  file-isolation.ts). The stage wires `stageFileFailureAnnotator` here so
     *  the dashboard Live tab can list which files were skipped and why. */
    onFileFailures: (snapshot: FileFailureSnapshot) => Effect.Effect<void>;
    /** Hard cap on session files processed - a backstop for `ingest --dry-run`
     *  calibration (paired with `deadlineMs`). */
    limit: number | undefined;
    /** Absolute wall-clock deadline (ms epoch). Once reached, no NEW file is
     *  started; in-flight files finish. Lets `--dry-run` time-box calibration. */
    deadlineMs: number | undefined;
    /** Repo roots to scope ingest to (`ingest here`). When set, only codex
     *  rollout files whose session cwd is inside one of these roots are
     *  ingested (head-peeked before parse). Undefined = ingest all (#680). */
    repoRoots: readonly string[] | undefined;
}

export interface CodexStats {
    records: number;
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
    toolCalls: number;
    planSnapshots: number;
    /** JSONL lines skipped at the decode boundary (unparseable / non-record). */
    malformedLines: number;
    /** Files whose pipeline failed and was skipped (retried next run). */
    failedFiles: number;
}

export const ingestCodex = Effect.fn("codex.ingest")(
    function* (opts: Partial<CodexIngestOpts> = {}) {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const fs = yield* FileSystem.FileSystem;
        const dataDir = cfg.paths.dataDir;
        // Shared across all files this stage run: the agent_event ghost-index
        // rebuild fires at most once, memoized so file concurrency awaits one
        // in-flight rebuild + a failed rebuild is observable (#680).
        const agentEventSeqRebuild = yield* makeAgentEventSeqRebuild(db);
        // Set when a file exhausts the heal ladder this run; gates the
        // clear-on-clean-completion below so we don't wipe a just-written marker.
        let indexHealExhausted = false;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        let files = yield* walkJsonlFilesStrict(cfg.paths.codexDir, cutoff);
        // `ingest here` repo scope (#680): head-peek each rollout's session_meta
        // cwd (bounded, cheap) and keep only files inside a repo root. Out-of-repo
        // files are dropped BEFORE the work-unit so they never watermark - a later
        // global ingest still picks them up. No repoRoots => ingest everything.
        if (opts.repoRoots && opts.repoRoots.length > 0) {
            const roots = opts.repoRoots;
            const scoped: typeof files = [];
            // NOTE (accepted tradeoff): a head-peek read error maps the cwd to
            // null -> out-of-scope (best-effort); a later full ingest still
            // picks the file up. `unreadable` tallies those for a debug log.
            let unreadable = 0;
            yield* Effect.forEach(
                files,
                (file) =>
                    Effect.gen(function* () {
                        const cwd = yield* readCodexSessionCwd(file.path);
                        if (cwd === null) unreadable += 1;
                        // Canonicalize both sides (realpath) so a symlinked
                        // in-repo cwd is included and `/repo/../outside` excluded.
                        if (yield* canonicalCwdInRepoScope(cwd, roots)) scoped.push(file);
                    }),
                { concurrency: 8, discard: true },
            );
            if (unreadable > 0) {
                yield* Effect.logDebug("codex ingest here: unreadable head-peek files", { unreadable });
            }
            yield* Effect.logDebug("codex ingest here scope", {
                candidates: files.length,
                inScope: scoped.length,
            });
            files = scoped;
        }
        // `--dry-run` calibration: cap to a small representative slice so we can
        // time real parse+write throughput without processing everything.
        if (typeof opts.limit === "number" && files.length > opts.limit) {
            files.length = opts.limit;
        }
        const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
        if (opts.onProgress) yield* opts.onProgress({ totalFiles: files.length, totalBytes });
        const rawMaxBytes = cfg.knobs.codexRawMaxBytes;
        const progressEvery = cfg.knobs.codexProgressEvery;
        const flushEvery = cfg.knobs.codexFlushEvery;
        const concurrency = cfg.knobs.codexConcurrency;
        const payloadMaxBytes = cfg.knobs.codexPayloadMaxBytes;

        let fileCount = 0;
        let byteCount = 0;
        let sessionCount = 0;
        let turnCount = 0;
        let invCount = 0;
        let toolCallCount = 0;
        let planSnapshotCount = 0;
        let malformedLineCount = 0;
        const recordCount = () => turnCount + invCount + toolCallCount + planSnapshotCount;

        // Skip-unchanged watermark + per-file failure isolation + deadline +
        // active-file counting all live in the shared JSONL work-unit; codex
        // supplies discovery (above) and the per-file parse/write below. A file
        // whose (mtime,size) matched a prior run is skipped without re-parsing.
        const result = yield* runJsonlProviderFiles({
            candidates: files,
            sourceKind: "codex_session",
            forceEnv: "AX_REDERIVE_CODEX",
            source: "codex",
            ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
            ...(opts.onFileFailures ? { onFileFailures: opts.onFileFailures } : {}),
            ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
            concurrency,
            processFile: (file, index, loop) => Effect.gen(function* () {
                if (opts.onProgress && (index < 5 || index % 10 === 0)) {
                    yield* opts.onProgress({
                        currentFile: index + 1,
                        totalFiles: files.length,
                        currentFileBytes: file.sizeBytes,
                        totalBytes,
                        files: fileCount,
                        bytes: byteCount,
                        records: recordCount(),
                        lines: 0,
                        activeFiles: loop.activeFiles,
                        phase: 1,
                        sessions: sessionCount,
                        turns: turnCount,
                        invocations: invCount,
                        toolCalls: toolCallCount,
                        planSnapshots: planSnapshotCount,
                    });
                }
                const filePath = file.path;
                const fileStartedAt = Date.now();
                const sizeBytes = file.sizeBytes;
                const snapshotRaw = shouldSnapshotCodexRaw(sizeBytes, rawMaxBytes);
                if (!snapshotRaw) {
                    yield* Effect.logDebug("codex raw snapshot skipped", {
                        file: fileCount + 1,
                        totalFiles: files.length,
                        size: formatBytes(sizeBytes),
                        max: formatBytes(rawMaxBytes),
                        path: filePath,
                    });
                }

                const extractor = createCodexExtractor(filePath, payloadMaxBytes);
                let lineCount = 0;
                let currentSession: CodexSession | null = null;
                let sessionUpserted = false;
                let fileTurns = 0;
                let fileInvocations = 0;
                let fileToolCalls = 0;
                let filePlanSnapshots = 0;

                const emitProgress = (phase: number) =>
                    opts.onProgress
                        ? opts.onProgress({
                            currentFile: index + 1,
                            totalFiles: files.length,
                            currentFileBytes: sizeBytes,
                            totalBytes,
                            files: fileCount,
                            bytes: byteCount,
                            records: recordCount(),
                            lines: lineCount,
                            fileTurns,
                            fileToolCalls,
                            activeFiles: loop.activeFiles,
                            phase,
                            sessions: sessionCount + (sessionUpserted ? 1 : 0),
                            turns: turnCount,
                            invocations: invCount,
                            toolCalls: toolCallCount,
                            planSnapshots: planSnapshotCount,
                        })
                        : Effect.void;

                const upsertSession = (
                    session: CodexSession,
                    rawPointer: string | null,
                ) =>
                    db.upsert(new RecordId("session", session.id), {
                        project: session.cwd ?? undefined,
                        cwd: session.cwd ?? undefined,
                        model: concreteCodexModel(session) ?? undefined,
                        reasoning_effort: session.reasoning_effort ?? undefined,
                        source: codexSourceForThread(session.thread_source),
                        started_at: new Date(session.started_at),
                        ended_at: new Date(session.ended_at),
                        raw_file: rawPointer ?? undefined,
                    });

                let providerEventsCleared = false;
                const writeBatch = (batch: MutableCodexExtract) =>
                    Effect.gen(function* () {
                        yield* Effect.forEach(
                            batch.warnings,
                            (warning) => Effect.logWarning("codex transcript timestamp fallback", {
                                file: filePath,
                                warning,
                            }),
                            { discard: true },
                        );
                        if (!batch.session) return;
                        currentSession = batch.session;
                        if (!sessionUpserted) {
                            yield* upsertSession(batch.session, null);
                            sessionUpserted = true;
                        }
                        // Clear pre-existing agent_event rows once, on the first
                        // batch for this session. Subsequent streaming batches must
                        // NOT re-clear or they would wipe this ingest's own events.
                        const clearExisting = !providerEventsCleared;
                        providerEventsCleared = true;
                        yield* queryCodexStatements(buildCodexBatchStatements(batch, payloadMaxBytes, clearExisting));
                        turnCount += batch.turns.length;
                        fileTurns += batch.turns.length;
                        toolCallCount += batch.toolCalls.length;
                        fileToolCalls += batch.toolCalls.length;
                        invCount += batch.invocations.length;
                        fileInvocations += batch.invocations.length;
                        planSnapshotCount += batch.planSnapshots.length;
                        filePlanSnapshots += batch.planSnapshots.length;
                    });

                // Stream the file the SAME way the test seams do, via the shared
                // `streamCodexFile` body (NOT a node fh): `FileSystem.stream` so a
                // session that VANISHED between discovery and here (e.g. a cleaned-up
                // session dir) surfaces as a typed NotFound `PlatformError`. The
                // flush/progress cadence is threaded INTO the per-line Effect (via
                // `onFlush`/`onProgress`) so a 30 MB session still drains in bounded
                // batches at `flushEvery` intervals - identical to before. `onLine`
                // keeps our outer `lineCount` live mid-stream so the progress emitter
                // sees the running total AND so the NotFound guard below sees the
                // real count even when the stream fails before returning.
                //
                // NotFound handling is GUARDED: a vanished file is only a benign skip
                // when NOTHING was persisted yet (no line processed AND no session
                // upserted). If NotFound strikes AFTER a mid-stream flush already wrote
                // partial rows (`sessionUpserted`), swallowing it would leave a
                // partial/incomplete session in the DB while reporting "skipped" - a
                // silent partial ingest. In that case we let it propagate as a loud
                // stage-level failure instead. Other PlatformErrors always re-raise.
                const vanished = yield* streamCodexFile(filePath, extractor, {
                    flushEvery,
                    onFlush: writeBatch,
                    onProgress: emitProgress,
                    onLine: (count) => {
                        lineCount = count;
                    },
                }).pipe(
                    Effect.as(false),
                    Effect.catchTag("PlatformError", (e) =>
                        isNotFound(e) && lineCount === 0 && !sessionUpserted
                            ? Effect.succeed(true)
                            : Effect.fail(e),
                    ),
                );
                if (vanished) {
                    return false;
                }

                const finalBatch = extractor.drain(true);
                yield* writeBatch(finalBatch);
                malformedLineCount += extractor.malformedLines();
                const completedSession = finalBatch.session ?? currentSession;
                if (!completedSession) {
                    return false;
                }

                // Snapshot the raw codex jsonl into the `codex_artifacts` bucket as
                // best-effort cold storage for modest files. Large Codex sessions
                // are parsed line-by-line above; reading them again just to copy the
                // raw transcript can dominate benchmark runs.
                const bucketPath = `${completedSession.id}.jsonl`;
                const rawContent = snapshotRaw
                    ? yield* emitProgress(3).pipe(
                        Effect.andThen(
                            // Best-effort cold-storage copy: a file that vanished
                            // after streaming tolerates to null so the snapshot is
                            // simply skipped - the parsed rows are already persisted.
                            // Matches `transcripts.ts`: NotFound recovers to null,
                            // genuine read faults re-raise rather than being silently
                            // swallowed.
                            fs.readFileString(filePath).pipe(
                                skipNotFound(null as string | null),
                            ),
                        ),
                    )
                    : null;
                let rawPointer: string | null = null;
                if (rawContent !== null) {
                    rawPointer = yield* db
                        .putFile("codex_artifacts", bucketPath, rawContent)
                        .pipe(
                            Effect.map(() => filePointer("codex_artifacts", bucketPath)),
                            Effect.catch((err) =>
                                Effect.logDebug("codex raw snapshot failed", {
                                    sessionId: completedSession.id,
                                    message: err.message,
                                }).pipe(Effect.as(null as string | null)),
                            ),
                        );
                }

                // Final session upsert carries the latest ended_at and raw artifact
                // pointer after the streaming writes have completed.
                yield* upsertSession(completedSession, rawPointer);
                fileCount += 1;
                byteCount += sizeBytes;
                sessionCount += 1;

                if (!snapshotRaw) {
                    yield* Effect.logDebug("codex file ingested", {
                        file: fileCount,
                        totalFiles: files.length,
                        bytes: formatBytes(byteCount),
                        totalBytes: formatBytes(totalBytes),
                        sessionId: completedSession.id,
                        ms: Date.now() - fileStartedAt,
                        lines: lineCount,
                        turns: fileTurns,
                        toolCalls: fileToolCalls,
                    });
                }

                if (fileCount % progressEvery === 0) {
                    const counts = {
                        currentFile: index + 1,
                        totalFiles: files.length,
                        currentFileBytes: sizeBytes,
                        totalBytes,
                        files: fileCount,
                        bytes: byteCount,
                        records: recordCount(),
                        lines: lineCount,
                        fileTurns,
                        fileToolCalls,
                        activeFiles: loop.activeFiles,
                        phase: 2,
                        sessions: sessionCount,
                        turns: turnCount,
                        invocations: invCount,
                        toolCalls: toolCallCount,
                        planSnapshots: planSnapshotCount,
                    };
                    if (opts.onProgress) yield* opts.onProgress(counts);
                    yield* Effect.logDebug("codex ingest progress", counts);
                }
                return true;
            }).pipe(
                // Self-heal the agent_event ghost-index collision (#680): on a
                // duplicate-index DbError, dedupe this session by primary id +
                // retry; if still blocked, rebuild the index CONCURRENTLY once
                // per stage + retry; a second failure records a doctor marker and
                // rethrows so per-file isolation skips it (no silent skip loop).
                (eff) =>
                    withAgentEventSeqHeal(eff, {
                        db,
                        rebuild: agentEventSeqRebuild,
                        onExhausted: (sessionId) =>
                            Effect.sync(() => {
                                indexHealExhausted = true;
                            }).pipe(
                                Effect.andThen(
                                    writeIndexUnhealthyMarker(dataDir, sessionId, `codex file ${file.path}`),
                                ),
                                Effect.provideService(FileSystem.FileSystem, fs),
                            ),
                        onHealed: () =>
                            clearIndexUnhealthyMarker(dataDir).pipe(
                                Effect.provideService(FileSystem.FileSystem, fs),
                            ),
                    }),
                Effect.withSpan("codex.file", {
                    // Basename only: keeps exported-trace attributes small (the full
                    // session path is reconstructable locally if ever needed).
                    attributes: {
                        "file.name": file.path.slice(file.path.lastIndexOf("/") + 1),
                        "file.bytes": file.sizeBytes,
                    },
                }),
            ),
        });
        // F3: clear a stale unhealthy marker on ANY clean stage completion (e.g.
        // a manual `bun scripts/repair-agent-event-index.ts` followed by a clean
        // ingest that never re-triggers the heal). Skip the clear only when a
        // file exhausted the ladder THIS run - that just-written marker stays.
        if (!indexHealExhausted) {
            yield* clearIndexUnhealthyMarker(dataDir).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
            );
        }
        yield* Effect.logDebug("codex ingest complete", {
            files: fileCount,
            records: recordCount(),
            sessions: sessionCount,
            turns: turnCount,
            invocations: invCount,
            toolCalls: toolCallCount,
            planSnapshots: planSnapshotCount,
        });
        return {
            records: recordCount(),
            files: fileCount,
            sessions: sessionCount,
            turns: turnCount,
            invocations: invCount,
            toolCalls: toolCallCount,
            planSnapshots: planSnapshotCount,
            malformedLines: malformedLineCount,
            failedFiles: result.failures.count(),
        } satisfies CodexStats;
    },
);

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        ingestCodex({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<CodexStats>,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const CodexKey = Schema.Literal("codex");
export type CodexKey = typeof CodexKey.Type;

/**
 * Codex transcripts stage - ingests `~/.codex/sessions/` JSONL.
 *
 * Depends on: {@link SkillsKey}, {@link CommandsKey}
 * Consumed by: {@link SubagentsKey}, {@link SpawnedKey}, {@link SignalsKey}
 * Tags: ingest
 */
// Named CodexStageStats to avoid collision with the original CodexStats interface.
export class CodexStageStats extends BaseStageStats.extend<CodexStageStats>("CodexStageStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
    /** JSONL lines skipped at the decode boundary (unparseable / non-record). */
    malformedLines: Schema.Number,
    /** Files whose pipeline failed and was skipped (retried next run). */
    failedFiles: Schema.Number,
}) {}

export const codexStage: StageDef<CodexStageStats, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> = {
    meta: StageMeta.make({ key: "codex", deps: ["skills", "commands"], tags: ["ingest"] }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext) {
        const t0 = Date.now();
        const sinceDays = sinceDaysFromCtx(ctx);
        // Capture the stage span HERE (current span = the runner's
        // LiveTrace.step span) so failure snapshots emitted from deep inside
        // per-file child spans still key to this stage on the live stream.
        const onFileFailures = yield* stageFileFailureAnnotator;
        // A vanished session file is caught + skipped inside `ingestCodex`;
        // any PlatformError that escapes here is a genuine FS fault (e.g. an
        // unreadable sessions root or a non-NotFound stat/stream error), so
        // it dies as a defect rather than masquerading as a recoverable
        // DbError - mirroring `claudeStage`.
        const result = yield* ingestCodex({
            sinceDays,
            runId: ctx.runId,
            onProgress: annotateStageProgress,
            onFileFailures,
            // `ingest here` scopes codex to the repo(s) at $PWD (#680); a global
            // ingest leaves repoRoots undefined => all sessions.
            ...(ctx.repoPaths ? { repoRoots: ctx.repoPaths } : {}),
        }).pipe(
            Effect.catchTag("PlatformError", (e) => Effect.die(e)),
        );
        return CodexStageStats.make({
            durationMs: Date.now() - t0,
            summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls` +
                (result.malformedLines > 0 ? `, ${result.malformedLines} malformed lines skipped` : "") +
                (result.failedFiles > 0 ? `, ${result.failedFiles} file(s) failed (retry next run)` : ""),
            sessionsIngested: result.sessions,
            turnsIngested: result.turns,
            toolCallsIngested: result.toolCalls,
            malformedLines: result.malformedLines,
            failedFiles: result.failedFiles,
        });
    }),
};
