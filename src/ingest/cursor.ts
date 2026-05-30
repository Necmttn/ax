import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { AxConfig } from "../lib/config.ts";
import { RecordId, SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { executeStatements } from "../lib/shared/statement-exec.ts";
import { recordRef, surrealDate, surrealString } from "../lib/shared/surql.ts";
import {
    buildRelateToolCallSkillStatements,
    buildToolCallStatements,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { providerDelegationSignalAvailability } from "./delegation.ts";
import { agentEventRecordKey, buildAgentEventStatements, buildAgentProviderStatements, type AgentEventWrite } from "./provider-events.ts";
import { providerPlanSignalAvailability } from "./plans.ts";
import { identityPart, invokedRelationRecordKey, toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { extractCommandTool, normalizeCommand, toolKindForName } from "./tool-calls.ts";

export const CursorKey = Schema.Literal("cursor");
export type CursorKey = typeof CursorKey.Type;

export interface CursorStats {
    readonly sessions: number;
    readonly turns: number;
    readonly toolCalls: number;
    readonly skipped: number;
    readonly warnings: number;
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
    skill: string;
    args: unknown;
}

export interface CursorExtract {
    sessions: CursorSession[];
    turns: CursorTurn[];
    invocations: CursorInvocation[];
    toolCalls: ToolCallWrite[];
    providerEvents: AgentEventWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
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

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" ? value : null;
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
        skipped,
        warnings,
    };
}

function cursorDbIdentity(dbPath: string, cursorUserDir?: string | null): string {
    if (cursorUserDir && cursorUserDir.length > 0) {
        const relativePath = relative(cursorUserDir, dbPath);
        if (
            relativePath.length > 0 &&
            relativePath !== ".." &&
            !relativePath.startsWith("../") &&
            !relativePath.startsWith("..\\") &&
            !isAbsolute(relativePath)
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

function parseJsonRecord(raw: string | null, label: string, warnings: string[]): Record<string, unknown> | null {
    if (raw === null || raw.trim().length === 0) {
        warnings.push(`${label}: missing JSON data`);
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (isRecord(parsed)) return parsed;
        warnings.push(`${label}: JSON data is not an object`);
        return null;
    } catch (error) {
        warnings.push(`${label}: invalid JSON data (${error instanceof Error ? error.message : String(error)})`);
        return null;
    }
}

function parseJsonValue(input: unknown): unknown {
    if (typeof input !== "string") return input;
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return input;
    }
}

function boundExcerpt(input: unknown, max = 1200): string | null {
    let text: string | null = null;
    if (typeof input === "string") {
        text = input;
    } else if (input !== null && input !== undefined) {
        try {
            text = JSON.stringify(input);
        } catch {
            text = String(input);
        }
    }
    if (text === null) return null;
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (normalized.length === 0) return null;
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
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
    turnKey: string;
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
        provider: "cursor",
        toolName,
        toolKind: toolKindForName(toolName),
        sessionId: input.session.id,
        seq: input.seq,
        turnKey: input.turnKey,
        agentEventKey: agentEventRecordKey({
            provider: "cursor",
            providerSessionId: input.session.id,
            providerEventId: callId,
            seq: eventSeq,
        }),
        callId,
        ts: input.ts,
        inputJson,
        outputJson,
        rawJson: {
            source: "cursor_state_vscdb",
            sourceKey: input.sourceKey,
            tool: rawToolPayload(input.raw),
        },
        outputExcerpt: boundExcerpt(outputJson),
        errorText,
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

    const skillName = `cursor:${toolName}`;
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

    const turnKey = turnRecordKey(input.session.id, input.seq);
    activities.forEach((activity, index) => {
        pushCursorToolCall({
            session: input.session,
            raw: activity,
            seq: input.seq,
            ordinal: index + 1,
            ts,
            sourceKey: input.sourceKey,
            turnKey,
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
    let skipped = 0;
    const conversations = Array.isArray(data.conversations) ? data.conversations : [];
    if (!Array.isArray(data.conversations)) {
        warnings.push(`${sourceKey}: missing conversations array`);
        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, skipped: 1 };
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

    return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, skipped };
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
    let skipped = 0;
    const composerId = stringField(data, "composerId") ?? sourceKey.slice(CURSOR_COMPOSER_DATA_PREFIX.length);
    if (composerId.length === 0) {
        warnings.push(`${sourceKey}: missing composerId`);
        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, skipped: 1 };
    }
    const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
    if (!Array.isArray(data.fullConversationHeadersOnly)) {
        warnings.push(`${sourceKey}: missing fullConversationHeadersOnly array`);
        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, skipped: 1 };
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

    return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, skipped };
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
                    skipped += extracted.skipped;
                } else if (row.key.startsWith(CURSOR_COMPOSER_DATA_PREFIX)) {
                    const extracted = extractComposerDiskKvData(payload, row.key, dbPath, dbIdentity, db, table, warnings);
                    sessions.push(...extracted.sessions);
                    turns.push(...extracted.turns);
                    invocations.push(...extracted.invocations);
                    toolCalls.push(...extracted.toolCalls);
                    providerEvents.push(...extracted.providerEvents);
                    skillRelations.push(...extracted.skillRelations);
                    skipped += extracted.skipped;
                }
            }
        }

        return { sessions, turns, invocations, toolCalls, providerEvents, skillRelations, skipped, warnings };
    } catch (error) {
        return emptyExtract(
            [`failed to extract Cursor state database ${dbPath}: ${error instanceof Error ? error.message : String(error)}`],
            1,
        );
    } finally {
        db.close();
    }
}

const buildTurnStatements = (turns: readonly CursorTurn[]): string[] =>
    turns.map((turn) => {
        const eventKey = agentEventRecordKey({
            provider: "cursor",
            providerSessionId: turn.session,
            providerEventId: turn.providerEventId,
            seq: turn.seq,
        });
        return `UPSERT turn:\`${turnRecordKey(turn.session, turn.seq)}\` CONTENT { session: ${recordRef("session", turn.session)}, agent_event: ${recordRef("agent_event", eventKey)}, seq: ${turn.seq}, ts: ${surrealDate(turn.ts)}, role: ${surrealString(turn.role)}, message_kind: ${surrealString(turn.message_kind)}, intent_kind: ${surrealString(turn.intent_kind)}, text: ${turn.text === null ? "NONE" : surrealString(turn.text)}, text_excerpt: ${turn.text_excerpt === null ? "NONE" : surrealString(turn.text_excerpt)}, has_tool_use: ${turn.has_tool_use}, has_error: ${turn.has_error} };`;
    });

const buildSyntheticSkillAndInvocationStatements = (
    invocations: readonly CursorInvocation[],
): string[] => {
    if (invocations.length === 0) return [];
    const tools = new Set(invocations.map((invocation) => invocation.skill));
    const skillStatements = [...tools].map((name) =>
        `UPSERT skill:\`${skillRecordKey(name)}\` MERGE { name: ${surrealString(name)}, scope: "cursor-tool", dir_path: "(synthetic)", content_hash: "cursor" };`
    );
    const invocationStatements = invocations.map((invocation) => {
        const turnKey = turnRecordKey(invocation.session, invocation.seq);
        const skillKey = skillRecordKey(invocation.skill);
        const args = JSON.stringify(invocation.args ?? {});
        const edgeKey = invokedRelationRecordKey({ turnKey, skillKey, args });
        return `RELATE turn:\`${turnKey}\`->invoked:\`${edgeKey}\`->skill:\`${skillKey}\` SET ts = ${surrealDate(invocation.ts)}, args = ${surrealString(args)}, turn_has_error = false, turn_index = ${invocation.seq};`;
    });
    return [...skillStatements, ...invocationStatements];
};

const buildCursorBatchStatements = (extract: CursorExtract, sourcePath: string): string[] => [
    ...buildAgentProviderStatements([
        {
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
        },
    ]),
    ...buildAgentEventStatements({
        sessions: extract.sessions.map((session) => ({
            provider: "cursor",
            providerSessionId: session.id,
            axSessionId: session.id,
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
    }),
    ...buildTurnStatements(extract.turns),
    ...buildToolCallStatements(extract.toolCalls),
    ...buildSyntheticSkillAndInvocationStatements(extract.invocations),
    ...extract.skillRelations.flatMap((relation) =>
        buildRelateToolCallSkillStatements(relation),
    ),
];

export const __testBuildCursorBatchStatements = buildCursorBatchStatements;

async function includeDbByMtime(dbPath: string, cutoffMs: number): Promise<boolean> {
    if (!existsSync(dbPath)) return false;
    if (cutoffMs <= 0) return true;
    try {
        const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
        for (const path of paths) {
            if (!existsSync(path)) continue;
            const st = await stat(path);
            if (st.mtimeMs >= cutoffMs) return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function findCursorStateDbs(cursorUserDir: string, cutoffMs = 0): Promise<string[]> {
    const dbPaths: string[] = [];
    const globalDb = join(cursorUserDir, "globalStorage", "state.vscdb");
    if (await includeDbByMtime(globalDb, cutoffMs)) dbPaths.push(globalDb);

    const workspaceStorage = join(cursorUserDir, "workspaceStorage");
    let entries;
    try {
        entries = await readdir(workspaceStorage, { withFileTypes: true });
    } catch {
        return dbPaths;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dbPath = join(workspaceStorage, entry.name, "state.vscdb");
        if (await includeDbByMtime(dbPath, cutoffMs)) dbPaths.push(dbPath);
    }
    return dbPaths;
}

export const __testFindCursorStateDbs = findCursorStateDbs;

interface CursorIngestOpts {
    sinceDays: number | undefined;
}

export const ingestCursor = (
    opts: Partial<CursorIngestOpts> = {},
): Effect.Effect<CursorStats, DbError, SurrealClient | AxConfig> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const dbPaths = yield* Effect.promise(() => findCursorStateDbs(cfg.paths.cursorUserDir, cutoff));
        let sessionCount = 0;
        let turnCount = 0;
        let toolCallCount = 0;
        let skipped = 0;
        let warnings = 0;

        for (const dbPath of dbPaths) {
            const extract = yield* Effect.sync(() =>
                extractCursorStateDb(dbPath, { cursorUserDir: cfg.paths.cursorUserDir })
            );
            skipped += extract.skipped;
            warnings += extract.warnings.length;
            if (extract.sessions.length === 0) continue;

            for (const session of extract.sessions) {
                yield* db.upsert(new RecordId("session", session.id), {
                    source: "cursor",
                    started_at: new Date(session.started_at),
                    ended_at: new Date(session.ended_at),
                    raw_file: session.sourcePath,
                });
            }
            yield* executeStatements(buildCursorBatchStatements(extract, dbPath), { chunkSize: 500 });
            sessionCount += extract.sessions.length;
            turnCount += extract.turns.length;
            toolCallCount += extract.toolCalls.length;
        }

        return {
            sessions: sessionCount,
            turns: turnCount,
            toolCalls: toolCallCount,
            skipped,
            warnings,
        };
    });

export class CursorStageStats extends BaseStageStats.extend<CursorStageStats>("CursorStageStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
    skipped: Schema.Number,
    warnings: Schema.Number,
}) {}

export const cursorStage: StageDef<CursorStageStats, SurrealClient | AxConfig> = {
    meta: StageMeta.make({ key: "cursor", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* ingestCursor({ sinceDays });
            return CursorStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls, skipped ${result.skipped}, warnings ${result.warnings}`,
                sessionsIngested: result.sessions,
                turnsIngested: result.turns,
                toolCallsIngested: result.toolCalls,
                skipped: result.skipped,
                warnings: result.warnings,
            });
        }),
};
