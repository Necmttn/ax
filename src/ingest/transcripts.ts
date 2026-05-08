import { readdir, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { connect, RecordId } from "../lib/db.ts";
import { TRANSCRIPTS_DIR } from "../lib/paths.ts";
import { skillRecordKey } from "../lib/skill-id.ts";

interface Session {
    id: string;
    project: string;
    cwd: string | null;
    started_at: string | null;
    ended_at: string | null;
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

async function bulkUpsertSessions(db: Awaited<ReturnType<typeof connect>>, sessions: Session[]) {
    for (const s of sessions) {
        const id = new RecordId("session", s.id);
        await db.upsert(id).content({
            project: s.project,
            cwd: s.cwd,
            started_at: s.started_at ? new Date(s.started_at) : null,
            ended_at: s.ended_at ? new Date(s.ended_at) : null,
        });
    }
}

async function bulkUpsertTurns(db: Awaited<ReturnType<typeof connect>>, turns: Turn[]) {
    // Use raw SQL for speed
    const chunks: string[] = [];
    for (const t of turns) {
        const key = turnRecordKey(t.session, t.seq);
        chunks.push(
            `UPSERT turn:\`${key}\` CONTENT { session: session:\`${t.session}\`, seq: ${t.seq}, ts: d"${t.ts}", role: "${t.role}", text_excerpt: ${
                t.text_excerpt === null ? "NONE" : JSON.stringify(t.text_excerpt)
            }, has_tool_use: ${t.has_tool_use}, has_error: ${t.has_error} };`,
        );
    }
    if (chunks.length === 0) return;
    // Send in batches of 500
    for (let i = 0; i < chunks.length; i += 500) {
        await db.query(chunks.slice(i, i + 500).join(""));
    }
}

async function bulkRelateInvocations(
    db: Awaited<ReturnType<typeof connect>>,
    invocations: Invocation[],
) {
    const stmts: string[] = [];
    for (const inv of invocations) {
        const turnKey = turnRecordKey(inv.session, inv.seq);
        const skillKey = skillRecordKey(inv.skill);
        stmts.push(
            `RELATE turn:\`${turnKey}\`->invoked->skill:\`${skillKey}\` SET ts = d"${inv.ts}", args = ${JSON.stringify(JSON.stringify(inv.args))};`,
        );
    }
    for (let i = 0; i < stmts.length; i += 500) {
        await db.query(stmts.slice(i, i + 500).join(""));
    }
}

async function bulkUpsertEdits(db: Awaited<ReturnType<typeof connect>>, edits: Edit[]) {
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
        await db.query(fileStmts.slice(i, i + 500).join(""));
    }
    for (let i = 0; i < relStmts.length; i += 500) {
        await db.query(relStmts.slice(i, i + 500).join(""));
    }
}

interface IngestOpts {
    sinceDays: number | undefined;
    project: string | undefined;
}

export async function ingestTranscripts(
    opts: Partial<IngestOpts> = {},
): Promise<{
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
    edits: number;
}> {
    const cutoff = opts.sinceDays
        ? Date.now() - opts.sinceDays * 86400 * 1000
        : 0;
    const projectDirs = (await readdir(TRANSCRIPTS_DIR)).filter(
        (d) => !opts.project || d === opts.project,
    );

    const db = await connect();
    let files = 0;
    let sessions = 0;
    let turnCount = 0;
    let invCount = 0;
    let editCount = 0;
    try {
        for (const projectDir of projectDirs) {
            const fullProject = join(TRANSCRIPTS_DIR, projectDir);
            let entries: string[];
            try {
                entries = await readdir(fullProject);
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (!entry.endsWith(".jsonl")) continue;
                const filePath = join(fullProject, entry);
                if (cutoff > 0) {
                    const st = await stat(filePath);
                    if (st.mtimeMs < cutoff) continue;
                }
                const extracted = await extractFile(filePath, projectDir);
                if (!extracted) continue;
                files += 1;
                await bulkUpsertSessions(db, [extracted.session]);
                sessions += 1;
                await bulkUpsertTurns(db, extracted.turns);
                turnCount += extracted.turns.length;
                await bulkRelateInvocations(db, extracted.invocations);
                invCount += extracted.invocations.length;
                await bulkUpsertEdits(db, extracted.edits);
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
    } finally {
        await db.close();
    }
}

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await ingestTranscripts({ sinceDays });
}
