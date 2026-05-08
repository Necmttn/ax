import { readdir, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { Effect } from "effect";
import { RecordId, SurrealClient, filePointer } from "../lib/db.ts";
import { TRANSCRIPTS_DIR } from "../lib/paths.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";

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

function turnRecordKey(sessionId: string, seq: number): string {
    return `${sessionId.replace(/-/g, "")}_${seq}`;
}

function fileRecordKey(repo: string | null, path: string): string {
    const repoPart = (repo ?? "_").replace(/[^a-zA-Z0-9]/g, "_");
    const pathPart = path.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
    return `${repoPart}__${pathPart}__${Bun.hash(path).toString(16).slice(0, 8)}`;
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

interface FileExtract {
    session: Session;
    turns: Turn[];
    invocations: Invocation[];
    edits: Edit[];
}

async function extractFile(filePath: string, projectDir: string): Promise<FileExtract | null> {
    const sessionId = basename(filePath, ".jsonl");
    const fh = await open(filePath, "r");
    let session: Session | null = null;
    const turns: Turn[] = [];
    const invocations: Invocation[] = [];
    const edits: Edit[] = [];
    let seq = 0;
    let cwd: string | null = null;

    for await (const line of fh.readLines()) {
        if (!line.trim()) continue;
        const entry = parseJsonl(line);
        if (!entry) continue;
        const type = entry.type as string | undefined;
        if (type === "summary") continue;

        const ts =
            (entry.timestamp as string | undefined) ??
            (entry.ts as string | undefined) ??
            null;
        if (!ts) continue;
        if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd as string;
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
        const message = entry.message as { content?: unknown[]; role?: string } | undefined;
        const content = (message?.content ?? []) as Array<{
            type?: string;
            text?: string;
            name?: string;
            input?: Record<string, unknown>;
        }>;

        let textExcerpt: string | null = null;
        let hasToolUse = false;
        let hasError = false;
        // Track invocation indices added this iteration so we can backfill
        // `turn_has_error` once `hasError` is finalised below (a tool_result
        // block later in the same content array can flip it after the
        // tool_use that emitted the invocation).
        const turnInvStart = invocations.length;

        for (const block of content) {
            if (block.type === "text" && typeof block.text === "string" && !textExcerpt) {
                textExcerpt = block.text.slice(0, 500);
            }
            if (block.type === "tool_use") {
                hasToolUse = true;
                const name = block.name;
                if (name === "Skill" && block.input) {
                    const skillName =
                        (block.input.skill as string | undefined) ??
                        (block.input.skill_name as string | undefined);
                    if (skillName) {
                        invocations.push({
                            session: sessionId,
                            seq,
                            ts,
                            skill: skillName,
                            args: block.input,
                            // Backfilled after the content loop below; assistant
                            // turns essentially never carry has_error in current
                            // data (it lives on tool_result turns) but we set
                            // the field correctly in case future capture changes.
                            turn_has_error: false,
                        });
                    }
                } else if (
                    (name === "Edit" || name === "Write" || name === "NotebookEdit") &&
                    block.input
                ) {
                    const path =
                        (block.input.file_path as string | undefined) ??
                        (block.input.path as string | undefined) ??
                        (block.input.notebook_path as string | undefined);
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
            }
            if (block.type === "tool_result" && (block as { is_error?: boolean }).is_error) {
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
    }
    await fh.close();

    if (!session) return null;
    return { session, turns, invocations, edits };
}

const upsertSessions = (sessions: Session[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* Effect.forEach(
            sessions,
            (s) =>
                db.upsert(new RecordId("session", s.id), {
                    project: s.project,
                    cwd: s.cwd,
                    source: "claude",
                    started_at: s.started_at ? new Date(s.started_at) : null,
                    ended_at: s.ended_at ? new Date(s.ended_at) : null,
                    raw_file: s.raw_file,
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
                Effect.catch((err) => {
                    console.error(
                        `[transcripts] putFile failed ${sessionId}: ${err.message}`,
                    );
                    return Effect.succeed(null as string | null);
                }),
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
            const fileKey = fileRecordKey(e.repo, e.path);
            if (!seenFiles.has(fileKey)) {
                seenFiles.add(fileKey);
                fileStmts.push(
                    `UPSERT file:\`${fileKey}\` CONTENT { repo: ${e.repo === null ? "NONE" : JSON.stringify(e.repo)}, path: ${JSON.stringify(e.path)} };`,
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

interface IngestOpts {
    sinceDays: number | undefined;
    project: string | undefined;
}

export interface TranscriptStats {
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
    edits: number;
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

        let files = 0;
        let sessions = 0;
        let turnCount = 0;
        let invCount = 0;
        let editCount = 0;

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
                const extracted = yield* Effect.promise(() =>
                    extractFile(filePath, projectDir),
                );
                if (!extracted) continue;
                files += 1;
                const pointer = yield* snapshotTranscript(
                    extracted.session.id,
                    filePath,
                );
                extracted.session.raw_file = pointer;
                yield* upsertSessions([extracted.session]);
                sessions += 1;
                yield* upsertTurns(extracted.turns);
                turnCount += extracted.turns.length;
                yield* relateInvocations(extracted.invocations);
                invCount += extracted.invocations.length;
                yield* upsertEdits(extracted.edits);
                editCount += extracted.edits.length;
                if (files % 50 === 0) {
                    console.log(
                        `[transcripts] files=${files} sessions=${sessions} turns=${turnCount} inv=${invCount} edits=${editCount}`,
                    );
                }
            }
        }
        console.log(
            `[transcripts] DONE files=${files} sessions=${sessions} turns=${turnCount} invocations=${invCount} edits=${editCount}`,
        );
        return { files, sessions, turns: turnCount, invocations: invCount, edits: editCount };
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
