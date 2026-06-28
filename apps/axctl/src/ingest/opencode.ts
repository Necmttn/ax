import { Database } from "bun:sqlite";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SkillName } from "@ax/lib/brands";
import { RecordId, SurrealClient } from "@ax/lib/db";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import {
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import { makeFileFailureCollector } from "./file-isolation.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { providerDelegationSignalAvailability } from "./delegation.ts";
import { buildNormalizedTranscriptStatements } from "./normalized/transcripts.ts";
import { agentEventRecordKey, type AgentEventWrite } from "./provider-events.ts";
import { providerPlanSignalAvailability } from "./plans.ts";
import { toolCallRecordKey } from "./record-keys.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import {
    extractOpenCodeCompaction,
    type CompactionWrite,
} from "./compaction.ts";
// OpenCode reads numbers out of SQLite rows (number | bigint | stringly) -
// the toolkit's coercing probe is this parser's `numberField`.
import {
    booleanField,
    boundedExcerpt,
    coercedNumberField as numberField,
    isRecord,
    nestedStringField,
    parseJsonRecord,
    parseMaybeJson,
    stringField,
} from "./normalized/toolkit.ts";
import {
    applyCommandFields,
    makeToolCallWrite,
    type MutableToolCallWrite,
} from "./normalized/tool-call-write.ts";

export const OpenCodeKey = Schema.Literal("opencode");
export type OpenCodeKey = typeof OpenCodeKey.Type;

interface OpenCodeSession {
    id: string;
    cwd: string | null;
    title: string | null;
    model: string | null;
    started_at: string;
    ended_at: string;
}

interface OpenCodeTurn {
    session: string;
    providerEventId: string;
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

export interface OpenCodeExtract {
    sessions: OpenCodeSession[];
    turns: OpenCodeTurn[];
    providerEvents: AgentEventWrite[];
    toolCalls: ToolCallWrite[];
    invocations: OpenCodeInvocation[];
    skillRelations: ToolCallSkillRelationWrite[];
    compactions: CompactionWrite[];
    skipped: number;
    warnings: string[];
}

interface OpenCodeInvocation {
    session: string;
    seq: number;
    ts: string;
    skill: SkillName;
    args: unknown;
}

export interface OpenCodeStats {
    readonly sessions: number;
    readonly turns: number;
    readonly toolCalls: number;
    readonly skipped: number;
    readonly warnings: number;
    /** Sessions whose write pipeline failed and was skipped (retried next
     *  run). Named `failedFiles` to match the cross-provider stage-stats key
     *  the run totals + CLI skip summary aggregate (#261). */
    readonly failedFiles: number;
}

const SAFE_FALLBACK_TS = "1970-01-01T00:00:00.000Z";

type SQLiteValue = string | number | bigint | boolean | null;

interface SQLiteRow {
    readonly [key: string]: SQLiteValue | undefined;
}

interface SyntheticSessionRow extends SQLiteRow {
    readonly id: string;
    readonly cwd: string | null;
    readonly title: string | null;
    readonly created_at: string | null;
    readonly updated_at: string | null;
}

interface SyntheticMessageRow extends SQLiteRow {
    readonly id: string;
    readonly session_id: string;
    readonly role: string | null;
    readonly content: string | null;
    readonly created_at: string | null;
}

interface ObservedSessionRow extends SQLiteRow {
    readonly id: string;
    readonly directory: string | null;
    readonly title: string | null;
    readonly model: string | null;
    readonly time_created: number | bigint | string | null;
    readonly time_updated: number | bigint | string | null;
}

interface ObservedMessageRow extends SQLiteRow {
    readonly id: string;
    readonly session_id: string;
    readonly time_created: number | bigint | string | null;
    readonly data: string | null;
}

interface ObservedPartRow extends SQLiteRow {
    readonly id: string;
    readonly message_id: string;
    readonly session_id: string;
    readonly time_created: number | bigint | string | null;
    readonly data: string | null;
}

interface ParsedObservedPart {
    readonly row: ObservedPartRow;
    readonly data: Record<string, unknown>;
}

interface OpenCodeStepFinish {
    readonly row: ObservedPartRow;
    readonly ts: string;
    readonly inputContextTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheWriteTokens: number;
    readonly cacheReadTokens: number;
    readonly totalTokens: number | null;
    readonly contextWindow: number | null;
    readonly rawTokens: Record<string, unknown>;
}

interface ToolResultFields {
    readonly outputJson: unknown;
    readonly outputExcerpt: string | null;
    readonly errorText: string | null;
    readonly hasError: boolean;
    readonly durationMs: number | null;
}

const SYNTHETIC_PROVIDER_SEQ_OFFSET = 1_000_000_000;
const OPENCODE_COMPACTION_PROVIDER_SEQ_OFFSET = 2_000_000_000;
// OpenCode has no structural compaction marker. Only emit a derived boundary
// after a high-water step-finish input context sharply resets.
const OPENCODE_COMPACTION_SATURATION_FLOOR = 20_000;
const OPENCODE_COMPACTION_RESET_RATIO = 0.35;
const OPENCODE_COMPACTION_MIN_DROP = 12_000;

function validTimestamp(input: SQLiteValue | undefined, fallback: string): { ts: string; warning: string | null } {
    if (input === null || input === undefined) {
        return { ts: fallback, warning: "missing timestamp" };
    }
    let value: string | number;
    if (typeof input === "number") {
        value = input;
    } else if (typeof input === "bigint") {
        value = Number(input);
    } else if (typeof input === "string") {
        const trimmed = input.trim();
        if (trimmed.length === 0) return { ts: fallback, warning: "missing timestamp" };
        value = /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
    } else {
        return { ts: fallback, warning: `invalid timestamp: ${String(input)}` };
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return { ts: fallback, warning: `invalid timestamp: ${String(input)}` };
    }
    return { ts: date.toISOString(), warning: null };
}

function messageKind(role: string): string {
    if (role === "system" || role === "developer") return "system_or_developer";
    if (role === "assistant") return "assistant";
    if (role === "tool" || role === "tool_result") return "tool_result";
    if (role === "user") return "task";
    return "message";
}

function emptyExtract(warnings: string[] = [], skipped = 0): OpenCodeExtract {
    return {
        sessions: [],
        turns: [],
        providerEvents: [],
        toolCalls: [],
        invocations: [],
        skillRelations: [],
        compactions: [],
        skipped,
        warnings,
    };
}

function tableNames(db: Database): Set<string> {
    const rows = db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all();
    return new Set(rows.map((row) => row.name));
}

function columnNames(db: Database, table: string): Set<string> {
    const quotedTable = JSON.stringify(table);
    const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${quotedTable})`).all();
    return new Set(rows.map((row) => row.name));
}

function hasColumns(columns: Set<string>, names: readonly string[]): boolean {
    return names.every((name) => columns.has(name));
}

function hasErrorFlag(input: Record<string, unknown>): boolean {
    return input.error !== null && input.error !== undefined;
}

function textFromPartData(data: Record<string, unknown>): string | null {
    const type = stringField(data, "type");
    if (type !== "text" && type !== "input_text" && type !== "output_text") return null;
    const text = stringField(data, "text");
    return text && text.length > 0 ? text : null;
}

function toolNameFromPartData(data: Record<string, unknown>): string | null {
    if (stringField(data, "type") !== "tool") return null;
    return stringField(data, "tool") ??
        stringField(data, "name") ??
        stringField(data, "toolName");
}

function toolCallIdFromPartData(data: Record<string, unknown>, row: ObservedPartRow): string {
    return stringField(data, "callID") ??
        stringField(data, "callId") ??
        stringField(data, "toolCallId") ??
        row.id;
}

function toolState(data: Record<string, unknown>): Record<string, unknown> | null {
    return isRecord(data.state) ? data.state : null;
}

function toolInputFromPartData(data: Record<string, unknown>): unknown {
    const state = toolState(data);
    const input = state?.input ?? data.input ?? data.arguments ?? data.args ?? null;
    return parseMaybeJson(input);
}

function outputText(input: unknown): string | null {
    if (typeof input === "string") return input;
    if (input === null || input === undefined) return null;
    try {
        return JSON.stringify(input);
    } catch {
        return String(input);
    }
}

function toolResultFromPartData(data: Record<string, unknown>): ToolResultFields {
    const state = toolState(data);
    const status = state ? stringField(state, "status") : stringField(data, "status");
    const outputJson = state?.output ?? data.output ?? null;
    const errorJson = state?.error ?? data.error ?? null;
    const text = outputText(outputJson);
    const errorText = outputText(errorJson);
    const hasError = status === "error" ||
        status === "failed" ||
        booleanField(data, "isError") === true ||
        booleanField(data, "is_error") === true ||
        errorJson !== null;
    const time = state && isRecord(state.time) ? state.time : null;
    const start = time ? numberField(time, "start") : null;
    const end = time ? numberField(time, "end") : null;

    return {
        outputJson,
        outputExcerpt: text && text.length > 0 ? boundedExcerpt(text) : null,
        errorText: errorText && errorText.length > 0
            ? boundedExcerpt(errorText)
            : hasError && text && text.length > 0
                ? boundedExcerpt(text)
                : null,
        hasError,
        durationMs: start !== null && end !== null && end >= start ? Math.round(end - start) : null,
    };
}

function toolPartTimestamp(row: ObservedPartRow, data: Record<string, unknown>, fallback: string): string {
    const state = toolState(data);
    const time = state && isRecord(state.time) ? state.time : null;
    return validTimestamp(time?.start as SQLiteValue | undefined ?? row.time_created, fallback).ts;
}

function contextWindowFromTokens(tokens: Record<string, unknown>): number | null {
    return numberField(tokens, "contextWindow") ??
        numberField(tokens, "context_window") ??
        numberField(tokens, "modelContextWindow") ??
        numberField(tokens, "model_context_window");
}

function stepFinishFromPart(input: ParsedObservedPart, fallbackTs: string): OpenCodeStepFinish | null {
    if (stringField(input.data, "type") !== "step-finish") return null;
    const tokens = isRecord(input.data.tokens) ? input.data.tokens : null;
    if (!tokens) return null;

    const cache = isRecord(tokens.cache) ? tokens.cache : null;
    const inputTokens = numberField(tokens, "input") ?? 0;
    const outputTokens = numberField(tokens, "output") ?? 0;
    const cacheWriteTokens = (cache ? numberField(cache, "write") : null) ??
        numberField(tokens, "cacheWrite") ??
        numberField(tokens, "cache_write") ??
        0;
    const cacheReadTokens = (cache ? numberField(cache, "read") : null) ??
        numberField(tokens, "cacheRead") ??
        numberField(tokens, "cache_read") ??
        0;
    const totalTokens = numberField(tokens, "total");
    const cacheInclusiveInput = inputTokens + cacheWriteTokens + cacheReadTokens;
    const totalMinusOutput = totalTokens === null ? 0 : Math.max(0, totalTokens - outputTokens);
    const inputContextTokens = Math.trunc(Math.max(cacheInclusiveInput, totalMinusOutput));
    if (inputContextTokens <= 0) return null;

    return {
        row: input.row,
        ts: validTimestamp(input.row.time_created, fallbackTs).ts,
        inputContextTokens,
        inputTokens: Math.trunc(inputTokens),
        outputTokens: Math.trunc(outputTokens),
        cacheWriteTokens: Math.trunc(cacheWriteTokens),
        cacheReadTokens: Math.trunc(cacheReadTokens),
        totalTokens,
        contextWindow: contextWindowFromTokens(tokens),
        rawTokens: tokens,
    };
}

function isOpenCodeCompactionReset(previous: OpenCodeStepFinish, current: OpenCodeStepFinish): boolean {
    const saturationFloor = previous.contextWindow === null
        ? OPENCODE_COMPACTION_SATURATION_FLOOR
        : Math.floor(previous.contextWindow * 0.85);
    const drop = previous.inputContextTokens - current.inputContextTokens;
    const minDrop = Math.min(
        OPENCODE_COMPACTION_MIN_DROP,
        Math.floor(previous.inputContextTokens * (1 - OPENCODE_COMPACTION_RESET_RATIO)),
    );

    return previous.inputContextTokens >= saturationFloor &&
        drop >= minDrop &&
        current.inputContextTokens <= Math.floor(previous.inputContextTokens * OPENCODE_COMPACTION_RESET_RATIO);
}

function processStepFinishCompactions(input: {
    stepFinishes: readonly OpenCodeStepFinish[];
    session: OpenCodeSession;
    parentProviderEventId: string;
    providerEvents: AgentEventWrite[];
    compactions: CompactionWrite[];
    lastStepFinishBySession: Map<string, OpenCodeStepFinish>;
    compactionSeqBySession: Map<string, number>;
}): void {
    for (const step of input.stepFinishes) {
        const previous = input.lastStepFinishBySession.get(input.session.id);
        input.lastStepFinishBySession.set(input.session.id, step);
        if (!previous || !isOpenCodeCompactionReset(previous, step)) continue;

        const ordinal = (input.compactionSeqBySession.get(input.session.id) ?? 0) + 1;
        input.compactionSeqBySession.set(input.session.id, ordinal);
        const seq = OPENCODE_COMPACTION_PROVIDER_SEQ_OFFSET + ordinal;
        const providerEventId = `step-finish:${step.row.id}`;
        const raw = {
            heuristic: "opencode_step_finish_context_reset",
            source_confidence: "derived",
            previous_step_part_id: previous.row.id,
            reset_step_part_id: step.row.id,
            previous_message_id: previous.row.message_id,
            reset_message_id: step.row.message_id,
            previous_input_context_tokens: previous.inputContextTokens,
            reset_input_context_tokens: step.inputContextTokens,
            previous_tokens: previous.rawTokens,
            reset_tokens: step.rawTokens,
        };
        const event: AgentEventWrite = {
            provider: "opencode",
            providerSessionId: input.session.id,
            axSessionId: input.session.id,
            providerEventId,
            parentProviderEventId: input.parentProviderEventId,
            parentKind: "message_part",
            seq,
            ts: step.ts,
            type: "compaction",
            role: null,
            text: null,
            textExcerpt: null,
            raw,
            labels: {
                source: "opencode_sqlite",
                sourceConfidence: "derived",
                heuristic: "opencode_step_finish_context_reset",
            },
            metrics: {
                strategy: "summarize",
                sourceConfidence: "derived",
                tokensBefore: previous.inputContextTokens,
                tokensAfter: step.inputContextTokens,
                resetRatio: step.inputContextTokens / previous.inputContextTokens,
            },
        };
        input.providerEvents.push(event);
        input.compactions.push(extractOpenCodeCompaction({
            sessionId: input.session.id,
            providerSessionId: input.session.id,
            seq,
            ts: new Date(step.ts),
            agentEventKey: agentEventRecordKey(event),
            tokensBefore: previous.inputContextTokens,
            boundaryRef: step.row.id,
            raw,
        }));
    }
}

function syntheticRows(db: Database): {
    sessions: SyntheticSessionRow[];
    messages: SyntheticMessageRow[];
} {
    return {
        sessions: db.query<SyntheticSessionRow, []>(
            "SELECT id, cwd, title, created_at, updated_at FROM session ORDER BY created_at, id",
        ).all(),
        messages: db.query<SyntheticMessageRow, []>(
            "SELECT id, session_id, role, content, created_at FROM message ORDER BY created_at, id",
        ).all(),
    };
}

function observedRows(db: Database, hasModelColumn: boolean): {
    sessions: ObservedSessionRow[];
    messages: ObservedMessageRow[];
    parts: ObservedPartRow[];
} {
    const modelSelect = hasModelColumn ? "model" : "NULL AS model";
    return {
        sessions: db.query<ObservedSessionRow, []>(
            `SELECT id, directory, title, ${modelSelect}, time_created, time_updated FROM session ORDER BY time_created, id`,
        ).all(),
        messages: db.query<ObservedMessageRow, []>(
            "SELECT id, session_id, time_created, data FROM message ORDER BY time_created, id",
        ).all(),
        parts: db.query<ObservedPartRow, []>(
            "SELECT id, message_id, session_id, time_created, data FROM part ORDER BY time_created, id",
        ).all(),
    };
}

function pushMessage(input: {
    row: {
        id: string;
        session_id: string;
        created: SQLiteValue | undefined;
        role: string;
        text: string | null;
        hasToolUse?: boolean;
        raw: unknown;
        parentProviderEventId?: string | null;
        labels: Record<string, unknown>;
        metrics?: Record<string, unknown>;
    };
    session: OpenCodeSession;
    turns: OpenCodeTurn[];
    providerEvents: AgentEventWrite[];
    seqBySession: Map<string, number>;
    warnings: string[];
}): number {
    const seq = (input.seqBySession.get(input.row.session_id) ?? 0) + 1;
    input.seqBySession.set(input.row.session_id, seq);
    const timestamp = validTimestamp(input.row.created, input.session.ended_at);
    if (timestamp.warning) input.warnings.push(`message ${input.row.id}: ${timestamp.warning}`);
    if (new Date(timestamp.ts).getTime() > new Date(input.session.ended_at).getTime()) {
        input.session.ended_at = timestamp.ts;
    }
    const textExcerpt = input.row.text === null ? null : input.row.text.slice(0, 500);
    const kind = messageKind(input.row.role);
    const intentKind = classifyTurnIntent({
        role: input.row.role,
        messageKind: kind,
        source: "opencode",
        text: input.row.text,
    });

    input.turns.push({
        session: input.row.session_id,
        providerEventId: input.row.id,
        seq,
        ts: timestamp.ts,
        role: input.row.role,
        message_kind: kind,
        intent_kind: intentKind,
        text: input.row.text,
        text_excerpt: textExcerpt,
        has_tool_use: input.row.hasToolUse === true,
        has_error: input.row.metrics?.isError === true,
    });
    input.providerEvents.push({
        provider: "opencode",
        providerSessionId: input.row.session_id,
        axSessionId: input.row.session_id,
        providerEventId: input.row.id,
        parentProviderEventId: input.row.parentProviderEventId ?? null,
        seq,
        ts: timestamp.ts,
        type: "message",
        role: input.row.role,
        text: input.row.text,
        textExcerpt,
        raw: input.row.raw,
        labels: {
            source: "opencode_sqlite",
            sessionId: input.row.session_id,
            messageKind: kind,
            intentKind,
            ...input.row.labels,
        },
        metrics: {
            turnSeq: seq,
            hasToolUse: input.row.hasToolUse === true,
            isError: false,
            ...input.row.metrics,
        },
    });
    return seq;
}

function processToolPart(input: {
    part: ParsedObservedPart;
    session: OpenCodeSession;
    turnSeq: number;
    ordinal: number;
    parentProviderEventId: string;
    toolCalls: MutableToolCallWrite[];
    invocations: OpenCodeInvocation[];
    skillRelations: ToolCallSkillRelationWrite[];
    providerEvents: AgentEventWrite[];
}): void {
    const toolName = toolNameFromPartData(input.part.data);
    if (!toolName) return;

    const callId = toolCallIdFromPartData(input.part.data, input.part.row);
    const ts = toolPartTimestamp(input.part.row, input.part.data, input.session.ended_at);
    const eventSeq = SYNTHETIC_PROVIDER_SEQ_OFFSET + (input.turnSeq * 1000) + input.ordinal;
    const providerEventId = input.part.row.id;
    const inputJson = toolInputFromPartData(input.part.data);
    const result = toolResultFromPartData(input.part.data);
    const toolCallKey = toolCallRecordKey({
        sessionId: input.session.id,
        seq: input.turnSeq,
        callId,
    });
    const call: MutableToolCallWrite = {
        ...makeToolCallWrite({
            provider: "opencode",
            toolName,
            sessionId: input.session.id,
            seq: input.turnSeq,
            callId,
            // OpenCode keys the tool-call agent_event by the PART row id, not
            // the call id.
            providerEventId,
            eventSeq,
            ts,
            cwd: input.session.cwd,
            inputJson,
            rawJson: input.part.data,
        }),
        outputJson: result.outputJson,
        outputExcerpt: result.outputExcerpt,
        errorText: result.errorText,
        durationMs: result.durationMs,
        hasError: result.hasError,
    };

    applyCommandFields(call, inputJson);

    input.providerEvents.push({
        provider: "opencode",
        providerSessionId: input.session.id,
        axSessionId: input.session.id,
        providerEventId,
        parentProviderEventId: input.parentProviderEventId,
        parentKind: "message_part",
        seq: eventSeq,
        ts,
        type: "tool",
        role: "assistant",
        text: toolName,
        textExcerpt: toolName,
        raw: input.part.data,
        labels: {
            source: "opencode_sqlite",
            toolName,
            toolKind: call.toolKind,
        },
        metrics: {
            turnSeq: input.turnSeq,
            partOrdinal: input.ordinal,
            durationMs: result.durationMs ?? null,
            hasError: result.hasError,
        },
    });

    input.toolCalls.push(call);
    // Synthetic provider-tool skill name - branded at the true source.
    const skillName = SkillName.make(`opencode:${toolName}`);
    input.invocations.push({
        session: input.session.id,
        seq: input.turnSeq,
        ts,
        skill: skillName,
        args: inputJson ?? {},
    });
    input.skillRelations.push({
        toolCallKey,
        skillName,
        ts,
        reason: "OpenCode tool part",
        labels: {
            provider: "opencode",
            toolName,
            source: "opencode_sqlite",
        },
        metrics: {
            turnSeq: input.turnSeq,
            partOrdinal: input.ordinal,
        },
    });
}

export function extractOpenCodeDatabase(dbPath: string): OpenCodeExtract {
    const db = new Database(dbPath, { readonly: true });
    try {
        const tables = tableNames(db);
        if (!tables.has("session") || !tables.has("message")) {
            return emptyExtract();
        }

        const sessionColumns = columnNames(db, "session");
        const messageColumns = columnNames(db, "message");
        const partColumns = tables.has("part") ? columnNames(db, "part") : new Set<string>();
        const isSynthetic = hasColumns(sessionColumns, ["id", "cwd", "title", "created_at", "updated_at"]) &&
            hasColumns(messageColumns, ["id", "session_id", "role", "content", "created_at"]);
        const isObserved = hasColumns(sessionColumns, ["id", "directory", "title", "time_created", "time_updated"]) &&
            hasColumns(messageColumns, ["id", "session_id", "time_created", "data"]) &&
            hasColumns(partColumns, ["id", "message_id", "session_id", "time_created", "data"]);

        if (!isSynthetic && !isObserved) {
            return emptyExtract(["unsupported OpenCode schema: missing required session/message columns"]);
        }

        const sessions = new Map<string, OpenCodeSession>();
        const warnings: string[] = [];
        let skipped = 0;
        const turns: OpenCodeTurn[] = [];
        const providerEvents: AgentEventWrite[] = [];
        const toolCalls: MutableToolCallWrite[] = [];
        const invocations: OpenCodeInvocation[] = [];
        const skillRelations: ToolCallSkillRelationWrite[] = [];
        const compactions: CompactionWrite[] = [];
        const seqBySession = new Map<string, number>();
        const lastStepFinishBySession = new Map<string, OpenCodeStepFinish>();
        const compactionSeqBySession = new Map<string, number>();

        if (isSynthetic) {
            const { sessions: sessionRows, messages: messageRows } = syntheticRows(db);
            for (const row of sessionRows) {
                if (typeof row.id !== "string" || row.id.length === 0) {
                    skipped += 1;
                    warnings.push("skipped session row with missing id");
                    continue;
                }
                const started = validTimestamp(row.created_at, SAFE_FALLBACK_TS);
                const ended = validTimestamp(row.updated_at, started.ts);
                if (started.warning) warnings.push(`session ${row.id}: ${started.warning}`);
                if (ended.warning) warnings.push(`session ${row.id}: ${ended.warning}`);
                sessions.set(row.id, {
                    id: row.id,
                    cwd: typeof row.cwd === "string" ? row.cwd : null,
                    title: typeof row.title === "string" ? row.title : null,
                    model: null,
                    started_at: started.ts,
                    ended_at: ended.ts,
                });
            }

            for (const row of messageRows) {
                if (
                    typeof row.id !== "string" || row.id.length === 0 ||
                    typeof row.session_id !== "string" || row.session_id.length === 0
                ) {
                    skipped += 1;
                    warnings.push("skipped message row with missing id or session_id");
                    continue;
                }
                const session = sessions.get(row.session_id);
                if (!session) {
                    skipped += 1;
                    warnings.push(`skipped message ${row.id}: missing session ${row.session_id}`);
                    continue;
                }
                const role = typeof row.role === "string" && row.role.length > 0 ? row.role : "unknown";
                const text = typeof row.content === "string" ? row.content : null;
                pushMessage({
                    row: {
                        id: row.id,
                        session_id: row.session_id,
                        created: row.created_at,
                        role,
                        text,
                        raw: {
                            id: row.id,
                            sessionId: row.session_id,
                            role: row.role,
                            createdAt: row.created_at,
                        },
                        labels: {},
                    },
                    session,
                    turns,
                    providerEvents,
                    seqBySession,
                    warnings,
                });
            }
        } else {
            const { sessions: sessionRows, messages: messageRows, parts } = observedRows(
                db,
                sessionColumns.has("model"),
            );
            for (const row of sessionRows) {
                if (typeof row.id !== "string" || row.id.length === 0) {
                    skipped += 1;
                    warnings.push("skipped session row with missing id");
                    continue;
                }
                const started = validTimestamp(row.time_created, SAFE_FALLBACK_TS);
                const ended = validTimestamp(row.time_updated, started.ts);
                if (started.warning) warnings.push(`session ${row.id}: ${started.warning}`);
                if (ended.warning) warnings.push(`session ${row.id}: ${ended.warning}`);
                sessions.set(row.id, {
                    id: row.id,
                    cwd: typeof row.directory === "string" ? row.directory : null,
                    title: typeof row.title === "string" ? row.title : null,
                    model: typeof row.model === "string" ? row.model : null,
                    started_at: started.ts,
                    ended_at: ended.ts,
                });
            }

            const partsByMessage = new Map<string, ObservedPartRow[]>();
            for (const part of parts) {
                if (typeof part.message_id !== "string" || part.message_id.length === 0) {
                    skipped += 1;
                    warnings.push("skipped part row with missing message_id");
                    continue;
                }
                const bucket = partsByMessage.get(part.message_id) ?? [];
                bucket.push(part);
                partsByMessage.set(part.message_id, bucket);
            }

            for (const row of messageRows) {
                if (
                    typeof row.id !== "string" || row.id.length === 0 ||
                    typeof row.session_id !== "string" || row.session_id.length === 0
                ) {
                    skipped += 1;
                    warnings.push("skipped message row with missing id or session_id");
                    continue;
                }
                const session = sessions.get(row.session_id);
                if (!session) {
                    skipped += 1;
                    warnings.push(`skipped message ${row.id}: missing session ${row.session_id}`);
                    continue;
                }
                const messageData = parseJsonRecord(row.data, `message ${row.id}`, warnings);
                if (!messageData) {
                    skipped += 1;
                    warnings.push(`skipped message ${row.id}: invalid message JSON`);
                    continue;
                }
                const parsedParts: ParsedObservedPart[] = [];
                const texts: string[] = [];
                for (const part of partsByMessage.get(row.id) ?? []) {
                    const partData = parseJsonRecord(part.data, `part ${part.id}`, warnings);
                    if (!partData) {
                        skipped += 1;
                        continue;
                    }
                    parsedParts.push({ row: part, data: partData });
                    const text = textFromPartData(partData);
                    if (text !== null) texts.push(text);
                }
                const toolParts = parsedParts.filter((part) => toolNameFromPartData(part.data) !== null);
                const stepFinishes = parsedParts
                    .map((part) => stepFinishFromPart(part, session.ended_at))
                    .filter((step): step is OpenCodeStepFinish => step !== null);
                const role = stringField(messageData, "role") ?? "unknown";
                const model = nestedStringField(messageData, "model", "modelID") ??
                    stringField(messageData, "modelID") ??
                    session.model;
                const provider = nestedStringField(messageData, "model", "providerID") ??
                    stringField(messageData, "providerID");
                const toolPartsHaveError = toolParts.some((part) => toolResultFromPartData(part.data).hasError);
                const turnSeq = pushMessage({
                    row: {
                        id: row.id,
                        session_id: row.session_id,
                        created: row.time_created,
                        role,
                        text: texts.length > 0 ? texts.join("\n") : null,
                        hasToolUse: toolParts.length > 0,
                        raw: {
                            id: row.id,
                            sessionId: row.session_id,
                            data: messageData,
                            parts: parsedParts.map((part) => ({
                                id: part.row.id,
                                data: part.data,
                            })) ?? [],
                        },
                        parentProviderEventId: stringField(messageData, "parentID"),
                        labels: {
                            model,
                            provider,
                            mode: stringField(messageData, "mode"),
                            agent: stringField(messageData, "agent"),
                        },
                        metrics: {
                            isError: hasErrorFlag(messageData) || toolPartsHaveError,
                            toolCalls: toolParts.length,
                        },
                    },
                    session,
                    turns,
                    providerEvents,
                    seqBySession,
                    warnings,
                });
                toolParts.forEach((part, index) =>
                    processToolPart({
                        part,
                        session,
                        turnSeq,
                        ordinal: index + 1,
                        parentProviderEventId: row.id,
                        toolCalls,
                        invocations,
                        skillRelations,
                        providerEvents,
                    })
                );
                processStepFinishCompactions({
                    stepFinishes,
                    session,
                    parentProviderEventId: row.id,
                    providerEvents,
                    compactions,
                    lastStepFinishBySession,
                    compactionSeqBySession,
                });
            }
        }

        return {
            sessions: [...sessions.values()],
            turns,
            providerEvents,
            toolCalls,
            invocations,
            skillRelations,
            compactions,
            skipped,
            warnings,
        };
    } catch (error) {
        return emptyExtract(
            [`failed to extract OpenCode database ${dbPath}: ${error instanceof Error ? error.message : String(error)}`],
            1,
        );
    } finally {
        db.close();
    }
}

/**
 * Narrow a whole-store extract down to ONE session - the unit of isolation
 * for SQLite-backed providers (#261). The store is re-extracted on every run,
 * so a session skipped by the isolation seam is naturally retried next run.
 * `skipped`/`warnings` stay store-level and are NOT attributed to slices.
 */
const sliceOpenCodeExtractForSession = (
    extract: OpenCodeExtract,
    sessionId: string,
): OpenCodeExtract => {
    const toolCalls = extract.toolCalls.filter((call) => call.sessionId === sessionId);
    // Skill relations carry no session field; correlate through the same
    // toolCallRecordKey their tool calls were keyed with at extraction time.
    const toolCallKeys = new Set(toolCalls.map((call) =>
        toolCallRecordKey({ sessionId, seq: call.seq, callId: call.callId ?? null })
    ));
    return {
        sessions: extract.sessions.filter((session) => session.id === sessionId),
        turns: extract.turns.filter((turn) => turn.session === sessionId),
        providerEvents: extract.providerEvents.filter((event) => event.providerSessionId === sessionId),
        toolCalls,
        invocations: extract.invocations.filter((invocation) => invocation.session === sessionId),
        skillRelations: extract.skillRelations.filter((relation) => toolCallKeys.has(relation.toolCallKey)),
        compactions: extract.compactions.filter((compaction) => compaction.sessionId === sessionId),
        skipped: 0,
        warnings: [],
    };
};

export const __testSliceOpenCodeExtractForSession = sliceOpenCodeExtractForSession;

const buildOpenCodeBatchStatements = (
    extract: OpenCodeExtract,
    sourcePath: string,
): string[] =>
    buildNormalizedTranscriptStatements({
        providers: [{
            name: "opencode",
            displayName: "OpenCode",
            capabilities: {
                sqlite: true,
                transcripts: true,
                providerGraph: true,
                toolCalls: true,
                planSignals: providerPlanSignalAvailability.opencode,
                delegationSignals: providerDelegationSignalAvailability.opencode,
            },
        }],
        sessions: extract.sessions.map((session) => ({
            id: session.id,
            provider: "opencode",
            providerSessionId: session.id,
            cwd: session.cwd,
            project: session.cwd,
            title: session.title,
            model: session.model,
            sourcePath,
            raw: {
                source: "opencode_sqlite",
                sourcePath,
            },
            labels: {
                source: "opencode",
            },
            metrics: {
                turns: extract.turns.filter((turn) => turn.session === session.id).length,
                toolCalls: extract.toolCalls.filter((call) => call.sessionId === session.id).length,
                providerEvents: extract.providerEvents.filter((event) => event.providerSessionId === session.id).length,
            },
            startedAt: session.started_at,
            endedAt: session.ended_at,
        })),
        events: extract.providerEvents,
        turns: extract.turns.map((turn) => ({
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
            agentEvent: {
                provider: "opencode",
                providerSessionId: turn.session,
                providerEventId: turn.providerEventId,
                seq: turn.seq,
            },
        })),
        toolCalls: extract.toolCalls,
        // OpenCode emits no tool-file evidence today (pre-toolkit behavior preserved).
        toolFileEvidence: [],
        agentEventParentEdges: [],
        syntheticSkillInvocations: extract.invocations.map((invocation) => ({
            sessionId: invocation.session,
            seq: invocation.seq,
            ts: invocation.ts,
            skillName: invocation.skill,
            args: invocation.args,
            skillScope: "opencode-tool",
            skillContentHash: "opencode",
        })),
        toolCallSkillRelations: extract.skillRelations,
        planSnapshots: [],
        compactions: extract.compactions,
    });

export const __testBuildOpenCodeBatchStatements = buildOpenCodeBatchStatements;

function failedExtract(dbPath: string, error: unknown): OpenCodeExtract {
    return emptyExtract(
        [`failed to read OpenCode database ${dbPath}: ${error instanceof Error ? error.message : String(error)}`],
        1,
    );
}

// Discovery PROBE: the OLD code guarded with `existsSync` and `stat`-in-try/catch,
// treating any miss/fault as "no candidate". `orAbsent` reproduces that exactly
// (recovers ANY PlatformError to the fallback), so this reader never fails; R is
// just FileSystem + Path.
const findOpenCodeDbCandidates = (
    opencodeDir: string,
    cutoffMs = 0,
): Effect.Effect<string[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dbPath = path.join(opencodeDir, "opencode.db");
        // OLD: existsSync guard → [] when the db file is absent.
        const exists = yield* fs.exists(dbPath).pipe(orAbsent(false));
        if (!exists) return [];
        if (cutoffMs > 0) {
            // OLD: stat in try/catch → [] on fault or when mtime is below cutoff.
            const mtimeMs = yield* fs.stat(dbPath).pipe(
                Effect.map((st) => Option.getOrElse(st.mtime, () => new Date(0)).getTime()),
                orAbsent(-1),
            );
            if (mtimeMs < cutoffMs) return [];
        }
        return [dbPath];
    });

export const __testFindOpenCodeDbCandidates = findOpenCodeDbCandidates;

interface OpenCodeIngestOpts {
    sinceDays: number | undefined;
}

export const ingestOpenCode = Effect.fn("opencode.ingest")(
    function* (opts: Partial<OpenCodeIngestOpts> = {}) {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const dbPaths = yield* findOpenCodeDbCandidates(cfg.paths.opencodeDir, cutoff);

        if (dbPaths.length === 0) {
            return {
                sessions: 0,
                turns: 0,
                toolCalls: 0,
                skipped: 0,
                warnings: 0,
                failedFiles: 0,
            };
        }

        const dbPath = dbPaths[0]!;
        const extract = yield* Effect.sync(() => {
            try {
                return extractOpenCodeDatabase(dbPath);
            } catch (error) {
                return failedExtract(dbPath, error);
            }
        }).pipe(Effect.withSpan("opencode.extract", {
            attributes: { "file.name": dbPath.slice(dbPath.lastIndexOf("/") + 1) },
        }));

        if (extract.sessions.length === 0) {
            return {
                sessions: 0,
                turns: 0,
                toolCalls: 0,
                skipped: extract.skipped,
                warnings: extract.warnings.length,
                failedFiles: 0,
            };
        }

        const failures = makeFileFailureCollector({ source: "opencode", unit: "session" });
        let sessionCount = 0;
        let turnCount = 0;
        let toolCallCount = 0;
        for (const session of extract.sessions) {
            const slice = sliceOpenCodeExtractForSession(extract, session.id);
            // Per-session failure isolation (#261): one undecodable / rejected
            // session skips THIS session - the store is re-read next run -
            // instead of aborting the whole stage (see file-isolation.ts).
            yield* failures.isolate(`${dbPath}#${session.id}`, Effect.gen(function* () {
                yield* db.upsert(new RecordId("session", session.id), {
                    project: session.cwd ?? undefined,
                    cwd: session.cwd ?? undefined,
                    model: session.model ?? undefined,
                    source: "opencode",
                    started_at: new Date(session.started_at),
                    ended_at: new Date(session.ended_at),
                    raw_file: dbPath,
                });
                yield* executeStatements(buildOpenCodeBatchStatements(slice, dbPath), { chunkSize: 500, label: "opencode" });
                sessionCount += 1;
                turnCount += slice.turns.length;
                toolCallCount += slice.toolCalls.length;
            }));
        }
        yield* failures.report;

        return {
            sessions: sessionCount,
            turns: turnCount,
            toolCalls: toolCallCount,
            skipped: extract.skipped,
            warnings: extract.warnings.length,
            failedFiles: failures.count(),
        } satisfies OpenCodeStats;
    },
);

export class OpenCodeStageStats extends BaseStageStats.extend<OpenCodeStageStats>("OpenCodeStageStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
    skipped: Schema.Number,
    warnings: Schema.Number,
    /** Sessions whose write pipeline failed and was skipped (retried next
     *  run). Named `failedFiles` to match the cross-provider stage-stats key
     *  the run totals + CLI skip summary aggregate (#261). */
    failedFiles: Schema.Number,
}) {}

export const opencodeStage: StageDef<OpenCodeStageStats, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> = {
    meta: StageMeta.make({ key: "opencode", deps: ["skills", "commands"], tags: ["ingest"] }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext) {
        const t0 = Date.now();
        const sinceDays = sinceDaysFromCtx(ctx);
        const result = yield* ingestOpenCode({ sinceDays });
        return OpenCodeStageStats.make({
            durationMs: Date.now() - t0,
            summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls, skipped ${result.skipped}, warnings ${result.warnings}` +
                (result.failedFiles > 0 ? `, ${result.failedFiles} session(s) failed (retry next run)` : ""),
            sessionsIngested: result.sessions,
            turnsIngested: result.turns,
            toolCallsIngested: result.toolCalls,
            skipped: result.skipped,
            warnings: result.warnings,
            failedFiles: result.failedFiles,
        });
    }),
};
