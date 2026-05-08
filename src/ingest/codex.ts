import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { RecordId, SurrealClient, filePointer } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";

const CODEX_ROOT = process.env.AGENTCTL_CODEX_DIR ?? join(homedir(), ".codex", "sessions");

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

function turnRecordKey(sessionId: string, seq: number): string {
    return `${sessionId.replace(/-/g, "")}_${seq}`;
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
}

async function extractCodexFile(filePath: string): Promise<CodexExtract | null> {
    const fh = await open(filePath, "r");
    let session: CodexSession | null = null;
    const turns: CodexTurn[] = [];
    const invocations: CodexInvocation[] = [];
    let seq = 0;

    for await (const line of fh.readLines()) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const type = entry.type as string | undefined;
        const ts = entry.timestamp as string | undefined;
        if (!ts) continue;
        const payload = entry.payload as Record<string, unknown> | undefined;

        if (type === "session_meta" && payload) {
            session = {
                id: (payload.id as string) ?? filePath,
                cwd: (payload.cwd as string) ?? null,
                cli_version: (payload.cli_version as string) ?? null,
                model_provider: (payload.model_provider as string) ?? null,
                started_at: (payload.timestamp as string) ?? ts,
                ended_at: ts,
            };
            continue;
        }
        if (!session) continue;
        session.ended_at = ts;

        if (type === "response_item" && payload) {
            seq += 1;
            const itemType = payload.type as string | undefined;
            const role =
                itemType === "function_call"
                    ? "tool_call"
                    : itemType === "message"
                      ? ((payload.message as { role?: string } | undefined)?.role ?? "assistant")
                      : (itemType ?? "unknown");

            let textExcerpt: string | null = null;
            const messageContent = (payload.message as { content?: unknown[] } | undefined)
                ?.content;
            if (Array.isArray(messageContent)) {
                for (const block of messageContent as Array<{ type?: string; text?: string }>) {
                    if (block.type === "text" || block.type === "output_text") {
                        if (typeof block.text === "string" && !textExcerpt) {
                            textExcerpt = block.text.slice(0, 500);
                        }
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
                const toolName = payload.name as string | undefined;
                if (toolName) {
                    invocations.push({
                        session: session.id,
                        seq,
                        ts,
                        skill: `codex:${toolName}`,
                        args: payload.arguments ?? {},
                    });
                }
            }
        }
    }

    await fh.close();
    if (!session) return null;
    return { session, turns, invocations };
}

interface CodexIngestOpts {
    sinceDays: number | undefined;
}

export interface CodexStats {
    files: number;
    sessions: number;
    turns: number;
    invocations: number;
}

export const ingestCodex = (
    opts: Partial<CodexIngestOpts> = {},
): Effect.Effect<CodexStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400 * 1000 : 0;
        const files = yield* Effect.promise(() => walkJsonlFiles(CODEX_ROOT, cutoff));

        let fileCount = 0;
        let sessionCount = 0;
        let turnCount = 0;
        let invCount = 0;

        for (const filePath of files) {
            const extracted = yield* Effect.promise(() => extractCodexFile(filePath));
            if (!extracted) continue;
            fileCount += 1;

            // Snapshot the raw codex jsonl into the `codex_artifacts` bucket as
            // best-effort cold storage. Failure does not abort ingest.
            const bucketPath = `${extracted.session.id}.jsonl`;
            const rawContent = yield* Effect.promise(async () => {
                try {
                    return await Bun.file(filePath).text();
                } catch {
                    return null;
                }
            });
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

            yield* db.upsert(new RecordId("session", extracted.session.id), {
                project: extracted.session.cwd,
                cwd: extracted.session.cwd,
                model: extracted.session.model_provider,
                source: "codex",
                started_at: new Date(extracted.session.started_at),
                ended_at: new Date(extracted.session.ended_at),
                raw_file: rawPointer,
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

            // First, ensure codex tool skills exist as skill records
            const codexTools = new Set(extracted.invocations.map((i) => i.skill));
            const skillStmts = [...codexTools].map(
                (name) =>
                    `UPSERT skill:\`${skillRecordKey(name)}\` MERGE { name: ${JSON.stringify(name)}, scope: "codex-tool", dir_path: "(synthetic)", content_hash: "codex" };`,
            );
            if (skillStmts.length > 0) {
                yield* db.query(skillStmts.join(""));
            }

            const invStmts = extracted.invocations.map(
                (inv) =>
                    `RELATE turn:\`${turnRecordKey(inv.session, inv.seq)}\`->invoked->skill:\`${skillRecordKey(inv.skill)}\` SET ts = d"${inv.ts}", args = ${JSON.stringify(JSON.stringify(inv.args))};`,
            );
            for (let i = 0; i < invStmts.length; i += 500) {
                yield* db.query(invStmts.slice(i, i + 500).join(""));
            }
            invCount += extracted.invocations.length;

            if (fileCount % 25 === 0) {
                console.log(
                    `[codex] files=${fileCount} sessions=${sessionCount} turns=${turnCount} inv=${invCount}`,
                );
            }
        }
        console.log(
            `[codex] DONE files=${fileCount} sessions=${sessionCount} turns=${turnCount} invocations=${invCount}`,
        );
        return {
            files: fileCount,
            sessions: sessionCount,
            turns: turnCount,
            invocations: invCount,
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
