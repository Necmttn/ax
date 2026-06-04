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

import { homedir } from "node:os";
import { Effect, FileSystem, Path } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
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

const findClaudeJsonl = (
    sessionId: string,
): Effect.Effect<FoundTranscript | null, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectsDir = path.join(homedir(), ".claude", "projects");
        // OLD: readdir(projectsDir) in try/catch → return null. A missing or
        // unreadable projects dir means "no claude transcript here", so recover
        // ANY PlatformError to [] then bail with null - orAbsent.
        const subdirs = yield* fs.readDirectory(projectsDir).pipe(orAbsent([] as string[]));
        for (const sub of subdirs) {
            const candidate = path.join(projectsDir, sub, `${sessionId}.jsonl`);
            // OLD: stat(candidate) in try/catch → continue. A probe for "does
            // this file exist?" where any failure means "not here" - orAbsent.
            const here = yield* fs.exists(candidate).pipe(orAbsent(false));
            if (here) return { path: candidate, harness: "claude" } satisfies FoundTranscript;
        }
        return null;
    });

/** Codex transcripts live under `~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{sessionId}.jsonl`. */
const findCodexJsonl = (
    sessionId: string,
): Effect.Effect<FoundTranscript | null, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(homedir(), ".codex", "sessions");
        // OLD: each level's readdir tolerated failure (outer try/catch → root
        // missing; inner `.catch(() => [])` per level). Every directory listing
        // recovers ANY PlatformError to [] - orAbsent.
        const years = yield* fs.readDirectory(root).pipe(orAbsent([] as string[]));
        for (const year of years) {
            const yearDir = path.join(root, year);
            const months = yield* fs.readDirectory(yearDir).pipe(orAbsent([] as string[]));
            for (const month of months) {
                const monthDir = path.join(yearDir, month);
                const days = yield* fs.readDirectory(monthDir).pipe(orAbsent([] as string[]));
                for (const day of days) {
                    const dayDir = path.join(monthDir, day);
                    const fileEntries = yield* fs
                        .readDirectory(dayDir)
                        .pipe(orAbsent([] as string[]));
                    for (const file of fileEntries) {
                        if (file.endsWith(`-${sessionId}.jsonl`)) {
                            return {
                                path: path.join(dayDir, file),
                                harness: "codex",
                            } satisfies FoundTranscript;
                        }
                    }
                }
            }
        }
        return null;
    });

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
 *  No DB dep so it can be exercised without a SurrealClient layer. */
const findOnDisk = (
    sessionId: string,
    rawFileHint: string | null,
): Effect.Effect<FoundTranscript, TranscriptNotFoundError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Hinted path wins when it actually exists on disk - this is how
        // synthetic session ids (e.g. claude-subagent-<agentId>) resolve to
        // their real jsonl, since the hint was persisted at ingest time.
        if (rawFileHint) {
            // OLD: stat(rawFileHint) in try/catch → fall through to search. A
            // probe where any failure means "hint stale, keep searching" -
            // orAbsent.
            const hintExists = yield* fs.exists(rawFileHint).pipe(orAbsent(false));
            if (hintExists) {
                return { path: rawFileHint, harness: harnessFromPath(rawFileHint) } satisfies FoundTranscript;
            }
        }
        const claude = yield* findClaudeJsonl(sessionId);
        if (claude) return claude;
        const codex = yield* findCodexJsonl(sessionId);
        if (codex) return codex;
        return yield* Effect.fail(new TranscriptNotFoundError(sessionId));
    });

/**
 * Locate the JSONL transcript for a session, preferring the persisted
 * `raw_file` column on the session row when available, falling back to
 * filesystem search by session id pattern.
 */
export const locateTranscript = (
    sessionId: string,
): Effect.Effect<
    FoundTranscript,
    TranscriptNotFoundError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const hint = yield* resolveRawFileFromDb(sessionId);
        return yield* findOnDisk(sessionId, hint);
    });

/** Disk-only variant exposed for tests that don't want to spin up a fake
 *  SurrealClient just to exercise the hint + search logic. */
export const locateTranscriptOnDisk = (
    sessionId: string,
    rawFileHint: string | null,
): Effect.Effect<FoundTranscript, TranscriptNotFoundError, FileSystem.FileSystem | Path.Path> =>
    findOnDisk(sessionId, rawFileHint);
