import { Database } from "bun:sqlite";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SkillName } from "@ax/lib/brands";
import { RecordId, SurrealClient } from "@ax/lib/db";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { posixPath } from "@ax/lib/shared/path";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import {
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import { extractCursorCompaction, type CompactionWrite } from "./compaction.ts";
import { makeFileFailureCollector } from "./file-isolation.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { providerDelegationSignalAvailability } from "./delegation.ts";
import { agentEventRecordKey, type AgentEventWrite } from "./provider-events.ts";
import { buildNormalizedTranscriptStatements, type NormalizedTranscriptBatch } from "./normalized/transcripts.ts";
import { providerPlanSignalAvailability } from "./plans.ts";
import { identityPart, toolCallRecordKey } from "./record-keys.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { boundExcerpt, isRecord, parseJsonRecord, stringField } from "./normalized/toolkit.ts";
import { makeToolCallWrite } from "./normalized/tool-call-write.ts";
import { extractCommandTool, normalizeCommand } from "./tool-calls.ts";

export const CursorKey = Schema.Literal("cursor");
export type CursorKey = typeof CursorKey.Type;

export interface CursorStats {
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

interface CursorSession {
    id: string;
    cursorConversationId: string;
    dbIdentity: string;
    title: string | null;
    sourcePath: string;
    started_at: string;
    ended_at: string;
}

interface CursorTurn {
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

interface CursorInvocation {
    session: string;
    seq: number;
    ts: string;
    skill: SkillName;
    args: unknown;
}

export interface CursorExtract {
    sessions: CursorSession[];
    turns: CursorTurn[];
    invocations: CursorInvocation[];
    toolCalls: ToolCallWrite[];
    providerEvents: AgentEventWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    compactions: CompactionWrite[];
    skipped: number;
    warnings: string[];
}

export interface CursorExtractOptions {
    readonly cursorUserDir?: string | null;
}

type SQLiteValue = string | number | bigint | boolean | Uint8Array | ArrayBuffer | null;

interface SQLiteRow {
    readonly key: string | null;
    readonly value: SQLiteValue | undefined;
}

interface SQLiteKeyRow {
    readonly key: string | null;
}

interface SQLiteColumnRow {
    readonly name: string;
}

const SAFE_FALLBACK_TS = "1970-01-01T00:00:00.000Z";
const SYNTHETIC_PROVIDER_SEQ_OFFSET = 1_000_000_000;
const CURSOR_HISTORY_KEYS = new Set(["composer.composerData"]);
const CURSOR_COMPOSER_DATA_PREFIX = "composerData:";

export function isAllowedCursorHistoryKey(key: string): boolean {
    const lower = key.toLowerCase();
    if (
        lower.includes("auth") ||
        lower.includes("token") ||
        lower.includes("privacy")
    ) {
        return false;
    }
    return CURSOR_HISTORY_KEYS.has(key) || key.startsWith(CURSOR_COMPOSER_DATA_PREFIX);
}

function validTimestamp(input: unknown, fallback: string): { ts: string; warning: string | null } {
    if (input === null || input === undefined) return { ts: fallback, warning: "missing timestamp" };
    if (typeof input !== "string" && typeof input !== "number") {
        return { ts: fallback, warning: `invalid timestamp: ${String(input)}` };
    }
    const date = new Date(input);
    if (!Number.isFinite(date.getTime())) {
        return { ts: fallback, warning: `invalid timestamp: ${String(input)}` };
    }
    return { ts: date.toISOString(), warning: null };
}

function cursorMessageKind(role: string): string {
    if (role === "system" || role === "developer") return "system_or_developer";
    if (role === "assistant") return "assistant";
    if (role === "tool" || role === "tool_result") return "tool_result";
    if (role === "user") return "task";
    return "message";
}

function cursorRoleFromBubbleType(type: unknown): string {
    if (type === 1) return "user";
    if (type === 2) return "assistant";
    return "unknown";
}

function emptyExtract(warnings: string[] = [], skipped = 0): CursorExtract {
    return {
        sessions: [],
        turns: [],
        invocations: [],
        toolCalls: [],
        providerEvents: [],
        skillRelations: [],
        compactions: [],
        skipped,
        warnings,
    };
}

function cursorDbIdentity(dbPath: string, cursorUserDir?: string | null): string {
    if (cursorUserDir && cursorUserDir.length > 0) {
        const relativePath = posixPath.relative(cursorUserDir, dbPath);
        if (
            relativePath.length > 0 &&
            relativePath !== ".." &&
            !relativePath.startsWith("../") &&
            !relativePath.startsWith("..\\") &&
            !posixPath.isAbsolute(relativePath)
        ) {
            return relativePath.replace(/[\\/]/g, "/");
        }
    }
    return dbPath.replace(/[\\/]/g, "/");
}

function cursorSessionId(input: {
    readonly dbIdentity: string;
    readonly cursorConversationId: string;
}): string {
    return [
        "cursor",
        identityPart(input.dbIdentity, "db"),
        identityPart(input.cursorConversationId, "conversation"),
    ].join("__");
}

function decodeSqliteValue(value: SQLiteValue | undefined): string | null {
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
    return null;
}

/** Effect-Schema-backed JSON decode at the SQLite blob boundary. `Option`
 *  (not `null`) so a literal JSON `null` is distinguishable from a failed
 *  parse. */
const decodeJsonStringOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

function parseJsonValue(input: unknown): unknown {
    if (typeof input !== "string") return input;
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    const parsed = decodeJsonStringOption(trimmed);
    return Option.isSome(parsed) ? parsed.value : input;
}

function cursorToolCallId(
    raw: Record<string, unknown>,
    sessionId: string,
    seq: number,
    ordinal: number,
): string {
    return stringField(raw, "toolCallId") ??
        stringField(raw, "tool_call_id") ??
        stringField(raw, "callId") ??
        stringField(raw, "id") ??
        `cursor_tool_call_${identityPart(sessionId, "session")}_${seq.toString(10).padStart(6, "0")}_${ordinal.toString(10).padStart(3, "0")}`;
}

function cursorToolName(raw: Record<string, unknown>): string | null {
    const name = stringField(raw, "name") ??
        stringField(raw, "toolName") ??
        stringField(raw, "tool_name");
    if (name !== null && name.trim().length > 0) return name;
    const fn = raw.function;
    if (isRecord(fn)) return stringField(fn, "name");
    return null;
}

function toolInputFromRaw(raw: Record<string, unknown>): unknown {
    const fn = raw.function;
    if (isRecord(fn) && fn.arguments !== undefined) return parseJsonValue(fn.arguments);
    if (raw.arguments !== undefined) return parseJsonValue(raw.arguments);

    const rawArgs = raw.rawArgs === undefined ? null : parseJsonValue(raw.rawArgs);
    const params = raw.params === undefined ? null : parseJsonValue(raw.params);
    if (isRecord(rawArgs) && isRecord(params)) return { ...rawArgs, ...params };
    if (isRecord(rawArgs) && Object.keys(rawArgs).length === 0 && params !== null) return params;
    if (rawArgs !== null && rawArgs !== undefined) return rawArgs;
    if (params !== null && params !== undefined) return params;

    for (const field of ["input", "args"]) {
        if (raw[field] === undefined) continue;
        const parsed = parseJsonValue(raw[field]);
        if (parsed !== null && parsed !== undefined) return parsed;
    }
    return null;
}

function toolOutputFromRaw(raw: Record<string, unknown>): unknown {
    if (raw.result !== undefined) return parseJsonValue(raw.result);
    if (raw.output !== undefined) return parseJsonValue(raw.output);
    if (raw.response !== undefined) return parseJsonValue(raw.response);
    return null;
}

function errorTextFromRaw(raw: Record<string, unknown>): string | null {
    const parsed = parseJsonValue(raw.error);
    if (isRecord(parsed)) {
        return stringField(parsed, "modelVisibleErrorMessage") ??
            stringField(parsed, "clientVisibleErrorMessage") ??
            boundExcerpt(parsed);
    }
    return boundExcerpt(parsed);
}

function rawToolPayload(raw: Record<string, unknown>): Record<string, unknown> {
    return {
        name: cursorToolName(raw),
        status: raw.status ?? null,
        toolCallId: raw.toolCallId ?? raw.tool_call_id ?? raw.callId ?? raw.id ?? null,
        toolIndex: raw.toolIndex ?? null,
        modelCallId: raw.modelCallId ?? null,
        tool: raw.tool ?? null,
        params: parseJsonValue(raw.params),
        rawArgs: parseJsonValue(raw.rawArgs),
        additionalData: parseJsonValue(raw.additionalData),
        error: parseJsonValue(raw.error),
    };
}

function cursorToolActivities(raw: Record<string, unknown>): Record<string, unknown>[] {
    const activities: Record<string, unknown>[] = [];
    if (isRecord(raw.toolFormerData)) activities.push(raw.toolFormerData);

    for (const field of ["toolCalls", "tool_calls", "functionCalls", "function_calls"]) {
        const value = raw[field];
        if (!Array.isArray(value)) continue;
        for (const item of value) {
            if (isRecord(item)) activities.push(item);
        }
    }

    for (const field of ["toolCall", "tool_call", "functionCall", "function_call"]) {
        const value = raw[field];
        if (isRecord(value)) activities.push(value);
    }

    return activities.filter((activity) => cursorToolName(activity) !== null);
}

function pushCursorToolCall(input: {
    session: CursorSession;
    raw: Record<string, unknown>;
    seq: number;
    ordinal: number;
    ts: string;
    sourceKey: string;
    toolCalls: ToolCallWrite[];
    providerEvents: AgentEventWrite[];
    invocations: CursorInvocation[];
    skillRelations: ToolCallSkillRelationWrite[];
    parentProviderEventId: string | null;
}): void {
    const toolName = cursorToolName(input.raw);
    if (toolName === null) return;

    const callId = cursorToolCallId(input.raw, input.session.id, input.seq, input.ordinal);
    const toolCallKey = toolCallRecordKey({
        sessionId: input.session.id,
        seq: input.seq,
        callId,
    });
    const inputJson = toolInputFromRaw(input.raw);
    const outputJson = toolOutputFromRaw(input.raw);
    const errorText = errorTextFromRaw(input.raw);
    const status = stringField(input.raw, "status");
    const hasError = errorText !== null || status === "error" || status === "failed";
    const commandSource = isRecord(inputJson) ? inputJson : {};
    const command = (toolName === "run_terminal_command_v2" || toolName === "run_terminal_command")
        ? stringField(commandSource, "command") ?? stringField(commandSource, "cmd")
        : null;
    const eventSeq = SYNTHETIC_PROVIDER_SEQ_OFFSET + (input.seq * 1000) + input.ordinal;
    const call: ToolCallWrite = {
        ...makeToolCallWrite({
            provider: "cursor",
            toolName,
            sessionId: input.session.id,
            seq: input.seq,
            callId,
            eventSeq,
            ts: input.ts,
            inputJson,
            rawJson: {
                source: "cursor_state_vscdb",
                sourceKey: input.sourceKey,
                tool: rawToolPayload(input.raw),
            },
        }),
        outputJson,
        outputExcerpt: boundExcerpt(outputJson),
        errorText,
        // Cursor always carries the command triple (possibly null) rather
        // than the exec_command-gated applyCommandFields path.
        commandText: command,
        commandToolName: extractCommandTool(command),
        commandNorm: normalizeCommand(command),
        hasError,
    };

    input.providerEvents.push({
        provider: "cursor",
        providerSessionId: input.session.id,
        axSessionId: input.session.id,
        providerEventId: callId,
        parentProviderEventId: input.parentProviderEventId,
        parentKind: "turn_item",
        seq: eventSeq,
        ts: input.ts,
        type: "toolCall",
        role: "assistant",
        text: toolName,
        textExcerpt: toolName,
        raw: rawToolPayload(input.raw),
        labels: {
            source: "cursor_state_vscdb",
            toolName,
            toolKind: call.toolKind,
        },
        metrics: {
            turnSeq: input.seq,
            hasError,
        },
    });

    input.toolCalls.push(call);

    // Synthetic provider-tool skill name - branded at the true source.
    const skillName = SkillName.make(`cursor:${toolName}`);
    input.invocations.push({
        session: input.session.id,
        seq: input.seq,
        ts: input.ts,
        skill: skillName,
        args: inputJson ?? {},
    });
    input.skillRelations.push({
        toolCallKey,
        skillName,
        ts: input.ts,
        reason: "Cursor tool call",
        labels: {
            provider: "cursor",
            toolName,
            source: input.sourceKey,
        },
        metrics: { turnSeq: input.seq },
    });
}

function tableNames(db: Database): Set<string> {
    const rows = db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all();
    return new Set(rows.map((row) => row.name));
}

function columnNames(db: Database, table: string): Set<string> {
    const quotedTable = JSON.stringify(table);
    const rows = db.query<SQLiteColumnRow, []>(`PRAGMA table_info(${quotedTable})`).all();
    return new Set(rows.map((row) => row.name));
}

function simpleKvTables(db: Database, tableCandidates: readonly string[]): string[] {
    return tableCandidates.filter((table) => {
        const columns = columnNames(db, table);
        return columns.has("key") && columns.has("value");
    });
}

function readKeys(db: Database, table: string): SQLiteKeyRow[] {
    const quotedTable = JSON.stringify(table);
    return db.query<SQLiteKeyRow, []>(`SELECT key FROM ${quotedTable}`).all();
}

function readValueForKey(db: Database, table: string, key: string): SQLiteValue | undefined {
    const quotedTable = JSON.stringify(table);
    return db.query<SQLiteRow, [string]>(
        `SELECT key, value FROM ${quotedTable} WHERE key = ? LIMIT 1`,
    ).get(key)?.value;
}

function pushCursorMessage(input: {
    session: CursorSession;
    message: Record<string, unknown>;
    seq: number;
    sourceKey: string;
    turns: CursorTurn[];
    invocations: CursorInvocation[];
    toolCalls: ToolCallWrite[];
    providerEvents: AgentEventWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    warnings: string[];
}): void {
    const rawId = stringField(input.message, "id");
    const providerEventId = rawId && rawId.length > 0
        ? rawId
        : `${input.session.id}:${input.seq}`;
    const role = stringField(input.message, "role") ?? "unknown";
    const text = stringField(input.message, "text");
    const activities = cursorToolActivities(input.message);
    const timestamp = validTimestamp(input.message.timestamp, input.session.ended_at);
    if (timestamp.warning) input.warnings.push(`message ${providerEventId}: ${timestamp.warning}`);
    const ts = timestamp.ts;
    if (
        input.session.started_at === SAFE_FALLBACK_TS ||
        new Date(ts).getTime() < new Date(input.session.started_at).getTime()
    ) {
        input.session.started_at = ts;
    }
    if (new Date(ts).getTime() > new Date(input.session.ended_at).getTime()) {
        input.session.ended_at = ts;
    }

    const textExcerpt = text === null ? null : text.slice(0, 500);
    const messageKind = activities.length > 0 ? "tool_call" : cursorMessageKind(role);
    const intentKind = classifyTurnIntent({
        role,
        messageKind,
        source: "cursor",
        text,
    });

    input.turns.push({
        session: input.session.id,
        providerEventId,
        seq: input.seq,
        ts,
        role,
        message_kind: messageKind,
        intent_kind: intentKind,
        text,
        text_excerpt: textExcerpt,
        has_tool_use: activities.length > 0,
        has_error: activities.some((activity) => errorTextFromRaw(activity) !== null),
    });
    input.providerEvents.push({
        provider: "cursor",
        providerSessionId: input.session.id,
        axSessionId: input.session.id,
        providerEventId,
        seq: input.seq,
        ts,
        type: "message",
        role,
        text,
        textExcerpt,
        raw: {
            sourceKey: input.sourceKey,
            cursorConversationId: input.session.cursorConversationId,
            cursorMessageId: rawId,
            id: rawId,
            role,
            text,
            timestamp: input.message.timestamp,
        },
        labels: {
            source: "cursor_state_vscdb",
            sourceKey: input.sourceKey,
            dbIdentity: input.session.dbIdentity,
            cursorConversationId: input.session.cursorConversationId,
            cursorMessageId: rawId,
            messageKind,
            intentKind,
        },
        metrics: {
            turnSeq: input.seq,
            hasToolUse: activities.length > 0,
            isError: activities.some((activity) => errorTextFromRaw(activity) !== null),
        },
    });

    activities.forEach((activity, index) => {
        pushCursorToolCall({
            session: input.session,
            raw: activity,
            seq: input.seq,
            ordinal: index + 1,
            ts,
            sourceKey: input.sourceKey,
            toolCalls: input.toolCalls,
            providerEvents: input.providerEvents,
            invocations: input.invocations,
            skillRelations: input.skillRelations,
            parentProviderEventId: providerEventId,
        });
    });
}

function extractComposerData(
    data: Record<string, unknown>,
    sourceKey: string,
    sourcePath: string,
    dbIdentity: string,
    warnings: string[],
): Omit<CursorExtract, "warnings"> {
    const sessions: CursorSession[] = [];
    const turns: CursorTurn[] = [];
    const invocations: CursorInvocation[] = [];
    const toolCalls: ToolCallWrite[] = [];
    const providerEvents: AgentEventWrite[] = [];
    const skillRelations: ToolCallSkillRelationWrite[] = [];
    const compactions: CompactionWrite[] = [];
    let skipped = 0;
    const conversations = Array.isArray(data.conversations) ? data.conversations : [];
    if (!Array.isArray(data.conversations)) {
        warnings.push(`${sourceKey}: missing conversations array`);
        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, compactions, skipped: 1 };
    }

    for (const conversation of conversations) {
        if (!isRecord(conversation)) {
            skipped += 1;
            continue;
        }
        const id = stringField(conversation, "id");
        if (id === null || id.length === 0) {
            skipped += 1;
            warnings.push(`${sourceKey}: skipped conversation with missing id`);
            continue;
        }
        const session: CursorSession = {
            id: cursorSessionId({
                dbIdentity,
                cursorConversationId: id,
            }),
            cursorConversationId: id,
            dbIdentity,
            title: stringField(conversation, "title"),
            sourcePath,
            started_at: SAFE_FALLBACK_TS,
            ended_at: SAFE_FALLBACK_TS,
        };
        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        let seq = 0;
        for (const message of messages) {
            if (!isRecord(message)) {
                skipped += 1;
                continue;
            }
            seq += 1;
            pushCursorMessage({
                session,
                message,
                seq,
                sourceKey,
                turns,
                invocations,
                toolCalls,
                providerEvents,
                skillRelations,
                warnings,
            });
        }
        if (seq > 0) sessions.push(session);
    }

    return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, compactions, skipped };
}

function extractComposerDiskKvData(
    data: Record<string, unknown>,
    sourceKey: string,
    sourcePath: string,
    dbIdentity: string,
    db: Database,
    table: string,
    warnings: string[],
): Omit<CursorExtract, "warnings"> {
    const sessions: CursorSession[] = [];
    const turns: CursorTurn[] = [];
    const invocations: CursorInvocation[] = [];
    const toolCalls: ToolCallWrite[] = [];
    const providerEvents: AgentEventWrite[] = [];
    const skillRelations: ToolCallSkillRelationWrite[] = [];
    const compactions: CompactionWrite[] = [];
    let skipped = 0;
    const composerId = stringField(data, "composerId") ?? sourceKey.slice(CURSOR_COMPOSER_DATA_PREFIX.length);
    if (composerId.length === 0) {
        warnings.push(`${sourceKey}: missing composerId`);
        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, compactions, skipped: 1 };
    }
    const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
    if (!Array.isArray(data.fullConversationHeadersOnly)) {
        warnings.push(`${sourceKey}: missing fullConversationHeadersOnly array`);
        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, compactions, skipped: 1 };
    }

    const session: CursorSession = {
        id: cursorSessionId({
            dbIdentity,
            cursorConversationId: composerId,
        }),
        cursorConversationId: composerId,
        dbIdentity,
        title: stringField(data, "name"),
        sourcePath,
        started_at: SAFE_FALLBACK_TS,
        ended_at: SAFE_FALLBACK_TS,
    };

    let seq = 0;
    for (const header of headers) {
        if (!isRecord(header)) {
            skipped += 1;
            continue;
        }
        const bubbleId = stringField(header, "bubbleId");
        if (bubbleId === null || bubbleId.length === 0) {
            skipped += 1;
            warnings.push(`${sourceKey}: skipped bubble header with missing bubbleId`);
            continue;
        }
        const bubbleKey = `bubbleId:${composerId}:${bubbleId}`;
        const bubble = parseJsonRecord(
            decodeSqliteValue(readValueForKey(db, table, bubbleKey)),
            `${table}.${bubbleKey}`,
            warnings,
        );
        if (bubble === null) {
            skipped += 1;
            continue;
        }
        const role = stringField(bubble, "role") ?? cursorRoleFromBubbleType(bubble.type ?? header.type);
        const timestamp = bubble.createdAt ?? bubble.timestamp ?? data.createdAt;
        seq += 1;
        pushCursorMessage({
            session,
            message: {
                id: bubbleId,
                role,
                text: stringField(bubble, "text") ?? "",
                timestamp,
                toolFormerData: bubble.toolFormerData,
                toolCalls: bubble.toolCalls,
                tool_calls: bubble.tool_calls,
                functionCall: bubble.functionCall,
                function_call: bubble.function_call,
            },
            seq,
            sourceKey,
            turns,
            invocations,
            toolCalls,
            providerEvents,
            skillRelations,
            warnings,
        });
    }
    if (seq > 0) sessions.push(session);

    const summarizedComposers = Array.isArray((data as Record<string, unknown>).summarizedComposers)
        ? ((data as Record<string, unknown>).summarizedComposers as unknown[]).filter(
              (x): x is string => typeof x === "string",
          )
        : [];
    if (summarizedComposers.length > 0) {
        const compactionSeq = seq + 1;
        const firstHeader = headers.find((header): header is Record<string, unknown> => isRecord(header));
        const firstBubbleId =
            (firstHeader ? stringField(firstHeader, "bubbleId") : null) ?? composerId;
        const compactionTs = validTimestamp(data.createdAt, session.ended_at).ts;
        const compactionEventId = `compaction:${composerId}`;
        const eventKey = agentEventRecordKey({
            provider: "cursor",
            providerSessionId: session.id,
            providerEventId: compactionEventId,
            seq: compactionSeq,
        });
        providerEvents.push({
            provider: "cursor",
            providerSessionId: session.id,
            axSessionId: session.id,
            providerEventId: compactionEventId,
            seq: compactionSeq,
            ts: compactionTs,
            type: "compaction",
            role: null,
            text: null,
            metrics: { strategy: "encrypted" },
        });
        compactions.push(
            extractCursorCompaction({
                sessionId: session.id,
                providerSessionId: session.id,
                seq: compactionSeq,
                ts: new Date(compactionTs),
                agentEventKey: eventKey,
                boundaryRef: firstBubbleId,
                summarizedComposers,
            }),
        );
    }

    return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, compactions, skipped };
}

export function extractCursorStateDb(dbPath: string, options: CursorExtractOptions = {}): CursorExtract {
    const db = new Database(dbPath, { readonly: true });
    try {
        const dbIdentity = cursorDbIdentity(dbPath, options.cursorUserDir);
        const tables = tableNames(db);
        const kvTables = simpleKvTables(
            db,
            ["ItemTable", "cursorDiskKV"].filter((table) => tables.has(table)),
        );
        if (kvTables.length === 0) {
            return emptyExtract(["unsupported Cursor state schema: missing ItemTable/cursorDiskKV"]);
        }

        const sessions: CursorSession[] = [];
        const turns: CursorTurn[] = [];
        const invocations: CursorInvocation[] = [];
        const toolCalls: ToolCallWrite[] = [];
        const providerEvents: AgentEventWrite[] = [];
        const skillRelations: ToolCallSkillRelationWrite[] = [];
        const compactions: CompactionWrite[] = [];
        const warnings: string[] = [];
        let skipped = 0;

        for (const table of kvTables) {
            for (const row of readKeys(db, table)) {
                if (typeof row.key !== "string" || row.key.length === 0) {
                    skipped += 1;
                    continue;
                }
                if (!isAllowedCursorHistoryKey(row.key)) continue;

                const payload = parseJsonRecord(
                    decodeSqliteValue(readValueForKey(db, table, row.key)),
                    `${table}.${row.key}`,
                    warnings,
                );
                if (payload === null) {
                    skipped += 1;
                    continue;
                }

                if (row.key === "composer.composerData") {
                    const extracted = extractComposerData(payload, row.key, dbPath, dbIdentity, warnings);
                    sessions.push(...extracted.sessions);
                    turns.push(...extracted.turns);
                    invocations.push(...extracted.invocations);
                    toolCalls.push(...extracted.toolCalls);
                    providerEvents.push(...extracted.providerEvents);
                    skillRelations.push(...extracted.skillRelations);
                    compactions.push(...extracted.compactions);
                    skipped += extracted.skipped;
                } else if (row.key.startsWith(CURSOR_COMPOSER_DATA_PREFIX)) {
                    const extracted = extractComposerDiskKvData(payload, row.key, dbPath, dbIdentity, db, table, warnings);
                    sessions.push(...extracted.sessions);
                    turns.push(...extracted.turns);
                    invocations.push(...extracted.invocations);
                    toolCalls.push(...extracted.toolCalls);
                    providerEvents.push(...extracted.providerEvents);
                    skillRelations.push(...extracted.skillRelations);
                    compactions.push(...extracted.compactions);
                    skipped += extracted.skipped;
                }
            }
        }

        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, compactions, skipped, warnings };
    } catch (error) {
        return emptyExtract(
            [`failed to extract Cursor state database ${dbPath}: ${error instanceof Error ? error.message : String(error)}`],
            1,
        );
    } finally {
        db.close();
    }
}

const toCursorNormalizedBatch = (
    extract: CursorExtract,
    sourcePath: string,
): NormalizedTranscriptBatch => ({
    providers: [{
        name: "cursor",
        displayName: "Cursor",
        capabilities: {
            sqlite: true,
            transcripts: true,
            providerGraph: true,
            toolCalls: true,
            planSignals: providerPlanSignalAvailability.cursor,
            delegationSignals: providerDelegationSignalAvailability.cursor,
        },
    }],
    sessions: extract.sessions.map((session) => ({
        id: session.id,
        provider: "cursor",
        providerSessionId: session.id,
        title: session.title,
        sourcePath,
        raw: {
            source: "cursor_state_vscdb",
            sourcePath,
            dbIdentity: session.dbIdentity,
            cursorConversationId: session.cursorConversationId,
        },
        labels: {
            source: "cursor",
            dbIdentity: session.dbIdentity,
            cursorConversationId: session.cursorConversationId,
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
            provider: "cursor",
            providerSessionId: turn.session,
            providerEventId: turn.providerEventId,
            seq: turn.seq,
        },
    })),
    toolCalls: extract.toolCalls,
    // Cursor intentionally emits NO tool-file evidence today; do not add it here.
    toolFileEvidence: [],
    agentEventParentEdges: [],
    syntheticSkillInvocations: extract.invocations.map((invocation) => ({
        sessionId: invocation.session,
        seq: invocation.seq,
        ts: invocation.ts,
        skillName: invocation.skill,
        args: invocation.args,
        skillScope: "cursor-tool",
        skillContentHash: "cursor",
    })),
    toolCallSkillRelations: extract.skillRelations,
    planSnapshots: [],
    compactions: extract.compactions,
});

const buildCursorBatchStatements = (extract: CursorExtract, sourcePath: string): string[] =>
    buildNormalizedTranscriptStatements(toCursorNormalizedBatch(extract, sourcePath));

export const __testBuildCursorBatchStatements = buildCursorBatchStatements;

/**
 * Narrow a whole-store extract down to ONE session - the unit of isolation
 * for SQLite-backed providers (#261). The store is re-extracted on every run,
 * so a session skipped by the isolation seam is naturally retried next run.
 * `skipped`/`warnings` stay store-level and are NOT attributed to slices.
 */
const sliceCursorExtractForSession = (
    extract: CursorExtract,
    sessionId: string,
): CursorExtract => {
    const toolCalls = extract.toolCalls.filter((call) => call.sessionId === sessionId);
    // Skill relations carry no session field; correlate through the same
    // toolCallRecordKey their tool calls were keyed with at extraction time.
    const toolCallKeys = new Set(toolCalls.map((call) =>
        toolCallRecordKey({ sessionId, seq: call.seq, callId: call.callId ?? null })
    ));
    return {
        sessions: extract.sessions.filter((session) => session.id === sessionId),
        turns: extract.turns.filter((turn) => turn.session === sessionId),
        invocations: extract.invocations.filter((invocation) => invocation.session === sessionId),
        toolCalls,
        providerEvents: extract.providerEvents.filter((event) => event.providerSessionId === sessionId),
        skillRelations: extract.skillRelations.filter((relation) => toolCallKeys.has(relation.toolCallKey)),
        compactions: extract.compactions.filter((compaction) => compaction.sessionId === sessionId),
        skipped: 0,
        warnings: [],
    };
};

export const __testSliceCursorExtractForSession = sliceCursorExtractForSession;

const includeByMtime = (mtime: Option.Option<Date>, cutoffMs: number): boolean =>
    Option.match(mtime, {
        onNone: () => true,
        onSome: (date) => date.getTime() >= cutoffMs,
    });

export const __testIncludeCursorByMtime = includeByMtime;

// All fs ops below are discovery PROBES: the OLD code guarded every access with
// `existsSync`/`readdir`-in-try/catch and treated any miss/fault as "absent,
// skip". `orAbsent` reproduces that exactly (recovers ANY PlatformError to the
// fallback, clearing the E channel), so these readers never fail; R is just
// FileSystem (+ Path for the directory walk).
const includeDbByMtime = (
    dbPath: string,
    cutoffMs: number,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // OLD: existsSync guard → false when the db file is absent.
        const exists = yield* fs.exists(dbPath).pipe(orAbsent(false));
        if (!exists) return false;
        if (cutoffMs <= 0) return true;
        const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
        for (const path of paths) {
            // OLD: existsSync guard → skip absent sidecars; stat in try/catch → false.
            const sidecarExists = yield* fs.exists(path).pipe(orAbsent(false));
            if (!sidecarExists) continue;
            const included = yield* fs.stat(path).pipe(
                Effect.map((st) => includeByMtime(st.mtime, cutoffMs)),
                orAbsent(false),
            );
            if (included) return true;
        }
        return false;
    });

const findCursorStateDbs = (
    cursorUserDir: string,
    cutoffMs = 0,
): Effect.Effect<string[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dbPaths: string[] = [];
        const globalDb = path.join(cursorUserDir, "globalStorage", "state.vscdb");
        if (yield* includeDbByMtime(globalDb, cutoffMs)) dbPaths.push(globalDb);

        const workspaceStorage = path.join(cursorUserDir, "workspaceStorage");
        // OLD: readdir(withFileTypes) in try/catch → return dbPaths on error.
        const entries = yield* fs.readDirectory(workspaceStorage).pipe(orAbsent([] as string[]));
        for (const entry of entries) {
            const entryPath = path.join(workspaceStorage, entry);
            // OLD: entry.isDirectory() filter via readdir(withFileTypes) - a
            // `Dirent` check that does NOT follow symlinks. `classifyNoFollow`
            // restores that: a symlinked workspace dir classifies as
            // "SymbolicLink" (not "Directory") and is skipped, matching the old
            // Dirent partition. Unreadable / missing entries also skip.
            const kind = yield* classifyNoFollow(entryPath);
            if (kind !== "Directory") continue;
            const dbPath = path.join(entryPath, "state.vscdb");
            if (yield* includeDbByMtime(dbPath, cutoffMs)) dbPaths.push(dbPath);
        }
        return dbPaths;
    });

export const __testFindCursorStateDbs = findCursorStateDbs;

interface CursorIngestOpts {
    sinceDays: number | undefined;
}

export const ingestCursor = Effect.fn("cursor.ingest")(
    function* (opts: Partial<CursorIngestOpts> = {}) {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const dbPaths = yield* findCursorStateDbs(cfg.paths.cursorUserDir, cutoff);
        let sessionCount = 0;
        let turnCount = 0;
        let toolCallCount = 0;
        let skipped = 0;
        let warnings = 0;

        // One collector across all state DBs: a failure storm spanning stores
        // is just as systemic as one inside a single store.
        const failures = makeFileFailureCollector({ source: "cursor", unit: "session" });
        for (const dbPath of dbPaths) {
            const extract = yield* Effect.sync(() =>
                extractCursorStateDb(dbPath, { cursorUserDir: cfg.paths.cursorUserDir })
            ).pipe(Effect.withSpan("cursor.db", {
                // Last two segments (`<workspace-hash>/state.vscdb`) - the
                // basename alone is always "state.vscdb".
                attributes: { "file.name": dbPath.split("/").slice(-2).join("/") },
            }));
            skipped += extract.skipped;
            warnings += extract.warnings.length;
            if (extract.sessions.length === 0) continue;

            for (const session of extract.sessions) {
                const slice = sliceCursorExtractForSession(extract, session.id);
                // Per-session failure isolation (#261): one undecodable /
                // rejected session skips THIS session - the store is re-read
                // next run - instead of aborting the whole stage (see
                // file-isolation.ts).
                yield* failures.isolate(`${dbPath}#${session.id}`, Effect.gen(function* () {
                    yield* db.upsert(new RecordId("session", session.id), {
                        source: "cursor",
                        started_at: new Date(session.started_at),
                        ended_at: new Date(session.ended_at),
                        raw_file: session.sourcePath,
                    });
                    yield* executeStatements(buildCursorBatchStatements(slice, dbPath), { chunkSize: 500, label: "cursor" });
                    sessionCount += 1;
                    turnCount += slice.turns.length;
                    toolCallCount += slice.toolCalls.length;
                }));
            }
        }
        yield* failures.report;

        return {
            sessions: sessionCount,
            turns: turnCount,
            toolCalls: toolCallCount,
            skipped,
            warnings,
            failedFiles: failures.count(),
        } satisfies CursorStats;
    },
);

export class CursorStageStats extends BaseStageStats.extend<CursorStageStats>("CursorStageStats")({
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

export const cursorStage: StageDef<CursorStageStats, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> = {
    meta: StageMeta.make({ key: "cursor", deps: ["skills", "commands"], tags: ["ingest"] }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext) {
        const t0 = Date.now();
        const sinceDays = sinceDaysFromCtx(ctx);
        const result = yield* ingestCursor({ sinceDays });
        return CursorStageStats.make({
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
