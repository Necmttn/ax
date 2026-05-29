import { readdir, stat, open } from "node:fs/promises";
import { join, basename, isAbsolute, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { RecordId, SurrealClient, filePointer } from "../lib/db.ts";
import { AxConfig } from "../lib/config.ts";
import { surrealLiteral } from "../lib/json.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import { resolveSkillName, skillRecordKey } from "../lib/skill-id.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildToolCallStatements,
    type PlanSnapshotWrite,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import {
    agentEventRecordKey,
    buildAgentEventStatements,
    buildAgentProviderStatements,
    type AgentEventWrite,
} from "./provider-events.ts";
import {
    extractCommandTool,
    normalizeCommand,
    toolKindForName,
} from "./tool-calls.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { normalizeClaudeTodoWrite, type PlanStatus } from "./plans.ts";
import {
    editedRelationRecordKey,
    fileRecordKey,
    invokedRelationRecordKey,
    toolCallRecordKey,
    turnRecordKey,
} from "./record-keys.ts";

import { executeStatements, executeStatementsWith } from "../lib/shared/statement-exec.ts";

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
}

interface Invocation {
    session: string;
    seq: number;
    ts: string;
    skill: string;
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

function deriveProject(transcriptDir: string): string {
    // ~/.claude/projects encodes cwd as `-Users-necmttn-Projects-myapp`
    const m = basename(transcriptDir);
    return m;
}

function repoFromCwd(cwd: string | null): string | null {
    if (!cwd) return null;
    // Best effort: last path segment after Projects/ or worktrees/ etc.
    const m = cwd.match(/\/(?:Projects|workspaces|worktrees)\/([^/]+)/);
    return m?.[1] ?? null;
}

function normalizeEditPath(path: string, cwd: string | null): string {
    if (isAbsolute(path) || !cwd) return path;
    return resolve(cwd, path);
}

export function transcriptEditFileRecordKey(path: string): string {
    return fileRecordKey("_", path);
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseJsonl(line: string): Record<string, unknown> | null {
    const decoded = decodeJsonOrNull(line);
    return isRecord(decoded) ? decoded : null;
}

function asContentBlocks(input: unknown): Record<string, unknown>[] {
    return Array.isArray(input) ? input.filter(isRecord) : [];
}

function textFromContent(input: unknown): string | null {
    if (typeof input === "string") {
        return input;
    }
    const text = asContentBlocks(input)
        .filter((block) => stringField(block, "type") === "text")
        .map((block) => stringField(block, "text"))
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join("\n");
    return text.length > 0 ? text : null;
}

function messageKind(role: string, content: unknown, textExcerpt: string | null): string {
    const blocks = asContentBlocks(content);
    if (blocks.length > 0 && blocks.every((block) => stringField(block, "type") === "tool_result")) {
        return "tool_result";
    }
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
    return role;
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" ? value : null;
}

function stableHash(input: string): string {
    return Bun.hash(input).toString(16).padStart(16, "0");
}

function recordKeyPart(input: string, fallback = "_"): string {
    const sanitized = input
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : fallback;
}

function planKey(sessionId: string, source: string): string {
    return [
        "claude",
        recordKeyPart(sessionId, "session").slice(0, 80),
        recordKeyPart(source, "source"),
        stableHash(`${sessionId}:${source}`).slice(0, 16),
    ].join("__");
}

function planSnapshotKey(input: {
    sessionId: string;
    source: string;
    snapshotSeq: number;
    toolCallKey: string;
}): string {
    return [
        planKey(input.sessionId, input.source),
        `snapshot_${input.snapshotSeq.toString(10).padStart(6, "0")}`,
        stableHash(input.toolCallKey).slice(0, 12),
    ].join("__");
}

function planItemKey(input: {
    sessionId: string;
    source: string;
    seq: number;
}): string {
    return [
        planKey(input.sessionId, input.source),
        `item_${input.seq.toString(10).padStart(3, "0")}`,
    ].join("__");
}

function planStatus(items: readonly { status: PlanStatus }[]): PlanStatus {
    if (items.some((item) => item.status === "in_progress")) return "in_progress";
    if (items.length > 0 && items.every((item) => item.status === "completed")) {
        return "completed";
    }
    if (items.some((item) => item.status === "pending")) return "pending";
    if (items.length > 0 && items.every((item) => item.status === "abandoned")) {
        return "abandoned";
    }
    return "pending";
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

function numberField(input: Record<string, unknown>, field: string): number | null {
    const value = input[field];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function claudeConcurrency(raw = process.env.AX_CLAUDE_CONCURRENCY): number {
    if (!raw) return DEFAULT_CLAUDE_CONCURRENCY;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLAUDE_CONCURRENCY;
}

function jsonText(input: unknown): string | null {
    try {
        const encoded = JSON.stringify(input);
        return encoded === undefined ? null : encoded;
    } catch {
        return null;
    }
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

function applyToolResult(call: MutableToolCallWrite, result: ToolResultFields): void {
    call.outputJson = result.outputJson;
    call.outputExcerpt = result.outputExcerpt;
    call.errorText = result.errorText;
    call.hasError = result.hasError;
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
}

function createClaudeExtractor(projectDir: string, sessionId: string) {
    let session: Session | null = null;
    const turns: Turn[] = [];
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
    const planCreatedAtBySource = new Map<string, string>();
    const planSnapshotCountsBySource = new Map<string, number>();
    const anonymousToolUseCountsByTurn = new Map<number, number>();
    let seq = 0;
    let providerSeq = 0;
    let cwd: string | null = null;
    let model: string | null = null;

    const nextProviderSeq = (): number => {
        providerSeq += 1;
        return providerSeq;
    };

    const pushProviderEvent = (event: Omit<AgentEventWrite, "provider" | "providerSessionId" | "axSessionId">): void => {
        providerEvents.push({
            provider: "claude",
            providerSessionId: sessionId,
            axSessionId: sessionId,
            ...event,
        });
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
            raw: block,
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
            const skillName =
                stringField(input, "skill") ?? stringField(input, "skill_name");
            if (skillName) {
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
            const path =
                stringField(input, "file_path") ??
                stringField(input, "path") ??
                stringField(input, "notebook_path");
            if (path) {
                edits.push({
                    session: sessionId,
                    seq,
                    ts,
                    repo: repoFromCwd(cwd),
                    path: normalizeEditPath(path, turnCwd),
                    tool: name,
                });
            }
        }

        if (name === "TodoWrite" && input) {
            const normalized = normalizeClaudeTodoWrite({
                sessionId,
                ts,
                input,
            });
            if (normalized.items.length > 0) {
                const source = normalized.source;
                const snapshotSeq = nextPlanSnapshotSeq(source);
                const createdAt = rememberPlanCreatedAt(source, ts);
                const currentPlanKey = planKey(sessionId, source);
                const items = normalized.items.map((item) => ({
                    key: planItemKey({
                        sessionId,
                        source,
                        seq: item.seq,
                    }),
                    externalId: item.externalId,
                    seq: item.seq,
                    content: item.content,
                    activeForm: item.activeForm,
                    status: item.status,
                }));

                planSnapshots.push({
                    planKey: currentPlanKey,
                    sessionId,
                    source,
                    status: planStatus(normalized.items),
                    createdAt,
                    updatedAt: ts,
                    snapshotKey: planSnapshotKey({
                        sessionId,
                        source,
                        snapshotSeq,
                        toolCallKey,
                    }),
                    toolCallKey,
                    itemsJson: normalized.items,
                    explanation: normalized.explanation,
                    ts: normalized.ts,
                    items,
                });
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

    const processToolResult = (
        block: Record<string, unknown>,
        ts: string,
        role: string,
        parentProviderEventId: string | null,
    ): boolean => {
        const callId = stringField(block, "tool_use_id");
        const hasError = block.is_error === true;
        const text = outputText(block.content ?? null);
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
            raw: block,
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
            } else {
                pendingToolResultsByCallId.set(callId, result);
            }
        }

        return hasError;
    };

    return {
        processLine(line: string): void {
            if (!line.trim()) return;
            const entry = parseJsonl(line);
            if (!entry) return;
            const type = entry.type as string | undefined;
            if (type === "summary") return;

            const ts =
                (entry.timestamp as string | undefined) ??
                (entry.ts as string | undefined) ??
                null;
            if (!ts) return;
            const turnCwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
            if (!cwd && turnCwd) cwd = turnCwd;
            const data = isRecord(entry.data) ? entry.data : null;
            if (data && stringField(data, "type") === "hook_progress") {
                processHookProgress(data, ts, turnCwd, entry);
            }
            const attachment = isRecord(entry.attachment) ? entry.attachment : null;
            if (attachment) {
                processHookAttachment(attachment, ts, turnCwd, entry);
            }
            if (!session) {
                session = {
                    id: sessionId,
                    project: deriveProject(projectDir),
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
            const role = (type as string) ?? "unknown";
            const message = isRecord(entry.message) ? entry.message : null;
            const entryModel =
                (message ? stringField(message, "model") : null) ??
                stringField(entry, "model");
            if (entryModel) {
                model = entryModel;
                if (session) session.model = entryModel;
            }
            const messageContent = message?.content;
            const content = asContentBlocks(messageContent);

            const text = textFromContent(messageContent);
            const textExcerpt = text === null ? null : text.slice(0, 500);
            let hasToolUse = false;
            let hasError = false;
            // Track invocation indices added this iteration so we can backfill
            // `turn_has_error` once `hasError` is finalised below (a tool_result
            // block later in the same content array can flip it after the
            // tool_use that emitted the invocation).
            const turnInvStart = invocations.length;
            const providerEventId = stringField(entry, "uuid");
            const kind = messageKind(role, messageContent, textExcerpt);
            const intentKind = classifyTurnIntent({ role, messageKind: kind, source: "claude", text });
            pushProviderEvent({
                providerEventId,
                seq: nextProviderSeq(),
                ts,
                type: role,
                role,
                text,
                textExcerpt,
                raw: entry,
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
                if (blockType === "tool_result" && processToolResult(block, ts, role, providerEventId)) {
                    hasError = true;
                }
            }

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
            };
        },
    };
}

export function __testExtractClaudeJsonlLines(
    lines: Iterable<string>,
    projectDir: string,
    sessionId: string,
): FileExtract | null {
    const extractor = createClaudeExtractor(projectDir, sessionId);
    for (const line of lines) {
        extractor.processLine(line);
    }
    return extractor.finish();
}

async function extractFile(filePath: string, projectDir: string): Promise<FileExtract | null> {
    const sessionId = basename(filePath, ".jsonl");
    return extractFileWithSessionId(filePath, projectDir, sessionId);
}

/**
 * Run the Claude extractor against an arbitrary file with a caller-supplied
 * session id. Used by the subagent ingest path so it can produce synthetic
 * `claude-subagent-<agentId>` session records rather than the
 * filename-derived id.
 */
export async function extractFileWithSessionId(
    filePath: string,
    projectDir: string,
    sessionId: string,
): Promise<FileExtract | null> {
    const fh = await open(filePath, "r");
    const extractor = createClaudeExtractor(projectDir, sessionId);
    try {
        for await (const line of fh.readLines()) {
            extractor.processLine(line);
        }
    } finally {
        await fh.close();
    }
    const extracted = extractor.finish();
    if (!extracted) return null;
    return { ...extracted, sourcePath: filePath };
}

export {
    upsertSessions as upsertSessionsForSubagents,
    upsertTurns as upsertTurnsForSubagents,
    writeToolCallStatements as writeToolCallStatementsForSubagents,
    relateInvocations as relateInvocationsForSubagents,
    relateToolCallSkills as relateToolCallSkillsForSubagents,
    writePlanSnapshots as writePlanSnapshotsForSubagents,
    upsertEdits as upsertEditsForSubagents,
};

const upsertSessions = (sessions: Session[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* Effect.forEach(
            sessions,
            (s) =>
                // SurrealDB v3 rejects JS `null` for `option<T>` fields - the
                // JS client must see `undefined` to encode NONE. See issue #37.
                db.upsert(new RecordId("session", s.id), {
                    project: s.project ?? undefined,
                    cwd: s.cwd ?? undefined,
                    model: s.model ?? undefined,
                    source: "claude",
                    started_at: s.started_at ? new Date(s.started_at) : undefined,
                    ended_at: s.ended_at ? new Date(s.ended_at) : undefined,
                    raw_file: s.raw_file ?? undefined,
                }),
            { concurrency: 4, discard: true },
        );
    });

/**
 * Snapshot the original transcript jsonl into the `transcripts` bucket and
 * return the file pointer string to persist on `session.raw_file`. Failures
 * are logged but do not abort ingest - the bucket is best-effort cold storage.
 */
const snapshotTranscript = (sessionId: string, filePath: string) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const content = yield* Effect.promise(async () => {
            try {
                return await Bun.file(filePath).text();
            } catch {
                return null;
            }
        });
        if (content === null) return null;
        const bucketPath = `${sessionId}.jsonl`;
        const result = yield* db
            .putFile("transcripts", bucketPath, content)
            .pipe(
                Effect.map(() => filePointer("transcripts", bucketPath)),
                Effect.catch((err) =>
                    Effect.logDebug("transcript snapshot failed", {
                        sessionId,
                        message: err.message,
                    }).pipe(Effect.as(null as string | null)),
                ),
            );
        return result;
    });

const upsertTurns = (turns: Turn[]) =>
    Effect.gen(function* () {
        if (turns.length === 0) return;
        yield* queryTranscriptStatements(buildTurnStatements(turns));
    });

const buildTurnStatements = (turns: readonly Turn[]): string[] =>
    turns.map(
        (t) =>
            `UPSERT turn:\`${turnRecordKey(t.session, t.seq)}\` CONTENT { session: session:\`${t.session}\`, seq: ${t.seq}, ts: d"${t.ts}", role: "${t.role}", message_kind: ${surrealLiteral(t.message_kind)}, intent_kind: ${surrealLiteral(t.intent_kind)}, text: ${
                t.text === null ? "NONE" : surrealLiteral(t.text)
            }, text_excerpt: ${
                t.text_excerpt === null ? "NONE" : surrealLiteral(t.text_excerpt)
            }, has_tool_use: ${t.has_tool_use}, has_error: ${t.has_error} };`,
    );

const escapeRecordKey = (key: string): string =>
    key
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");

const recordRef = (table: string, key: string): string =>
    `${table}:\`${escapeRecordKey(key)}\``;

const optionRecordRef = (table: string, key: string | null): string =>
    key === null ? "NONE" : recordRef(table, key);

const optionString = (value: string | null): string =>
    value === null ? "NONE" : surrealLiteral(value);

const optionInt = (value: number | null): string =>
    value === null ? "NONE" : String(Math.trunc(value));

const buildHarnessHookEventStatements = (events: readonly HarnessHookEventWrite[]): string[] =>
    events.map((event) =>
        `UPSERT ${recordRef("harness_hook_event", event.key)} CONTENT { session: ${recordRef("session", event.session)}, ts: d"${event.ts}", harness: ${surrealLiteral(event.harness)}, event_name: ${surrealLiteral(event.event_name)}, hook_name: ${surrealLiteral(event.hook_name)}, tool_call_id: ${optionString(event.tool_call_id)}, tool_call: ${optionRecordRef("tool_call", event.tool_call_key)}, cwd: ${optionString(event.cwd)}, transcript_uuid: ${optionString(event.transcript_uuid)}, source_type: ${surrealLiteral(event.source_type)} };`,
    );

const buildHookCommandInvocationStatements = (invocations: readonly HookCommandInvocationWrite[]): string[] =>
    invocations.map((invocation) =>
        `UPSERT ${recordRef("hook_command_invocation", invocation.key)} CONTENT { hook_event: ${recordRef("harness_hook_event", invocation.hook_event_key)}, session: ${recordRef("session", invocation.session)}, ts: d"${invocation.ts}", harness: ${surrealLiteral(invocation.harness)}, event_name: ${surrealLiteral(invocation.event_name)}, hook_name: ${surrealLiteral(invocation.hook_name)}, tool_call_id: ${optionString(invocation.tool_call_id)}, tool_call: ${optionRecordRef("tool_call", invocation.tool_call_key)}, command: ${surrealLiteral(invocation.command)}, command_hash: ${surrealLiteral(invocation.command_hash)}, provider_status: ${surrealLiteral(invocation.provider_status)}, effect: ${surrealLiteral(invocation.effect)}, exit_code: ${optionInt(invocation.exit_code)}, duration_ms: ${optionInt(invocation.duration_ms)}, stdout_excerpt: ${optionString(invocation.stdout_excerpt)}, stderr_excerpt: ${optionString(invocation.stderr_excerpt)}, content_excerpt: ${optionString(invocation.content_excerpt)}, blocking_error_excerpt: ${optionString(invocation.blocking_error_excerpt)} };`,
    );

const queryTranscriptStatements = (statements: readonly string[]) =>
    executeStatements(statements, { chunkSize: 500 });

const relateInvocations = (invocations: Invocation[]) =>
    Effect.gen(function* () {
        if (invocations.length === 0) return;
        const db = yield* SurrealClient;

        // Backstop for issues #41 / #42: any Skill-tool invocation whose
        // target isn't on disk (e.g. a slash command vendored by a plugin we
        // didn't enumerate, or one already removed) would otherwise create
        // an orphan `invoked` edge - the RELATE auto-creates a schemafull
        // skill row with no `name`, which then gets filtered out everywhere.
        // We pre-upsert a minimal `scope='unknown'` placeholder for every
        // unique invoked target. ingestSkills + ingestCommands run before
        // this, so a real record (if one exists) already won the row, and
        // our `MERGE` only touches the field set we own here.
        const uniqueSkills = new Set(invocations.map((i) => i.skill));
        if (uniqueSkills.size > 0) {
            // Look up which skill rows already exist so we don't overwrite
            // the proper scope/dir_path/description on known skills with
            // our 'unknown' placeholder. Idempotent re-runs of ingest stay
            // a no-op for everything that has a real on-disk source.
            const ids = [...uniqueSkills].map(
                (n) => `skill:\`${skillRecordKey(n)}\``,
            );
            // Use `WHERE id IN [...]` rather than `FROM [...]` because the
            // latter form is broken in SurrealDB 3.0 (returns DatabaseEmpty)
            // - so we filter the full skill table by id list instead.
            const existing = (yield* db.query<[Array<{ name?: string }>]>(
                `SELECT name FROM skill WHERE id IN [${ids.join(",")}];`,
            )) as [Array<{ name?: string }>];
            const knownNames = new Set(
                (existing[0] ?? [])
                    .map((r) => r.name)
                    .filter((n): n is string => typeof n === "string" && n.length > 0),
            );
            const missing = [...uniqueSkills].filter((n) => !knownNames.has(n));
            if (missing.length > 0) {
                const placeholders = missing.map(
                    (n) =>
                        `UPSERT skill:\`${skillRecordKey(n)}\` MERGE { name: ${surrealLiteral(n)}, scope: "unknown", dir_path: "(unknown)", content_hash: "unknown" };`,
                );
                yield* executeStatementsWith(db, placeholders, { chunkSize: 500 });
            }
        }

        const stmts = invocations.flatMap((inv) => {
            const turnKey = turnRecordKey(inv.session, inv.seq);
            const skillKey = skillRecordKey(inv.skill);
            const args = JSON.stringify(inv.args);
            const edgeKey = invokedRelationRecordKey({ turnKey, skillKey, args });
            return [
                `RELATE turn:\`${turnKey}\`->invoked:\`${edgeKey}\`->skill:\`${skillKey}\` SET ts = d"${inv.ts}", args = ${surrealLiteral(args)}, turn_has_error = ${inv.turn_has_error}, turn_index = ${inv.seq};`,
            ];
        });
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
    });

const upsertEdits = (edits: Edit[]) =>
    Effect.gen(function* () {
        if (edits.length === 0) return;
        const db = yield* SurrealClient;
        const fileStmts: string[] = [];
        const relStmts: string[] = [];
        const seenFiles = new Set<string>();
        for (const e of edits) {
            const fileKey = transcriptEditFileRecordKey(e.path);
            if (!seenFiles.has(fileKey)) {
                seenFiles.add(fileKey);
                fileStmts.push(
                    `UPSERT file:\`${fileKey}\` CONTENT { repo: NONE, path: ${surrealLiteral(e.path)}, identity_scope: "local_path" };`,
                );
            }
            const turnKey = turnRecordKey(e.session, e.seq);
            const edgeKey = editedRelationRecordKey({ turnKey, fileKey, tool: e.tool });
            relStmts.push(
                `RELATE turn:\`${turnKey}\`->edited:\`${edgeKey}\`->file:\`${fileKey}\` SET tool = "${e.tool}", ts = d"${e.ts}";`,
            );
        }
        yield* executeStatementsWith(db, fileStmts, { chunkSize: 500 });
        yield* executeStatementsWith(db, relStmts, { chunkSize: 500 });
    });

const relateToolCallSkills = (relations: ToolCallSkillRelationWrite[]) =>
    Effect.gen(function* () {
        if (relations.length === 0) return;
        yield* queryTranscriptStatements(relations.flatMap((relation) =>
            buildRelateToolCallSkillStatements(relation),
        ));
    });

const writePlanSnapshots = (snapshots: PlanSnapshotWrite[]) =>
    Effect.gen(function* () {
        if (snapshots.length === 0) return;
        yield* queryTranscriptStatements(snapshots.flatMap((snapshot) =>
            buildPlanSnapshotStatements(snapshot),
        ));
    });

const writeToolCallStatements = (toolCalls: readonly ToolCallWrite[]) =>
    queryTranscriptStatements(buildToolCallStatements(toolCalls));

const writeHookEvidence = (
    events: readonly HarnessHookEventWrite[],
    invocations: readonly HookCommandInvocationWrite[],
) =>
    queryTranscriptStatements([
        ...buildHarnessHookEventStatements(events),
        ...buildHookCommandInvocationStatements(invocations),
    ]);

const buildClaudeProviderStatements = (extracted: FileExtract): string[] => [
    ...buildAgentProviderStatements([
        {
            name: "claude",
            displayName: "Claude Code",
            capabilities: {
                transcripts: true,
                toolCalls: true,
            },
        },
    ]),
    ...buildAgentEventStatements({
        sessions: [
            {
                provider: "claude",
                providerSessionId: extracted.session.id,
                axSessionId: extracted.session.id,
                cwd: extracted.session.cwd,
                project: extracted.session.project,
                model: extracted.session.model,
                sourcePath: extracted.sourcePath,
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
            },
        ],
        events: extracted.providerEvents,
    }),
];

const writeProviderEvidence = (extracted: FileExtract) =>
    queryTranscriptStatements(buildClaudeProviderStatements(extracted));

interface IngestOpts {
    sinceDays: number | undefined;
    project: string | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
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
}

export const ingestTranscripts = (
    opts: Partial<IngestOpts> = {},
): Effect.Effect<TranscriptStats, DbError, SurrealClient | AxConfig> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const transcriptsDir = cfg.paths.transcriptsDir;
        const cutoff = opts.sinceDays
            ? Date.now() - opts.sinceDays * 86400 * 1000
            : 0;
        const projectDirs = (yield* Effect.promise(() => readdir(transcriptsDir))).filter(
            (d) => !opts.project || d === opts.project,
        );
        if (opts.onProgress) yield* opts.onProgress({ projectDirs: projectDirs.length });

        const candidates: Array<{ projectDir: string; filePath: string }> = [];
        let files = 0;
        let sessions = 0;
        let turnCount = 0;
        let invCount = 0;
        let editCount = 0;
        let toolCallCount = 0;
        let planSnapshotCount = 0;
        let hookEventCount = 0;
        let hookCommandInvocationCount = 0;
        let activeFiles = 0;
        const concurrency = cfg.knobs.claudeConcurrency;
        const recordCount = () =>
            turnCount +
            invCount +
            editCount +
            toolCallCount +
            planSnapshotCount +
            hookEventCount +
            hookCommandInvocationCount;

        for (const projectDir of projectDirs) {
            const fullProject = join(transcriptsDir, projectDir);
            const entries = yield* Effect.promise(async () => {
                try {
                    return await readdir(fullProject);
                } catch {
                    return [] as string[];
                }
            });
            for (const entry of entries) {
                if (!entry.endsWith(".jsonl")) continue;
                const filePath = join(fullProject, entry);
                if (cutoff > 0) {
                    const st = yield* Effect.promise(() => stat(filePath));
                    if (st.mtimeMs < cutoff) continue;
                }
                candidates.push({ projectDir, filePath });
            }
        }

        if (opts.onProgress) yield* opts.onProgress({ totalFiles: candidates.length });

        // Snapshot the real skill/command catalog once. The skills + commands
        // ingest stages run before this one, so it is complete and stable;
        // `resolveSkillName` maps each invoked name back onto it so plugin
        // skills invoked under a bare name attach to the real row instead of
        // minting a ghost `scope='unknown'` placeholder.
        const db = yield* SurrealClient;
        const catalogRows = (yield* db.query<[Array<{ name?: string }>]>(
            `SELECT name FROM skill WHERE dir_path != "(unknown)";`,
        ))?.[0] ?? [];
        const skillCatalog: ReadonlySet<string> = new Set(
            catalogRows
                .map((row) => row.name)
                .filter((name): name is string => typeof name === "string" && name.length > 0),
        );

        yield* Effect.forEach(candidates.map((candidate, index) => ({ candidate, index })), ({ candidate, index }) => Effect.gen(function* () {
            activeFiles += 1;
            if (opts.onProgress && (index < 5 || index % 10 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: candidates.length,
                    files,
                    activeFiles,
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
            const extracted = yield* Effect.promise(() =>
                extractFile(candidate.filePath, candidate.projectDir),
            );
            if (!extracted) {
                activeFiles -= 1;
                return;
            }
            files += 1;
            const pointer = yield* snapshotTranscript(
                extracted.session.id,
                candidate.filePath,
            );
            extracted.session.raw_file = pointer;
            yield* upsertSessions([extracted.session]);
            sessions += 1;
            yield* upsertTurns(extracted.turns);
            turnCount += extracted.turns.length;
            yield* writeProviderEvidence(extracted);
            yield* writeToolCallStatements(extracted.toolCalls);
            toolCallCount += extracted.toolCalls.length;
            // Resolve invoked names onto the catalog before writing so the
            // `invoked` and `concerns` edges land on the real skill row.
            const resolvedInvocations = extracted.invocations.map((inv) => ({
                ...inv,
                skill: resolveSkillName(inv.skill, skillCatalog) ?? inv.skill,
            }));
            yield* relateInvocations(resolvedInvocations);
            invCount += resolvedInvocations.length;
            const resolvedSkillRelations = extracted.skillRelations.map((rel) => ({
                ...rel,
                skillName: resolveSkillName(rel.skillName, skillCatalog) ?? rel.skillName,
            }));
            yield* relateToolCallSkills(resolvedSkillRelations);
            yield* writePlanSnapshots(extracted.planSnapshots);
            planSnapshotCount += extracted.planSnapshots.length;
            yield* writeHookEvidence(extracted.hookEvents, extracted.hookCommandInvocations);
            hookEventCount += extracted.hookEvents.length;
            hookCommandInvocationCount += extracted.hookCommandInvocations.length;
            yield* upsertEdits(extracted.edits);
            editCount += extracted.edits.length;
            if (opts.onProgress && (files <= 5 || files % 10 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: candidates.length,
                    files,
                    activeFiles,
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
                    activeFiles,
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
            activeFiles -= 1;
        }), { concurrency, discard: true });
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
        };
    });

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        ingestTranscripts({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<TranscriptStats>,
    );
}

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
}) {}

export const claudeStage: StageDef<ClaudeStats, SurrealClient | AxConfig> = {
    meta: StageMeta.make({ key: "claude", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* ingestTranscripts({ sinceDays });
            return ClaudeStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls`,
                sessionsIngested: result.sessions,
                turnsIngested: result.turns,
                toolCallsIngested: result.toolCalls,
            });
        }),
};
