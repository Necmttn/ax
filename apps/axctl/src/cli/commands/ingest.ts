// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, FileSystem, Layer, Option, Path, References } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Command, Flag } from "effect/unstable/cli";
import { gcFileBuckets, type BlobGcResult } from "@ax/lib/blob-gc";
import { AxConfig } from "@ax/lib/config";
import { jsonParam } from "@ax/lib/duckdb/row";
import { withCacheWrite, type CacheWriteError, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { ProcessService } from "@ax/lib/process";
import { prettyPrint } from "@ax/lib/json";
import { posixPath } from "@ax/lib/shared/path";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { encodeClaudeProjectSlug } from "@ax/lib/transcript-locator";
import { duckdbAssetPathOption } from "../../duckdb-embed-wiring.ts";
import { runIngest, withIngestRunFinish, type RunIngestResult } from "../../ingest/run.ts";
import { resolveIngestDeadlineSeconds } from "../../ingest/deadline.ts";
import { snapshotPath } from "@ax/lib/duckdb/client";
import { reapStaleIngestRuns } from "../../ingest/reap-runs.ts";
import type { OtelRetentionResult } from "../../otel/retention.ts";
import { ingestLockOptions, withIngestLock } from "@ax/lib/ingest-lock";
import { StageRegistry, type IngestStageError, type StageRegistryShape } from "../../ingest/stage/registry.ts";
import { selectByKeys, selectByTag } from "../../ingest/stage/select.ts";
import { type BaseStageStats, type StageDef } from "../../ingest/stage/types.ts";
import { resolvePwdIdentity } from "../../pwd.ts";
import { estimateIngest, formatDryRun } from "../../ingest/dry-run.ts";
import { withConfigWrite } from "../../config-core/reconcile.ts";
import {
    applyReparseSelection,
    REPARSE_TARGETS,
    resolveReparseTargets,
} from "../../ingest/reparse-targets.ts";
// backfillInvokedPositions - Phase B will register this as invokedPositionsStage.
import { deriveSignals } from "../../ingest/derive-signals.ts";
import { deriveTurnIntents } from "../../ingest/derive-intents.ts";
import { ingestClaudeInsights } from "../../ingest/claude-insights.ts";
import {
    createProgressReporter,
    type ProgressMode,
    type ProgressReporter,
} from "../progress.ts";
import { stderrExit } from "../output.ts";
import {
    writeIngestEvent,
    writeIngestRunStart,
    writeIngestStageFinish,
    writeIngestStageStart,
} from "../../ingest/telemetry.ts";
import type { RuntimeManifest } from "./manifest.ts";
import {
    boolArg,
    fail,
    intArg,
    jsonFlag,
    optionValue,
    optionalSince,
    parseCsvFlag,
    requireOptionalPositiveInt,
    stringArg,
} from "./shared.ts";

function runIdFor(command: string): string {
    return Bun.hash(`${command}|${Date.now()}|${Math.random()}`).toString(16).padStart(16, "0");
}

function numericCounts(value: unknown): Record<string, number> {
    if (typeof value !== "object" || value === null) return {};
    const counts: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (typeof raw === "number" && Number.isFinite(raw)) counts[key] = raw;
    }
    return counts;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const telemetryStage = <A, E, R = AxConfig | ProcessService>(
    write: CacheWriteService,
    runId: string,
    source: string,
    stage: string,
    program: Effect.Effect<A, E, R>,
    progress?: ProgressReporter,
): Effect.Effect<A, CacheWriteError | E, R | AxConfig | ProcessService> =>
    Effect.gen(function* () {
        const ledgerKey = { runId, source, stage } as const;
        progress?.start({ source, stage });
        yield* writeIngestStageStart(write, ledgerKey);
        const result = yield* program.pipe(
            Effect.tap((value) => {
                const counts = numericCounts(value);
                return Effect.gen(function* () {
                    progress?.finish({ source, stage }, counts);
                    yield* writeIngestStageFinish(write, { ...ledgerKey, status: "ok", counts });
                    yield* writeIngestEvent(write, {
                        ...ledgerKey,
                        level: "info",
                        message: `${source} ${stage} complete`,
                        counts,
                    });
                });
            }),
            Effect.catch((error) =>
                Effect.gen(function* () {
                    const message = errorText(error);
                    progress?.fail({ source, stage }, message);
                    yield* writeIngestStageFinish(write, {
                        ...ledgerKey,
                        status: "error",
                        errorText: message,
                    });
                    yield* writeIngestEvent(write, {
                        ...ledgerKey,
                        level: "error",
                        message,
                    });
                    return yield* Effect.fail(error);
                }),
            ),
        );
        return result;
    });

const progressUpdater = (
    progress: ProgressReporter | undefined,
    source: string,
    stage: string,
) =>
    (counts: Record<string, number>): Effect.Effect<void> =>
        Effect.sync(() => progress?.update({ source, stage }, counts));

/** Resolve which ingest stages to run from CLI args. Precedence:
 *  `--stages=` (explicit list) > `--derive-only` > all.
 *  Exits with code 2 on an unknown `--stages=` value. */
export const resolveIngestStages = (
    registry: StageRegistryShape,
    args: string[],
): ReadonlyArray<StageDef<BaseStageStats, unknown, IngestStageError>> => {
    const stagesArg = args.find((a) => a.startsWith("--stages="));
    if (stagesArg) {
        const raw = parseCsvFlag(stagesArg.slice("--stages=".length));
        try {
            return selectByKeys(registry, raw);
        } catch (err) {
            fail(`axctl ingest: ${(err as Error).message}`);
        }
    }
    if (args.includes("--derive-only")) return selectByTag(registry, "derive");
    return registry.all();
};


/** Removed `--*-only` flags mapped to the equivalent `--stages=` suggestion.
 *  Effect's CLI parser silently ignores unknown flags, so without this guard
 *  users typing the old flag would get a no-op full ingest. */
const REMOVED_INGEST_FLAGS: ReadonlyArray<readonly [string, string]> = [
    ["--skills-only", "--stages=skills"],
    ["--transcripts-only", "--stages=claude,codex,pi,opencode,cursor"],
    ["--codex-only", "--stages=codex"],
    ["--git-only", "--stages=git"],
    ["--claude-only", "--stages=claude"],
];

/** Returns the removed flag + replacement suggestion if any `args` entry
 *  matches a deprecated `--*-only` flag, else `null`. Exported for tests. */
export const detectRemovedIngestFlag = (
    args: ReadonlyArray<string>,
): { flag: string; replacement: string } | null => {
    for (const [flag, replacement] of REMOVED_INGEST_FLAGS) {
        if (args.includes(flag)) return { flag, replacement };
    }
    return null;
};

interface IngestCommandOpts {
    readonly command?: string;
    readonly cwd?: string;
    readonly repoPaths?: readonly string[];
    readonly claudeProject?: string;
}

/**
 * Blob GC deletes any bucket blob no `session` row references. That is only
 * safe when the run built a COMPLETE reference set - i.e. a truly GLOBAL
 * ingest. `--since` was the only scope the old `fullIngest` gate checked (#F2),
 * but repo/project scope (`ax ingest here`, an explicit project) and a
 * `--stages=` subset each leave the `session` table a PARTIAL view too, so a
 * scoped run would GC blobs referenced only by out-of-scope repos/sessions.
 *
 * This is the single predicate the GC gate reads: true ONLY when NONE of the
 * scope narrowings are present - no `--since=`, no `--stages=`/stage subset,
 * and no repo/project scope (repoPaths / claudeProject, set by
 * `ax ingest here` and project-scoped callers). Retention (otel, rebuildable)
 * is unaffected and still runs on every ingest.
 */
export const isGlobalIngest = (args: readonly string[], opts: IngestCommandOpts = {}): boolean =>
    !args.some((a) => a.startsWith("--since=")) &&
    !args.some((a) => a.startsWith("--stages=")) &&
    opts.repoPaths === undefined &&
    opts.claudeProject === undefined;

/** `ax ingest-here` resumes as `ax ingest here`; everything else as-is. */
const resumeCommand = (command: string): string =>
    command === "ingest-here" ? "ax ingest here" : `ax ${command}`;

/** One-line verdicts (#265) printed to stderr so the outcome of a run is
 *  legible without grepping cascade teardown. Exported for tests. */
export const formatIngestTimeoutVerdict = (command: string, timeoutSeconds: number): string =>
    `ingest: timed out after ${timeoutSeconds}s (AX_INGEST_TIMEOUT_SECONDS) - ` +
    `progress saved, re-run '${resumeCommand(command)}' to continue`;

export const formatIngestFailedVerdict = (sessions: number, firstError: string): string =>
    `ingest: FAILED after ${sessions} sessions - ${firstError}`;

export const formatIngestSkipSummary = (skippedFiles: number): string =>
    `ingest: ok - ${skippedFiles} file(s) skipped (per-file isolation; retried next run)`;

/**
 * Best-effort maintenance run after a successful ingest (otel retention +
 * blob GC). Either side may have failed independently, or blob GC may have
 * declined to run (see `BlobGcResult.skipped`) - callers pass whichever
 * halves actually resolved.
 */
export interface MaintenanceSummary {
    readonly otel?: OtelRetentionResult;
    readonly otelError?: string;
    readonly blobGc?: BlobGcResult;
    readonly blobGcError?: string;
}

/**
 * Write options for the ingest MAINTENANCE writes - the blob GC in `afterWork`
 * and the timeout stamp in `onTimeout`. Never for the ingest itself, which
 * builds its own inside `runIngest`.
 *
 * `publish: false` is the whole reason this is a named function rather than an
 * object literal at the call site. `withCacheWrite` publishes a snapshot when
 * its `body` succeeds, and both of these bodies are one-statement writes that
 * succeed regardless of how the ingest they report on ENDED. With the default
 * they publish the live database as a timed-out run left it - partial rows,
 * derives computed over half-written base tables, no FTS index - as the
 * authoritative snapshot every CLI, MCP and dashboard read then answers from.
 * Ingest holds no transaction, so those partial rows are committed and there is
 * no rollback behind them.
 *
 * Exported so the choice is covered by a test instead of a comment; the seam
 * mechanism itself is regression-tested in packages/lib/src/duckdb/seam.test.ts.
 */
export const maintenanceCacheWriteOptions = (
    dataDir: string,
    lockPath: string,
): {
    readonly livePath: string;
    readonly lockPath: string;
    readonly schemaSql: string;
    readonly publish: false;
    readonly assetPath?: string;
} => ({
    livePath: posixPath.join(dataDir, "ax-live.duckdb"),
    lockPath,
    schemaSql: DUCKDB_SCHEMA_SQL,
    publish: false,
    ...duckdbAssetPathOption(),
});

/** One-line maintenance summary (F5/F6): reports pruned/deleted counts (or
 *  the failure reason) for otel retention + blob GC so a slow-but-successful
 *  ingest's aftermath is legible without grepping the DB. Exported for tests. */
export const formatMaintenanceSummary = (summary: MaintenanceSummary): string => {
    const parts: string[] = [];

    if (summary.otelError) {
        parts.push(`otel retention FAILED - ${summary.otelError}`);
    } else if (summary.otel) {
        const rows = Object.values(summary.otel.deletedByTable).reduce((a, b) => a + b, 0);
        parts.push(`otel pruned ${rows} row(s) + ${summary.otel.deletedEdges} edge(s)`);
    }

    if (summary.blobGcError) {
        parts.push(`blob gc FAILED - ${summary.blobGcError}`);
    } else if (summary.blobGc?.skipped) {
        parts.push(`blob gc skipped (${summary.blobGc.skipReason})`);
    } else if (summary.blobGc) {
        const failedSuffix = summary.blobGc.failed > 0 ? `, ${summary.blobGc.failed} failed` : "";
        parts.push(`blob gc removed ${summary.blobGc.removed}/${summary.blobGc.scanned} blob(s)${failedSuffix}`);
    }

    return `ingest: maintenance - ${parts.join("; ")}`;
};

/** One half of a `MaintenanceSummary` field pair (`otel`/`otelError`,
 *  `blobGc`/`blobGcError`). */
interface MaintenanceHalf<A> {
    readonly result?: A;
    readonly error?: string;
}

/**
 * Run one independent maintenance half, catching its failure into
 * `{ error }` instead of letting it fail the whole `afterWork` - each half
 * must report its own outcome without ever taking the other down with it.
 */
const runMaintenanceHalf = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
): Effect.Effect<MaintenanceHalf<A>, never, R> =>
    effect.pipe(
        Effect.map((result): MaintenanceHalf<A> => ({ result })),
        Effect.catch((error): Effect.Effect<MaintenanceHalf<A>> =>
            Effect.succeed({ error: errorText(error) })),
    );

/**
 * Sessions persisted by this run so far, summed from the per-stage `counts`
 * JSON already written to `ingest_stage` rows. Feeds the FAILED verdict
 * (#265) - the stage stats themselves are lost down the error channel.
 */
// EXCEPTION to the typed-options rule: runIngest({ args }) forwards raw CLI
// args into the stage pipeline (src/ingest/run.ts does its own --stages/
// --since/--reset parsing). Until runIngest grows a typed options contract,
// the ingest handlers stay on string args; the Command handlers below build
// them from typed flags exactly as before.
// Exported for `ax segment import` (#902): after loading a segment it triggers
// the wide-window re-derive through this exact path, so the lock, deadline,
// verdicts, and maintenance summary behave like any other ingest.
export const cmdIngest = (args: string[], opts: IngestCommandOpts = {}) =>
    Effect.gen(function* () {
        const commandName = opts.command ?? "ingest";
        const cfg = yield* AxConfig;
        const path = yield* Path.Path;
        // The wall-clock budget is resolved PER RUN, not baked in: a warm
        // incremental run wants the 900s tripwire, and a first-run backfill
        // legitimately needs hours. One constant cannot be both, which is why
        // every first ingest used to fail (#830). "First run" = no published
        // snapshot yet; `fs.exists` is fail-open to false, so a filesystem
        // hiccup degrades to today's behaviour rather than granting hours.
        const deadline = resolveIngestDeadlineSeconds({
            configuredSeconds: cfg.knobs.ingestTimeoutSeconds,
            knobExplicitlySet: (process.env.AX_INGEST_TIMEOUT_SECONDS ?? "").trim().length > 0,
            firstRun: !(yield* (yield* FileSystem.FileSystem)
                .exists(snapshotPath())
                .pipe(Effect.orElseSucceed(() => true))),
        });
        const timeoutSeconds = deadline.seconds;
        if (deadline.upgraded) yield* Effect.logInfo(`ingest: ${deadline.reason}`);
        // The runId is minted HERE (not inside runIngest) so the timeout and
        // failure paths below can address the `ingest_run` row.
        const runId = runIdFor(commandName);

        // Additive schema self-heal (#283), before any DB write this run. A
        // binary that adds schema fields breaks ingest against a DB whose
        // schema predates them - SCHEMAFULL rejects the UPSERT - when the user
        // swapped the binary without re-running the installer (the #251
        // checksum incident forced exactly that; dev/bench setups hit it too).
        // Replays the bundled DEFINE TABLE/FIELD statements as IF NOT EXISTS,
        // sentinel-gated to once per version, so steady-state ingest pays only
        // an fs.exists. Additive + idempotent + fail-open: on any failure
        // ingest proceeds exactly as today (honest missing-field verdict #265).
        // Sweep ingest_run rows stranded in "running" by crashes / SIGKILL /
        // pre-0.25 binaries before this run starts (#282). Without this, rows
        // left by an old binary warn in `ax doctor` forever - "re-run ax ingest"
        // never cleared them, training users to ignore doctor. The stranded
        // filter only matches rows whose newest heartbeat is past the ingest
        // timeout + grace, so a live concurrent run is never reaped; this run's
        // own row does not exist yet (runIngest creates it). Best-effort: a reap
        // failure must never block the actual ingest.
        // GC's reference set is built from the CURRENT `session` table (#F2):
        // any scoped run (--since window, repo/project scope, or a --stages
        // subset) leaves that table a PARTIAL view of what's referenced. Only a
        // truly GLOBAL ingest run is trustworthy enough to GC against, so the
        // gate reads the single `isGlobalIngest` predicate over args + scope.
        const globalIngest = isGlobalIngest(args, opts);
        const lockPath = posixPath.join(cfg.paths.dataDir, "ingest.lock");
        // MAINTENANCE-ONLY (never the ingest itself - `runIngest` owns its own
        // write scope and its own publish). See `maintenanceCacheWriteOptions`
        // for why these must not publish a snapshot.
        const cacheWriteOptions = maintenanceCacheWriteOptions(cfg.paths.dataDir, lockPath);

        const work = runIngest({
            command: commandName,
            args,
            cwd: opts.cwd ?? process.cwd(),
            ...(opts.repoPaths ? { repoPaths: opts.repoPaths } : {}),
            ...(opts.claudeProject ? { claudeProject: opts.claudeProject } : {}),
            debug: args.includes("--debug"),
            verbose: args.includes("--verbose"),
            runId: () => runId,
            // This run IS wrapped in withIngestLock's hard timeout below, so it
            // genuinely owns a deadline - derive stages are budgeted against it
            // so the pass finalizes itself instead of being guillotined (#697).
            // Computed from the same `timeoutSeconds` knob the lock uses; the
            // lock's own clock starts a hair after this, so the deadline reads
            // slightly early - the derive reserve absorbs that.
            ...(timeoutSeconds > 0 ? { deadlineMs: Date.now() + timeoutSeconds * 1000 } : {}),
        });

        // Best-effort maintenance, still under the lock, but NOT subject to
        // `timeoutSeconds` (F5/F6) - passed as `afterWork` so slow-but-harmless
        // maintenance can never retroactively stamp a genuinely-completed ingest
        // as timeout-failed. Each half is caught independently (never
        // `Effect.ignore`-d silently) so a fault logs a warn line instead of
        // vanishing.
        //
        // The two halves now run in different places, and the split is
        // deliberate. OTLP retention runs INSIDE `runIngest` so its DELETEs land
        // in the snapshot that run publishes; it reports back through
        // `RunIngestResult.otelRetention`, which `withIngestLock` hands to
        // `afterWork` as `completed`. Blob GC touches the bucket directory, not
        // the database, so it stays here - and its write scope must not publish
        // (see `maintenanceCacheWriteOptions`).
        const afterWork = (completed: RunIngestResult): Effect.Effect<void, never> =>
            Effect.gen(function* () {
                const otel = completed.otelRetention;

                const blobGc = yield* runMaintenanceHalf(
                    withCacheWrite(cacheWriteOptions, (write) =>
                        Effect.gen(function* () {
                            const result = yield* write.raw(
                                "SELECT raw_file FROM session WHERE raw_file IS NOT NULL",
                            );
                            const referenced = new Set(
                                result.rows
                                    .map((row) => row.raw_file)
                                    .filter((value): value is string => typeof value === "string"),
                            );
                            return yield* gcFileBuckets(path.join(cfg.paths.dataDir, "buckets"), {
                                isGlobalIngest: globalIngest,
                                referenced,
                            });
                        }),
                    ),
                );
                if (blobGc.error) {
                    process.stderr.write(`axctl ${commandName}: blob gc failed - ${blobGc.error}\n`);
                }

                process.stderr.write(
                    `${
                        formatMaintenanceSummary({
                            ...(otel.result ? { otel: otel.result } : {}),
                            ...(otel.error ? { otelError: otel.error } : {}),
                            ...(blobGc.result ? { blobGc: blobGc.result } : {}),
                            ...(blobGc.error ? { blobGcError: blobGc.error } : {}),
                        })
                    }\n`,
                );
            }).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)));

        // Single-flight + hard wall-clock cap, both owned by the lock. While one
        // ingest holds the lock another SKIPS (the watcher re-fires anyway, so a
        // redundant run is harmless and avoids the pile-up that wedges the DB).
        // The timeout lives inside the lock so that a timed-out run LEAVES its
        // lock to age into a cooldown - interrupting the fiber doesn't prove
        // DuckDB stopped work, so the next ingest must hold off until
        // the lock goes stale rather than charging a still-busy DB.
        const outcome = yield* withIngestLock(
            {
                ...ingestLockOptions(path, cfg.paths.dataDir, commandName, timeoutSeconds),
                timeoutSeconds,
                onBusy: (holder) =>
                    Effect.sync(() =>
                        process.stderr.write(
                            `axctl ${commandName}: another ingest (pid ${holder.pid}, ${holder.command}) ` +
                                `is in progress; skipping.\n`,
                        )
                    ),
                // The interrupt finalizer (withIngestRunFinish) has already
                // settled the row as "partial"/interrupted by the time this
                // runs; overwrite the metrics with the honest timeout reason so
                // diagnosis doesn't need wall-clock correlation (#266, #269).
                // Best-effort: a dead DB must not mask the timeout verdict.
                onTimeout: () =>
                    withCacheWrite(cacheWriteOptions, (write) =>
                        write.exec(
                            "UPDATE ingest_run SET status = 'partial', ended_at = CURRENT_TIMESTAMP, metrics = ? WHERE id = ?",
                            [jsonParam({ error: `timeout after ${timeoutSeconds}s` }), runId],
                        ),
                    ).pipe(
                        Effect.ignore,
                        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
                    ),
                afterWork,
            },
            work,
        ).pipe(
            // Typed failure: print the one-line FAILED verdict (#265) before the
            // error propagates (BunRuntime.runMain then exits 1).
            Effect.tapError((error) =>
                Effect.sync(() => process.stderr.write(
                    `${formatIngestFailedVerdict(0, errorText(error))}\n`,
                )),
            ),
        );

        if (outcome._tag === "timeout") {
            // Timed-out run must not look like success (#265): honest verdict +
            // resume hint (#266), then a non-zero exit. The ingest_run row is
            // already finalized as "partial" by onTimeout above.
            return yield* stderrExit(
                `${formatIngestTimeoutVerdict(commandName, timeoutSeconds)}\n`,
                1,
            );
        }
        if (outcome._tag === "completed") {
            // Per-file isolation (#257) skips broken files instead of failing
            // the run; say so instead of a silent exit 0.
            const skipped = outcome.value.totals["failedFiles"] ?? 0;
            if (skipped > 0) {
                process.stderr.write(`${formatIngestSkipSummary(skipped)}\n`);
            }
        }
    });

/**
 * `ax ingest here` - scope ingest to the git repo at $PWD.
 *
 * By default, stages without a repository-level filter are skipped to preserve
 * the meaning of "here". Passing --stages explicitly runs exactly those stages.
 */
const cmdIngestHere = (args: string[]) => {
    const hasStagesArg = args.some((a) => a.startsWith("--stages="));
    return Effect.gen(function* () {
        const registry = yield* StageRegistry;
        // `cwd` and `repoRoot` are all this uses, and both are git-derived -
        // so it needs the identity and no database.
        const pwd = yield* resolvePwdIdentity().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                stderrExit(`axctl ingest here: not in a git repository (cwd=${err.cwd})\n`, 2),
            ),
        );

        const scopedArgs = hasStagesArg
            ? args
            : [
                ...args,
                `--stages=${registry
                    .all()
                    .map((s) => s.meta.key)
                    // codex now has a cwd filter (#680); pi/opencode/cursor don't yet.
                    .filter((key) => !["pi", "opencode", "cursor"].includes(key))
                    .join(",")}`,
            ];
        if (!hasStagesArg) {
            process.stderr.write(
                "axctl ingest here: pi, opencode, cursor stages skipped - no cwd filter yet\n",
            );
        }

        return yield* cmdIngest(scopedArgs, {
            command: "ingest-here",
            cwd: pwd.cwd,
            repoPaths: [pwd.repoRoot],
            claudeProject: encodeClaudeProjectSlug(pwd.repoRoot),
        });
    });
};

const cmdDeriveSignals = (input: {
    readonly sinceDays: number | undefined;
    readonly progress: ProgressMode;
    readonly verbose: boolean;
}) =>
    Effect.gen(function* () {
        const runId = runIdFor("derive-signals");
        const sinceDays = requireOptionalPositiveInt("derive-signals", "since", input.sinceDays);
        const progress = createProgressReporter({
            command: "derive-signals",
            mode: input.progress,
            runId,
            stages: [{ source: "signals", stage: "derive" }],
        });
        yield* withConfigWrite((write) =>
            Effect.gen(function* () {
                yield* writeIngestRunStart(write, {
                    runId,
                    command: "derive-signals",
                    sinceDays: sinceDays ?? null,
                });
                return yield* withIngestRunFinish(write, runId)(telemetryStage(
                    write,
                    runId,
                    "signals",
                    "derive",
                    deriveSignals(write, { sinceDays, onProgress: progressUpdater(progress, "signals", "derive") }),
                    progress,
                ));
            }),
        ).pipe(
            Effect.provideService(References.MinimumLogLevel, input.verbose ? "Debug" : "Info"),
            Effect.ensuring(Effect.sync(() => progress.stop())),
        );
    });

const cmdIngestInsights = (input: {
    readonly progress: ProgressMode;
    readonly verbose: boolean;
}) =>
    Effect.gen(function* () {
        const runId = runIdFor("ingest-insights");
        const progress = createProgressReporter({
            command: "ingest-insights",
            mode: input.progress,
            runId,
            stages: [
                { source: "claude", stage: "insights" },
            ],
        });
        const program = withConfigWrite((write) =>
            Effect.gen(function* () {
                yield* writeIngestRunStart(write, {
                    runId,
                    command: "ingest-insights",
                    sinceDays: null,
                });
                return yield* withIngestRunFinish(write, runId)(telemetryStage(
                    write,
                    runId,
                    "claude",
                    "insights",
                    ingestClaudeInsights(write),
                    progress,
                ));
            }),
        );
        yield* program.pipe(
            Effect.provideService(References.MinimumLogLevel, input.verbose ? "Debug" : "Info"),
            Effect.ensuring(Effect.sync(() => progress.stop())),
            // ingestClaudeInsights now reads via @effect/platform FileSystem +
            // Path. Provide the Bun-backed layers here so this command's R stays
            // aligned with the sibling `cmdIngest` branch in the `ax ingest`
            // handler (AppLayer also supplies them at the top level; these pure
            // leaf layers are idempotent to re-provide).
            Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        );
    }).pipe(Effect.asVoid);

const verboseFlag = Flag.boolean("verbose").pipe(Flag.withDefault(false));
/**
 * `--debug` opts the user into stderr trace events. Wired only into the
 * ingest command (Task #4). Default off keeps stdout clean for
 * `--progress=json` and friends. When set, the CLI layers
 * `ConsoleTransportLayer` on top of `IngestRuntimeLayer`.
 */
const debugFlag = Flag.boolean("debug").pipe(Flag.withDefault(false));
const progressFlag = Flag.choice("progress", ["auto", "pipeline", "plain", "json", "off"] as const).pipe(
    Flag.withDefault("auto"),
);

/**
 * `--insights-only` short-circuits to `cmdIngestInsights`, bypassing
 * `cmdIngest`. `--since` doesn't apply to insights, so combining them is
 * user-error. Exported for unit testing.
 */
export const insightsOnlyConflicts = (opts: {
    hasSince: boolean;
}): string[] => {
    const conflicts: string[] = [];
    if (opts.hasSince) conflicts.push("--since");
    return conflicts;
};

/**
 * `--reparse[=<targets>]` - drop the skip-unchanged watermark for those inputs
 * so ingest reads them again (#743). Needed after any parser change that
 * recovers evidence from files ax already marked as done; without it the fix
 * only ever applies to files written after it shipped.
 *
 * Sets the stages' existing `AX_REDERIVE_*` switches, so this is a discoverable
 * name for a mechanism that already worked - not a second code path.
 */
const reparseFlag = Flag.string("reparse").pipe(Flag.optional);

const applyReparseFlag = (raw: string | undefined, label: string): void => {
    const selection = resolveReparseTargets(raw);
    if (selection.unknown.length > 0) {
        fail(
            `${label}: unknown --reparse target${selection.unknown.length > 1 ? "s" : ""} ` +
                `${selection.unknown.join(", ")} (known: ${REPARSE_TARGETS.join(", ")}, or all)`,
        );
    }
    applyReparseSelection(selection);
    console.log(`reparse: ignoring the skip-unchanged watermark for ${selection.targets.join(", ")}`);
};


const ingestHereCommand = Command.make(
    "here",
    {
        since: optionalSince,
        stages: Flag.string("stages").pipe(Flag.optional),
        reparse: reparseFlag,
        progress: progressFlag,
        verbose: verboseFlag,
        debug: debugFlag,
    },
    ({ since, stages, reparse, progress, verbose, debug }) => {
        if (Option.isSome(reparse)) applyReparseFlag(optionValue(reparse), "axctl ingest here");
        return cmdIngestHere([
            ...intArg("since", optionValue(since)),
            ...stringArg("stages", optionValue(stages)),
            `--progress=${progress}`,
            ...boolArg("verbose", verbose),
            ...boolArg("debug", debug),
        ]);
    },
).pipe(Command.withDescription(
    "Ingest only the git repository at $PWD. Restricts the claude stage to the matching " +
        "~/.claude/projects/<slug>/ transcript dir, scopes codex sessions to those whose cwd is " +
        "inside this repo, and restricts git history to this repo path. " +
        "Pi, OpenCode, and Cursor are skipped by default (no cwd filter yet). " +
        "--stages=<a,b,c> overrides the default set. " +
        "--reparse=<targets|all> re-reads inputs the skip-unchanged watermark would skip.",
));

const ingestReapCommand = Command.make(
    "reap",
    { dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)), json: jsonFlag },
    ({ dryRun, json }) =>
        Effect.gen(function* () {
            const result = yield* withConfigWrite((write) => reapStaleIngestRuns(write, { dryRun }));
            if (json) {
                console.log(prettyPrint(result));
                return;
            }
            if (result.found === 0) {
                console.log("no stale ingest_run rows - nothing to reap");
                return;
            }
            console.log(`${dryRun ? "would reap" : "reaped"} ${result.found} stale ingest_run row(s):`);
            for (const id of result.ids) console.log(`  ingest_run:${id}`);
            if (dryRun) console.log("(dry-run - no writes)");
        }),
).pipe(
    Command.withDescription(
        "Settle ingest_run rows stranded in status \"running\" past the ingest timeout " +
            "(crash/SIGKILL residue that doctor flags). Marks each \"partial\"; idempotent. Use --dry-run to preview.",
    ),
);

export const ingestCommand = Command.make(
    "ingest",
    {
        insightsOnly: Flag.boolean("insights-only").pipe(Flag.withDefault(false)),
        // Run a chosen subset of stages, e.g. --stages=signals,outcomes.
        stages: Flag.string("stages").pipe(Flag.optional),
        // Shortcut: run every stage tagged `derive` (currently signals,
        // outcomes, session-health, closure, proposals, opportunities,
        // retro-proposals, subagents, spawned, harness) and skip the slow
        // transcript + git parse. Tag membership lives on each stage; see
        // ADR-0009 and the stage registry for the canonical list.
        deriveOnly: Flag.boolean("derive-only").pipe(Flag.withDefault(false)),
        // Wipe the skill graph before a full re-ingest so it rebuilds clean.
        reset: Flag.boolean("reset").pipe(Flag.withDefault(false)),
        // Estimate how long a full backfill takes (counts sources + times a
        // small sample) and exit without running the full ingest.
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        json: jsonFlag,
        since: optionalSince,
        // Re-read inputs whose watermark says "unchanged" (see reparseFlag).
        reparse: reparseFlag,
        progress: progressFlag,
        verbose: verboseFlag,
        debug: debugFlag,
    },
    ({ insightsOnly, stages, deriveOnly, reset, dryRun, json, since, reparse, progress, verbose, debug }) => {
        if (Option.isSome(reparse)) applyReparseFlag(optionValue(reparse), "axctl ingest");
        if (dryRun) {
            // Same runtime layer (IngestRuntimeLayer via withIngest) provides
            // estimateIngest's services (AxConfig/FS/Path); the cast
            // aligns this branch's requirement set with the other ingest branches
            // so Command.make infers one handler return type.
            return Effect.gen(function* () {
                const result = yield* withConfigWrite((write) => estimateIngest(write, {
                    sinceDays: Option.getOrUndefined(since),
                }));
                console.log(formatDryRun(result, json));
            }) as ReturnType<typeof cmdIngest>;
        }
        if (insightsOnly) {
            if (reset) {
                fail("axctl ingest: --reset cannot be combined with --insights-only");
            }
            const conflicts = insightsOnlyConflicts({
                hasSince: Option.isSome(since),
            });
            if (conflicts.length > 0) {
                fail(`axctl ingest: --insights-only is mutually exclusive with ${conflicts.join(", ")}`);
            }
            return cmdIngestInsights({ progress, verbose });
        }
        return cmdIngest([
            ...stringArg("stages", optionValue(stages)),
            ...boolArg("derive-only", deriveOnly),
            ...boolArg("reset", reset),
            ...intArg("since", optionValue(since)),
            `--progress=${progress}`,
            ...boolArg("verbose", verbose),
            ...boolArg("debug", debug),
        ]);
    },
).pipe(
    Command.withDescription(
        "Ingest skills, local agent transcripts, git history, and insight artifacts. " +
            "Use --dry-run [--json] to estimate how long a full backfill will take (and exit). " +
            "Use --stages=<a,b,c> for a custom subset, or --derive-only to run every stage tagged `derive` " +
            "(see ADR-0009; canonical list lives in src/ingest/stage/registry.ts). " +
            "Use --reset to wipe the skill graph first and rebuild it clean. " +
            "Use --reparse=<targets|all> (e.g. --reparse=claude) to ignore the skip-unchanged " +
            "watermark and re-read inputs ax already ingested - needed to backfill evidence a " +
            "parser fix newly recovers.",
    ),
    Command.withSubcommands([ingestHereCommand, ingestReapCommand]),
);

// Shared flag specs + handlers for the derive verbs. They back BOTH the flat
// top-level commands (`derive-signals` / `derive-intents` - hardcoded in the
// installed LaunchAgent plists, MUST keep working) AND the grouped
// `derive signals` / `derive intents` forms under the `derive` parent.
const deriveSignalsFlags = { since: optionalSince, progress: progressFlag, verbose: verboseFlag } as const;
const handleDeriveSignals = ({ since, progress, verbose }: {
    since: Option.Option<number>;
    progress: ProgressMode;
    verbose: boolean;
}) =>
    cmdDeriveSignals({ sinceDays: optionValue(since), progress, verbose });

const deriveIntentsFlags = {
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
} as const;
const handleDeriveIntents = ({ dryRun, json }: { dryRun: boolean; json: boolean }) =>
    Effect.gen(function* () {
        const summary = yield* withConfigWrite((write) => deriveTurnIntents(write, { dryRun }));
        if (json) {
            console.log(prettyPrint({
                considered: summary.considered,
                changed: summary.changed,
                by_transition: summary.byTransition,
                dry_run: dryRun,
            }));
            return;
        }
        console.log(`considered: ${summary.considered}`);
        console.log(`changed:    ${summary.changed}${dryRun ? "  (dry-run - no writes)" : ""}`);
        if (summary.changed === 0) return;
        console.log("");
        console.log("transitions:");
        const sorted = Object.entries(summary.byTransition).sort((a, b) => b[1] - a[1]);
        for (const [transition, n] of sorted) {
            console.log(`  ${String(n).padStart(6)}  ${transition}`);
        }
    });

const deriveSignalsDescription = "Derive friction, diagnostic, recommendation, and recovery signals";
const deriveIntentsDescription = "Re-run intent classification over existing turn rows; updates intent_kind in place";

// Flat top-level forms - referenced by name in the installed LaunchAgent plists
// (`${binPath} derive-signals --since=1`). Do NOT rename or remove.
export const deriveSignalsCommand = Command.make("derive-signals", deriveSignalsFlags, handleDeriveSignals)
    .pipe(Command.withDescription(deriveSignalsDescription));

export const deriveIntentsCommand = Command.make("derive-intents", deriveIntentsFlags, handleDeriveIntents)
    .pipe(Command.withDescription(deriveIntentsDescription));

// Grouped forms: `axctl derive signals` / `axctl derive intents`. Same handlers,
// shorter sub-names, surfaced under one `derive` entry in the top-level index.
export const deriveCommand = Command.make("derive").pipe(
    Command.withDescription("Derive signals and intents from ingested turns"),
    Command.withSubcommands([
        Command.make("signals", deriveSignalsFlags, handleDeriveSignals)
            .pipe(Command.withDescription(deriveSignalsDescription)),
        Command.make("intents", deriveIntentsFlags, handleDeriveIntents)
            .pipe(Command.withDescription(deriveIntentsDescription)),
    ]),
);

export const ingestRuntime: RuntimeManifest = {
    ingest: "ingest",
    // Hidden maintenance verbs. `derive-signals`/`derive-intents` MUST stay
    // callable - the installed LaunchAgent plists invoke them by name.
    //
    // Runtime `"ingest"`, not `"db"`: all three handlers write through
    // `withConfigWrite` -> the DuckDB seam, and never resolve a database
    // connection through `withDb`. `withIngest` gives them the same
    // `AxConfig`/platform/trace stack, the panicking no-DB client, and the
    // trace transport the progress reporter needs.
    derive: { runtime: "ingest", hidden: true },
    "derive-signals": { runtime: "ingest", hidden: true },
    "derive-intents": { runtime: "ingest", hidden: true },
};
