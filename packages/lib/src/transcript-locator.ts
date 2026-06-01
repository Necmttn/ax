/**
 * TranscriptLocator - given a session id, find its on-disk JSONL transcript
 * and identify the harness (claude vs codex) that produced it.
 *
 * Strategy is DB-first, disk-fallback:
 *   1. Read the persisted `raw_file` column off the session row. Synthetic
 *      session ids (e.g. `claude-subagent-<agentId>`) don't match the
 *      filename patterns the disk search scans for, so the hint is the only
 *      way to locate their jsonl.
 *   2. If the hint exists on disk, use it (harness derived from path).
 *   3. Otherwise fall back to filesystem search under `~/.claude/projects/`
 *      then `~/.codex/sessions/`.
 *   4. If nothing matches, throw `TranscriptNotFoundError`.
 *
 * Used by `src/dashboard/session-inspect.ts` and intended as the single
 * source of truth for "where does this session's transcript live?" so future
 * CLI commands (e.g. `axctl session replay`) and re-ingest paths don't have
 * to copy the resolution logic.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "./db.ts";
import { toBareSessionId, toSessionRid } from "./shared/session-id.ts";

export type Harness = "claude" | "codex";

/**
 * Encode an absolute filesystem path as the Claude project directory slug.
 *
 * Claude stores transcripts under `~/.claude/projects/<slug>/` where slug is
 * derived by replacing every `/` in the absolute path with `-`, retaining
 * the leading `-`. For example:
 *   `/Users/necmttn/Projects/ax` → `-Users-necmttn-Projects-ax`
 *
 * Handles trailing slashes by stripping them first.
 */
export function encodeClaudeProjectSlug(absolutePath: string): string {
    const normalized = absolutePath.replace(/\/+$/, ""); // strip trailing slash
    return normalized.replace(/\//g, "-");
}

export interface FoundTranscript {
    readonly path: string;
    readonly harness: Harness;
}

/** Preserves the wire string `"session transcript not found: <id>.jsonl"`
 *  that the dashboard surfaces to the UI. */
export class TranscriptNotFoundError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string) {
        super(`session transcript not found: ${sessionId}.jsonl`);
        this.name = "TranscriptNotFoundError";
        this.sessionId = sessionId;
    }
}

/** Infer harness from a transcript file path. Codex transcripts live under
 *  `~/.codex/sessions/`; everything else (including Claude subagent JSONLs
 *  at `~/.claude/projects/<proj>/<parent>/subagents/agent-<id>.jsonl`)
 *  parses with the claude shape. */
export function harnessFromPath(path: string): Harness {
    return path.includes("/.codex/sessions/") ? "codex" : "claude";
}

async function findClaudeJsonl(sessionId: string): Promise<FoundTranscript | null> {
    const projectsDir = join(homedir(), ".claude", "projects");
    let subdirs: string[];
    try { subdirs = await readdir(projectsDir); } catch { return null; }
    for (const sub of subdirs) {
        const candidate = join(projectsDir, sub, `${sessionId}.jsonl`);
        try {
            await stat(candidate);
            return { path: candidate, harness: "claude" };
        } catch { /* not here */ }
    }
    return null;
}

/** Codex transcripts live under `~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{sessionId}.jsonl`. */
async function findCodexJsonl(sessionId: string): Promise<FoundTranscript | null> {
    const root = join(homedir(), ".codex", "sessions");
    try {
        for (const year of await readdir(root)) {
            const yearDir = join(root, year);
            for (const month of await readdir(yearDir).catch(() => [])) {
                const monthDir = join(yearDir, month);
                for (const day of await readdir(monthDir).catch(() => [])) {
                    const dayDir = join(monthDir, day);
                    for (const file of await readdir(dayDir).catch(() => [])) {
                        if (file.endsWith(`-${sessionId}.jsonl`)) {
                            return { path: join(dayDir, file), harness: "codex" };
                        }
                    }
                }
            }
        }
    } catch { /* root missing */ }
    return null;
}

/** Pull the persisted transcript path (`raw_file`) off the session row.
 *  Defensive: DB error or missing row degrades to null so the search-based
 *  fallback still runs. Mirrors the shape of the other defensive resolvers
 *  in the inspector (see `resolveParent`). */
const resolveRawFileFromDb = (sessionId: string): Effect.Effect<string | null, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sessionRid = toSessionRid(toBareSessionId(sessionId));
        const [rows] = yield* db.query<[Array<{ raw_file: string | null }>]>(`
            SELECT raw_file FROM ${sessionRid} LIMIT 1;
        `);
        const row = rows[0];
        if (!row) return null;
        return typeof row.raw_file === "string" && row.raw_file.length > 0 ? row.raw_file : null;
    }).pipe(Effect.catch((err) =>
        Effect.sync(() => {
            console.error("transcript-locator resolveRawFileFromDb failed:", err);
            return null as string | null;
        }),
    ));

/** Disk-only resolution: try the hint, then claude search, then codex search.
 *  Pure async (no DB dep) so it can be tested without a SurrealClient layer. */
async function findOnDisk(
    sessionId: string,
    rawFileHint: string | null,
): Promise<FoundTranscript> {
    // Hinted path wins when it actually exists on disk - this is how
    // synthetic session ids (e.g. claude-subagent-<agentId>) resolve to
    // their real jsonl, since the hint was persisted at ingest time.
    if (rawFileHint) {
        try {
            await stat(rawFileHint);
            return { path: rawFileHint, harness: harnessFromPath(rawFileHint) };
        } catch { /* hint stale - fall through to search */ }
    }
    const claude = await findClaudeJsonl(sessionId);
    if (claude) return claude;
    const codex = await findCodexJsonl(sessionId);
    if (codex) return codex;
    throw new TranscriptNotFoundError(sessionId);
}

/**
 * Locate the JSONL transcript for a session, preferring the persisted
 * `raw_file` column on the session row when available, falling back to
 * filesystem search by session id pattern.
 */
export const locateTranscript = (
    sessionId: string,
): Effect.Effect<FoundTranscript, TranscriptNotFoundError, SurrealClient> =>
    Effect.gen(function* () {
        const hint = yield* resolveRawFileFromDb(sessionId);
        return yield* Effect.tryPromise({
            try: () => findOnDisk(sessionId, hint),
            catch: (err) =>
                err instanceof TranscriptNotFoundError
                    ? err
                    : new TranscriptNotFoundError(sessionId),
        });
    });

/** Disk-only variant exposed for tests that don't want to spin up a fake
 *  SurrealClient just to exercise the hint + search logic. */
export const locateTranscriptOnDisk = (
    sessionId: string,
    rawFileHint: string | null,
): Promise<FoundTranscript> => findOnDisk(sessionId, rawFileHint);
