/**
 * recover.ts - locate + targeted-ingest fallback for `ax share` when the
 * session isn't in the graph yet (#270).
 *
 * The session a user most wants to share - the live one they're in - is by
 * definition not ingested yet. On an export miss the share command uses this
 * module to (1) find the transcript on disk via the canonical
 * TranscriptLocator, (2) run the narrowest existing ingest for it (claude:
 * the stage's per-project filter, the same one `ax ingest here` uses; codex:
 * the date-bucketed --since walk - there is no per-file filter), then the
 * caller retries the export once.
 *
 * The ingest runs under the same single-flight lock as every other CLI
 * ingest (see ingest-lock.ts): if the watcher or a manual ingest holds it,
 * we surface "busy" instead of piling a second ingest onto the DB.
 */
import { Effect, FileSystem, Option, Path } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient } from "@ax/lib/db";
import { ProcessService } from "@ax/lib/process";
import { TraceSink } from "@ax/lib/live-traces/Sink";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import { locateTranscript, type Harness } from "@ax/lib/transcript-locator";
import { runIngest } from "../ingest/run.ts";
import { withIngestLock } from "../ingest/ingest-lock.ts";
import { StageRegistry } from "../ingest/stage/registry.ts";

/** A transcript found on disk for a session that isn't in the graph. */
export interface ShareTranscriptHit {
    readonly path: string;
    readonly harness: Harness;
}

export type ShareIngestOutcome =
    | { readonly kind: "ingested" }
    | { readonly kind: "busy"; readonly pid: number; readonly command: string }
    | { readonly kind: "failed"; readonly message: string };

/** Mirrors cli/commands/ingest.ts: extra grace beyond the hard ingest timeout
 *  before a held lock is deemed stale and stolen. */
const INGEST_LOCK_STALE_GRACE_MS = 60_000;

/**
 * --since window for the targeted ingest: just wide enough to include the
 * transcript's mtime (min 1 day), so the project-scoped claude stage / codex
 * date walk picks the file up without backfilling unrelated history.
 */
export const sinceDaysForMtime = (mtimeMs: number, nowMs: number): number =>
    Math.max(1, Math.ceil((nowMs - mtimeMs) / 86_400_000) + 1);

/**
 * Find the on-disk transcript for `sessionId` (claude then codex), or null.
 * Uses the canonical TranscriptLocator - DB `raw_file` hint first (a no-op
 * here since the session isn't ingested), then filesystem search.
 */
export const locateShareTranscript = (
    sessionId: string,
): Effect.Effect<
    ShareTranscriptHit | null,
    never,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    locateTranscript(toBareSessionId(sessionId)).pipe(
        Effect.map((found): ShareTranscriptHit | null => ({
            path: found.path,
            harness: found.harness,
        })),
        // TranscriptNotFoundError -> null: the caller renders "not found".
        Effect.orElseSucceed(() => null),
    );

/**
 * Run the narrowest existing ingest that covers `hit`, under the
 * single-flight ingest lock. Never fails: every error (DB, stage, defect)
 * degrades to `{ kind: "failed" }` so the share command can report what was
 * attempted instead of crashing.
 */
export const ingestShareTranscript = (
    hit: ShareTranscriptHit,
): Effect.Effect<
    ShareIngestOutcome,
    never,
    SurrealClient | AxConfig | ProcessService | StageRegistry | TraceSink | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const mtimeMs = yield* fs.stat(hit.path).pipe(
            Effect.map((info) => Option.getOrElse(info.mtime, () => new Date()).getTime()),
            Effect.orElseSucceed(() => Date.now()),
        );
        const sinceDays = sinceDaysForMtime(mtimeMs, Date.now());

        // Claude transcripts: scope the stage to the single
        // ~/.claude/projects/<slug>/ dir the file lives in (the same
        // `claudeProject` filter `ax ingest here` passes). Codex has no
        // per-project filter; the --since window is the narrowest scope.
        const relative = path.relative(cfg.paths.transcriptsDir, hit.path);
        const claudeProject = hit.harness === "claude" && !relative.startsWith("..")
            ? relative.split(path.sep)[0]
            : undefined;

        const timeoutSeconds = cfg.knobs.ingestTimeoutSeconds;
        const work = runIngest({
            command: "share-ingest",
            args: [`--stages=${hit.harness}`, `--since=${sinceDays}`],
            cwd: process.cwd(),
            ...(claudeProject ? { claudeProject } : {}),
            // This run is wrapped in the same `withIngestLock` hard timeout
            // below, so - like cli/commands/ingest.ts - it genuinely owns a
            // deadline (#697). The `--stages=<harness>` filter above never
            // selects a `derive`-tagged stage today, so this is currently a
            // no-op; passing it anyway keeps the invariant honest ("a caller
            // wrapped in a real timeout passes one") instead of silently
            // relying on today's stage selection never changing.
            ...(timeoutSeconds > 0 ? { deadlineMs: Date.now() + timeoutSeconds * 1000 } : {}),
        }).pipe(Effect.as<ShareIngestOutcome>({ kind: "ingested" }));

        const outcome = yield* withIngestLock(
            {
                lockPath: path.join(cfg.paths.dataDir, "ingest.lock"),
                command: "share-ingest",
                staleMs: timeoutSeconds * 1000 + INGEST_LOCK_STALE_GRACE_MS,
                timeoutSeconds,
                onBusy: (holder) =>
                    Effect.succeed<ShareIngestOutcome>({
                        kind: "busy",
                        pid: holder.pid,
                        command: holder.command,
                    }),
            },
            work,
        );

        // On timeout the lock is deliberately left as a cooldown (see
        // ingest-lock.ts header); completed/busy both carry a ShareIngestOutcome.
        if (outcome._tag === "timeout") {
            return {
                kind: "failed",
                message: `ingest exceeded ${timeoutSeconds}s and was cancelled; retry shortly`,
            } satisfies ShareIngestOutcome;
        }
        return outcome.value;
    }).pipe(
        Effect.catch((error) =>
            Effect.succeed<ShareIngestOutcome>({
                kind: "failed",
                message: error instanceof Error ? error.message : String(error),
            })
        ),
        Effect.catchDefect((defect) =>
            Effect.succeed<ShareIngestOutcome>({
                kind: "failed",
                message: defect instanceof Error ? defect.message : String(defect),
            })
        ),
    );
