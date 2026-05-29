import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { AxConfig } from "../lib/config.ts";
import { RecordId, SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { executeStatements } from "../lib/shared/statement-exec.ts";
import { recordRef, surrealDate, surrealString } from "../lib/shared/surql.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { agentEventRecordKey, buildAgentEventStatements, buildAgentProviderStatements, type AgentEventWrite } from "./provider-events.ts";
import { turnRecordKey } from "./record-keys.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const OpenCodeKey = Schema.Literal("opencode");
export type OpenCodeKey = typeof OpenCodeKey.Type;

interface OpenCodeSession {
    id: string;
    cwd: string | null;
    title: string | null;
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
    skipped: number;
    warnings: string[];
}

export interface OpenCodeStats {
    readonly sessions: number;
    readonly turns: number;
    readonly toolCalls: number;
    readonly skipped: number;
    readonly warnings: number;
}

const SAFE_FALLBACK_TS = "1970-01-01T00:00:00.000Z";

type SQLiteValue = string | number | bigint | boolean | null;

interface SQLiteRow {
    readonly [key: string]: SQLiteValue | undefined;
}

interface OpenCodeSessionRow extends SQLiteRow {
    readonly id: string;
    readonly cwd: string | null;
    readonly title: string | null;
    readonly created_at: string | null;
    readonly updated_at: string | null;
}

interface OpenCodeMessageRow extends SQLiteRow {
    readonly id: string;
    readonly session_id: string;
    readonly role: string | null;
    readonly content: string | null;
    readonly created_at: string | null;
}

function validIsoTimestamp(input: string | null, fallback: string): { ts: string; warning: string | null } {
    if (input === null || input.trim() === "") {
        return { ts: fallback, warning: "missing timestamp" };
    }
    const date = new Date(input);
    if (!Number.isFinite(date.getTime())) {
        return { ts: fallback, warning: `invalid timestamp: ${input}` };
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

export function extractOpenCodeDatabase(dbPath: string): OpenCodeExtract {
    const db = new Database(dbPath, { readonly: true });
    try {
        const tables = tableNames(db);
        if (!tables.has("session") || !tables.has("message")) {
            return emptyExtract();
        }

        const sessionRows = db.query<OpenCodeSessionRow, []>(
            "SELECT id, cwd, title, created_at, updated_at FROM session ORDER BY created_at, id",
        ).all();
        const messageRows = db.query<OpenCodeMessageRow, []>(
            "SELECT id, session_id, role, content, created_at FROM message ORDER BY created_at, id",
        ).all();
        const sessions = new Map<string, OpenCodeSession>();
        const warnings: string[] = [];
        let skipped = 0;

        for (const row of sessionRows) {
            if (typeof row.id !== "string" || row.id.length === 0) {
                skipped += 1;
                warnings.push("skipped session row with missing id");
                continue;
            }
            const started = validIsoTimestamp(row.created_at, SAFE_FALLBACK_TS);
            const ended = validIsoTimestamp(row.updated_at, started.ts);
            if (started.warning) warnings.push(`session ${row.id}: ${started.warning}`);
            if (ended.warning) warnings.push(`session ${row.id}: ${ended.warning}`);
            sessions.set(row.id, {
                id: row.id,
                cwd: typeof row.cwd === "string" ? row.cwd : null,
                title: typeof row.title === "string" ? row.title : null,
                started_at: started.ts,
                ended_at: ended.ts,
            });
        }

        const turns: OpenCodeTurn[] = [];
        const providerEvents: AgentEventWrite[] = [];
        const seqBySession = new Map<string, number>();

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

            const seq = (seqBySession.get(row.session_id) ?? 0) + 1;
            seqBySession.set(row.session_id, seq);
            const timestamp = validIsoTimestamp(row.created_at, session.ended_at);
            if (timestamp.warning) warnings.push(`message ${row.id}: ${timestamp.warning}`);
            if (new Date(timestamp.ts).getTime() > new Date(session.ended_at).getTime()) {
                session.ended_at = timestamp.ts;
            }
            const role = typeof row.role === "string" && row.role.length > 0 ? row.role : "unknown";
            const text = typeof row.content === "string" ? row.content : null;
            const textExcerpt = text === null ? null : text.slice(0, 500);
            const kind = messageKind(role);
            const intentKind = classifyTurnIntent({
                role,
                messageKind: kind,
                source: "opencode",
                text,
            });

            turns.push({
                session: row.session_id,
                providerEventId: row.id,
                seq,
                ts: timestamp.ts,
                role,
                message_kind: kind,
                intent_kind: intentKind,
                text,
                text_excerpt: textExcerpt,
                has_tool_use: false,
                has_error: false,
            });
            providerEvents.push({
                provider: "opencode",
                providerSessionId: row.session_id,
                axSessionId: row.session_id,
                providerEventId: row.id,
                seq,
                ts: timestamp.ts,
                type: "message",
                role,
                text,
                textExcerpt,
                raw: {
                    id: row.id,
                    sessionId: row.session_id,
                    role: row.role,
                    createdAt: row.created_at,
                },
                labels: {
                    source: "opencode_sqlite",
                    sessionId: row.session_id,
                    messageKind: kind,
                    intentKind,
                },
                metrics: {
                    turnSeq: seq,
                    hasToolUse: false,
                    isError: false,
                },
            });
        }

        return {
            sessions: [...sessions.values()],
            turns,
            providerEvents,
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

const buildTurnStatements = (turns: readonly OpenCodeTurn[]): string[] =>
    turns.map((turn) => {
        const eventKey = agentEventRecordKey({
            provider: "opencode",
            providerSessionId: turn.session,
            providerEventId: turn.providerEventId,
            seq: turn.seq,
        });
        return `UPSERT turn:\`${turnRecordKey(turn.session, turn.seq)}\` CONTENT { session: ${recordRef("session", turn.session)}, agent_event: ${recordRef("agent_event", eventKey)}, seq: ${turn.seq}, ts: ${surrealDate(turn.ts)}, role: ${surrealString(turn.role)}, message_kind: ${surrealString(turn.message_kind)}, intent_kind: ${surrealString(turn.intent_kind)}, text: ${turn.text === null ? "NONE" : surrealString(turn.text)}, text_excerpt: ${turn.text_excerpt === null ? "NONE" : surrealString(turn.text_excerpt)}, has_tool_use: ${turn.has_tool_use}, has_error: ${turn.has_error} };`;
    });

const buildOpenCodeBatchStatements = (
    extract: OpenCodeExtract,
    sourcePath: string,
): string[] => [
    ...buildAgentProviderStatements([
        {
            name: "opencode",
            displayName: "OpenCode",
            capabilities: {
                sqlite: true,
                transcripts: true,
                providerGraph: true,
            },
        },
    ]),
    ...buildAgentEventStatements({
        sessions: extract.sessions.map((session) => ({
            provider: "opencode",
            providerSessionId: session.id,
            axSessionId: session.id,
            cwd: session.cwd,
            project: session.cwd,
            title: session.title,
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

export const __testBuildOpenCodeBatchStatements = buildOpenCodeBatchStatements;

function failedExtract(dbPath: string, error: unknown): OpenCodeExtract {
    return emptyExtract(
        [`failed to read OpenCode database ${dbPath}: ${error instanceof Error ? error.message : String(error)}`],
        1,
    );
}

export const ingestOpenCode = (): Effect.Effect<OpenCodeStats, DbError, SurrealClient | AxConfig> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const dbPath = join(cfg.paths.opencodeDir, "opencode.db");

        if (!existsSync(dbPath)) {
            return {
                sessions: 0,
                turns: 0,
                toolCalls: 0,
                skipped: 0,
                warnings: 0,
            };
        }

        const extract = yield* Effect.sync(() => {
            try {
                return extractOpenCodeDatabase(dbPath);
            } catch (error) {
                return failedExtract(dbPath, error);
            }
        });

        if (extract.sessions.length === 0) {
            return {
                sessions: 0,
                turns: 0,
                toolCalls: 0,
                skipped: extract.skipped,
                warnings: extract.warnings.length,
            };
        }

        for (const session of extract.sessions) {
            yield* db.upsert(new RecordId("session", session.id), {
                project: session.cwd ?? undefined,
                cwd: session.cwd ?? undefined,
                source: "opencode",
                started_at: new Date(session.started_at),
                ended_at: new Date(session.ended_at),
                raw_file: dbPath,
            });
        }
        yield* executeStatements(buildOpenCodeBatchStatements(extract, dbPath), { chunkSize: 500 });

        return {
            sessions: extract.sessions.length,
            turns: extract.turns.length,
            toolCalls: 0,
            skipped: extract.skipped,
            warnings: extract.warnings.length,
        };
    });

export class OpenCodeStageStats extends BaseStageStats.extend<OpenCodeStageStats>("OpenCodeStageStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
    skipped: Schema.Number,
    warnings: Schema.Number,
}) {}

export const opencodeStage: StageDef<OpenCodeStageStats, SurrealClient | AxConfig> = {
    meta: StageMeta.make({ key: "opencode", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestOpenCode();
            return OpenCodeStageStats.make({
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
