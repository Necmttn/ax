/**
 * Repo-scope filter for codex `ingest here` (#680).
 *
 * The codex parser already extracts each rollout's cwd from its `session_meta`
 * head line and lands it on `session.cwd`. To scope `ingest here` to the repo
 * at $PWD we head-peek that cwd BEFORE the full parse and drop rollouts whose
 * cwd is outside the repo root - the cheapest viable filter (a few lines read,
 * not a full parse of every global session).
 */

import { Effect, FileSystem, Stream } from "effect";
import type { PlatformError } from "effect";
import { safeJsonParse } from "@ax/lib/shared/safe-json";

/** How many head lines to scan for the `session_meta` record. It is line 1 in
 *  practice; the small budget tolerates a stray leading line without reading
 *  the whole (possibly 30 MB) file. */
const HEAD_LINE_BUDGET = 8;

const stripTrailingSlash = (p: string): string => p.replace(/\/+$/, "");

/**
 * Is `cwd` inside one of `repoRoots`? Exact match or a true path-segment
 * descendant (so `/x/ax` does NOT capture the sibling `/x/ax-extra`).
 */
export const cwdInRepoScope = (cwd: string | null | undefined, repoRoots: readonly string[]): boolean => {
    if (!cwd) return false;
    const c = stripTrailingSlash(cwd);
    return repoRoots.some((root) => {
        const r = stripTrailingSlash(root);
        return c === r || c.startsWith(`${r}/`);
    });
};

/** Extract `cwd` from a codex `session_meta` JSONL line, or null if the line is
 *  not a session_meta / has no cwd / is malformed. Pure. */
export const codexCwdFromMetaLine = (line: string): string | null => {
    if (!line.trim()) return null;
    const parsed = safeJsonParse<{ type?: unknown; payload?: unknown }>(line);
    if (!parsed || parsed.type !== "session_meta") return null;
    const payload = parsed.payload;
    if (typeof payload !== "object" || payload === null) return null;
    const cwd = (payload as { cwd?: unknown }).cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
};

/**
 * Head-peek a codex rollout file for its session cwd. Reads at most
 * {@link HEAD_LINE_BUDGET} lines (the stream is torn down early). Best-effort:
 * any read error (vanished / unreadable file) recovers to null so the caller
 * simply treats it as out-of-scope; the genuine fault, if any, surfaces on a
 * later full ingest.
 */
export const readCodexSessionCwd = (
    filePath: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let cwd: string | null = null;
        yield* fs.stream(filePath).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(HEAD_LINE_BUDGET),
            Stream.runForEach((line) =>
                Effect.sync(() => {
                    if (cwd === null) cwd = codexCwdFromMetaLine(line);
                }),
            ),
            Effect.catchTag("PlatformError", (_e: PlatformError.PlatformError) => Effect.void),
        );
        return cwd;
    });
