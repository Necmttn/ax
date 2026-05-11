import { readdir, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { Effect } from "effect";
import { RecordId, SurrealClient, filePointer } from "../lib/db.ts";
import { TRANSCRIPTS_DIR } from "../lib/paths.ts";
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
    toolKindForName,
} from "./tool-calls.ts";
import { normalizeClaudeTodoWrite, type PlanStatus } from "./plans.ts";
import { fileRecordKey, toolCallRecordKey, turnRecordKey } from "./record-keys.ts";

const MAX_OUTPUT_EXCERPT_CHARS = 1200;

interface Session {
    id: string;
    project: string;
    cwd: string | null;
    started_at: string | null;
    ended_at: string | null;
    raw_file: string | null;
}

interface Turn {
    session: string;
    seq: number;
    ts: string;
    role: string;
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

function deriveProject(transcriptDir: string): string {
    // ~/.claude/projects encodes cwd as `-Users-necmttn-Projects-quera`
    const m = basename(transcriptDir);
    return m;
}

function repoFromCwd(cwd: string | null): string | null {
    if (!cwd) return null;
    // Best effort: last path segment after Projects/ or worktrees/ etc.
    const m = cwd.match(/\/(?:Projects|workspaces|worktrees)\/([^/]+)/);
    return m?.[1] ?? null;
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

function asContentBlocks(input: unknown): Record<string, unknown>[] {
    return Array.isArray(input) ? input.filter(isRecord) : [];
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

function outputExcerpt(input: unknown): string | null {
    const text = outputText(input);
    if (!text) return null;
    const excerpt = boundedExcerpt(text);
    return excerpt.length > 0 ? excerpt : null;
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
    turns: Turn[];
    invocations: Invocation[];
    edits: Edit[];
    toolCalls: ToolCallWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    planSnapshots: PlanSnapshotWrite[];
}

function createClaudeExtractor(projectDir: string, sessionId: string) {
    let session: Session | null = null;
    const turns: Turn[] = [];
    const invocations: Invocation[] = [];
    const edits: Edit[] = [];
    const toolCalls: MutableToolCallWrite[] = [];
    const skillRelations: ToolCallSkillRelationWrite[] = [];
    const planSnapshots: PlanSnapshotWrite[] = [];
    const toolCallsByCallId = new Map<string, MutableToolCallWrite>();
    const pendingToolResultsByCallId = new Map<string, ToolResultFields>();
    const planCreatedAtBySource = new Map<string, string>();
    const planSnapshotCountsBySource = new Map<string, number>();
    const anonymousToolUseCountsByTurn = new Map<number, number>();
    let seq = 0;
    let cwd: string | null = null;

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
        const call: MutableToolCallWrite = {
            provider: "claude",
            toolName: name,
            toolKind: toolKindForName(name),
            sessionId,
            seq,
            turnKey: currentTurnKey,
            callId,
            ts,
            cwd: turnCwd,
            inputJson: input ?? null,
            rawJson: block,
            hasError: false,
        };

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
                    path,
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

    const processToolResult = (block: Record<string, unknown>): boolean => {
        const callId = stringField(block, "tool_use_id");
        const hasError = block.is_error === true;
        const result: ToolResultFields = {
            outputJson: block.content ?? null,
            outputExcerpt: outputExcerpt(block.content ?? null),
            errorText: hasError ? outputExcerpt(block.content ?? null) : null,
            hasError,
        };

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
            if (!session) {
                session = {
                    id: sessionId,
                    project: deriveProject(projectDir),
                    cwd,
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
            const content = asContentBlocks(message?.content);

            let textExcerpt: string | null = null;
            let hasToolUse = false;
            let hasError = false;
            // Track invocation indices added this iteration so we can backfill
            // `turn_has_error` once `hasError` is finalised below (a tool_result
            // block later in the same content array can flip it after the
            // tool_use that emitted the invocation).
            const turnInvStart = invocations.length;

            for (const block of content) {
                const blockType = stringField(block, "type");
                const blockText = stringField(block, "text");
                if (blockType === "text" && blockText && !textExcerpt) {
                    textExcerpt = blockText.slice(0, 500);
                }
                if (blockType === "tool_use") {
                    hasToolUse = true;
                    processToolUse(block, ts, turnCwd);
                }
                if (blockType === "tool_result" && processToolResult(block)) {
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
                text_excerpt: textExcerpt,
                has_tool_use: hasToolUse,
                has_error: hasError,
            });
        },
        finish(): FileExtract | null {
            if (!session) return null;
            return {
                session,
                turns,
                invocations,
                edits,
                toolCalls,
                skillRelations,
                planSnapshots,
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
    const fh = await open(filePath, "r");
    const extractor = createClaudeExtractor(projectDir, sessionId);

    try {
        for await (const line of fh.readLines()) {
            extractor.processLine(line);
        }
    } finally {
        await fh.close();
    }

    return extractor.finish();
}

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
        const db = yield* SurrealClient;
        const chunks: string[] = turns.map(
            (t) =>
                `UPSERT turn:\`${turnRecordKey(t.session, t.seq)}\` CONTENT { session: session:\`${t.session}\`, seq: ${t.seq}, ts: d"${t.ts}", role: "${t.role}", text_excerpt: ${
                    t.text_excerpt === null ? "NONE" : JSON.stringify(t.text_excerpt)
                }, has_tool_use: ${t.has_tool_use}, has_error: ${t.has_error} };`,
        );
        for (let i = 0; i < chunks.length; i += 500) {
            yield* db.query(chunks.slice(i, i + 500).join(""));
        }
    });

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
                        `UPSERT skill:\`${skillRecordKey(n)}\` MERGE { name: ${JSON.stringify(n)}, scope: "unknown", dir_path: "(unknown)", content_hash: "unknown" };`,
                );
                for (let i = 0; i < placeholders.length; i += 500) {
                    yield* db.query(placeholders.slice(i, i + 500).join(""));
                }
            }
        }

        const stmts = invocations.map(
            (inv) =>
                `RELATE turn:\`${turnRecordKey(inv.session, inv.seq)}\`->invoked->skill:\`${skillRecordKey(inv.skill)}\` SET ts = d"${inv.ts}", args = ${JSON.stringify(JSON.stringify(inv.args))}, turn_has_error = ${inv.turn_has_error};`,
        );
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

const upsertEdits = (edits: Edit[]) =>
    Effect.gen(function* () {
        if (edits.length === 0) return;
        const db = yield* SurrealClient;
        const fileStmts: string[] = [];
        const relStmts: string[] = [];
        const seenFiles = new Set<string>();
        for (const e of edits) {
            const repositoryKey = e.repo ?? "_";
            const fileKey = fileRecordKey(repositoryKey, e.path);
            if (!seenFiles.has(fileKey)) {
                seenFiles.add(fileKey);
                const identityScope = e.repo === null ? `, identity_scope: "legacy_local"` : "";
                fileStmts.push(
                    `UPSERT file:\`${fileKey}\` CONTENT { repo: ${e.repo === null ? "NONE" : JSON.stringify(e.repo)}, path: ${JSON.stringify(e.path)}${identityScope} };`,
                );
            }
            const turnKey = turnRecordKey(e.session, e.seq);
            relStmts.push(
                `RELATE turn:\`${turnKey}\`->edited->file:\`${fileKey}\` SET tool = "${e.tool}", ts = d"${e.ts}";`,
            );
        }
        for (let i = 0; i < fileStmts.length; i += 500) {
            yield* db.query(fileStmts.slice(i, i + 500).join(""));
        }
        for (let i = 0; i < relStmts.length; i += 500) {
            yield* db.query(relStmts.slice(i, i + 500).join(""));
        }
    });

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

interface IngestOpts {
    sinceDays: number | undefined;
    project: string | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
}

export interface TranscriptStats {
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
    edits: number;
    toolCalls: number;
    planSnapshots: number;
}

export const ingestTranscripts = (
    opts: Partial<IngestOpts> = {},
): Effect.Effect<TranscriptStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const cutoff = opts.sinceDays
            ? Date.now() - opts.sinceDays * 86400 * 1000
            : 0;
        const projectDirs = (yield* Effect.promise(() => readdir(TRANSCRIPTS_DIR))).filter(
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

        for (const projectDir of projectDirs) {
            const fullProject = join(TRANSCRIPTS_DIR, projectDir);
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

        for (const [index, candidate] of candidates.entries()) {
            if (opts.onProgress && (index < 5 || index % 10 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: candidates.length,
                    files,
                    sessions,
                    turns: turnCount,
                    invocations: invCount,
                    edits: editCount,
                    toolCalls: toolCallCount,
                    planSnapshots: planSnapshotCount,
                });
            }
            const extracted = yield* Effect.promise(() =>
                extractFile(candidate.filePath, candidate.projectDir),
            );
            if (!extracted) continue;
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
            yield* writeToolCalls(extracted.toolCalls);
            toolCallCount += extracted.toolCalls.length;
            yield* relateToolCallSkills(extracted.skillRelations);
            yield* writePlanSnapshots(extracted.planSnapshots);
            planSnapshotCount += extracted.planSnapshots.length;
            yield* relateInvocations(extracted.invocations);
            invCount += extracted.invocations.length;
            yield* upsertEdits(extracted.edits);
            editCount += extracted.edits.length;
            if (opts.onProgress && (files <= 5 || files % 10 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: candidates.length,
                    files,
                    sessions,
                    turns: turnCount,
                    invocations: invCount,
                    edits: editCount,
                    toolCalls: toolCallCount,
                    planSnapshots: planSnapshotCount,
                });
            }
            if (files % 50 === 0) {
                const counts = {
                    currentFile: index + 1,
                    totalFiles: candidates.length,
                    files,
                    sessions,
                    turns: turnCount,
                    invocations: invCount,
                    edits: editCount,
                    toolCalls: toolCallCount,
                    planSnapshots: planSnapshotCount,
                };
                if (opts.onProgress) yield* opts.onProgress(counts);
                yield* Effect.logDebug("transcript ingest progress", {
                    ...counts,
                });
            }
        }
        yield* Effect.logDebug("transcript ingest complete", {
            files,
            sessions,
            turns: turnCount,
            invocations: invCount,
            edits: editCount,
            toolCalls: toolCallCount,
            planSnapshots: planSnapshotCount,
        });
        return {
            files,
            sessions,
            turns: turnCount,
            invocations: invCount,
            edits: editCount,
            toolCalls: toolCallCount,
            planSnapshots: planSnapshotCount,
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
