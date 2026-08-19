import { Effect, FileSystem, Option, Path, PlatformError, Schema, Stream } from "effect";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { makeTableSpool, withTableSpool } from "@ax/lib/duckdb/spool";
import type { DbError } from "@ax/lib/errors";
import { AxConfig } from "@ax/lib/config";
import { SkillName } from "@ax/lib/brands";
import { resolveSkillName } from "@ax/lib/skill-id";
import { skillRowId } from "@ax/lib/stable-id";
import { blobName, putBlobFromFile } from "@ax/lib/blob-store";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import { JSONL_WORK_UNIT_WRITES, NORMALIZED_BATCH_WRITES } from "./stage/table-writes.ts";
import { annotateStageProgress, stageFileFailureAnnotator } from "./stage/runner.ts";
import type { StageDef } from "./stage/registry.ts";
import {
    type PlanSnapshotWrite,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
    relateToolCallSkill as relateToolCallSkillRow,
    writePlanSnapshot as writePlanSnapshotRow,
    writeToolCalls as writeToolCallRows,
    writeToolFileEvidence as writeToolFileEvidenceRows,
} from "./evidence-writers.ts";
import {
    agentEventRecordKey,
    type AgentEventWrite,
} from "./provider-events.ts";
import {
    extractCommandTool,
    normalizeCommand,
    toolKindForName,
} from "./tool-calls.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { providerDelegationSignalAvailability } from "./delegation.ts";
import {
    normalizeProviderPlanSnapshot,
    providerPlanSignalAvailability,
    toPlanSnapshotWrite,
} from "./plans.ts";
import {
    fileRecordKey,
    invokedRelationRecordKey,
    toolCallRecordKey,
    turnRecordKey,
} from "./record-keys.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";
import { computeBurnBuckets } from "./burn-buckets.ts";
import {
    type NormalizedTranscriptBatch,
    type NormalizedTurnWrite,
    writeNormalizedTranscriptBatch,
} from "./normalized/transcripts.ts";
import {
    CLAUDE_TEXT_TYPES,
    isRecord,
    jsonText,
    numberField,
    parseJsonl,
    stringField,
    textFromContent,
} from "./normalized/toolkit.ts";
import { classifyUserText, FULL_CONTEXT_RULES } from "./normalized/message-kind.ts";
import { decodeClaudeTranscriptLine } from "./line-schemas.ts";
import { parseHookBlocksFromText } from "./hook-block-text.ts";
import { claudeEffortStamp, loadClaudeEffortLevel } from "./claude-effort.ts";

import { skipNotFound } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { estimateCost, isSyntheticModel, normalizeModelName } from "./model-pricing.ts";
import type { FileFailureSnapshot } from "./file-isolation.ts";
import { INGEST_SPOOL_TABLES, runJsonlProviderFiles } from "./jsonl-work-unit.ts";
import {
    extractClaudeCompaction,
    type CompactionWrite,
} from "./compaction.ts";

const MAX_OUTPUT_EXCERPT_CHARS = 1200;
const DEFAULT_CLAUDE_CONCURRENCY = 4;

interface Session {
    id: string;
    project: string;
    cwd: string | null;
    model: string | null;
    started_at: string | null;
    ended_at: string | null;
    raw_file: string | null;
}

interface Turn {
    session: string;
    seq: number;
    ts: string;
    role: string;
    message_kind: string;
    intent_kind: string;
    text: string | null;
    text_excerpt: string | null;
    has_tool_use: boolean;
    has_error: boolean;
    /** Thinking content-block stats; null on non-assistant turns. */
    thinking_blocks: number | null;
    thinking_tokens: number | null;
}

interface Invocation {
    session: string;
    seq: number;
    ts: string;
    skill: SkillName;
    args: unknown;
    // Snapshot of the source turn's `has_error` at relate time. Denormalised
    // onto the edge so cmdTaste's `clean_inv` count can hit a single
    // GROUP BY scan instead of dereferencing `in.has_error` per row (~30x
    // slower on the largest skills). See issue #31.
    turn_has_error: boolean;
}

interface Edit {
    session: string;
    seq: number;
    ts: string;
    repo: string | null;
    path: string;
    tool: string;
}

export type HookProviderStatus = "progress_only" | "success" | "blocking_error";
export type HookEffect = "allowed" | "blocked" | "injected_context" | "modified_input" | "notified" | "no_op" | "unknown";

export interface HarnessHookEventWrite {
    readonly key: string;
    readonly session: string;
    readonly ts: string;
    readonly harness: "claude";
    readonly event_name: string;
    readonly hook_name: string;
    readonly tool_call_id: string | null;
    readonly tool_call_key: string | null;
    readonly cwd: string | null;
    readonly transcript_uuid: string | null;
    readonly source_type: string;
}

export interface HookCommandInvocationWrite {
    readonly key: string;
    readonly hook_event_key: string;
    readonly session: string;
    readonly ts: string;
    readonly harness: "claude";
    readonly event_name: string;
    readonly hook_name: string;
    readonly tool_call_id: string | null;
    readonly tool_call_key: string | null;
    readonly command: string;
    readonly command_hash: string;
    readonly provider_status: HookProviderStatus;
    readonly effect: HookEffect;
    readonly exit_code: number | null;
    readonly duration_ms: number | null;
    readonly stdout_excerpt: string | null;
    readonly stderr_excerpt: string | null;
    readonly content_excerpt: string | null;
    readonly blocking_error_excerpt: string | null;
}

function deriveProject(path: Path.Path, transcriptDir: string): string {
    // ~/.claude/projects encodes cwd as `-Users-necmttn-Projects-myapp`
    const m = path.basename(transcriptDir);
    return m;
}

function repoFromCwd(cwd: string | null): string | null {
    if (!cwd) return null;
    // Best effort: last path segment after Projects/ or worktrees/ etc.
    const m = cwd.match(/\/(?:Projects|workspaces|worktrees)\/([^/]+)/);
    return m?.[1] ?? null;
}

function normalizeEditPath(pathSvc: Path.Path, filePath: string, cwd: string | null): string {
    if (pathSvc.isAbsolute(filePath) || !cwd) return filePath;
    return pathSvc.resolve(cwd, filePath);
}

export function transcriptEditFileRecordKey(path: string): string {
    return fileRecordKey("_", path);
}

function asContentBlocks(input: unknown): Record<string, unknown>[] {
    return Array.isArray(input) ? input.filter(isRecord) : [];
}

/** `api_error_status` (#867) has never been observed locally, so its type is
 *  unpinned upstream - accept a string or a finite number, store as text. */
function scalarToString(value: unknown): string | null {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
}

function messageKind(role: string, content: unknown, textExcerpt: string | null): string {
    const blocks = asContentBlocks(content);
    if (blocks.length > 0 && blocks.every((block) => stringField(block, "type") === "tool_result")) {
        return "tool_result";
    }
    if (role === "user") {
        return classifyUserText(textExcerpt, FULL_CONTEXT_RULES);
    }
    if (role === "assistant") return "assistant";
    return role;
}

function stableHash(input: string): string {
    return Bun.hash(input).toString(16).padStart(16, "0");
}

function boundedExcerpt(input: string): string {
    const text = input.replace(/\r\n/g, "\n").trim();
    return text.length > MAX_OUTPUT_EXCERPT_CHARS
        ? text.slice(0, MAX_OUTPUT_EXCERPT_CHARS)
        : text;
}

function stringOrJsonExcerpt(input: unknown): string | null {
    if (input === undefined || input === null) return null;
    const text = typeof input === "string" ? input : jsonText(input);
    if (!text) return null;
    const excerpt = boundedExcerpt(text);
    return excerpt.length > 0 ? excerpt : null;
}

export function claudeConcurrency(raw = process.env.AX_CLAUDE_CONCURRENCY): number {
    if (!raw) return DEFAULT_CLAUDE_CONCURRENCY;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLAUDE_CONCURRENCY;
}

function outputText(input: unknown): string | null {
    if (typeof input === "string") return input;
    if (Array.isArray(input)) {
        const parts = input
            .filter(isRecord)
            .map((item) => stringField(item, "text") ?? stringField(item, "content"))
            .filter((text): text is string => text !== null);
        if (parts.length > 0) return parts.join("\n");
    }

    return jsonText(input);
}

function providerEventTextExcerpt(input: string | null): string | null {
    return input === null ? null : input.slice(0, 500);
}

type MutableToolCallWrite = {
    -readonly [Key in keyof ToolCallWrite]: ToolCallWrite[Key];
};

type ToolResultFields = {
    outputJson: unknown;
    outputExcerpt: string | null;
    errorText: string | null;
    hasError: boolean;
};

type PlanSnapshotSlot = {
    readonly index: number;
    readonly snapshotSeq: number;
    readonly createdAt: string;
    readonly toolCallKey: string;
};

function applyToolResult(call: MutableToolCallWrite, result: ToolResultFields): void {
    call.outputJson = result.outputJson;
    call.outputExcerpt = result.outputExcerpt;
    call.errorText = result.errorText;
    call.hasError = result.hasError;
}

/**
 * Per-session token usage summed from the Claude transcript's own
 * `message.usage` blocks. Anthropic reports `input_tokens` EXCLUSIVE of cache
 * tokens, so `promptTokens` here is the total billed input
 * (fresh + cache-creation + cache-read) to match the convention `estimateCost`
 * expects (it subtracts cache from prompt to recover fresh input).
 */
interface ClaudeTokenUsage {
    promptTokens: number;
    completionTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    estimatedTokens: number;
    model: string | null;
    ts: string;
}

/** One assistant turn's usage, captured from that message's `usage` block. */
interface ClaudeTurnTokenUsage {
    seq: number;
    ts: string;
    model: string | null;
    promptTokens: number;
    completionTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    freshInputTokens: number;
    estimatedTokens: number;
    /** Native harness attribution (#867), null before the ~2026-05 cutover. */
    attributionSkill: string | null;
    attributionAgent: string | null;
    /** `message.diagnostics.cache_miss_reason.type` - the reason is an object. */
    cacheMissReasonType: string | null;
    apiErrorStatus: string | null;
}

interface FileExtract {
    session: Session;
    sourcePath: string | null;
    turns: Turn[];
    invocations: Invocation[];
    edits: Edit[];
    toolCalls: ToolCallWrite[];
    providerEvents: AgentEventWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    planSnapshots: PlanSnapshotWrite[];
    hookEvents: HarnessHookEventWrite[];
    hookCommandInvocations: HookCommandInvocationWrite[];
    compactions: CompactionWrite[];
    tokenUsage: ClaudeTokenUsage | null;
    turnTokenUsages: ClaudeTurnTokenUsage[];
    /** Lines that failed the JSONL boundary decode (unparseable JSON or a
     *  non-record payload). Counted, never thrown. */
    malformedLines: number;
}

function createClaudeExtractor(path: Path.Path, projectDir: string, sessionId: string) {
    let session: Session | null = null;
    const turns: Turn[] = [];
    const compactions: CompactionWrite[] = [];
    const invocations: Invocation[] = [];
    const edits: Edit[] = [];
    const toolCalls: MutableToolCallWrite[] = [];
    const providerEvents: AgentEventWrite[] = [];
    const skillRelations: ToolCallSkillRelationWrite[] = [];
    const planSnapshots: PlanSnapshotWrite[] = [];
    const hookEventsByKey = new Map<string, HarnessHookEventWrite>();
    const hookCommandInvocationsByKey = new Map<string, HookCommandInvocationWrite>();
    const toolCallsByCallId = new Map<string, MutableToolCallWrite>();
    const pendingToolResultsByCallId = new Map<string, ToolResultFields>();
    const taskPlanSnapshotSlotsByCallId = new Map<string, PlanSnapshotSlot>();
    const planCreatedAtBySource = new Map<string, string>();
    const planSnapshotCountsBySource = new Map<string, number>();
    const anonymousToolUseCountsByTurn = new Map<number, number>();
    let seq = 0;
    let providerSeq = 0;
    let malformedLines = 0;
    let cwd: string | null = null;
    let model: string | null = null;
    let lastProviderEventId: string | null = null;
    // Token usage accumulated from per-message `usage` blocks. `freshInput` is
    // Anthropic's cache-exclusive `input_tokens`; cache totals are tracked
    // separately so we can both store the breakdown and price it correctly.
    let usageFreshInput = 0;
    let usageCompletion = 0;
    let usageCacheCreation = 0;
    let usageCacheRead = 0;
    let sawUsage = false;
    const turnTokenUsages: ClaudeTurnTokenUsage[] = [];

    const nextProviderSeq = (): number => {
        providerSeq += 1;
        return providerSeq;
    };

    const pushProviderEvent = (event: Omit<AgentEventWrite, "provider" | "providerSessionId" | "axSessionId">): void => {
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
        providerEvents.push({
            provider: "claude",
            providerSessionId: sessionId,
            axSessionId: sessionId,
            ...eventWithoutParents,
            ...(parentProviderEventId !== undefined ? { parentProviderEventId } : {}),
            ...(parentProviderEventIds.size > 0 ? { parentProviderEventIds: [...parentProviderEventIds] } : {}),
        });
        if (event.providerEventId) lastProviderEventId = event.providerEventId;
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

    const isClaudeTaskPlanTool = (name: string): boolean =>
        name === "TaskCreate" || name === "TaskUpdate" || name === "TaskGet" || name === "TaskList";

    const upsertPlanSnapshot = (input: {
        readonly toolName: string;
        readonly payload: unknown;
        readonly ts: string;
        readonly toolCallKey: string;
        readonly existingSlot?: PlanSnapshotSlot;
    }): PlanSnapshotSlot | null => {
        const normalized = normalizeProviderPlanSnapshot({
            provider: "claude",
            toolName: input.toolName,
            sessionId,
            ts: input.ts,
            input: input.payload,
        });
        if (!normalized || normalized.items.length === 0) return null;

        const source = normalized.source;
        const snapshotSeq = input.existingSlot?.snapshotSeq ?? nextPlanSnapshotSeq(source);
        const createdAt = input.existingSlot?.createdAt ?? rememberPlanCreatedAt(source, input.ts);
        const write = toPlanSnapshotWrite({
            snapshot: normalized,
            snapshotSeq,
            createdAt,
            toolCallKey: input.toolCallKey,
        });

        if (input.existingSlot) {
            planSnapshots[input.existingSlot.index] = write;
            return input.existingSlot;
        }

        const slot = {
            index: planSnapshots.length,
            snapshotSeq,
            createdAt,
            toolCallKey: input.toolCallKey,
        };
        planSnapshots.push(write);
        return slot;
    };

    const taskToolResultPayload = (
        call: MutableToolCallWrite,
        resultContent: unknown,
        topLevelToolUseResult: unknown,
    ): unknown => {
        const callInput = isRecord(call.inputJson) ? call.inputJson : {};
        const resultPayload = isRecord(resultContent) ? resultContent : {};
        const topLevelPayload = isRecord(topLevelToolUseResult)
            ? { toolUseResult: topLevelToolUseResult }
            : {};
        return { ...callInput, ...topLevelPayload, ...resultPayload };
    };

    const processToolUse = (
        block: Record<string, unknown>,
        ts: string,
        turnCwd: string | null,
        role: string,
        parentProviderEventId: string | null,
    ): void => {
        const name = stringField(block, "name");
        if (!name) return;

        const input = isRecord(block.input) ? block.input : undefined;
        const transcriptCallId = stringField(block, "id");
        const callId =
            transcriptCallId ??
            `anonymous_tool_use_${seq.toString(10).padStart(6, "0")}_${(
                (anonymousToolUseCountsByTurn.get(seq) ?? 0) + 1
            )
                .toString(10)
                .padStart(3, "0")}`;
        if (!transcriptCallId) {
            anonymousToolUseCountsByTurn.set(
                seq,
                (anonymousToolUseCountsByTurn.get(seq) ?? 0) + 1,
            );
        }
        const currentTurnKey = turnRecordKey(sessionId, seq);
        const toolCallKey = toolCallRecordKey({
            sessionId,
            seq,
            callId,
        });
        const eventSeq = nextProviderSeq();
        const call: MutableToolCallWrite = {
            provider: "claude",
            toolName: name,
            toolKind: toolKindForName(name),
            sessionId,
            seq,
            turnKey: currentTurnKey,
            agentEventKey: agentEventRecordKey({
                provider: "claude",
                providerSessionId: sessionId,
                providerEventId: callId,
                seq: eventSeq,
            }),
            callId,
            ts,
            cwd: turnCwd,
            inputJson: input ?? null,
            rawJson: block,
            hasError: false,
        };

        pushProviderEvent({
            providerEventId: callId,
            parentProviderEventId,
            parentKind: "turn_item",
            seq: eventSeq,
            ts,
            type: "tool_use",
            role,
            text: name,
            textExcerpt: name,
            labels: {
                source: "claude_transcript",
                toolName: name,
                toolKind: call.toolKind,
            },
            metrics: { turnSeq: seq },
        });

        if (name === "Bash") {
            const command = input ? stringField(input, "command") : null;
            if (command) {
                call.commandText = command;
                call.commandToolName = extractCommandTool(command);
                call.commandNorm = normalizeCommand(command);
            }
        }

        toolCalls.push(call);
        if (callId) {
            toolCallsByCallId.set(callId, call);
            const pendingResult = pendingToolResultsByCallId.get(callId);
            if (pendingResult) {
                applyToolResult(call, pendingResult);
                pendingToolResultsByCallId.delete(callId);
            }
        }

        if (name === "Skill" && input) {
            const invokedSkillRaw =
                stringField(input, "skill") ?? stringField(input, "skill_name");
            if (invokedSkillRaw) {
                // Transcript-recorded invocation target: this is a true
                // producer of skill names, so brand via the schema
                // constructor (resolveSkillName re-canonicalizes later).
                const skillName = SkillName.make(invokedSkillRaw);
                invocations.push({
                    session: sessionId,
                    seq,
                    ts,
                    skill: skillName,
                    args: input,
                    // Backfilled after the content loop below; assistant
                    // turns essentially never carry has_error in current
                    // data (it lives on tool_result turns) but we set
                    // the field correctly in case future capture changes.
                    turn_has_error: false,
                });
                skillRelations.push({
                    toolCallKey,
                    skillName,
                    ts,
                    reason: "Claude Skill tool invocation",
                    labels: {
                        provider: "claude",
                        toolName: "Skill",
                        source: "transcript",
                    },
                    metrics: { turnSeq: seq },
                });
            }
        } else if (
            (name === "Edit" || name === "Write" || name === "NotebookEdit") &&
            input
        ) {
            const editPath =
                stringField(input, "file_path") ??
                stringField(input, "path") ??
                stringField(input, "notebook_path");
            if (editPath) {
                edits.push({
                    session: sessionId,
                    seq,
                    ts,
                    repo: repoFromCwd(cwd),
                    path: normalizeEditPath(path, editPath, turnCwd),
                    tool: name,
                });
            }
        }

        if ((name === "TodoWrite" || isClaudeTaskPlanTool(name)) && input) {
            const slot = upsertPlanSnapshot({
                toolName: name,
                payload: input,
                ts,
                toolCallKey,
            });
            if (slot && isClaudeTaskPlanTool(name)) {
                taskPlanSnapshotSlotsByCallId.set(callId, slot);
            }
        }
    };

    const hookEventKey = (input: {
        readonly hookEvent: string;
        readonly hookName: string;
        readonly toolUseId: string | null;
        readonly transcriptUuid: string | null;
    }): string =>
        stableHash([
            sessionId,
            input.hookEvent,
            input.hookName,
            input.toolUseId ?? "-",
            input.toolUseId ? "-" : input.transcriptUuid ?? "-",
        ].join("|"));

    const hookInvocationKey = (input: {
        readonly eventKey: string;
        readonly command: string;
    }): string =>
        stableHash([
            input.eventKey,
            input.command,
        ].join("|"));

    const toolCallKeyForId = (callId: string | null): string | null => {
        if (!callId) return null;
        const call = toolCallsByCallId.get(callId);
        if (!call) return null;
        return toolCallRecordKey({
            sessionId,
            seq: call.seq,
            callId,
        });
    };

    const upsertHookEvent = (input: {
        readonly ts: string;
        readonly turnCwd: string | null;
        readonly hookEvent: string | null;
        readonly hookName: string | null;
        readonly toolUseId: string | null;
        readonly transcriptUuid: string | null;
        readonly sourceType: string;
    }): string | null => {
        const eventName = input.hookEvent ?? "unknown";
        const hookName = input.hookName ?? `${eventName}:unknown`;
        const key = hookEventKey({
            hookEvent: eventName,
            hookName,
            toolUseId: input.toolUseId,
            transcriptUuid: input.transcriptUuid,
        });
        const existing = hookEventsByKey.get(key);
        const next: HarnessHookEventWrite = {
            key,
            session: sessionId,
            ts: existing?.ts ?? input.ts,
            harness: "claude",
            event_name: eventName,
            hook_name: hookName,
            tool_call_id: input.toolUseId,
            tool_call_key: existing?.tool_call_key ?? toolCallKeyForId(input.toolUseId),
            cwd: input.turnCwd,
            transcript_uuid: input.transcriptUuid,
            source_type: input.sourceType,
        };
        hookEventsByKey.set(key, next);
        return key;
    };

    const classifyHookSuccessEffect = (attachment: Record<string, unknown>): HookEffect => {
        const stdout = stringField(attachment, "stdout");
        const content = attachment.content;
        const combined = `${stdout ?? ""}\n${stringOrJsonExcerpt(content) ?? ""}`;
        if (combined.includes("additionalContext")) return "injected_context";
        if (combined.includes("updatedInput")) return "modified_input";
        if (combined.includes('"permissionDecision"') || combined.includes("permissionDecision")) {
            return combined.includes('"deny"') || combined.includes(": \"deny\"")
                ? "blocked"
                : "allowed";
        }
        return "no_op";
    };

    const upsertHookInvocation = (input: {
        readonly eventKey: string;
        readonly ts: string;
        readonly hookEvent: string;
        readonly hookName: string;
        readonly toolUseId: string | null;
        readonly command: string;
        readonly providerStatus: HookProviderStatus;
        readonly effect: HookEffect;
        readonly exitCode?: number | null;
        readonly durationMs?: number | null;
        readonly stdout?: unknown;
        readonly stderr?: unknown;
        readonly content?: unknown;
        readonly blockingError?: unknown;
    }): void => {
        const key = hookInvocationKey({
            eventKey: input.eventKey,
            command: input.command,
        });
        const existing = hookCommandInvocationsByKey.get(key);
        const isTerminal = input.providerStatus !== "progress_only";
        const chosen = existing && !isTerminal && existing.provider_status !== "progress_only"
            ? existing
            : {
                key,
                hook_event_key: input.eventKey,
                session: sessionId,
                ts: input.ts,
                harness: "claude" as const,
                event_name: input.hookEvent,
                hook_name: input.hookName,
                tool_call_id: input.toolUseId,
                tool_call_key: toolCallKeyForId(input.toolUseId),
                command: input.command,
                command_hash: stableHash(input.command),
                provider_status: input.providerStatus,
                effect: input.effect,
                exit_code: input.exitCode ?? existing?.exit_code ?? null,
                duration_ms: input.durationMs ?? existing?.duration_ms ?? null,
                stdout_excerpt: stringOrJsonExcerpt(input.stdout) ?? existing?.stdout_excerpt ?? null,
                stderr_excerpt: stringOrJsonExcerpt(input.stderr) ?? existing?.stderr_excerpt ?? null,
                content_excerpt: stringOrJsonExcerpt(input.content) ?? existing?.content_excerpt ?? null,
                blocking_error_excerpt: stringOrJsonExcerpt(input.blockingError) ?? existing?.blocking_error_excerpt ?? null,
            };
        hookCommandInvocationsByKey.set(key, chosen);
    };

    const processHookProgress = (
        data: Record<string, unknown>,
        ts: string,
        turnCwd: string | null,
        entry: Record<string, unknown>,
    ): void => {
        const hookEvent = stringField(data, "hookEvent");
        const hookName = stringField(data, "hookName");
        const command = stringField(data, "command");
        const toolUseId = stringField(entry, "toolUseID") ?? stringField(entry, "parentToolUseID");
        const eventKey = upsertHookEvent({
            ts,
            turnCwd,
            hookEvent,
            hookName,
            toolUseId,
            transcriptUuid: stringField(entry, "uuid"),
            sourceType: "hook_progress",
        });
        if (!eventKey || !command) return;
        upsertHookInvocation({
            eventKey,
            ts,
            hookEvent: hookEvent ?? "unknown",
            hookName: hookName ?? `${hookEvent ?? "unknown"}:unknown`,
            toolUseId,
            command,
            providerStatus: "progress_only",
            effect: "unknown",
        });
    };

    const processHookAttachment = (
        attachment: Record<string, unknown>,
        ts: string,
        turnCwd: string | null,
        entry: Record<string, unknown>,
    ): void => {
        const attachmentType = stringField(attachment, "type");
        if (
            attachmentType !== "hook_success" &&
            attachmentType !== "hook_blocking_error" &&
            attachmentType !== "hook_additional_context"
        ) return;
        const hookEvent = stringField(attachment, "hookEvent");
        const hookName = stringField(attachment, "hookName");
        const toolUseId = stringField(attachment, "toolUseID");
        const eventKey = upsertHookEvent({
            ts,
            turnCwd,
            hookEvent,
            hookName,
            toolUseId,
            transcriptUuid: stringField(entry, "uuid"),
            sourceType: attachmentType,
        });
        if (!eventKey) return;

        if (attachmentType === "hook_success") {
            const command = stringField(attachment, "command");
            if (!command) return;
            upsertHookInvocation({
                eventKey,
                ts,
                hookEvent: hookEvent ?? "unknown",
                hookName: hookName ?? `${hookEvent ?? "unknown"}:unknown`,
                toolUseId,
                command,
                providerStatus: "success",
                effect: classifyHookSuccessEffect(attachment),
                exitCode: numberField(attachment, "exitCode"),
                durationMs: numberField(attachment, "durationMs"),
                stdout: attachment.stdout,
                stderr: attachment.stderr,
                content: attachment.content,
            });
            return;
        }

        if (attachmentType === "hook_blocking_error") {
            const blocking = isRecord(attachment.blockingError)
                ? attachment.blockingError
                : {};
            const command = stringField(blocking, "command");
            if (!command) return;
            upsertHookInvocation({
                eventKey,
                ts,
                hookEvent: hookEvent ?? "unknown",
                hookName: hookName ?? `${hookEvent ?? "unknown"}:unknown`,
                toolUseId,
                command,
                providerStatus: "blocking_error",
                effect: "blocked",
                blockingError: blocking.blockingError,
            });
        }
    };

    /**
     * Recover blocked-hook fires from a tool_result's text (#743).
     *
     * Current Claude Code writes no `hook_blocking_error` attachment - a block
     * survives only as the `PreToolUse:Bash hook error: [<cmd>]: ...` line the
     * model reads. Without this, guards that are silent-on-pass and blocking
     * -on-fail leave NO trace in the graph. Keys match the attachment path, so
     * a transcript that carries both shapes still yields one invocation row.
     */
    const processHookBlocksInText = (
        text: string | null,
        ts: string,
        turnCwd: string | null,
        toolUseId: string | null,
        entry: Record<string, unknown>,
    ): void => {
        for (const fire of parseHookBlocksFromText(text)) {
            const eventKey = upsertHookEvent({
                ts,
                turnCwd,
                hookEvent: fire.eventName,
                hookName: fire.hookName,
                toolUseId,
                transcriptUuid: stringField(entry, "uuid"),
                sourceType: "tool_result_text",
            });
            if (!eventKey) continue;
            upsertHookInvocation({
                eventKey,
                ts,
                hookEvent: fire.eventName,
                hookName: fire.hookName,
                toolUseId,
                command: fire.command,
                providerStatus: "blocking_error",
                effect: "blocked",
                blockingError: fire.message.length > 0 ? fire.message : null,
            });
        }
    };

    const processToolResult = (
        block: Record<string, unknown>,
        ts: string,
        role: string,
        parentProviderEventId: string | null,
        topLevelToolUseResult: unknown,
        turnCwd: string | null,
        entry: Record<string, unknown>,
    ): boolean => {
        const callId = stringField(block, "tool_use_id");
        const hasError = block.is_error === true;
        const text = outputText(block.content ?? null);
        processHookBlocksInText(text, ts, turnCwd, callId, entry);
        const eventSeq = nextProviderSeq();
        const result: ToolResultFields = {
            outputJson: block.content ?? null,
            outputExcerpt: text ? boundedExcerpt(text) : null,
            errorText: hasError && text ? boundedExcerpt(text) : null,
            hasError,
        };

        pushProviderEvent({
            providerEventId: callId ? `tool_result:${callId}` : null,
            parentProviderEventId: callId ?? parentProviderEventId,
            parentKind: callId ? "tool_result" : "turn_item",
            seq: eventSeq,
            ts,
            type: "tool_result",
            role,
            text,
            textExcerpt: providerEventTextExcerpt(text),
            labels: {
                source: "claude_transcript",
                toolUseId: callId,
                hasError,
            },
            metrics: { turnSeq: seq },
        });

        if (callId) {
            const call = toolCallsByCallId.get(callId);
            if (call) {
                applyToolResult(call, result);
                if (isClaudeTaskPlanTool(call.toolName)) {
                    const existingSlot = taskPlanSnapshotSlotsByCallId.get(callId);
                    const slot = upsertPlanSnapshot({
                        toolName: call.toolName,
                        payload: taskToolResultPayload(call, block.content, topLevelToolUseResult),
                        ts,
                        toolCallKey: toolCallRecordKey({
                            sessionId,
                            seq: call.seq,
                            callId,
                        }),
                        ...(existingSlot ? { existingSlot } : {}),
                    });
                    if (slot) taskPlanSnapshotSlotsByCallId.set(callId, slot);
                }
            } else {
                pendingToolResultsByCallId.set(callId, result);
            }
        }

        return hasError;
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
            // Deeper shapes (content blocks, hook data/attachment payloads)
            // stay on `rawEntry` and are probed where they are consumed.
            const entry = decodeClaudeTranscriptLine(rawEntry);
            if (!entry) {
                malformedLines += 1;
                return;
            }
            const type = entry.type;
            if (type === "summary") return;

            const ts = entry.timestamp ?? entry.ts ?? null;
            if (!ts) return;
            const turnCwd = entry.cwd ?? cwd;
            if (!cwd && turnCwd) cwd = turnCwd;
            const data = isRecord(rawEntry.data) ? rawEntry.data : null;
            if (data && stringField(data, "type") === "hook_progress") {
                processHookProgress(data, ts, turnCwd, rawEntry);
            }
            const attachment = isRecord(rawEntry.attachment) ? rawEntry.attachment : null;
            if (attachment) {
                processHookAttachment(attachment, ts, turnCwd, rawEntry);
            }
            if (!session) {
                session = {
                    id: sessionId,
                    project: deriveProject(path, projectDir),
                    cwd,
                    model,
                    started_at: ts,
                    ended_at: ts,
                    raw_file: null,
                };
            }
            session.ended_at = ts;
            if (cwd && !session.cwd) session.cwd = cwd;

            seq += 1;
            const role = type ?? "unknown";
            const message = entry.message ?? null;
            const entryModel = message?.model ?? entry.model ?? null;
            // `<synthetic>` marks a harness-generated entry with no API call. It
            // is not a model, and attribution here is last-write-wins, so one
            // trailing synthetic entry used to relabel the whole session -
            // filing its real spend under a non-model that prices at $0.
            // This also gates the LOCAL `model`, which flows into each
            // synthetic entry's own turn_token_usage row (it carries an
            // all-zero usage block, so a row IS emitted for it) - deliberate:
            // a zero-token `<synthetic>` leg would otherwise read as a
            // phantom model switch to per-model leg detection (dispatch
            // model-drop marking, thinking analytics).
            if (entryModel && !isSyntheticModel(entryModel)) {
                model = entryModel;
                if (session) session.model = entryModel;
            }
            // Anthropic emits `usage` on each assistant message. Sum across the
            // session; subagent transcripts live in separate files, so this
            // never double-counts a child's tokens into its parent.
            const usage = message?.usage ?? null;
            if (usage) {
                sawUsage = true;
                const freshInput = usage.input_tokens ?? 0;
                const completion = usage.output_tokens ?? 0;
                const cacheCreation = usage.cache_creation_input_tokens ?? 0;
                const cacheRead = usage.cache_read_input_tokens ?? 0;
                usageFreshInput += freshInput;
                usageCompletion += completion;
                usageCacheCreation += cacheCreation;
                usageCacheRead += cacheRead;
                // Native attribution + cache forensics (#867). The harness
                // stamps `attributionSkill`/`attributionAgent` on the entry
                // (camelCase); `cache_miss_reason` is an OBJECT under
                // `message.diagnostics` - only its `.type` is kept. All null
                // before the ~2026-05 harness cutover, so readers need
                // non-null denominators.
                const diagnostics = message?.diagnostics ?? null;
                const cacheMissReason = diagnostics?.cache_miss_reason;
                // Per-turn usage drives the inspector's per-turn cost rail.
                turnTokenUsages.push({
                    seq,
                    ts,
                    model,
                    promptTokens: freshInput + cacheCreation + cacheRead,
                    completionTokens: completion,
                    cacheCreationInputTokens: cacheCreation,
                    cacheReadInputTokens: cacheRead,
                    freshInputTokens: freshInput,
                    estimatedTokens: freshInput + cacheCreation + cacheRead + completion,
                    attributionSkill: entry.attributionSkill ?? null,
                    attributionAgent: entry.attributionAgent ?? null,
                    cacheMissReasonType: isRecord(cacheMissReason)
                        ? stringField(cacheMissReason, "type")
                        : null,
                    apiErrorStatus: scalarToString(entry.api_error_status ?? diagnostics?.api_error_status),
                });
            }
            const messageContent = message?.content;
            const content = asContentBlocks(messageContent);

            const text = textFromContent(messageContent, {
                acceptedTypes: CLAUDE_TEXT_TYPES,
                emptyStringIsNull: false,
            });
            const textExcerpt = text === null ? null : text.slice(0, 500);
            let hasToolUse = false;
            let hasError = false;
            let thinkingBlocks = 0;
            // Track invocation indices added this iteration so we can backfill
            // `turn_has_error` once `hasError` is finalised below (a tool_result
            // block later in the same content array can flip it after the
            // tool_use that emitted the invocation).
            const turnInvStart = invocations.length;
            const providerEventId = entry.uuid ?? null;
            const kind = messageKind(role, messageContent, textExcerpt);
            const intentKind = classifyTurnIntent({ role, messageKind: kind, source: "claude", text });

            // Context-compaction artifact: a synthetic `type:"user"` entry with
            // `isCompactSummary:true` carrying the summary text. Capture it as a
            // `compaction` row + a `compaction` provider event, and SKIP the
            // normal user turn + the unconditional provider push so it never
            // pollutes turn/recall data (it is transcript-only, not a real turn).
            const isCompactSummary =
                entry.isCompactSummary === true ||
                message?.isCompactSummary === true;
            if (isCompactSummary) {
                const compactionSeq = nextProviderSeq();
                const eventKey = agentEventRecordKey({
                    provider: "claude",
                    providerSessionId: sessionId,
                    providerEventId,
                    seq: compactionSeq,
                });
                pushProviderEvent({
                    providerEventId,
                    seq: compactionSeq,
                    ts,
                    type: "compaction",
                    role: null,
                    text,
                    textExcerpt,
                    labels: {
                        source: "claude_transcript",
                        messageKind: kind,
                        intentKind,
                    },
                    metrics: {
                        turnSeq: seq,
                        contentBlocks: content.length,
                    },
                });
                compactions.push(
                    extractClaudeCompaction({
                        sessionId,
                        providerSessionId: sessionId,
                        seq: compactionSeq,
                        ts: new Date(ts),
                        agentEventKey: eventKey,
                        summary: text ?? null,
                        boundaryRef: providerEventId ?? null,
                    }),
                );
                return;
            }

            pushProviderEvent({
                providerEventId,
                seq: nextProviderSeq(),
                ts,
                type: role,
                role,
                text,
                textExcerpt,
                labels: {
                    source: "claude_transcript",
                    messageKind: kind,
                    intentKind,
                },
                metrics: {
                    turnSeq: seq,
                    contentBlocks: content.length,
                },
            });

            for (const block of content) {
                const blockType = stringField(block, "type");
                if (blockType === "tool_use") {
                    hasToolUse = true;
                    processToolUse(block, ts, turnCwd, role, providerEventId);
                }
                if (
                    blockType === "tool_result" &&
                    processToolResult(block, ts, role, providerEventId, rawEntry.toolUseResult, turnCwd, rawEntry)
                ) {
                    hasError = true;
                }
                if (blockType === "thinking" || blockType === "redacted_thinking") {
                    thinkingBlocks += 1;
                }
            }

            // Thinking tokens: transcripts strip thinking text (empty
            // `thinking` + signature only), but thinking-only assistant
            // events carry their own `usage.output_tokens` - that IS the
            // thinking spend. Mixed-content turns can't be split, so they
            // report 0 (the aggregate is a lower bound).
            const thinkingOnly = thinkingBlocks > 0 &&
                content.every((block) => {
                    const t = stringField(block, "type");
                    return t === "thinking" || t === "redacted_thinking";
                });
            const thinkingTokens = thinkingOnly ? (usage?.output_tokens ?? 0) : 0;

            // Propagate the (now finalised) hasError onto every invocation
            // emitted by this turn so the edge-side flag matches the turn-side
            // one. Cheap: O(skills_invoked_this_turn).
            if (hasError) {
                for (let i = turnInvStart; i < invocations.length; i += 1) {
                    invocations[i].turn_has_error = true;
                }
            }

            turns.push({
                session: sessionId,
                seq,
                ts,
                role,
                message_kind: kind,
                intent_kind: intentKind,
                text,
                text_excerpt: textExcerpt,
                has_tool_use: hasToolUse,
                has_error: hasError,
                thinking_blocks: role === "assistant" ? thinkingBlocks : null,
                thinking_tokens: role === "assistant" ? thinkingTokens : null,
            });
        },
        finish(): FileExtract | null {
            if (!session) return null;
            const hookEvents = [...hookEventsByKey.values()].map((event) => ({
                ...event,
                tool_call_key: event.tool_call_key ?? toolCallKeyForId(event.tool_call_id),
            }));
            const hookCommandInvocations = [...hookCommandInvocationsByKey.values()].map((invocation) => ({
                ...invocation,
                tool_call_key: invocation.tool_call_key ?? toolCallKeyForId(invocation.tool_call_id),
            }));
            return {
                session,
                sourcePath: null,
                turns,
                invocations,
                edits,
                toolCalls,
                providerEvents,
                skillRelations,
                planSnapshots,
                hookEvents,
                hookCommandInvocations,
                compactions,
                tokenUsage: sawUsage
                    ? {
                          // Total billed input = fresh + both cache buckets, so
                          // estimateCost recovers fresh input by subtracting cache.
                          promptTokens: usageFreshInput + usageCacheCreation + usageCacheRead,
                          completionTokens: usageCompletion,
                          cacheCreationInputTokens: usageCacheCreation,
                          cacheReadInputTokens: usageCacheRead,
                          estimatedTokens:
                              usageFreshInput + usageCacheCreation + usageCacheRead + usageCompletion,
                          model: session.model,
                          ts: session.ended_at ?? session.started_at ?? new Date(0).toISOString(),
                      }
                    : null,
                turnTokenUsages,
                malformedLines,
            };
        },
    };
}

export function __testExtractClaudeJsonlLines(
    lines: Iterable<string>,
    projectDir: string,
    sessionId: string,
): FileExtract | null {
    const extractor = createClaudeExtractor(posixPath, projectDir, sessionId);
    for (const line of lines) {
        extractor.processLine(line);
    }
    return extractor.finish();
}

const extractFile = (
    filePath: string,
    projectDir: string,
): Effect.Effect<FileExtract | null, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const sessionId = path.basename(filePath, ".jsonl");
        return yield* extractFileWithSessionId(filePath, projectDir, sessionId);
    });

/**
 * Run the Claude extractor against an arbitrary file with a caller-supplied
 * session id. Used by the subagent ingest path so it can produce synthetic
 * `claude-subagent-<agentId>` session records rather than the
 * filename-derived id.
 *
 * Streams the file via `FileSystem.stream` so a transcript that VANISHES
 * mid-run (e.g. a cleaned-up git worktree) surfaces as a typed
 * `PlatformError` (`reason._tag === "NotFound"`) the caller can catch and
 * skip - rather than an unrecoverable defect that aborts the whole run.
 */
export const extractFileWithSessionId = Effect.fn("transcripts.extractFileWithSessionId")(
    function* (
        filePath: string,
        projectDir: string,
        sessionId: string,
    ): Effect.fn.Return<
        FileExtract | null,
        PlatformError.PlatformError,
        FileSystem.FileSystem | Path.Path
    > {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const extractor = createClaudeExtractor(path, projectDir, sessionId);
        yield* fs.stream(filePath).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => Effect.sync(() => extractor.processLine(line))),
        );
        const extracted = extractor.finish();
        if (!extracted) return null;
        return { ...extracted, sourcePath: filePath };
    },
);

export {
    upsertSessions as upsertSessionsForSubagents,
    upsertTurns as upsertTurnsForSubagents,
    writeToolCallStatements as writeToolCallStatementsForSubagents,
    writeToolFileEvidence as writeToolFileEvidenceForSubagents,
    relateInvocations as relateInvocationsForSubagents,
    relateToolCallSkills as relateToolCallSkillsForSubagents,
    writePlanSnapshots as writePlanSnapshotsForSubagents,
};

const upsertSessions = (write: CacheWriteService, sessions: Session[]) =>
    Effect.gen(function* () {
        // Claude effort level is global (settings.json), not in transcripts -
        // stamped only on sessions active within the freshness window, so the
        // current setting never gets attributed to historical sessions.
        const effortLevel = yield* loadClaudeEffortLevel;
        const nowMs = Date.now();
        yield* Effect.forEach(
            sessions,
            (s) =>
                // `cacheRow` normalizes any `undefined` field to an explicit
                // `null` - DuckDB's bind needs a real null for an absent value.
                write.put("session", cacheRow({
                    id: s.id,
                    project: s.project ?? null,
                    cwd: s.cwd ?? null,
                    model: s.model ?? null,
                    reasoning_effort: claudeEffortStamp(effortLevel, s.ended_at, nowMs),
                    source: "claude",
                    started_at: tsParam(s.started_at),
                    ended_at: tsParam(s.ended_at),
                    raw_file: s.raw_file ?? null,
                    labels: null,
                    repository: null,
                    checkout: null,
                    workspace: null,
                })),
            { concurrency: 4, discard: true },
        );
    }).pipe(Effect.withSpan("transcripts.upsertSessions", {
        attributes: { "sessions.count": sessions.length },
    }));

/**
 * Snapshot the original transcript jsonl into the `transcripts` bucket and
 * return the file pointer string to persist on `session.raw_file`. Failures
 * are logged but do not abort ingest - the bucket is best-effort cold storage.
 *
 * Falls back to the SOURCE PATH when the snapshot is skipped (oversized, or
 * disabled with `AX_CLAUDE_RAW_MAX_BYTES=0`) or fails, so `raw_file` still
 * locates the transcript for as long as the harness keeps it. That fallback is
 * why blob GC checks the reference set's SHAPE and not just its size: a store
 * where every snapshot was skipped holds paths, not pointers, and must not read
 * as "nothing is referenced" (see @ax/lib/blob-gc).
 */
const snapshotTranscript = (
    sessionId: string,
    filePath: string,
    bucketsDir: string,
    maxBytes: number,
    sizeBytes: number,
) =>
    putBlobFromFile(
        bucketsDir,
        "transcripts",
        blobName(sessionId, ".jsonl"),
        filePath,
        { maxBytes, sizeBytes },
    ).pipe(Effect.map((pointer) => pointer ?? filePath));

// Claude turn rows are NEVER agent_event-linked (the transcript
// extractor keys provider events by tool/turn uuid, not by turn seq), so the
// adapter passes `agentEvent: null` and the normalized turn builder OMITS the
// `agent_event` key entirely (plan ledger delta D2).
const toNormalizedClaudeTurn = (turn: Turn): NormalizedTurnWrite => ({
    sessionId: turn.session,
    seq: turn.seq,
    ts: turn.ts,
    role: turn.role,
    messageKind: turn.message_kind,
    intentKind: turn.intent_kind,
    text: turn.text,
    textExcerpt: turn.text_excerpt,
    hasToolUse: turn.has_tool_use,
    hasError: turn.has_error,
    thinkingBlocks: turn.thinking_blocks,
    thinkingTokens: turn.thinking_tokens,
    agentEvent: null,
});

const upsertTurns = (write: CacheWriteService, turns: Turn[]) =>
    write.putMany("turn", turns.map((turn) => {
        const row = toNormalizedClaudeTurn(turn);
        return cacheRow({
            id: turnRecordKey(row.sessionId, row.seq),
            session: row.sessionId,
            agent_event: null,
            seq: row.seq,
            ts: tsParam(row.ts),
            role: row.role,
            message_kind: row.messageKind,
            intent_kind: row.intentKind,
            text: row.text,
            text_excerpt: row.textExcerpt,
            has_tool_use: row.hasToolUse,
            has_error: row.hasError,
            thinking_blocks: row.thinkingBlocks ?? null,
            thinking_tokens: row.thinkingTokens ?? null,
        });
    }));

const relateInvocations = (write: CacheWriteService, invocations: Invocation[]) =>
    Effect.gen(function* () {
        for (const inv of invocations) {
            const turnKey = turnRecordKey(inv.session, inv.seq);
            const skillKey = skillRowId(inv.skill);
            const args = JSON.stringify(inv.args);
            yield* write.exec(
                "INSERT INTO skill (id, name, scope, dir_path, content_hash) VALUES (?, ?, 'unknown', '(unknown)', 'unknown') ON CONFLICT DO NOTHING",
                [skillKey, inv.skill],
            );
            yield* write.put("invoked", cacheRow({
                id: invokedRelationRecordKey({ turnKey, skillKey, args }),
                in_id: turnKey,
                out_id: skillKey,
                args,
                ts: tsParam(inv.ts),
                session: inv.session,
                turn_has_error: inv.turn_has_error,
                was_corrected: false,
                turn_index: inv.seq,
                total_turns: null,
                is_first: null,
            }));
        }
    });

const writeToolFileEvidence = (write: CacheWriteService, toolCalls: readonly ToolCallWrite[]) =>
    writeToolFileEvidenceRows(write, extractToolFileEvidence(toolCalls));

const relateToolCallSkills = (write: CacheWriteService, relations: ToolCallSkillRelationWrite[]) =>
    Effect.gen(function* () {
        for (const relation of relations) yield* relateToolCallSkillRow(write, relation);
    });

const writePlanSnapshots = (write: CacheWriteService, snapshots: PlanSnapshotWrite[]) =>
    Effect.gen(function* () {
        for (const snapshot of snapshots) yield* writePlanSnapshotRow(write, snapshot);
    });

const writeToolCallStatements = (write: CacheWriteService, toolCalls: readonly ToolCallWrite[]) =>
    writeToolCallRows(write, toolCalls);

const writeHookEvidence = (
    write: CacheWriteService,
    events: readonly HarnessHookEventWrite[],
    invocations: readonly HookCommandInvocationWrite[],
) => Effect.gen(function* () {
    yield* write.putMany("harness_hook_event", events.map((event) => cacheRow({
        id: event.key,
        session: event.session,
        ts: tsParam(event.ts),
        harness: event.harness,
        event_name: event.event_name,
        hook_name: event.hook_name,
        tool_call_id: event.tool_call_id,
        tool_call: event.tool_call_key,
        cwd: event.cwd,
        transcript_uuid: event.transcript_uuid,
        source_type: event.source_type,
    })));
    yield* write.putMany("hook_command_invocation", invocations.map((invocation) => cacheRow({
        id: invocation.key,
        hook_event: invocation.hook_event_key,
        session: invocation.session,
        ts: tsParam(invocation.ts),
        harness: invocation.harness,
        event_name: invocation.event_name,
        hook_name: invocation.hook_name,
        tool_call_id: invocation.tool_call_id,
        tool_call: invocation.tool_call_key,
        command: invocation.command,
        command_hash: invocation.command_hash,
        provider_status: invocation.provider_status,
        effect: invocation.effect,
        exit_code: invocation.exit_code,
        duration_ms: invocation.duration_ms,
        stdout_excerpt: invocation.stdout_excerpt,
        stderr_excerpt: invocation.stderr_excerpt,
        content_excerpt: invocation.content_excerpt,
        blocking_error_excerpt: invocation.blocking_error_excerpt,
    })));
});

/**
 * Adapter onto the parser-normalization seam: one FileExtract (= one claude
 * transcript file = one session) becomes one NormalizedTranscriptBatch.
 *
 * Skill relations are passed in (not read off the extract) because
 * `ingestTranscripts` resolves invoked skill names onto the real catalog
 * first, so `concerns` edges land on the real skill row.
 *
 * Normalization invariants:
 * - claude is single-shot per file (no streaming), so the default
 *   `clearExisting: true` per-session agent_event clear yields one file, one
 *   session, one batch, one clear.
 * - Real skill invocations use the batch's create-if-missing path.
 *   The path does not replace catalog rows.
 * - hook evidence and token usage are claude-specific extras written outside
 *   the batch (see plan gap table 1.1).
 * - `sourcePath` may be null on the test seam; the agent_session statement
 *   serializes null and undefined identically (`source_path: NONE`).
 */
export const toClaudeNormalizedBatch = (
    extracted: FileExtract,
    skillRelations: readonly ToolCallSkillRelationWrite[],
    invocations: readonly Invocation[] = [],
): NormalizedTranscriptBatch => ({
    providers: [{
        name: "claude",
        displayName: "Claude Code",
        capabilities: {
            transcripts: true,
            toolCalls: true,
            planSignals: providerPlanSignalAvailability.claude,
            delegationSignals: providerDelegationSignalAvailability.claude,
        },
    }],
    sessions: [{
        id: extracted.session.id,
        provider: "claude",
        providerSessionId: extracted.session.id,
        cwd: extracted.session.cwd,
        project: extracted.session.project,
        model: extracted.session.model,
        sourcePath: extracted.sourcePath,
        // The normalized session write derives `raw_file` as
        // `rawFile ?? sourcePath`, and it runs AFTER the `upsertSessions` call
        // that carries the blob pointer. Omitting `rawFile` here therefore
        // OVERWROTE every snapshot pointer with the source path, leaving the
        // blobs on disk with nothing referencing them - which is exactly the
        // reference-set shape that made blob GC delete the whole store (#854).
        rawFile: extracted.session.raw_file,
        raw: {
            source: "claude_transcript",
            rawFile: extracted.session.raw_file,
        },
        labels: {
            source: "transcript",
            project: extracted.session.project,
        },
        metrics: {
            turns: extracted.turns.length,
            toolCalls: extracted.toolCalls.length,
            providerEvents: extracted.providerEvents.length,
        },
        startedAt: extracted.session.started_at,
        endedAt: extracted.session.ended_at,
    }],
    events: extracted.providerEvents,
    turns: extracted.turns.map(toNormalizedClaudeTurn),
    toolCalls: extracted.toolCalls,
    toolFileEvidence: extractToolFileEvidence(extracted.toolCalls),
    agentEventParentEdges: [],
    // Catalog resolution occurs before this mapping.
    // The create-if-missing write preserves an existing real skill row.
    syntheticSkillInvocations: invocations.map((invocation) => ({
        sessionId: invocation.session,
        seq: invocation.seq,
        ts: invocation.ts,
        skillName: invocation.skill,
        args: invocation.args,
        turnHasError: invocation.turn_has_error,
        turnIndex: invocation.seq,
        skillUpsert: "if_missing" as const,
    })),
    toolCallSkillRelations: skillRelations,
    planSnapshots: extracted.planSnapshots,
    compactions: extracted.compactions,
});

const writeClaudeTokenUsageRows = (
    write: CacheWriteService,
    extracted: FileExtract,
    source: "claude" | "claude-subagent",
) => Effect.gen(function* () {
    const usage = extracted.tokenUsage;
    if (usage !== null) {
        const modelKey = normalizeModelName(usage.model);
        const cost = estimateCost({
            modelKey,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            estimatedTokens: usage.estimatedTokens,
            aggregated: true,
        });
        const burnBuckets = computeBurnBuckets(
            [...extracted.turnTokenUsages].sort((a, b) => a.seq - b.seq).map((t) => t.estimatedTokens),
        );
        yield* write.put("session_token_usage", cacheRow({
            id: extracted.session.id,
            session: extracted.session.id,
            source,
            workflow_epoch: null,
            model: usage.model,
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            cache_creation_input_tokens: usage.cacheCreationInputTokens,
            cache_read_input_tokens: usage.cacheReadInputTokens,
            reasoning_output_tokens: null,
            estimated_tokens: usage.estimatedTokens,
            transcript_bytes: 0,
            context_window: null,
            model_ref: modelKey,
            estimated_input_cost_usd: cost.inputUsd,
            estimated_output_cost_usd: cost.outputUsd,
            estimated_cache_creation_cost_usd: cost.cacheCreationUsd,
            estimated_cache_read_cost_usd: cost.cacheReadUsd,
            estimated_cost_usd: cost.totalUsd,
            pricing_source: cost.pricingSource,
            labels: jsonParam({ source: "claude_transcript", token_source: "transcript_usage" }),
            metrics: null,
            burn_buckets: burnBuckets.length > 0 ? jsonParam(burnBuckets) : null,
            ts: tsParam(usage.ts),
        }));
    }
    yield* write.putMany("turn_token_usage", extracted.turnTokenUsages.map((turnUsage) => {
        const modelKey = normalizeModelName(turnUsage.model);
        const cost = estimateCost({
            modelKey,
            promptTokens: turnUsage.promptTokens,
            completionTokens: turnUsage.completionTokens,
            cacheCreationInputTokens: turnUsage.cacheCreationInputTokens,
            cacheReadInputTokens: turnUsage.cacheReadInputTokens,
            estimatedTokens: turnUsage.estimatedTokens,
        });
        const turn = turnRecordKey(extracted.session.id, turnUsage.seq);
        return cacheRow({
            id: turn,
            session: extracted.session.id,
            turn,
            seq: turnUsage.seq,
            source,
            model: turnUsage.model,
            prompt_tokens: turnUsage.promptTokens,
            completion_tokens: turnUsage.completionTokens,
            cache_creation_input_tokens: turnUsage.cacheCreationInputTokens,
            cache_read_input_tokens: turnUsage.cacheReadInputTokens,
            reasoning_output_tokens: null,
            fresh_input_tokens: turnUsage.freshInputTokens,
            estimated_tokens: turnUsage.estimatedTokens,
            model_ref: modelKey,
            estimated_input_cost_usd: cost.inputUsd,
            estimated_output_cost_usd: cost.outputUsd,
            estimated_cache_creation_cost_usd: cost.cacheCreationUsd,
            estimated_cache_read_cost_usd: cost.cacheReadUsd,
            estimated_cost_usd: cost.totalUsd,
            pricing_source: cost.pricingSource,
            usage_source: "claude_transcript.message_usage",
            usage_quality: "provider_turn",
            attribution_skill: turnUsage.attributionSkill,
            attribution_agent: turnUsage.attributionAgent,
            cache_miss_reason_type: turnUsage.cacheMissReasonType,
            api_error_status: turnUsage.apiErrorStatus,
            raw: null,
            ts: tsParam(turnUsage.ts),
        });
    }));
});

const writeClaudeTokenUsage = (write: CacheWriteService, extracted: FileExtract) =>
    writeClaudeTokenUsageRows(write, extracted, "claude");

/**
 * Subagent variant: identical rows, but `source = "claude-subagent"` so
 * origin-level rollups (`ax cost split`) can separate main-loop spend from
 * dispatched-agent spend. The session-health pass writes the same value from
 * `session.source`; without this the last writer would flip the field.
 */
export const writeTokenUsageForSubagents = (write: CacheWriteService, extracted: FileExtract) =>
    writeClaudeTokenUsageRows(write, extracted, "claude-subagent");

interface IngestOpts {
    sinceDays: number | undefined;
    project: string | undefined;
    runId: string | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
    /** Cumulative skipped-file snapshots from the failure collector (see
     *  file-isolation.ts). The stage wires `stageFileFailureAnnotator` here so
     *  the dashboard Live tab can list which files were skipped and why. */
    onFileFailures: (snapshot: FileFailureSnapshot) => Effect.Effect<void>;
    /** Hard cap on transcript files processed - a backstop for `ingest --dry-run`
     *  calibration (paired with `deadlineMs`). */
    limit: number | undefined;
    /** Absolute wall-clock deadline (ms epoch). Once reached, no NEW file is
     *  started; in-flight files finish. Lets `--dry-run` time-box calibration so
     *  it stays snappy even when individual transcripts are large. */
    deadlineMs: number | undefined;
}

export interface TranscriptStats {
    records: number;
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
    edits: number;
    toolCalls: number;
    planSnapshots: number;
    hookEvents: number;
    hookCommandInvocations: number;
    /** JSONL lines skipped at the decode boundary (unparseable / non-record). */
    malformedLines: number;
    /** Files whose pipeline failed and was skipped (retried next run). */
    failedFiles: number;
}

export const ingestTranscripts = Effect.fn("transcripts.ingest")(
    function* (directWrite: CacheWriteService, opts: Partial<IngestOpts> = {}) {
        const cfg = yield* AxConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // v3 Phase 2 (#886): high-volume tables buffer in an NDJSON spool and
        // land as one read_ndjson load per (table, signature) per flush.
        // Everything else - session, skill, watermarks, reads, the per-session
        // agent_event DELETE - passes through to the direct path. The shadowed
        // `write` below routes EVERY write in this stage through the decorator;
        // the work-unit owns the flush cadence and defers watermarks past it.
        const spoolDir = yield* fs.makeTempDirectory({ prefix: "ax-spool-claude-" }).pipe(Effect.orDie);
        const spool = makeTableSpool({ tables: INGEST_SPOOL_TABLES, dir: spoolDir });
        const write = withTableSpool(directWrite, spool);
        const transcriptsDir = cfg.paths.transcriptsDir;
        const cutoff = opts.sinceDays
            ? Date.now() - opts.sinceDays * 86400 * 1000
            : 0;
        const projectEntries = (yield* fs.readDirectory(transcriptsDir)).filter(
            (d) => !opts.project || d === opts.project,
        );
        // Keep only actual directories. The transcripts root can hold regular
        // FILES (e.g. macOS `.DS_Store`); a `readDirectory` on those would fail
        // with a non-NotFound PlatformError (BadResource/ENOTDIR) and abort the
        // whole ingest, so we stat-and-filter up front. A vanished entry
        // (stat NotFound) is simply skipped.
        const projectDirs = yield* Effect.filter(
            projectEntries,
            (entry) =>
                fs.stat(path.join(transcriptsDir, entry)).pipe(
                    Effect.map((info) => info.type === "Directory"),
                    skipNotFound(false),
                ),
        );
        if (opts.onProgress) yield* opts.onProgress({ projectDirs: projectDirs.length });

        const candidates: Array<{
            projectDir: string;
            path: string;
            mtimeMs: number;
            sizeBytes: number;
        }> = [];
        let files = 0;
        let sessions = 0;
        let turnCount = 0;
        let invCount = 0;
        let editCount = 0;
        let toolCallCount = 0;
        let planSnapshotCount = 0;
        let hookEventCount = 0;
        let hookCommandInvocationCount = 0;
        let malformedLineCount = 0;
        const concurrency = cfg.knobs.claudeConcurrency;
        const rawMaxBytes = cfg.knobs.claudeRawMaxBytes;
        const bucketsDir = path.join(cfg.paths.dataDir, "buckets");
        const recordCount = () =>
            turnCount +
            invCount +
            editCount +
            toolCallCount +
            planSnapshotCount +
            hookEventCount +
            hookCommandInvocationCount;

        // Deliberately NOT walk-jsonl.ts: the Claude tree is flat (one
        // project-slug level, sessions directly inside - no recursion), and we
        // need the full (mtime,size) stat carried forward for the
        // skip-unchanged watermark below, which the shared skeleton's
        // cutoff-only walk discards. See walkJsonlCore's header note.
        for (const projectDir of projectDirs) {
            const fullProject = path.join(transcriptsDir, projectDir);
            // A project dir that vanished between the parent readDirectory and
            // here yields [] (NotFound→skip), preserving the prior
            // try/catch-returns-[] behavior; other failures re-raise.
            const entries = yield* fs.readDirectory(fullProject).pipe(
                skipNotFound([] as string[]),
            );
            for (const entry of entries) {
                if (!entry.endsWith(".jsonl")) continue;
                const filePath = path.join(fullProject, entry);
                // Always stat: we need (mtime,size) both for the optional
                // --since cutoff AND for the skip-unchanged watermark below.
                // A file that vanished after readDirectory enumerated it is
                // skipped (NotFound→skip) so it never enters the work list.
                const st = yield* fs.stat(filePath).pipe(
                    Effect.asSome,
                    skipNotFound(Option.none()),
                );
                if (Option.isNone(st)) continue;
                const info = st.value;
                // A file with no mtime gets epoch 0, so it is never
                // `--since`-skipped (intentional: never silently drop a
                // transcript just because the FS omitted an mtime).
                const mtimeMs = Option.getOrElse(info.mtime, () => new Date(0)).getTime();
                const size = Number(info.size);
                if (cutoff > 0 && mtimeMs < cutoff) continue;
                candidates.push({
                    projectDir,
                    path: filePath,
                    mtimeMs,
                    sizeBytes: size,
                });
            }
        }

        // `--dry-run` calibration: cap to a small representative slice so we can
        // time real parse+write throughput without processing everything.
        if (typeof opts.limit === "number" && candidates.length > opts.limit) {
            candidates.length = opts.limit;
        }

        if (opts.onProgress) yield* opts.onProgress({ totalFiles: candidates.length });

        // Snapshot the real skill/command catalog once. The skills + commands
        // ingest stages run before this one, so it is complete and stable;
        // `resolveSkillName` maps each invoked name back onto it so plugin
        // skills invoked under a bare name attach to the real row instead of
        // minting a ghost `scope='unknown'` placeholder.
        const catalogRows = yield* write.rows(
            Schema.Struct({ name: Schema.String }),
            "SELECT name FROM skill WHERE dir_path <> '(unknown)'",
        );
        const skillCatalog: ReadonlySet<string> = new Set(
            catalogRows
                .map((row) => row.name)
                .filter((name) => name.length > 0),
        );

        // Skip-unchanged watermark + per-file failure isolation + deadline +
        // active-file counting all live in the shared JSONL work-unit
        // (jsonl-work-unit.ts); claude supplies its flat-tree discovery (above)
        // and the per-file parse/write below. A candidate whose (mtime,size)
        // still matches a prior run is output-equivalent and skipped without
        // re-parsing. `AX_REDERIVE_CLAUDE=1` forces a full re-parse.
        const result = yield* runJsonlProviderFiles(write, {
            candidates,
            sourceKind: "claude_transcript",
            forceEnv: "AX_REDERIVE_CLAUDE",
            source: "claude",
            contentHash: true,
            spool,
            ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
            ...(opts.onFileFailures ? { onFileFailures: opts.onFileFailures } : {}),
            ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
            concurrency,
            processFile: (candidate, index, loop) => Effect.gen(function* () {
                if (opts.onProgress && (index < 5 || index % 10 === 0)) {
                    yield* opts.onProgress({
                        currentFile: index + 1,
                        totalFiles: candidates.length,
                        files,
                        activeFiles: loop.activeFiles,
                        records: recordCount(),
                        sessions,
                        turns: turnCount,
                        invocations: invCount,
                        edits: editCount,
                        toolCalls: toolCallCount,
                        planSnapshots: planSnapshotCount,
                        hookEvents: hookEventCount,
                        hookCommandInvocations: hookCommandInvocationCount,
                    });
                }
                // A transcript that VANISHED between discovery and here (e.g. a
                // git worktree cleaned up mid-run) surfaces as a typed
                // PlatformError; NotFound→null SKIPS it. The skip short-circuits
                // BEFORE `files += 1` / the work-unit's commit (returning null),
                // so a vanished file never advances the watermark. Non-NotFound
                // failures re-raise.
                const extracted = yield* extractFile(candidate.path, candidate.projectDir).pipe(
                    skipNotFound(null),
                    Effect.withSpan("transcripts.parse", {
                        attributes: { "file.size": candidate.sizeBytes },
                    }),
                );
                if (!extracted) {
                    return false;
                }
                files += 1;
                malformedLineCount += extracted.malformedLines;
                const pointer = yield* snapshotTranscript(
                    extracted.session.id,
                    candidate.path,
                    bucketsDir,
                    rawMaxBytes,
                    candidate.sizeBytes,
                );
                extracted.session.raw_file = pointer;
                yield* upsertSessions(write, [extracted.session]);
                sessions += 1;
                yield* writeClaudeTokenUsage(write, extracted);
                // Resolve invoked names onto the catalog before writing so the
                // `invoked` and `concerns` edges land on the real skill row.
                const resolvedInvocations = extracted.invocations.map((inv) => ({
                    ...inv,
                    skill: resolveSkillName(inv.skill, skillCatalog) ?? inv.skill,
                }));
                const resolvedSkillRelations = extracted.skillRelations.map((rel) => ({
                    ...rel,
                    skillName: resolveSkillName(rel.skillName, skillCatalog) ?? rel.skillName,
                }));
                // Seven per-section writes collapsed into ONE normalized-batch
                // write. transcripts.parity.test.ts keeps golden-shape coverage
                // for the normalized provider/session/event/turn/tool/plan rows;
                // token usage above and invoked-edges/hooks below stay separate
                // per the gap analysis.
                yield* writeNormalizedTranscriptBatch(
                    write,
                    toClaudeNormalizedBatch(extracted, resolvedSkillRelations, resolvedInvocations),
                );
                turnCount += extracted.turns.length;
                toolCallCount += extracted.toolCalls.length;
                planSnapshotCount += extracted.planSnapshots.length;
                invCount += resolvedInvocations.length;
                yield* writeHookEvidence(write, extracted.hookEvents, extracted.hookCommandInvocations);
                hookEventCount += extracted.hookEvents.length;
                hookCommandInvocationCount += extracted.hookCommandInvocations.length;
                editCount += extracted.edits.length;
                if (opts.onProgress && (files <= 5 || files % 10 === 0)) {
                    yield* opts.onProgress({
                        currentFile: index + 1,
                        totalFiles: candidates.length,
                        files,
                        activeFiles: loop.activeFiles,
                        records: recordCount(),
                        sessions,
                        turns: turnCount,
                        invocations: invCount,
                        edits: editCount,
                        toolCalls: toolCallCount,
                        planSnapshots: planSnapshotCount,
                        hookEvents: hookEventCount,
                        hookCommandInvocations: hookCommandInvocationCount,
                    });
                }
                if (files % 50 === 0) {
                    const counts = {
                        currentFile: index + 1,
                        totalFiles: candidates.length,
                        files,
                        activeFiles: loop.activeFiles,
                        records: recordCount(),
                        sessions,
                        turns: turnCount,
                        invocations: invCount,
                        edits: editCount,
                        toolCalls: toolCallCount,
                        planSnapshots: planSnapshotCount,
                        hookEvents: hookEventCount,
                        hookCommandInvocations: hookCommandInvocationCount,
                    };
                    if (opts.onProgress) yield* opts.onProgress(counts);
                    yield* Effect.logDebug("transcript ingest progress", {
                        ...counts,
                    });
                }
                // Returning true signals success: the work-unit commits the
                // watermark only after this processFile resolves, so a mid-file
                // failure re-processes next run.
                return true;
            }).pipe(Effect.withSpan("transcripts.file", {
                attributes: { "file.path": candidate.path, "file.size": candidate.sizeBytes },
            })),
        });
        // Safety net for any FUTURE write added after the loop: the work-unit
        // already flushed everything the loop buffered. Then drop the scratch
        // dir (flushed files are already unlinked; this catches strays).
        yield* spool.flush(write);
        yield* fs.remove(spoolDir, { recursive: true }).pipe(Effect.ignore);
        yield* Effect.logDebug("transcript ingest complete", {
            files,
            records: recordCount(),
            sessions,
            turns: turnCount,
            invocations: invCount,
            edits: editCount,
            toolCalls: toolCallCount,
            planSnapshots: planSnapshotCount,
            hookEvents: hookEventCount,
            hookCommandInvocations: hookCommandInvocationCount,
        });
        return {
            records: recordCount(),
            files,
            sessions,
            turns: turnCount,
            invocations: invCount,
            edits: editCount,
            toolCalls: toolCallCount,
            planSnapshots: planSnapshotCount,
            hookEvents: hookEventCount,
            hookCommandInvocations: hookCommandInvocationCount,
            malformedLines: malformedLineCount,
            failedFiles: result.failures.count(),
        } satisfies TranscriptStats;
    },
);

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const ClaudeKey = Schema.Literal("claude");
export type ClaudeKey = typeof ClaudeKey.Type;

/**
 * Claude transcripts stage - ingests `.claude/projects/` JSONL into Turn + Tool Call rows.
 *
 * Depends on: {@link SkillsKey}, {@link CommandsKey}
 * Consumed by: {@link SubagentsKey}, {@link SpawnedKey}, {@link SignalsKey}
 * Tags: ingest
 */
export class ClaudeStats extends BaseStageStats.extend<ClaudeStats>("ClaudeStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
    /** JSONL lines skipped at the decode boundary (unparseable / non-record). */
    malformedLines: Schema.Number,
    /** Files whose pipeline failed and was skipped (retried next run). */
    failedFiles: Schema.Number,
}) {}

export const claudeStage: StageDef<ClaudeStats, AxConfig | FileSystem.FileSystem | Path.Path, DbError | CacheWriteError> = {
    meta: StageMeta.make({
        key: "claude",
        deps: ["skills", "commands"],
        tags: ["ingest"],
        writes: [
            ...NORMALIZED_BATCH_WRITES,
            { table: "session_token_usage", mode: "parse" },
            { table: "turn_token_usage", mode: "parse" },
            { table: "harness_hook_event", mode: "parse" },
            { table: "hook_command_invocation", mode: "parse" },
            ...JSONL_WORK_UNIT_WRITES,
        ],
    }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext, write: CacheWriteService) {
        const t0 = Date.now();
        const sinceDays = sinceDaysFromCtx(ctx);
        // Capture the stage span HERE (current span = the runner's
        // LiveTrace.step span) so failure snapshots emitted from deep inside
        // per-file child spans still key to this stage on the live stream.
        const onFileFailures = yield* stageFileFailureAnnotator;
        // The vanished-transcript case is caught + skipped inside
        // `ingestTranscripts`; any PlatformError that escapes here is a
        // genuine FS failure (e.g. an unreadable transcripts root or a
        // non-NotFound stat/stream error) so it dies as a defect rather
        // than masquerading as a recoverable DbError.
        const result = yield* ingestTranscripts(write, {
            sinceDays,
            project: ctx.claudeProject,
            runId: ctx.runId,
            onProgress: annotateStageProgress,
            onFileFailures,
        }).pipe(
            Effect.catchTag("PlatformError", (e) => Effect.die(e)),
        );
        return ClaudeStats.make({
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
