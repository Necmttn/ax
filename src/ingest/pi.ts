import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { AxConfig } from "../lib/config.ts";
import { RecordId, SurrealClient } from "../lib/db.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import type { DbError } from "../lib/errors.ts";
import { executeStatements } from "../lib/shared/statement-exec.ts";
import {
    recordRef,
    surrealDate,
    surrealString,
} from "../lib/shared/surql.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { agentEventRecordKey, buildAgentEventStatements, buildAgentProviderStatements, type AgentEventWrite } from "./provider-events.ts";
import { turnRecordKey } from "./record-keys.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const PiKey = Schema.Literal("pi");
export type PiKey = typeof PiKey.Type;

interface PiSession {
    id: string;
    version: number | null;
    cwd: string | null;
    started_at: string;
    ended_at: string;
    model: string | null;
}

interface PiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
}

interface PiTurn {
    session: string;
    providerEventId: string | null;
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

interface PiExtract {
    session: PiSession;
    sourcePath: string | null;
    turns: PiTurn[];
    providerEvents: AgentEventWrite[];
    usage: PiUsage;
    skipped: number;
    warnings: string[];
}

export interface PiStats {
    readonly files: number;
    readonly sessions: number;
    readonly events: number;
    readonly turns: number;
    readonly toolCalls: number;
    readonly skipped: number;
    readonly warnings: number;
}

const SAFE_FALLBACK_TS = "1970-01-01T00:00:00.000Z";

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" ? value : null;
}

function numberField(input: Record<string, unknown>, field: string): number | null {
    const value = input[field];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(input: Record<string, unknown>, field: string): boolean | null {
    const value = input[field];
    return typeof value === "boolean" ? value : null;
}

function parseJsonl(line: string): Record<string, unknown> | null {
    const decoded = decodeJsonOrNull(line);
    return isRecord(decoded) ? decoded : null;
}

function validIsoTimestamp(input: string | number): string | null {
    const date = new Date(input);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function numericUsageField(input: Record<string, unknown>, field: string): number {
    const value = input[field];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyUsage(): PiUsage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
    };
}

function usageFromMessage(message: Record<string, unknown>): PiUsage | null {
    if (!isRecord(message.usage)) return null;
    const usage = {
        input: numericUsageField(message.usage, "input"),
        output: numericUsageField(message.usage, "output"),
        cacheRead: numericUsageField(message.usage, "cacheRead"),
        cacheWrite: numericUsageField(message.usage, "cacheWrite"),
        totalTokens: numericUsageField(message.usage, "totalTokens"),
    };
    if (usage.totalTokens === 0) {
        usage.totalTokens = usage.input + usage.output;
    }
    return Object.values(usage).some((value) => value > 0) ? usage : null;
}

function addUsage(total: PiUsage, next: PiUsage): void {
    total.input += next.input;
    total.output += next.output;
    total.cacheRead += next.cacheRead;
    total.cacheWrite += next.cacheWrite;
    total.totalTokens += next.totalTokens;
}

export function textFromPiContent(content: unknown): string | null {
    if (typeof content === "string") return content.length > 0 ? content : null;
    if (!Array.isArray(content)) return null;

    const text = content
        .filter(isRecord)
        .filter((block) => {
            const type = stringField(block, "type");
            return type === "text" || type === "input_text" || type === "output_text";
        })
        .map((block) => stringField(block, "text"))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n");

    return text.length > 0 ? text : null;
}

function hasPiToolUse(content: unknown): boolean {
    return Array.isArray(content) &&
        content.some((block) => isRecord(block) && stringField(block, "type") === "toolCall");
}

function piMessageKind(role: string, textExcerpt: string | null): string {
    if (role === "system" || role === "developer") return "system_or_developer";
    if (role === "toolResult" || role === "tool_result") return "tool_result";
    if (role === "assistant") return "assistant";
    if (role === "user") {
        if (textExcerpt?.startsWith("<command-name>")) return "control";
        if (textExcerpt && (
            textExcerpt.startsWith("# AGENTS.md instructions") ||
            textExcerpt.startsWith("# CLAUDE.md") ||
            textExcerpt.includes("<environment_context>") ||
            textExcerpt.includes("<INSTRUCTIONS>")
        )) {
            return "context";
        }
        return "task";
    }
    return role;
}

function piTurnRole(role: string): string {
    return role === "toolResult" ? "tool_result" : role;
}

function sourceTimestamp(
    entry: Record<string, unknown>,
    fallback: string,
): { ts: string; warning: string | null } {
    const timestamp = stringField(entry, "timestamp");
    if (timestamp !== null) {
        const iso = validIsoTimestamp(timestamp);
        if (iso) return { ts: iso, warning: null };
        return {
            ts: fallback,
            warning: `invalid entry timestamp for ${stringField(entry, "id") ?? "unknown"}: ${timestamp}`,
        };
    }
    if (isRecord(entry.message)) {
        const messageTimestamp = numberField(entry.message, "timestamp");
        if (messageTimestamp !== null) {
            const iso = validIsoTimestamp(messageTimestamp);
            if (iso) return { ts: iso, warning: null };
            return {
                ts: fallback,
                warning: `invalid message timestamp for ${stringField(entry, "id") ?? "unknown"}: ${messageTimestamp}`,
            };
        }
    }
    return { ts: fallback, warning: null };
}

function createPiExtractor(filePath: string) {
    let session: PiSession | null = null;
    let seq = 0;
    let skipped = 0;
    const warnings: string[] = [];
    const turns: PiTurn[] = [];
    const providerEvents: AgentEventWrite[] = [];
    const usage = emptyUsage();

    const pushProviderEvent = (
        event: Omit<AgentEventWrite, "provider" | "providerSessionId" | "axSessionId">,
        currentSession: PiSession,
    ): void => {
        providerEvents.push({
            provider: "pi",
            providerSessionId: currentSession.id,
            axSessionId: currentSession.id,
            ...event,
        });
    };

    return {
        processLine(line: string): void {
            if (!line.trim()) return;
            const entry = parseJsonl(line);
            if (!entry) {
                skipped += 1;
                return;
            }

            const type = stringField(entry, "type") ?? "unknown";
            if (type === "session") {
                if (session) return;
                const timestamp = stringField(entry, "timestamp");
                const startedAt = timestamp ? validIsoTimestamp(timestamp) : null;
                if (!startedAt) {
                    warnings.push(
                        `invalid session timestamp for ${stringField(entry, "id") ?? filePath}: ${timestamp ?? "(missing)"}`,
                    );
                }
                session = {
                    id: stringField(entry, "id") ?? filePath,
                    version: numberField(entry, "version"),
                    cwd: stringField(entry, "cwd"),
                    started_at: startedAt ?? SAFE_FALLBACK_TS,
                    ended_at: startedAt ?? SAFE_FALLBACK_TS,
                    model: null,
                };
                return;
            }

            if (!session) {
                skipped += 1;
                return;
            }

            seq += 1;
            const timestamp = sourceTimestamp(entry, session.ended_at);
            if (timestamp.warning) warnings.push(timestamp.warning);
            const ts = timestamp.ts;
            session.ended_at = ts;
            const providerEventId = stringField(entry, "id");
            const parentProviderEventId = stringField(entry, "parentId");
            const message = isRecord(entry.message) ? entry.message : null;
            const role = message ? stringField(message, "role") : null;
            const text = message ? textFromPiContent(message.content) : null;
            const textExcerpt = text === null ? null : text.slice(0, 500);
            const messageKind = role ? piMessageKind(role, textExcerpt) : null;
            const intentKind = role
                ? classifyTurnIntent({
                    role: piTurnRole(role),
                    messageKind,
                    source: "pi",
                    text,
                })
                : null;
            const entryUsage = role === "assistant" && message ? usageFromMessage(message) : null;
            if (entryUsage) addUsage(usage, entryUsage);

            if (type === "model_change") {
                session.model = stringField(entry, "modelId") ?? session.model;
            } else if (role === "assistant" && message) {
                session.model = stringField(message, "model") ?? session.model;
            }

            if (message && role) {
                turns.push({
                    session: session.id,
                    providerEventId,
                    seq,
                    ts,
                    role: piTurnRole(role),
                    message_kind: messageKind ?? "message",
                    intent_kind: intentKind ?? classifyTurnIntent({
                        role: piTurnRole(role),
                        messageKind,
                        source: "pi",
                        text,
                    }),
                    text,
                    text_excerpt: textExcerpt,
                    has_tool_use: hasPiToolUse(message.content),
                    has_error: booleanField(message, "isError") ?? false,
                });
            }

            pushProviderEvent({
                providerEventId,
                parentProviderEventId,
                parentKind: "parent",
                seq,
                ts,
                type,
                role,
                text,
                textExcerpt,
                raw: entry,
                labels: {
                    source: "pi_jsonl",
                    messageKind,
                    intentKind,
                    customType: stringField(entry, "customType"),
                    provider: stringField(entry, "provider") ?? (message ? stringField(message, "provider") : null),
                    model: stringField(entry, "modelId") ?? (message ? stringField(message, "model") : null),
                    toolName: message ? stringField(message, "toolName") : null,
                },
                metrics: {
                    turnSeq: message && role ? seq : null,
                    contentBlocks: Array.isArray(message?.content) ? message.content.length : 0,
                    hasToolUse: message ? hasPiToolUse(message.content) : false,
                    isError: message ? booleanField(message, "isError") : null,
                    usage: entryUsage,
                },
            }, session);
        },
        finish(): PiExtract | null {
            if (!session) {
                warnings.push(`no session header in ${filePath}`);
                return null;
            }
            return {
                session,
                sourcePath: filePath,
                turns,
                providerEvents,
                usage,
                skipped,
                warnings,
            };
        },
    };
}

export function __testExtractPiJsonlLines(lines: Iterable<string>): PiExtract | null {
    const extractor = createPiExtractor("pi-test.jsonl");
    for (const line of lines) {
        extractor.processLine(line);
    }
    return extractor.finish();
}

interface PiFileCandidate {
    path: string;
}

async function walkJsonlFiles(root: string, cutoffMs: number): Promise<PiFileCandidate[]> {
    const out: PiFileCandidate[] = [];
    async function visit(dir: string) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await visit(full);
            } else if (entry.isFile() && full.endsWith(".jsonl")) {
                let st;
                try {
                    st = await stat(full);
                } catch {
                    continue;
                }
                if (cutoffMs > 0 && st.mtimeMs < cutoffMs) continue;
                out.push({ path: full });
            }
        }
    }
    await visit(root);
    return out;
}

const buildTurnStatements = (turns: readonly PiTurn[]): string[] =>
    turns.map((turn) => {
        const eventKey = agentEventRecordKey({
            provider: "pi",
            providerSessionId: turn.session,
            providerEventId: turn.providerEventId,
            seq: turn.seq,
        });
        return `UPSERT turn:\`${turnRecordKey(turn.session, turn.seq)}\` CONTENT { session: ${recordRef("session", turn.session)}, agent_event: ${recordRef("agent_event", eventKey)}, seq: ${turn.seq}, ts: ${surrealDate(turn.ts)}, role: ${surrealString(turn.role)}, message_kind: ${surrealString(turn.message_kind)}, intent_kind: ${surrealString(turn.intent_kind)}, text: ${turn.text === null ? "NONE" : surrealString(turn.text)}, text_excerpt: ${turn.text_excerpt === null ? "NONE" : surrealString(turn.text_excerpt)}, has_tool_use: ${turn.has_tool_use}, has_error: ${turn.has_error} };`;
    });

const buildPiBatchStatements = (extract: PiExtract): string[] => [
    ...buildAgentProviderStatements([
        {
            name: "pi",
            displayName: "Pi",
            version: extract.session.version === null ? null : String(extract.session.version),
            capabilities: {
                transcripts: true,
                providerGraph: true,
            },
        },
    ]),
    ...buildAgentEventStatements({
        sessions: [
            {
                provider: "pi",
                providerSessionId: extract.session.id,
                axSessionId: extract.session.id,
                cwd: extract.session.cwd,
                project: extract.session.cwd,
                model: extract.session.model,
                sourcePath: extract.sourcePath,
                raw: {
                    source: "pi_jsonl",
                    sourcePath: extract.sourcePath,
                    version: extract.session.version,
                },
                labels: {
                    source: "pi",
                },
                metrics: {
                    turns: extract.turns.length,
                    toolCalls: 0,
                    providerEvents: extract.providerEvents.length,
                    usage: extract.usage,
                },
                startedAt: extract.session.started_at,
                endedAt: extract.session.ended_at,
            },
        ],
        events: extract.providerEvents,
    }),
    ...buildTurnStatements(extract.turns),
];

export const __testBuildPiBatchStatements = buildPiBatchStatements;

interface PiIngestOpts {
    sinceDays: number | undefined;
}

export const ingestPi = (
    opts: Partial<PiIngestOpts> = {},
): Effect.Effect<PiStats, DbError, SurrealClient | AxConfig> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const files = yield* Effect.promise(() => walkJsonlFiles(cfg.paths.piDir, cutoff));
        let fileCount = 0;
        let sessionCount = 0;
        let eventCount = 0;
        let turnCount = 0;
        let skipped = 0;
        let warningCount = 0;

        for (const file of files) {
            fileCount += 1;
            const text = yield* Effect.promise(() => Bun.file(file.path).text());
            const extractor = createPiExtractor(file.path);
            for (const line of text.split(/\r?\n/)) {
                extractor.processLine(line);
            }
            const extracted = extractor.finish();
            if (!extracted) {
                skipped += 1;
                warningCount += 1;
                continue;
            }

            skipped += extracted.skipped;
            warningCount += extracted.warnings.length;
            yield* db.upsert(new RecordId("session", extracted.session.id), {
                project: extracted.session.cwd ?? undefined,
                cwd: extracted.session.cwd ?? undefined,
                model: extracted.session.model ?? undefined,
                source: "pi",
                started_at: new Date(extracted.session.started_at),
                ended_at: new Date(extracted.session.ended_at),
                raw_file: extracted.sourcePath ?? undefined,
            });
            yield* executeStatements(buildPiBatchStatements(extracted), { chunkSize: 500 });
            sessionCount += 1;
            eventCount += extracted.providerEvents.length;
            turnCount += extracted.turns.length;
        }

        return {
            files: fileCount,
            sessions: sessionCount,
            events: eventCount,
            turns: turnCount,
            toolCalls: 0,
            skipped,
            warnings: warningCount,
        };
    });

export class PiStageStats extends BaseStageStats.extend<PiStageStats>("PiStageStats")({
    filesIngested: Schema.Number,
    sessionsIngested: Schema.Number,
    eventsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
    skipped: Schema.Number,
    warnings: Schema.Number,
}) {}

export const piStage: StageDef<PiStageStats, SurrealClient | AxConfig> = {
    meta: StageMeta.make({ key: "pi", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* ingestPi({ sinceDays });
            return PiStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.files} files, ${result.sessions} sessions, ${result.events} events, ${result.turns} turns, ${result.toolCalls} tool calls, skipped ${result.skipped}, warnings ${result.warnings}`,
                filesIngested: result.files,
                sessionsIngested: result.sessions,
                eventsIngested: result.events,
                turnsIngested: result.turns,
                toolCallsIngested: result.toolCalls,
                skipped: result.skipped,
                warnings: result.warnings,
            });
        }),
};
