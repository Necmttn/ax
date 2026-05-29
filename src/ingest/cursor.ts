import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { AxConfig } from "../lib/config.ts";
import { RecordId, SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { executeStatements } from "../lib/shared/statement-exec.ts";
import { recordRef, surrealDate, surrealString } from "../lib/shared/surql.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { agentEventRecordKey, buildAgentEventStatements, buildAgentProviderStatements, type AgentEventWrite } from "./provider-events.ts";
import { identityPart, turnRecordKey } from "./record-keys.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

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

export interface CursorExtract {
    sessions: CursorSession[];
    turns: CursorTurn[];
    providerEvents: AgentEventWrite[];
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
const CURSOR_HISTORY_KEYS = new Set(["composer.composerData"]);

export function isAllowedCursorHistoryKey(key: string): boolean {
    const lower = key.toLowerCase();
    if (
        lower.includes("auth") ||
        lower.includes("token") ||
        lower.includes("privacy")
    ) {
        return false;
    }
    return CURSOR_HISTORY_KEYS.has(key);
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

function emptyExtract(warnings: string[] = [], skipped = 0): CursorExtract {
    return {
        sessions: [],
        turns: [],
        providerEvents: [],
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
    providerEvents: AgentEventWrite[];
    warnings: string[];
}): void {
    const rawId = stringField(input.message, "id");
    const providerEventId = rawId && rawId.length > 0
        ? rawId
        : `${input.session.id}:${input.seq}`;
    const role = stringField(input.message, "role") ?? "unknown";
    const text = stringField(input.message, "text");
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
    const messageKind = cursorMessageKind(role);
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
        has_tool_use: false,
        has_error: false,
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
            hasToolUse: false,
            isError: false,
        },
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
    const providerEvents: AgentEventWrite[] = [];
    let skipped = 0;
    const conversations = Array.isArray(data.conversations) ? data.conversations : [];
    if (!Array.isArray(data.conversations)) {
        warnings.push(`${sourceKey}: missing conversations array`);
        return { sessions, turns, providerEvents, skipped: 1 };
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
                providerEvents,
                warnings,
            });
        }
        if (seq > 0) sessions.push(session);
    }

    return { sessions, turns, providerEvents, skipped };
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
        const providerEvents: AgentEventWrite[] = [];
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
                    providerEvents.push(...extracted.providerEvents);
                    skipped += extracted.skipped;
                }
            }
        }

        return { sessions, turns, providerEvents, skipped, warnings };
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

const buildCursorBatchStatements = (extract: CursorExtract, sourcePath: string): string[] => [
    ...buildAgentProviderStatements([
        {
            name: "cursor",
            displayName: "Cursor",
            capabilities: {
                sqlite: true,
                transcripts: true,
                providerGraph: true,
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
                toolCalls: 0,
                providerEvents: extract.providerEvents.filter((event) => event.providerSessionId === session.id).length,
            },
            startedAt: session.started_at,
            endedAt: session.ended_at,
        })),
        events: extract.providerEvents,
    }),
    ...buildTurnStatements(extract.turns),
];

async function includeDbByMtime(dbPath: string, cutoffMs: number): Promise<boolean> {
    if (!existsSync(dbPath)) return false;
    if (cutoffMs <= 0) return true;
    try {
        const st = await stat(dbPath);
        return st.mtimeMs >= cutoffMs;
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
        }

        return {
            sessions: sessionCount,
            turns: turnCount,
            toolCalls: 0,
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
