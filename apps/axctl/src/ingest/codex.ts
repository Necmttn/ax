import { Effect, FileSystem, Option, Path, PlatformError, Schema, Stream } from "effect";
import { RecordId, SurrealClient, filePointer } from "@ax/lib/db";
import { AxConfig } from "@ax/lib/config";
import { decodeJsonOrNull } from "@ax/lib/decode";
import { skillRecordKey } from "@ax/lib/skill-id";
import { recordRef, surrealDate, surrealJsonOption, surrealObject, surrealOptionInt, surrealOptionString, surrealString } from "@ax/lib/shared/surql";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import { annotateStageProgress } from "./stage/runner.ts";
import type { StageDef } from "./stage/registry.ts";
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildToolFileEvidenceStatements,
    buildToolCallStatements,
    type PlanSnapshotWrite,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import {
    buildAgentEventParentEdgeStatement,
    agentEventRecordKey,
    buildAgentEventStatements,
    buildAgentProviderStatements,
    type AgentEventParentEdgeWrite,
    type AgentEventWrite,
} from "./provider-events.ts";
import {
    extractCommandTool,
    normalizeCommand,
    parseCodexFunctionOutput,
    toolKindForName,
} from "./tool-calls.ts";
import { buildCompactionStatements, extractCodexCompaction, type CompactionWrite } from "./compaction.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { providerDelegationSignalAvailability } from "./delegation.ts";
import {
    normalizeProviderPlanSnapshot,
    providerPlanSignalAvailability,
    toPlanSnapshotWrite,
} from "./plans.ts";
import { invokedRelationRecordKey, toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import { isNotFound, skipNotFound } from "@ax/lib/shared/fs-error";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import { tokenQualityLabels } from "./token-quality.ts";
import { estimateCost } from "./model-pricing.ts";

const DEFAULT_CODEX_RAW_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CODEX_PROGRESS_EVERY = 10;
export const DEFAULT_CODEX_FLUSH_EVERY = 500;
const DEFAULT_CODEX_CONCURRENCY = 1;
const DEFAULT_CODEX_PAYLOAD_MAX_BYTES = 1200;
const CODEX_PROGRESS_LINE_EVERY = 100;

interface CodexSession {
    id: string;
    cwd: string | null;
    cli_version: string | null;
    model_provider: string | null;
    model: string | null;
    started_at: string;
    ended_at: string;
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
    skill: string; // namespaced as "codex:<tool>"
    args: unknown;
}

interface CodexTokenUsage {
    session: string;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheReadInputTokens: number | null;
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
    freshInputTokens: number | null;
    estimatedTokens: number;
    usageSource: string;
    usageQuality: string;
    raw: Record<string, unknown>;
}

function parseJsonl(line: string): Record<string, unknown> | null {
    const decoded = decodeJsonOrNull(line);
    return isRecord(decoded) ? decoded : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" ? value : null;
}

function numberField(input: Record<string, unknown>, field: string): number | null {
    const value = input[field];
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseCodexArguments(input: unknown): unknown {
    if (typeof input !== "string") return input ?? null;
    const decoded = decodeJsonOrNull(input);
    return decoded ?? input;
}

function jsonText(input: unknown): string | null {
    try {
        const encoded = JSON.stringify(input);
        return encoded === undefined ? null : encoded;
    } catch {
        return null;
    }
}

const surrealOptionFloat = (value: number | null | undefined): string =>
    value === null || value === undefined || !Number.isFinite(value)
        ? "NONE"
        : Number(value.toFixed(8)).toString();

function outputText(input: unknown): string | null {
    return typeof input === "string" ? input : jsonText(input);
}

function codexMessageRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
    if (isRecord(payload.message)) return payload.message;
    if (stringField(payload, "type") === "message") return payload;
    return null;
}

function textFromCodexContent(content: unknown): string | null {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    const text = content
        .filter(isRecord)
        .filter((block) => {
            const type = stringField(block, "type");
            return type === "text" || type === "input_text" || type === "output_text";
        })
        .map((block) => stringField(block, "text"))
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join("\n");
    return text.length > 0 ? text : null;
}

function codexMessageKind(role: string, itemType: string | null, textExcerpt: string | null): string {
    if (role === "system" || role === "developer") return "system_or_developer";
    if (role === "user") {
        if (textExcerpt?.startsWith("<command-name>")) {
            return "control";
        }
        if (textExcerpt && (
            textExcerpt.startsWith("# AGENTS.md instructions") ||
            textExcerpt.startsWith("# CLAUDE.md") ||
            textExcerpt.startsWith("<local-command-caveat>") ||
            textExcerpt.startsWith("Base directory for this skill:") ||
            textExcerpt.startsWith("Base directory for this plugin:") ||
            textExcerpt.includes("<environment_context>") ||
            textExcerpt.includes("<INSTRUCTIONS>")
        )) {
            return "context";
        }
        return "task";
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

type MutableToolCallWrite = {
    -readonly [Key in keyof ToolCallWrite]: ToolCallWrite[Key];
};

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
    const estimatedTokens = numberField(totalTokenUsage, "total_tokens") ??
        (promptTokens ?? 0) + (completionTokens ?? 0);
    const lastTokenUsage = isRecord(info.last_token_usage) ? info.last_token_usage : null;

    return {
        session: currentSession.id,
        model: concreteCodexModel(currentSession),
        promptTokens,
        completionTokens,
        cacheReadInputTokens,
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

interface CodexFileCandidate {
    path: string;
    sizeBytes: number;
}

/**
 * Recursively enumerate `*.jsonl` session files under `root` via the Effect
 * `FileSystem`. The codex sessions dir is nested (year/month/day), so we walk
 * directories depth-first. Resilience matches the prior node-fs walk:
 *   - a `readDirectory` on a vanished/missing dir (NotFound) yields `[]` → skip,
 *   - each entry is `stat`-ed; a vanished entry (NotFound) is skipped,
 *   - `.type === "Directory"` recurses, a `.jsonl` File is collected.
 * Non-NotFound `PlatformError`s (BadResource/PermissionDenied/...) re-raise so a
 * genuine FS fault is a defect, not a silently-dropped half-walk.
 *
 * `File.Info.mtime` is `Option<Date>` (epoch 0 fallback so a missing mtime is
 * never `--since`-skipped); `.size` is a branded bigint coerced to `number`.
 */
const walkJsonlFiles = (
    root: string,
    cutoffMs: number,
): Effect.Effect<CodexFileCandidate[], PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const out: CodexFileCandidate[] = [];

        const visit = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
            Effect.gen(function* () {
                const entries = yield* fs.readDirectory(dir).pipe(
                    skipNotFound([] as string[]),
                );
                for (const entry of entries) {
                    const full = path.join(dir, entry);
                    const info = yield* fs.stat(full).pipe(
                        Effect.asSome,
                        skipNotFound(Option.none()),
                    );
                    if (Option.isNone(info)) continue;
                    const stats = info.value;
                    if (stats.type === "Directory") {
                        yield* visit(full);
                    } else if (stats.type === "File" && full.endsWith(".jsonl")) {
                        const mtimeMs = Option.getOrElse(stats.mtime, () => new Date(0)).getTime();
                        if (cutoffMs > 0 && mtimeMs < cutoffMs) continue;
                        out.push({ path: full, sizeBytes: Number(stats.size) });
                    }
                }
            });

        yield* visit(root);
        return out;
    });

export interface CodexExtract {
    session: CodexSession;
    sourcePath: string | null;
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
        const inputJson = parseCodexArguments(payload.arguments);
        const turnKey = turnRecordKey(currentSession.id, seq);
        const toolCallKey = toolCallRecordKey({
            sessionId: currentSession.id,
            seq,
            callId,
        });
        const call: MutableToolCallWrite = {
            provider: "codex",
            toolName,
            toolKind: toolKindForName(toolName),
            sessionId: currentSession.id,
            seq,
            turnKey,
            agentEventKey: agentEventRecordKey({
                provider: "codex",
                providerSessionId: currentSession.id,
                providerEventId: callId,
                seq,
            }),
            callId,
            ts,
            cwd: currentSession.cwd,
            inputJson,
            rawJson: payload,
            hasError: false,
        };

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

        if (toolName === "exec_command" && isRecord(inputJson)) {
            const command = stringField(inputJson, "command") ?? stringField(inputJson, "cmd");
            if (command) {
                call.commandText = command;
                call.commandToolName = extractCommandTool(command);
                call.commandNorm = normalizeCommand(command);
            }
        }

        toolCalls.push(call);
        toolCallsByCallId.set(callId, call);
        pendingToolCallKeys.add(toolCallKey);
        const pendingResult = pendingToolResultsByCallId.get(callId);
        if (pendingResult) {
            applyToolResult(call, pendingResult);
            pendingToolCallKeys.delete(toolCallKey);
            pendingToolResultsByCallId.delete(callId);
        }

        const skillName = `codex:${toolName}`;
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
            const entry = parseJsonl(line);
            if (!entry) return;
            const type = stringField(entry, "type");
            const ts = stringField(entry, "timestamp");
            if (!ts) return;
            const payload = isRecord(entry.payload) ? entry.payload : null;

            if (type === "session_meta" && payload) {
                session = {
                    id: stringField(payload, "id") ?? filePath,
                    cwd: stringField(payload, "cwd"),
                    cli_version: stringField(payload, "cli_version"),
                    model_provider: stringField(payload, "model_provider"),
                    model: stringField(payload, "model"),
                    started_at: stringField(payload, "timestamp") ?? ts,
                    ended_at: ts,
                };
                return;
            }
            if (!session) return;
            session.ended_at = ts;

            if (type === "turn_context" && payload) {
                const model = stringField(payload, "model")
                    ?? (isRecord(payload.collaboration_mode) &&
                        isRecord(payload.collaboration_mode.settings)
                        ? stringField(payload.collaboration_mode.settings, "model")
                        : null);
                if (model) session.model = model;
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
                const role =
                    itemType === "function_call"
                        ? "tool_call"
                        : itemType === "message"
                          ? (stringField(message ?? {}, "role") ?? "assistant")
                          : (itemType ?? "unknown");

                const text = textFromCodexContent(message?.content);
                const textExcerpt = text === null ? null : text.slice(0, 500);

                const isToolCall = itemType === "function_call";
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
                } else if (itemType === "function_call_output") {
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

const buildTurnStatements = (turns: readonly CodexTurn[]): string[] =>
    turns.map(
        (t) =>
            `UPSERT turn:\`${turnRecordKey(t.session, t.seq)}\` CONTENT { session: session:\`${t.session}\`, seq: ${t.seq}, ts: d"${t.ts}", role: ${surrealString(t.role)}, message_kind: ${surrealString(t.message_kind)}, intent_kind: ${surrealString(t.intent_kind)}, text: ${t.text === null ? "NONE" : surrealString(t.text)}, text_excerpt: ${t.text_excerpt === null ? "NONE" : surrealString(t.text_excerpt)}, has_tool_use: ${t.has_tool_use}, has_error: false };`,
    );

const buildSyntheticSkillAndInvocationStatements = (
    invocations: readonly CodexInvocation[],
): string[] => {
    if (invocations.length === 0) return [];
    const codexTools = new Set(invocations.map((i) => i.skill));
    const skillStmts = [...codexTools].map(
        (name) =>
            `UPSERT skill:\`${skillRecordKey(name)}\` MERGE { name: ${surrealString(name)}, scope: "codex-tool", dir_path: "(synthetic)", content_hash: "codex" };`,
    );

    const invStmts = invocations.flatMap((inv) => {
        const turnKey = turnRecordKey(inv.session, inv.seq);
        const skillKey = skillRecordKey(inv.skill);
        const args = JSON.stringify(inv.args);
        const edgeKey = invokedRelationRecordKey({ turnKey, skillKey, args });
        return [
            `RELATE turn:\`${turnKey}\`->invoked:\`${edgeKey}\`->skill:\`${skillKey}\` SET ts = d"${inv.ts}", args = ${surrealString(args)}, turn_has_error = false, turn_index = ${inv.seq};`,
        ];
    });
    return [...skillStmts, ...invStmts];
};

export const __testCompactCodexToolCall = compactCodexToolCall;

const buildCodexProviderStatements = (
    batch: MutableCodexExtract,
    clearExisting: boolean,
): string[] => {
    if (!batch.session) return [];
    return [
        ...buildAgentProviderStatements([
            {
                name: "codex",
                displayName: "Codex",
                version: batch.session.cli_version,
                capabilities: {
                    transcripts: true,
                    toolCalls: true,
                    planSignals: providerPlanSignalAvailability.codex,
                    delegationSignals: providerDelegationSignalAvailability.codex,
                },
            },
        ]),
        ...buildAgentEventStatements({
            sessions: [
                {
                    provider: "codex",
                    providerSessionId: batch.session.id,
                    axSessionId: batch.session.id,
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
                    labels: {
                        source: "transcript",
                    },
                    metrics: {
                        turns: batch.turns.length,
                        toolCalls: batch.toolCalls.length,
                        providerEvents: batch.providerEvents.length,
                    },
                    startedAt: batch.session.started_at,
                    endedAt: batch.session.ended_at,
                },
            ],
            events: batch.providerEvents,
        }, { clearExisting }),
    ];
};

const buildCodexTokenUsageStatements = (usage: CodexTokenUsage | null): string[] => {
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
        `UPSERT ${recordRef("session_token_usage", safeKeyPart(usage.session))} MERGE ${surrealObject([
            ["session", recordRef("session", usage.session)],
            ["source", surrealString("codex")],
            ["workflow_epoch", "NONE"],
            ["model", surrealOptionString(usage.model)],
            ["prompt_tokens", surrealOptionInt(usage.promptTokens)],
            ["completion_tokens", surrealOptionInt(usage.completionTokens)],
            ["cache_creation_input_tokens", "NONE"],
            ["cache_read_input_tokens", surrealOptionInt(usage.cacheReadInputTokens)],
            ["estimated_tokens", Math.trunc(usage.estimatedTokens).toString(10)],
            ["transcript_bytes", "0"],
            ["context_window", surrealOptionInt(usage.contextWindow)],
            ["model_ref", usage.model ? recordRef("agent_model", usage.model) : "NONE"],
            ["estimated_input_cost_usd", surrealOptionFloat(cost.inputUsd)],
            ["estimated_output_cost_usd", surrealOptionFloat(cost.outputUsd)],
            ["estimated_cache_creation_cost_usd", surrealOptionFloat(cost.cacheCreationUsd)],
            ["estimated_cache_read_cost_usd", surrealOptionFloat(cost.cacheReadUsd)],
            ["estimated_cost_usd", surrealOptionFloat(cost.totalUsd)],
            ["pricing_source", surrealOptionString(cost.pricingSource)],
            ["labels", surrealJsonOption(tokenQualityLabels({
                source: "codex_token_count",
                tokenSourceQuality: "explicit",
                tokenSourceDetail: "codex_token_count.total_token_usage",
                model: usage.model,
                modelSourceDetail: usage.model ? "codex_session.model_provider" : "missing_codex_model_provider",
            }))],
            ["metrics", surrealJsonOption({
                total_token_usage: usage.totalTokenUsage,
                last_token_usage: usage.lastTokenUsage,
                token_count_events: usage.tokenCountEvents,
            })],
            ["ts", surrealDate(usage.ts)],
        ])};`,
    ];
};

const buildCodexTurnTokenUsageStatements = (
    usages: readonly CodexTurnTokenUsage[],
): string[] =>
    usages.map((usage) => {
        const cost = estimateCost({
            modelKey: usage.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            estimatedTokens: usage.estimatedTokens,
        });
        const turnKey = turnRecordKey(usage.session, usage.seq);
        return `UPSERT ${recordRef("turn_token_usage", turnKey)} MERGE ${surrealObject([
            ["session", recordRef("session", usage.session)],
            ["turn", recordRef("turn", turnKey)],
            ["seq", Math.trunc(usage.seq).toString(10)],
            ["source", surrealString("codex")],
            ["model", surrealOptionString(usage.model)],
            ["prompt_tokens", surrealOptionInt(usage.promptTokens)],
            ["completion_tokens", surrealOptionInt(usage.completionTokens)],
            ["cache_creation_input_tokens", surrealOptionInt(usage.cacheCreationInputTokens)],
            ["cache_read_input_tokens", surrealOptionInt(usage.cacheReadInputTokens)],
            ["fresh_input_tokens", surrealOptionInt(usage.freshInputTokens)],
            ["estimated_tokens", Math.trunc(usage.estimatedTokens).toString(10)],
            ["model_ref", usage.model ? recordRef("agent_model", usage.model) : "NONE"],
            ["estimated_input_cost_usd", surrealOptionFloat(cost.inputUsd)],
            ["estimated_output_cost_usd", surrealOptionFloat(cost.outputUsd)],
            ["estimated_cache_creation_cost_usd", surrealOptionFloat(cost.cacheCreationUsd)],
            ["estimated_cache_read_cost_usd", surrealOptionFloat(cost.cacheReadUsd)],
            ["estimated_cost_usd", surrealOptionFloat(cost.totalUsd)],
            ["pricing_source", surrealOptionString(cost.pricingSource)],
            ["usage_source", surrealString(usage.usageSource)],
            ["usage_quality", surrealString(usage.usageQuality)],
            ["raw", surrealJsonOption(usage.raw)],
            ["ts", surrealDate(usage.ts)],
        ])};`;
    });

const buildCodexBatchStatements = (
    batch: MutableCodexExtract,
    payloadMaxBytes: number,
    clearExisting = true,
): string[] => [
    ...buildCodexProviderStatements(batch, clearExisting),
    ...buildCodexTokenUsageStatements(batch.tokenUsage),
    ...buildTurnStatements(batch.turns),
    ...buildCodexTurnTokenUsageStatements(batch.turnTokenUsages),
    ...buildToolCallStatements(batch.toolCalls.map((call) =>
        compactCodexToolCall(call, payloadMaxBytes),
    )),
    ...buildToolFileEvidenceStatements(extractToolFileEvidence(batch.toolCalls)),
    ...batch.parentEdges.map((edge) =>
        buildAgentEventParentEdgeStatement(edge),
    ),
    ...buildSyntheticSkillAndInvocationStatements(batch.invocations),
    ...batch.skillRelations.flatMap((relation) =>
        buildRelateToolCallSkillStatements(relation),
    ),
    ...batch.planSnapshots.flatMap((snapshot) =>
        buildPlanSnapshotStatements(snapshot),
    ),
    ...buildCompactionStatements(batch.compactions ?? []),
];

export const __testBuildCodexBatchStatements = buildCodexBatchStatements;

const queryCodexStatements = (statements: readonly string[]) =>
    executeStatements(statements, { chunkSize: 500 });

interface CodexIngestOpts {
    sinceDays: number | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
    /** Hard cap on session files processed - a backstop for `ingest --dry-run`
     *  calibration (paired with `deadlineMs`). */
    limit: number | undefined;
    /** Absolute wall-clock deadline (ms epoch). Once reached, no NEW file is
     *  started; in-flight files finish. Lets `--dry-run` time-box calibration. */
    deadlineMs: number | undefined;
}

export interface CodexStats {
    records: number;
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
    toolCalls: number;
    planSnapshots: number;
}

export const ingestCodex = (
    opts: Partial<CodexIngestOpts> = {},
): Effect.Effect<CodexStats, DbError | PlatformError.PlatformError, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const fs = yield* FileSystem.FileSystem;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const files = yield* walkJsonlFiles(cfg.paths.codexDir, cutoff);
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
        let activeFiles = 0;
        const recordCount = () => turnCount + invCount + toolCallCount + planSnapshotCount;

        yield* Effect.forEach(files.map((file, index) => ({ file, index })), ({ file, index }) => Effect.gen(function* () {
            // Time-box (dry-run calibration): once the deadline passes, start no
            // new files; in-flight ones finish.
            if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
                return;
            }
            activeFiles += 1;
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
                    activeFiles,
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
                        activeFiles,
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
                    source: "codex",
                    started_at: new Date(session.started_at),
                    ended_at: new Date(session.ended_at),
                    raw_file: rawPointer ?? undefined,
                });

            let providerEventsCleared = false;
            const writeBatch = (batch: MutableCodexExtract) =>
                Effect.gen(function* () {
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
                activeFiles -= 1;
                return;
            }

            const finalBatch = extractor.drain(true);
            yield* writeBatch(finalBatch);
            const completedSession = finalBatch.session ?? currentSession;
            if (!completedSession) {
                activeFiles -= 1;
                return;
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
                    activeFiles,
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
            activeFiles -= 1;
        }), { concurrency, discard: true });
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
        };
    });

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
}) {}

export const codexStage: StageDef<CodexStageStats, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> = {
    meta: StageMeta.make({ key: "codex", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            // A vanished session file is caught + skipped inside `ingestCodex`;
            // any PlatformError that escapes here is a genuine FS fault (e.g. an
            // unreadable sessions root or a non-NotFound stat/stream error), so
            // it dies as a defect rather than masquerading as a recoverable
            // DbError - mirroring `claudeStage`.
            const result = yield* ingestCodex({ sinceDays, onProgress: annotateStageProgress }).pipe(
                Effect.catchTag("PlatformError", (e) => Effect.die(e)),
            );
            return CodexStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls`,
                sessionsIngested: result.sessions,
                turnsIngested: result.turns,
                toolCallsIngested: result.toolCalls,
            });
        }),
};
