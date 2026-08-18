/**
 * TranscriptLocator - given a session id, find its on-disk JSONL transcript
 * and identify the harness (claude vs codex) that produced it.
 *
 * Strategy is CACHE-first, disk-fallback, snapshot-last:
 *   1. Read the persisted `raw_file` column off the session row. Synthetic
 *      session ids (e.g. `claude-subagent-<agentId>`) don't match the
 *      filename patterns the disk search scans for, so the hint is the only
 *      way to locate their jsonl.
 *   2. If the hint is a source PATH and exists on disk, use it (harness
 *      derived from path).
 *   3. Otherwise fall back to filesystem search under `~/.claude/projects/`
 *      then `~/.codex/sessions/`.
 *   4. If the hint is a blob POINTER (see blob-pointer.ts), resolve it
 *      against `<dataDir>/buckets` - the ingest-time cold-storage snapshot,
 *      checked LAST because the live source can have grown since.
 *   5. If nothing matches, throw `TranscriptNotFoundError`.
 *
 * Used by `src/dashboard/session-inspect.ts` and intended as the single
 * source of truth for "where does this session's transcript live?" so future
 * CLI commands (e.g. `axctl session replay`) and re-ingest paths don't have
 * to copy the resolution logic.
 */

import { homedir } from "node:os";
import { Effect, FileSystem, Path, Schema } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "./shared/path.ts";
import { blobPointerBucket, blobPointerPath, isBlobPointer } from "./blob-pointer.ts";
import { resolveDataDirFromEnv } from "./config.ts";
import { CacheRead } from "./duckdb/seam.ts";
import { toBareSessionId } from "./shared/session-id.ts";

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

const RawFileRow = Schema.Struct({ raw_file: Schema.NullOr(Schema.String) });

/** Pull the persisted transcript path (`raw_file`) off the session row.
 *  Defensive: cache error or missing row degrades to null so the search-based
 *  fallback still runs. Mirrors the shape of the other defensive resolvers
 *  in the inspector (see `resolveParent`).
 *
 *  NOTE the failure mode this hides, and why it still degrades rather than
 *  fails: a `null` here is indistinguishable from "no hint recorded", and the
 *  disk search that follows CANNOT find a synthetic subagent id
 *  (`claude-subagent-<agentId>` matches no on-disk filename). So a broken read
 *  here is not an error the caller sees - it is a subagent transcript that
 *  reports "not found". That is the silent regression this port removes, and
 *  the reason the id is a BOUND parameter now: the Surreal spelling spliced a
 *  record id into statement text against a table nothing writes any more. */
const resolveRawFileFromCache = (
    sessionId: string,
): Effect.Effect<string | null, never, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const rows = yield* cache.rows(
            RawFileRow,
            "SELECT raw_file FROM session WHERE id = ? LIMIT 1",
            [toBareSessionId(sessionId)],
        );
        const raw = rows[0]?.raw_file;
        return typeof raw === "string" && raw.length > 0 ? raw : null;
    }).pipe(Effect.catch((err) =>
        Effect.sync(() => {
            console.error("transcript-locator resolveRawFileFromCache failed:", err);
            return null as string | null;
        }),
    ));

/** Where blob pointers resolve: `<dataDir>/buckets`, from `AX_DATA_DIR` else
 *  the default - the same tree the ingest snapshot writer targets. */
const defaultBucketsDir = (): string => posixPath.join(resolveDataDirFromEnv(), "buckets");

/** Which harness's parser reads a SNAPSHOT blob. The bucket is the producer's
 *  identity (transcripts.ts writes `transcripts`, codex.ts writes
 *  `codex_artifacts`), so it answers what `harnessFromPath` answers for live
 *  files - a bucket path never contains `/.codex/sessions/`. */
const harnessFromBucket = (bucket: string): Harness =>
    bucket === "codex_artifacts" ? "codex" : "claude";

/** Disk-only resolution: try the hint, then claude search, then codex search,
 *  then the cold-storage snapshot. No stored-data dep, so it can be exercised
 *  without any read seam.
 *
 *  The `raw_file` hint legitimately holds TWO shapes (see blob-pointer.ts),
 *  and they slot in at different priorities:
 *   - an absolute SOURCE PATH (claude subagents; codex when the snapshot was
 *     skipped) is the live file - it wins outright when it exists;
 *   - a blob POINTER names the ingest-time snapshot - COLD storage, checked
 *     LAST, because the live source (found by path hint or search) can have
 *     grown since the snapshot was taken. Before #891 a pointer hint was
 *     probed with `fs.exists(<pointer>)` - a silent no-op - so snapshots were
 *     never read back and a harness-pruned transcript reported "not found"
 *     while its full copy sat in the bucket. */
const findOnDisk = (
    sessionId: string,
    rawFileHint: string | null,
    bucketsDir: string,
): Effect.Effect<FoundTranscript, TranscriptNotFoundError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pointerHint = rawFileHint !== null && isBlobPointer(rawFileHint) ? rawFileHint : null;
        // Hinted source path wins when it actually exists on disk - this is
        // how synthetic session ids (e.g. claude-subagent-<agentId>) resolve
        // to their real jsonl, since the hint was persisted at ingest time.
        if (rawFileHint && pointerHint === null) {
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
        if (pointerHint !== null) {
            const blobPath = blobPointerPath(bucketsDir, pointerHint);
            const blobExists = yield* fs.exists(blobPath).pipe(orAbsent(false));
            if (blobExists) {
                return {
                    path: blobPath,
                    harness: harnessFromBucket(blobPointerBucket(pointerHint)),
                } satisfies FoundTranscript;
            }
        }
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
    CacheRead | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const hint = yield* resolveRawFileFromCache(sessionId);
        return yield* findOnDisk(sessionId, hint, defaultBucketsDir());
    });

/** Disk-only variant exposed for tests that don't want to spin up a fake
 *  read seam just to exercise the hint + search logic. `bucketsDir` overrides
 *  where a pointer hint resolves (default: `<dataDir>/buckets`). */
export const locateTranscriptOnDisk = (
    sessionId: string,
    rawFileHint: string | null,
    bucketsDir: string = defaultBucketsDir(),
): Effect.Effect<FoundTranscript, TranscriptNotFoundError, FileSystem.FileSystem | Path.Path> =>
    findOnDisk(sessionId, rawFileHint, bucketsDir);
