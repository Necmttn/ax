import { Effect, FileSystem, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SkillName } from "@ax/lib/brands";
import { RecordId, SurrealClient } from "@ax/lib/db";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import { surrealJsonTextOption } from "@ax/lib/shared/surql";
import {
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import { extractPiCompaction, type CompactionWrite } from "./compaction.ts";
import { buildNormalizedTranscriptStatements, type NormalizedTranscriptBatch } from "./normalized/transcripts.ts";
import { classifyTurnIntent } from "./intent-kind.ts";
import { providerDelegationSignalAvailability } from "./delegation.ts";
import { agentEventRecordKey, type AgentEventWrite } from "./provider-events.ts";
import { providerPlanSignalAvailability } from "./plans.ts";
import { toolCallRecordKey } from "./record-keys.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import {
    booleanField,
    boundedExcerpt,
    isRecord,
    numberField,
    parseJsonl,
    parseMaybeJson,
    RESPONSES_TEXT_TYPES,
    stringField,
    textFromContent,
} from "./normalized/toolkit.ts";
import { classifyUserText, PI_CONTEXT_RULES } from "./normalized/message-kind.ts";
import {
    applyCommandFields,
    makeToolCallWrite,
    type MutableToolCallWrite,
} from "./normalized/tool-call-write.ts";
import { buildSessionTokenUsageStatement } from "./token-usage-writers.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";
import { runJsonlProviderFiles } from "./jsonl-work-unit.ts";
import { decodePiTranscriptLine } from "./line-schemas.ts";
import { tokenQualityLabels } from "./token-quality.ts";
import { walkJsonlFilesLenient } from "./walk-jsonl.ts";

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
    providerEventSeq: number;
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

interface PiInvocation {
    session: string;
    seq: number;
    ts: string;
    skill: SkillName;
    args: unknown;
}

interface PiExtract {
    session: PiSession;
    sourcePath: string | null;
    turns: PiTurn[];
    invocations: PiInvocation[];
    toolCalls: ToolCallWrite[];
    providerEvents: AgentEventWrite[];
    compactions: CompactionWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
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
    /** Files whose pipeline failed and was skipped (retried next run). */
    readonly failedFiles: number;
}

const SAFE_FALLBACK_TS = "1970-01-01T00:00:00.000Z";
const SYNTHETIC_PROVIDER_SEQ_OFFSET = 1_000_000_000;

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

interface ToolResultFields {
    outputJson?: unknown;
    outputExcerpt?: string | null;
    errorText?: string | null;
    hasError: boolean;
}

function piToolCallId(block: Record<string, unknown>): string | null {
    return stringField(block, "id") ??
        stringField(block, "toolCallId") ??
        stringField(block, "callId");
}

function piToolName(input: Record<string, unknown>): string | null {
    return stringField(input, "name") ??
        stringField(input, "toolName") ??
        stringField(input, "tool");
}

function piToolInput(block: Record<string, unknown>): unknown {
    return parseMaybeJson(block.input ?? block.arguments ?? block.args ?? null);
}

function applyToolResult(call: MutableToolCallWrite, result: ToolResultFields): void {
    call.outputJson = result.outputJson ?? null;
    call.outputExcerpt = result.outputExcerpt ?? null;
    call.errorText = result.errorText ?? null;
    call.hasError = result.hasError;
}

export function textFromPiContent(content: unknown): string | null {
    return textFromContent(content, { acceptedTypes: RESPONSES_TEXT_TYPES, emptyStringIsNull: true });
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
        return classifyUserText(textExcerpt, PI_CONTEXT_RULES);
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
    const invocations: PiInvocation[] = [];
    const toolCalls: MutableToolCallWrite[] = [];
    const providerEvents: AgentEventWrite[] = [];
    const compactions: CompactionWrite[] = [];
    const skillRelations: ToolCallSkillRelationWrite[] = [];
    const toolCallsByCallId = new Map<string, MutableToolCallWrite>();
    const pendingToolResultsByCallId = new Map<string, ToolResultFields>();
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

    const processToolCallBlock = (
        block: Record<string, unknown>,
        ts: string,
        parentProviderEventId: string | null,
        currentSession: PiSession,
        blockOrdinal: number,
    ): void => {
        const toolName = piToolName(block);
        if (!toolName) return;
        const callId = piToolCallId(block) ?? `tool_call_${seq.toString(10).padStart(6, "0")}_${blockOrdinal}`;
        const eventSeq = SYNTHETIC_PROVIDER_SEQ_OFFSET + (seq * 1000) + blockOrdinal;
        const inputJson = piToolInput(block);
        const toolCallKey = toolCallRecordKey({
            sessionId: currentSession.id,
            seq,
            callId,
        });
        const call: MutableToolCallWrite = makeToolCallWrite({
            provider: "pi",
            toolName,
            sessionId: currentSession.id,
            seq,
            callId,
            eventSeq,
            ts,
            cwd: currentSession.cwd,
            inputJson,
            rawJson: block,
        });

        if (toolName === "exec_command") applyCommandFields(call, inputJson);

        pushProviderEvent({
            providerEventId: callId,
            parentProviderEventId,
            parentKind: "turn_item",
            seq: eventSeq,
            ts,
            type: "toolCall",
            role: "assistant",
            text: toolName,
            textExcerpt: toolName,
            raw: block,
            labels: {
                source: "pi_jsonl",
                toolName,
                toolKind: call.toolKind,
            },
            metrics: { turnSeq: seq },
        }, currentSession);

        toolCalls.push(call);
        toolCallsByCallId.set(callId, call);
        const pendingResult = pendingToolResultsByCallId.get(callId);
        if (pendingResult) {
            applyToolResult(call, pendingResult);
            pendingToolResultsByCallId.delete(callId);
        }

        // Synthetic provider-tool skill name - branded at the true source.
        const skillName = SkillName.make(`pi:${toolName}`);
        invocations.push({
            session: currentSession.id,
            seq,
            ts,
            skill: skillName,
            args: inputJson ?? {},
        });
        skillRelations.push({
            toolCallKey,
            skillName,
            ts,
            reason: "Pi tool call",
            labels: {
                provider: "pi",
                toolName,
                source: "pi_jsonl",
            },
            metrics: { turnSeq: seq },
        });
    };

    const processToolResultMessage = (
        message: Record<string, unknown>,
        text: string | null,
    ): void => {
        const callId = stringField(message, "toolCallId") ??
            stringField(message, "tool_call_id") ??
            stringField(message, "callId");
        if (!callId) return;
        const hasError = booleanField(message, "isError") ?? booleanField(message, "is_error") ?? false;
        const result: ToolResultFields = {
            outputJson: message.content ?? text,
            outputExcerpt: text ? boundedExcerpt(text) : null,
            errorText: hasError && text ? boundedExcerpt(text) : null,
            hasError,
        };
        const call = toolCallsByCallId.get(callId);
        if (call) {
            applyToolResult(call, result);
        } else {
            pendingToolResultsByCallId.set(callId, result);
        }
    };

    return {
        processLine(line: string): void {
            if (!line.trim()) return;
            const entry = parseJsonl(line);
            if (!entry) {
                skipped += 1;
                return;
            }
            // Typed, tolerant view of the line head (see line-schemas.ts).
            // The `message` payload stays a raw probe.
            const head = decodePiTranscriptLine(entry);
            if (!head) {
                skipped += 1;
                return;
            }

            const type = head.type ?? "unknown";
            if (type === "session") {
                if (session) return;
                const timestamp = head.timestamp ?? null;
                const startedAt = timestamp ? validIsoTimestamp(timestamp) : null;
                if (!startedAt) {
                    warnings.push(
                        `invalid session timestamp for ${head.id ?? filePath}: ${timestamp ?? "(missing)"}`,
                    );
                }
                session = {
                    id: head.id ?? filePath,
                    version: head.version ?? null,
                    cwd: head.cwd ?? null,
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
            const providerEventId = head.id ?? null;
            const parentProviderEventId = head.parentId ?? null;
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
                session.model = head.modelId ?? session.model;
            } else if (role === "assistant" && message) {
                session.model = stringField(message, "model") ?? session.model;
            }

            if (message && role) {
                turns.push({
                    session: session.id,
                    providerEventId,
                    providerEventSeq: seq,
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

            if (type === "compaction") {
                // The universal pushProviderEvent above already emitted the
                // `compaction` agent_event keyed on (provider, session, providerEventId,
                // seq). Reproduce that exact key here to link the compaction row; do
                // NOT push a second provider event.
                const eventKey = agentEventRecordKey({
                    provider: "pi",
                    providerSessionId: session.id,
                    providerEventId,
                    seq,
                });
                const write = extractPiCompaction(entry, {
                    sessionId: session.id,
                    providerSessionId: session.id,
                    seq,
                    ts: new Date(ts),
                    agentEventKey: eventKey,
                });
                if (write) compactions.push(write);
            }

            if (message && role === "assistant" && Array.isArray(message.content)) {
                let toolCallOrdinal = 0;
                for (const block of message.content) {
                    if (isRecord(block) && stringField(block, "type") === "toolCall") {
                        toolCallOrdinal += 1;
                        processToolCallBlock(block, ts, providerEventId, session, toolCallOrdinal);
                    }
                }
            } else if (message && (role === "toolResult" || role === "tool_result")) {
                processToolResultMessage(message, text);
            }
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
                invocations,
                toolCalls,
                providerEvents,
                compactions,
                skillRelations,
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

const buildPiTokenUsageStatements = (extract: PiExtract): string[] => {
    if (!Object.values(extract.usage).some((value) => value > 0)) return [];
    const estimatedTokens = extract.usage.totalTokens > 0
        ? extract.usage.totalTokens
        : extract.usage.input + extract.usage.output;
    return [
        buildSessionTokenUsageStatement({
            sessionId: extract.session.id,
            source: "pi",
            model: extract.session.model,
            promptTokens: extract.usage.input || null,
            completionTokens: extract.usage.output || null,
            cacheCreationInputTokens: extract.usage.cacheWrite || null,
            cacheReadInputTokens: extract.usage.cacheRead || null,
            estimatedTokens,
            contextWindow: null,
            labels: surrealJsonTextOption({
                ...tokenQualityLabels({
                    source: "pi_jsonl",
                    tokenSourceQuality: "explicit",
                    tokenSourceDetail: "pi_usage_fields",
                    model: extract.session.model,
                    modelSourceDetail: extract.session.model ? "pi_session.model" : "missing_pi_session_model",
                }),
            }),
            metrics: surrealJsonTextOption({ usage: extract.usage }),
            ts: extract.session.ended_at,
        }),
    ];
};

const toPiNormalizedBatch = (extract: PiExtract): NormalizedTranscriptBatch => ({
    providers: [{
        name: "pi",
        displayName: "Pi",
        version: extract.session.version === null ? null : String(extract.session.version),
        capabilities: {
            transcripts: true,
            providerGraph: true,
            planSignals: providerPlanSignalAvailability.pi,
            delegationSignals: providerDelegationSignalAvailability.pi,
        },
    }],
    sessions: [{
        id: extract.session.id,
        provider: "pi",
        providerSessionId: extract.session.id,
        cwd: extract.session.cwd,
        project: extract.session.cwd,
        model: extract.session.model,
        sourcePath: extract.sourcePath,
        raw: {
            source: "pi_jsonl",
            sourcePath: extract.sourcePath,
            version: extract.session.version,
        },
        labels: { source: "pi" },
        metrics: {
            turns: extract.turns.length,
            toolCalls: extract.toolCalls.length,
            providerEvents: extract.providerEvents.length,
            usage: extract.usage,
        },
        startedAt: extract.session.started_at,
        endedAt: extract.session.ended_at,
    }],
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
            provider: "pi",
            providerSessionId: turn.session,
            providerEventId: turn.providerEventId,
            seq: turn.providerEventSeq,
        },
    })),
    toolCalls: extract.toolCalls,
    toolFileEvidence: extractToolFileEvidence(extract.toolCalls),
    agentEventParentEdges: [],
    // turnHasError/turnIndex omitted: seam defaults preserve
    // `turn_has_error = false, turn_index = ${seq}`.
    syntheticSkillInvocations: extract.invocations.map((invocation) => ({
        sessionId: invocation.session,
        seq: invocation.seq,
        ts: invocation.ts,
        skillName: invocation.skill,
        args: invocation.args,
        skillScope: "pi-tool",
        skillContentHash: "pi",
    })),
    toolCallSkillRelations: extract.skillRelations,
    planSnapshots: [],
    compactions: extract.compactions,
});

const buildPiBatchStatements = (extract: PiExtract): string[] => [
    ...buildNormalizedTranscriptStatements(toPiNormalizedBatch(extract)),
    ...buildPiTokenUsageStatements(extract),
];

export const __testBuildPiBatchStatements = buildPiBatchStatements;

interface PiIngestOpts {
    sinceDays: number | undefined;
}

export const ingestPi = Effect.fn("pi.ingest")(
    function* (opts: Partial<PiIngestOpts> = {}) {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const fs = yield* FileSystem.FileSystem;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const files = yield* walkJsonlFilesLenient(cfg.paths.piDir, cutoff);
        let fileCount = 0;
        let sessionCount = 0;
        let eventCount = 0;
        let turnCount = 0;
        let toolCallCount = 0;
        let skipped = 0;
        let warningCount = 0;

        // Skip-unchanged watermark + per-file failure isolation (#261) live in
        // the shared JSONL work-unit; pi supplies discovery (above) and the
        // per-file parse/write below. A file whose (mtime,size) matches a prior
        // run is skipped without re-reading. `fileCount` (pi's own) counts
        // completed files, like claude/codex.
        const result = yield* runJsonlProviderFiles({
            candidates: files,
            sourceKind: "pi_session",
            forceEnv: "AX_REDERIVE_PI",
            source: "pi",
            processFile: (file) => Effect.gen(function* () {
                // OLD: `Bun.file(path).text()` under `Effect.promise` - a read
                // rejection became an unrecoverable defect. `readFileString`
                // surfaces a typed PlatformError that the isolation seam
                // records + skips like any other per-file failure.
                const text = yield* fs.readFileString(file.path);
                const extractor = createPiExtractor(file.path);
                for (const line of text.split(/\r?\n/)) {
                    extractor.processLine(line);
                }
                const extracted = extractor.finish();
                if (!extracted) {
                    fileCount += 1;
                    skipped += 1;
                    warningCount += 1;
                    // Empty/unparseable: not committed, so it re-warns next run -
                    // preserving the pre-watermark behavior (pi re-read every file).
                    return null;
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
                yield* executeStatements(buildPiBatchStatements(extracted), { chunkSize: 500, label: "pi" });
                fileCount += 1;
                sessionCount += 1;
                eventCount += extracted.providerEvents.length;
                turnCount += extracted.turns.length;
                toolCallCount += extracted.toolCalls.length;
                return extracted.session.id;
            }),
        });

        return {
            files: fileCount,
            sessions: sessionCount,
            events: eventCount,
            turns: turnCount,
            toolCalls: toolCallCount,
            skipped,
            warnings: warningCount,
            failedFiles: result.failures.count(),
        } satisfies PiStats;
    },
);

export class PiStageStats extends BaseStageStats.extend<PiStageStats>("PiStageStats")({
    filesIngested: Schema.Number,
    sessionsIngested: Schema.Number,
    eventsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
    skipped: Schema.Number,
    warnings: Schema.Number,
    /** Files whose pipeline failed and was skipped (retried next run). */
    failedFiles: Schema.Number,
}) {}

export const piStage: StageDef<PiStageStats, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> = {
    meta: StageMeta.make({ key: "pi", deps: ["skills", "commands"], tags: ["ingest"] }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext) {
        const t0 = Date.now();
        const sinceDays = sinceDaysFromCtx(ctx);
        // The directory walk recovers every PlatformError internally, and a
        // per-file `readFileString` fault is now recorded + skipped by the
        // per-file isolation seam (#261, see file-isolation.ts), so no
        // PlatformError escapes `ingestPi`. Only connection loss and failure
        // storms abort the stage, as a DbError.
        const result = yield* ingestPi({ sinceDays });
        return PiStageStats.make({
            durationMs: Date.now() - t0,
            summary: `ingested ${result.files} files, ${result.sessions} sessions, ${result.events} events, ${result.turns} turns, ${result.toolCalls} tool calls, skipped ${result.skipped}, warnings ${result.warnings}` +
                (result.failedFiles > 0 ? `, ${result.failedFiles} file(s) failed (retry next run)` : ""),
            filesIngested: result.files,
            sessionsIngested: result.sessions,
            eventsIngested: result.events,
            turnsIngested: result.turns,
            toolCallsIngested: result.toolCalls,
            skipped: result.skipped,
            warnings: result.warnings,
            failedFiles: result.failedFiles,
        });
    }),
};
