import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { RecordId, SurrealClient, filePointer } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import {
    relateToolCallSkill,
    writePlanSnapshot,
    writeToolCalls,
    type PlanSnapshotWrite,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
} from "./evidence-writers.ts";
import {
    extractCommandTool,
    normalizeCommand,
    parseCodexFunctionOutput,
    toolKindForName,
} from "./tool-calls.ts";
import { normalizeCodexUpdatePlan, type PlanStatus } from "./plans.ts";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";

const CODEX_ROOT = process.env.AGENTCTL_CODEX_DIR ?? join(homedir(), ".codex", "sessions");
const DEFAULT_CODEX_RAW_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CODEX_PROGRESS_EVERY = 10;

interface CodexSession {
    id: string;
    cwd: string | null;
    cli_version: string | null;
    model_provider: string | null;
    started_at: string;
    ended_at: string;
}

interface CodexTurn {
    session: string;
    seq: number;
    ts: string;
    role: string;
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

function parseJsonl(line: string): Record<string, unknown> | null {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" ? value : null;
}

function parseCodexArguments(input: unknown): unknown {
    if (typeof input !== "string") return input ?? null;

    try {
        return JSON.parse(input);
    } catch {
        return input;
    }
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
    return typeof input === "string" ? input : jsonText(input);
}

function stableHash(input: string): string {
    return Bun.hash(input).toString(16).padStart(16, "0");
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

function codexRawMaxBytes(raw = process.env.AGENTCTL_CODEX_RAW_MAX_BYTES): number {
    if (!raw) return DEFAULT_CODEX_RAW_MAX_BYTES;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CODEX_RAW_MAX_BYTES;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
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
        "codex",
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

function applyToolResult(call: MutableToolCallWrite, result: ToolResultFields): void {
    call.outputJson = result.outputJson;
    call.outputExcerpt = result.outputExcerpt;
    call.errorText = result.errorText;
    call.exitCode = result.exitCode;
    call.durationMs = result.durationMs;
    call.hasError = result.hasError;
}

async function walkJsonlFiles(root: string, cutoffMs: number): Promise<string[]> {
    const out: string[] = [];
    async function visit(dir: string) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                await visit(full);
            } else if (e.isFile() && full.endsWith(".jsonl")) {
                if (cutoffMs > 0) {
                    const st = await stat(full);
                    if (st.mtimeMs < cutoffMs) continue;
                }
                out.push(full);
            }
        }
    }
    await visit(root);
    return out;
}

interface CodexExtract {
    session: CodexSession;
    turns: CodexTurn[];
    invocations: CodexInvocation[];
    toolCalls: ToolCallWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    planSnapshots: PlanSnapshotWrite[];
}

function createCodexExtractor(filePath: string) {
    let session: CodexSession | null = null;
    const turns: CodexTurn[] = [];
    const invocations: CodexInvocation[] = [];
    const toolCalls: MutableToolCallWrite[] = [];
    const skillRelations: ToolCallSkillRelationWrite[] = [];
    const planSnapshots: PlanSnapshotWrite[] = [];
    const toolCallsByCallId = new Map<string, MutableToolCallWrite>();
    const pendingToolResultsByCallId = new Map<string, ToolResultFields>();
    const planCreatedAtBySource = new Map<string, string>();
    const planSnapshotCountsBySource = new Map<string, number>();
    const anonymousFunctionCallCountsByTurn = new Map<number, number>();
    let seq = 0;

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
            callId,
            ts,
            cwd: currentSession.cwd,
            inputJson,
            rawJson: payload,
            hasError: false,
        };

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
        const pendingResult = pendingToolResultsByCallId.get(callId);
        if (pendingResult) {
            applyToolResult(call, pendingResult);
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
            const normalized = normalizeCodexUpdatePlan({
                sessionId: currentSession.id,
                ts,
                input: payload.arguments,
            });
            if (normalized.items.length > 0) {
                const source = normalized.source;
                const snapshotSeq = nextPlanSnapshotSeq(source);
                const createdAt = rememberPlanCreatedAt(source, ts);
                const items = normalized.items.map((item) => ({
                    key: planItemKey({
                        sessionId: currentSession.id,
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
                    planKey: planKey(currentSession.id, source),
                    sessionId: currentSession.id,
                    source,
                    status: planStatus(normalized.items),
                    createdAt,
                    updatedAt: ts,
                    snapshotKey: planSnapshotKey({
                        sessionId: currentSession.id,
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

    const processFunctionOutput = (payload: Record<string, unknown>): void => {
        const callId = stringField(payload, "call_id");
        if (!callId) return;

        const result = codexOutputFields(payload.output);
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
                    started_at: stringField(payload, "timestamp") ?? ts,
                    ended_at: ts,
                };
                return;
            }
            if (!session) return;
            session.ended_at = ts;

            if (type === "response_item" && payload) {
                seq += 1;
                const itemType = stringField(payload, "type");
                const message = isRecord(payload.message) ? payload.message : null;
                const role =
                    itemType === "function_call"
                        ? "tool_call"
                        : itemType === "message"
                          ? (stringField(message ?? {}, "role") ?? "assistant")
                          : (itemType ?? "unknown");

                let textExcerpt: string | null = null;
                const messageContent = message?.content;
                if (Array.isArray(messageContent)) {
                    for (const block of messageContent.filter(isRecord)) {
                        const blockType = stringField(block, "type");
                        const blockText = stringField(block, "text");
                        if (
                            (blockType === "text" || blockType === "output_text") &&
                            blockText &&
                            !textExcerpt
                        ) {
                            textExcerpt = blockText.slice(0, 500);
                        }
                    }
                }

                const isToolCall = itemType === "function_call";
                turns.push({
                    session: session.id,
                    seq,
                    ts,
                    role,
                    text_excerpt: textExcerpt,
                    has_tool_use: isToolCall,
                });

                if (isToolCall) {
                    processFunctionCall(payload, ts, session);
                } else if (itemType === "function_call_output") {
                    processFunctionOutput(payload);
                }
            }
        },
        finish(): CodexExtract | null {
            if (!session) return null;
            return {
                session,
                turns,
                invocations,
                toolCalls,
                skillRelations,
                planSnapshots,
            };
        },
    };
}

export function __testExtractCodexJsonlLines(lines: Iterable<string>): CodexExtract | null {
    const extractor = createCodexExtractor("codex-test.jsonl");
    for (const line of lines) {
        extractor.processLine(line);
    }
    return extractor.finish();
}

async function extractCodexFile(filePath: string): Promise<CodexExtract | null> {
    const fh = await open(filePath, "r");
    const extractor = createCodexExtractor(filePath);

    try {
        for await (const line of fh.readLines()) {
            extractor.processLine(line);
        }
    } finally {
        await fh.close();
    }

    return extractor.finish();
}

const relateToolCallSkills = (relations: ToolCallSkillRelationWrite[]) =>
    Effect.gen(function* () {
        if (relations.length === 0) return;
        yield* Effect.forEach(relations, relateToolCallSkill, {
            concurrency: 4,
            discard: true,
        });
    });

const writePlanSnapshots = (snapshots: PlanSnapshotWrite[]) =>
    Effect.gen(function* () {
        if (snapshots.length === 0) return;
        yield* Effect.forEach(snapshots, writePlanSnapshot, {
            concurrency: 4,
            discard: true,
        });
    });

interface CodexIngestOpts {
    sinceDays: number | undefined;
}

export interface CodexStats {
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
    toolCalls: number;
    planSnapshots: number;
}

export const ingestCodex = (
    opts: Partial<CodexIngestOpts> = {},
): Effect.Effect<CodexStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const files = yield* Effect.promise(() => walkJsonlFiles(CODEX_ROOT, cutoff));
        const rawMaxBytes = codexRawMaxBytes();
        const progressEvery = codexProgressEvery(process.env.AGENTCTL_CODEX_PROGRESS_EVERY);

        let fileCount = 0;
        let sessionCount = 0;
        let turnCount = 0;
        let invCount = 0;
        let toolCallCount = 0;
        let planSnapshotCount = 0;

        for (const filePath of files) {
            const fileStartedAt = Date.now();
            const fileStat = yield* Effect.promise(async () => {
                try {
                    return await stat(filePath);
                } catch {
                    return null;
                }
            });
            const sizeBytes = fileStat?.size ?? 0;
            const snapshotRaw = shouldSnapshotCodexRaw(sizeBytes, rawMaxBytes);
            if (!snapshotRaw) {
                console.log(
                    `[codex] file=${fileCount + 1}/${files.length} rawSnapshot=skipped size=${formatBytes(sizeBytes)} max=${formatBytes(rawMaxBytes)} path=${filePath}`,
                );
            }

            const extracted = yield* Effect.promise(() => extractCodexFile(filePath));
            if (!extracted) continue;
            fileCount += 1;

            // Snapshot the raw codex jsonl into the `codex_artifacts` bucket as
            // best-effort cold storage for modest files. Large Codex sessions
            // are parsed line-by-line above; reading them again just to copy the
            // raw transcript can dominate benchmark runs.
            const bucketPath = `${extracted.session.id}.jsonl`;
            const rawContent = snapshotRaw
                ? yield* Effect.promise(async () => {
                      try {
                          return await Bun.file(filePath).text();
                      } catch {
                          return null;
                      }
                  })
                : null;
            let rawPointer: string | null = null;
            if (rawContent !== null) {
                rawPointer = yield* db
                    .putFile("codex_artifacts", bucketPath, rawContent)
                    .pipe(
                        Effect.map(() => filePointer("codex_artifacts", bucketPath)),
                        Effect.catch((err) => {
                            console.error(
                                `[codex] putFile failed ${extracted.session.id}: ${err.message}`,
                            );
                            return Effect.succeed(null as string | null);
                        }),
                    );
            }

            // SurrealDB v3 rejects JS `null` for `option<T>` fields (CBOR
            // encodes null as SurrealQL NULL, not NONE). Coalesce to
            // `undefined` so the JS client maps it to NONE. See issue #37.
            yield* db.upsert(new RecordId("session", extracted.session.id), {
                project: extracted.session.cwd ?? undefined,
                cwd: extracted.session.cwd ?? undefined,
                model: extracted.session.model_provider ?? undefined,
                source: "codex",
                started_at: new Date(extracted.session.started_at),
                ended_at: new Date(extracted.session.ended_at),
                raw_file: rawPointer ?? undefined,
            });
            sessionCount += 1;

            // Bulk turns
            const turnStmts = extracted.turns.map(
                (t) =>
                    `UPSERT turn:\`${turnRecordKey(t.session, t.seq)}\` CONTENT { session: session:\`${t.session}\`, seq: ${t.seq}, ts: d"${t.ts}", role: ${JSON.stringify(t.role)}, text_excerpt: ${t.text_excerpt === null ? "NONE" : JSON.stringify(t.text_excerpt)}, has_tool_use: ${t.has_tool_use}, has_error: false };`,
            );
            for (let i = 0; i < turnStmts.length; i += 500) {
                yield* db.query(turnStmts.slice(i, i + 500).join(""));
            }
            turnCount += extracted.turns.length;

            yield* writeToolCalls(extracted.toolCalls);
            toolCallCount += extracted.toolCalls.length;
            yield* relateToolCallSkills(extracted.skillRelations);
            yield* writePlanSnapshots(extracted.planSnapshots);
            planSnapshotCount += extracted.planSnapshots.length;

            // Preserve legacy synthetic Codex skill records and
            // turn->invoked->skill edges alongside the canonical evidence graph.
            const codexTools = new Set(extracted.invocations.map((i) => i.skill));
            const skillStmts = [...codexTools].map(
                (name) =>
                    `UPSERT skill:\`${skillRecordKey(name)}\` MERGE { name: ${JSON.stringify(name)}, scope: "codex-tool", dir_path: "(synthetic)", content_hash: "codex" };`,
            );
            if (skillStmts.length > 0) {
                yield* db.query(skillStmts.join(""));
            }

            // Codex tool errors live on the canonical tool_call records. The
            // legacy turn->skill edge never had turn-level error data, so keep
            // the old false value while preserving the edge shape from issue #31.
            const invStmts = extracted.invocations.map(
                (inv) =>
                    `RELATE turn:\`${turnRecordKey(inv.session, inv.seq)}\`->invoked->skill:\`${skillRecordKey(inv.skill)}\` SET ts = d"${inv.ts}", args = ${JSON.stringify(JSON.stringify(inv.args))}, turn_has_error = false;`,
            );
            for (let i = 0; i < invStmts.length; i += 500) {
                yield* db.query(invStmts.slice(i, i + 500).join(""));
            }
            invCount += extracted.invocations.length;

            if (!snapshotRaw) {
                console.log(
                    `[codex] file=${fileCount}/${files.length} done session=${extracted.session.id} ms=${Date.now() - fileStartedAt} turns=${extracted.turns.length} toolCalls=${extracted.toolCalls.length}`,
                );
            }

            if (fileCount % progressEvery === 0) {
                console.log(
                    `[codex] files=${fileCount} sessions=${sessionCount} turns=${turnCount} inv=${invCount} toolCalls=${toolCallCount} planSnapshots=${planSnapshotCount}`,
                );
            }
        }
        console.log(
            `[codex] DONE files=${fileCount} sessions=${sessionCount} turns=${turnCount} invocations=${invCount} toolCalls=${toolCallCount} planSnapshots=${planSnapshotCount}`,
        );
        return {
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
