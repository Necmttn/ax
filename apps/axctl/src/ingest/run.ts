import { Cause, Effect, Exit, Option, References } from "effect";
import { AxConfig } from "@ax/lib/config";
import { withCacheWrite, type CacheWriteError, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { buildFtsIndexes } from "@ax/lib/duckdb/fts";
import { posixPath } from "@ax/lib/shared/path";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { duckdbAssetPathOption } from "../duckdb-embed-wiring.ts";
import type { FileSystem } from "effect";
import { LiveTrace } from "@ax/lib/live-traces/index";
import { TraceSink } from "@ax/lib/live-traces/Sink";
import { ProcessService } from "@ax/lib/process";
import {
    reconcileStrandedIngestStages,
    writeIngestEvent,
    writeIngestRunFinish,
    writeIngestRunStart,
    writeIngestStageFinish,
    writeIngestStageStart,
} from "./telemetry.ts";
import { runPipeline } from "./stage/runner.ts";
import { selectByKeys, selectByTag } from "./stage/select.ts";
import { StageRegistry, type IngestStageError, type StageRegistryShape } from "./stage/registry.ts";
import { BaseStageStats, IngestContext, type StageDef } from "./stage/types.ts";
import { reapStaleIngestRuns } from "./reap-runs.ts";
import { correlateOrphanOtel } from "../otel/correlate.ts";
import { retainRecentOtel, type OtelRetentionResult } from "../otel/retention.ts";

export interface StageEventName {
    readonly source: string;
    readonly stage: string;
}

const STAGE_EVENT_NAMES: Record<string, StageEventName> = {
    skills: { source: "skills", stage: "upsert" },
    commands: { source: "commands", stage: "upsert" },
    pricing: { source: "pricing", stage: "models" },
    claude: { source: "claude", stage: "transcripts" },
    codex: { source: "codex", stage: "sessions" },
    pi: { source: "pi", stage: "sessions" },
    omp: { source: "omp", stage: "sessions" },
    opencode: { source: "opencode", stage: "sessions" },
    cursor: { source: "cursor", stage: "sessions" },
    subagents: { source: "claude", stage: "subagents" },
    "invoked-positions": { source: "invoked", stage: "backfill-positions" },
    spawned: { source: "signals", stage: "spawned" },
    git: { source: "git", stage: "history" },
    signals: { source: "signals", stage: "derive" },
    outcomes: { source: "outcomes", stage: "derive" },
    "turn-content-blocks": { source: "turn-content-blocks", stage: "derive" },
    "turn-analysis": { source: "turn-analysis", stage: "derive" },
    "session-health": { source: "session-health", stage: "derive" },
    closure: { source: "closure", stage: "derive" },
    proposals: { source: "proposals", stage: "derive" },
    opportunities: { source: "opportunities", stage: "derive" },
    "retro-proposals": { source: "retro-proposals", stage: "derive" },
    harness: { source: "harness", stage: "doctor" },
};

export const stageEventName = (key: string): StageEventName =>
    STAGE_EVENT_NAMES[key] ?? { source: key, stage: "run" };

const flag = (name: string, args: readonly string[]): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const parseOptionalPositiveIntFlag = (
    command: string,
    flagName: string,
    args: readonly string[],
): number | undefined => {
    const raw = flag(flagName, args);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`axctl ${command}: --${flagName} must be a positive integer (got "${raw}")`);
    }
    return n;
};

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Settle the `ingest_run` row for every way the wrapped effect can finish,
 * in ONE uninterruptible `onExit` finalizer (replaces the old triplicated
 * tap-ok / catch-error / onExit-interrupt trio):
 *
 *  - success       -> status "ok"
 *  - typed failure -> status "error" + `{ error: <message> }`; the original
 *                     failure still propagates
 *  - interruption  -> status "partial" + `{ error: "interrupted" }` (best
 *                     effort - the write itself is `Effect.ignore`d).
 *                     "partial", not "error": ingest is incremental, so a
 *                     Ctrl-C/timeout keeps everything persisted so far and a
 *                     re-run continues (#266). The timeout path in
 *                     cmdIngest's `onTimeout` then overwrites the metrics
 *                     with the honest timeout reason.
 *  - defect        -> status "error" + the squashed defect text (best
 *                     effort) - a crash must never strand the row in
 *                     "running" (#269); the defect still propagates
 *
 * The finalizer runs while the cache write scope is still open (inner
 * scope unwinds before the layer closes the connection), so the last write
 * has a live connection. The interruption arm requires the process main
 * fiber to actually be interrupted on SIGINT - see BunRuntime.runMain in
 * cli/index.ts. A hard kill (SIGKILL/power loss) runs no finalizer at all;
 * `ax doctor`'s stale-run check catches those rows.
 */
export const withIngestRunFinish = (write: CacheWriteService, runId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | CacheWriteError, R> =>
        Effect.onExit(effect, (exit): Effect.Effect<void, CacheWriteError> => {
            const finish = (status: "ok" | "error" | "partial", metrics: unknown = {}) =>
                writeIngestRunFinish(write, { runId, status, metrics });
            if (Exit.isSuccess(exit)) {
                return finish("ok");
            }
            // Read the cause before the `hasInterrupts` guard: its negative
            // branch would otherwise narrow `exit` to `never`.
            const cause = exit.cause;
            if (Exit.hasInterrupts(exit)) {
                return finish("partial", { error: "interrupted" }).pipe(Effect.ignore);
            }
            const failure = Cause.findErrorOption(cause);
            if (Option.isSome(failure)) {
                return finish("error", { error: errorText(failure.value) });
            }
            // Defect: still settle the row (never leave "running"), best
            // effort; the defect itself propagates past this finalizer.
            return finish("error", { error: errorText(Cause.squash(cause)) }).pipe(Effect.ignore);
        });

const numericCounts = (value: unknown): Record<string, number> => {
    if (typeof value !== "object" || value === null) return {};
    const counts: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (typeof raw === "number" && Number.isFinite(raw)) counts[key] = raw;
    }
    return counts;
};

const resolveStages = (
    registry: StageRegistryShape,
    args: readonly string[],
): ReadonlyArray<StageDef<BaseStageStats, unknown, IngestStageError>> => {
    const hasStagesArg = args.some((a) => a.startsWith("--stages="));
    const hasDeriveOnly = args.includes("--derive-only");
    if (hasStagesArg && hasDeriveOnly) {
        throw new Error("axctl ingest: --stages and --derive-only are mutually exclusive");
    }

    const stagesArg = args.find((a) => a.startsWith("--stages="));
    if (stagesArg) {
        const keys = stagesArg
            .slice("--stages=".length)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        return selectByKeys(registry, keys);
    }

    if (args.includes("--derive-only")) return selectByTag(registry, "derive");
    return registry.all();
};

/**
 * Settle one stage row from the stage's `Exit`, on EVERY exit path.
 *
 * This mirrors {@link withIngestRunFinish} deliberately: the run-level finalizer
 * already had all four arms (success / typed failure / interruption / defect),
 * and the stage-level wrapper had only the first two. That asymmetry is #840 -
 * `Effect.tap` runs only on success and `Effect.catch` only on a typed failure,
 * so an INTERRUPTED stage reached neither and its row stayed `running` forever,
 * with no `ended_at` and no reason. Both the derive watchdog
 * (`stage/runner.ts`, `Effect.timeoutOrElse`) and the outer run deadline
 * interrupt stages, which is why 38 rows accumulated - 3 of them inside a run
 * that reported `ok`, since the watchdog fails OPEN with a success sentinel.
 *
 * The interruption and defect arms `ignore` their write errors, exactly as the
 * run-level finalizer does: a run that is already being torn down must not have
 * its cause replaced by a bookkeeping failure. Success and typed failure let a
 * write error propagate, because there the write IS the work.
 *
 * Exported for tests: the four arms are the contract, and crafting an `Exit`
 * directly covers the interruption case that no end-to-end ingest test can
 * trigger reliably.
 */
export const settleStage = (
    write: CacheWriteService,
    ledgerKey: { readonly runId: string; readonly source: string; readonly stage: string },
    eventName: { readonly source: string; readonly stage: string },
    exit: Exit.Exit<BaseStageStats, IngestStageError>,
): Effect.Effect<void, CacheWriteError> => {
    if (Exit.isSuccess(exit)) {
        const counts = numericCounts(exit.value);
        return Effect.gen(function* () {
            yield* writeIngestStageFinish(write, { ...ledgerKey, status: "ok", counts });
            yield* writeIngestEvent(write, {
                ...ledgerKey,
                level: "info",
                message: `${eventName.source} ${eventName.stage} complete`,
                counts,
            });
        });
    }
    // Read the cause before the `hasInterrupts` guard: its negative branch
    // would otherwise narrow `exit` to `never`.
    const cause = exit.cause;
    const settle = (status: "error" | "interrupted", message: string) =>
        Effect.gen(function* () {
            yield* writeIngestStageFinish(write, { ...ledgerKey, status, errorText: message });
            yield* writeIngestEvent(write, {
                ...ledgerKey,
                level: "error",
                message,
            });
        });
    if (Exit.hasInterrupts(exit)) {
        // The watchdog overwrites this row with `timeout` immediately after,
        // via `recordStageOutcome` - it knows the cap, and this arm does not.
        return settle(
            "interrupted",
            "interrupted - the run ended before this stage finished (deadline, watchdog cap, or SIGINT)",
        ).pipe(Effect.ignore);
    }
    const failure = Cause.findErrorOption(cause);
    if (Option.isSome(failure)) {
        return settle("error", errorText(failure.value));
    }
    // Defect: still settle the row (never leave "running"), best effort; the
    // defect itself propagates past this finalizer.
    return settle("error", errorText(Cause.squash(cause))).pipe(Effect.ignore);
};

const wrapStage = (
    runId: string,
    stageDef: StageDef<BaseStageStats, AxConfig | ProcessService, IngestStageError>,
): StageDef<BaseStageStats, AxConfig | ProcessService, IngestStageError> => {
    const eventName = stageEventName(stageDef.meta.key);
    const ledgerKey = { runId, source: eventName.source, stage: eventName.stage } as const;
    return {
        ...stageDef,
        run: (ctx: IngestContext, write: CacheWriteService) =>
            Effect.gen(function* () {
                yield* writeIngestStageStart(write, ledgerKey);
                return yield* Effect.onExit(stageDef.run(ctx, write), (exit) =>
                    settleStage(write, ledgerKey, eventName, exit),
                );
            }),
    };
};

/**
 * Settle a stage the RUNNER decided about without ever entering (or while
 * cutting short) the stage body - the two cases the stage's own `Exit` cannot
 * describe honestly.
 *
 * `timeout`: the derive watchdog capped a running stage. The stage body was
 * interrupted, so {@link settleStage} has already written `interrupted`; this
 * overwrites it with the precise status and the cap that fired. Ordering is
 * guaranteed - `Effect.timeoutOrElse` completes the body's interruption
 * (finalizers included) before it runs `orElse`.
 *
 * `skipped`: the stage never started, so it has NO row at all. Writing one is
 * the point: a stage silently dropped for want of budget is indistinguishable
 * from a stage that was never configured, and that ambiguity is what made a
 * blank skill graph look like a broken feature rather than a starved derive.
 */
const recordRunnerStageOutcome = (
    runId: string,
    write: CacheWriteService,
) =>
(
    stageKey: string,
    outcome: { readonly status: "timeout" | "skipped"; readonly errorText: string },
): Effect.Effect<void> =>
    Effect.gen(function* () {
        const eventName = stageEventName(stageKey);
        const ledgerKey = { runId, source: eventName.source, stage: eventName.stage } as const;
        if (outcome.status === "skipped") yield* writeIngestStageStart(write, ledgerKey);
        yield* writeIngestStageFinish(write, {
            ...ledgerKey,
            status: outcome.status,
            errorText: outcome.errorText,
        });
    }).pipe(Effect.ignore);

export interface RunIngestOptions {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly repoPaths?: readonly string[];
    readonly claudeProject?: string;
    readonly debug?: boolean;
    readonly verbose?: boolean;
    readonly now?: () => Date;
    readonly runId?: () => string;
    /**
     * The run's wall-clock deadline (epoch ms). `derive`-tagged stages are
     * budgeted against it so the pass ends cleanly instead of being
     * guillotined by an outer timeout (#697) - see `runner.ts`'s
     * `runPipeline` for the budgeting itself.
     *
     * `runIngest` owns no timeout of its own; it only forwards whatever
     * deadline the CALLER supplies, because only the caller knows whether one
     * actually exists. `cli/commands/ingest.ts` and `share/recover.ts` both
     * wrap this run in `withIngestLock`'s hard timeout and pass a deadline
     * derived from the same `ingestTimeoutSeconds` knob. `dashboard/
     * ingest-workflow.ts` (the Studio Live tab) forks this run with NO
     * timeout at all and passes nothing - a derive budget there would guard
     * against a guillotine that doesn't exist, silently making the Live tab
     * drop long-running derives for no reason (this was the bug: an earlier
     * version computed this deadline unconditionally from `AxConfig`, which
     * applied it to every caller regardless of whether one wrapped the run).
     */
    readonly deadlineMs?: number;
}

/**
 * The outcome of OTLP retention, carried OUT of the run rather than swallowed.
 *
 * Retention runs inside `runIngest` (not in the CLI's `afterWork`) because its
 * DELETEs have to land in the snapshot this run publishes - housekeeping that
 * only reaches the live database would be invisible to every reader until the
 * next ingest. But "runs inside the run" must not mean "reports nowhere": an
 * `Effect.ignore` here is a silent, recurring data-retention failure, and the
 * CLI already owns a maintenance summary line built for exactly this. So the
 * result (or the failure text) rides back on `RunIngestResult` and the caller
 * prints it - `withIngestLock` hands the completed value to `afterWork`.
 *
 * Exactly one of the two fields is set.
 */
export interface OtelRetentionOutcome {
    readonly result?: OtelRetentionResult;
    readonly error?: string;
}

export interface RunIngestResult {
    readonly runId: string;
    readonly selectedStages: readonly string[];
    readonly status: "ok";
    /** Numeric stage stats summed across all stages (e.g. `sessions`,
     *  `failedFiles` from the per-file isolation guards). `durationMs` is
     *  excluded - summing wall-clocks across concurrent stages is noise. */
    readonly totals: Record<string, number>;
    /** OTLP retention's outcome, for the caller's maintenance summary. */
    readonly otelRetention: OtelRetentionOutcome;
}

const defaultRunId = (command: string): string =>
    Bun.hash(`${command}|${Date.now()}|${Math.random()}`).toString(16).padStart(16, "0");

export const runIngest = (
    opts: RunIngestOptions,
): Effect.Effect<
    RunIngestResult,
    IngestStageError | CacheWriteError,
    AxConfig | ProcessService | StageRegistry | TraceSink | FileSystem.FileSystem
> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const registry = yield* StageRegistry;
        return yield* withCacheWrite(
            {
                livePath: posixPath.join(cfg.paths.dataDir, "ax-live.duckdb"),
                lockPath: posixPath.join(cfg.paths.dataDir, "ingest.lock"),
                schemaSql: DUCKDB_SCHEMA_SQL,
                ...duckdbAssetPathOption(),
            },
            (write) => Effect.gen(function* () {
        yield* reapStaleIngestRuns(write).pipe(Effect.ignore);
        // Deadline ownership lives with the CALLER (see RunIngestOptions.deadlineMs)
        // - forward it as-is, or apply none.
        const deadlineMs = opts.deadlineMs;
        const hasFilter = opts.args.some((a) => a.startsWith("--stages=")) || opts.args.includes("--derive-only");
        if (opts.args.includes("--reset") && hasFilter) {
            throw new Error(`axctl ${opts.command}: --reset rebuilds the whole skill graph and cannot be combined with stage filters`);
        }

        const selectedStages = resolveStages(registry, opts.args);
        const sinceDays = parseOptionalPositiveIntFlag(opts.command, "since", opts.args);
        const runId = opts.runId?.() ?? defaultRunId(opts.command);
        const now = opts.now?.() ?? new Date();

        yield* writeIngestRunStart(write, {
            runId,
            command: opts.command,
            sinceDays: sinceDays ?? null,
        });

        // Clean up after runs that could not clean up after themselves. A
        // finalizer cannot run on SIGKILL or power loss, so settling every stage
        // on every exit path is necessary but never sufficient - the next run
        // has to reconcile the residue (#840). Deliberately AFTER
        // `reapStaleIngestRuns` above, which is what marks a stranded RUN
        // terminal; this only touches stages whose parent run already is, so a
        // concurrent run's live stages are untouched. Best effort: bookkeeping
        // must not be able to fail an ingest.
        const reconciled = yield* reconcileStrandedIngestStages(write, runId).pipe(
            Effect.catchCause(() => Effect.succeed(0)),
        );
        if (reconciled > 0) {
            yield* Effect.logInfo(
                `ingest: reconciled ${reconciled} stage row(s) stranded at 'running' by an earlier run`,
            );
        }

        if (opts.args.includes("--reset")) {
            for (const table of ["invoked", "loaded", "proposed", "concerns", "recovered_by", "skill_paired", "skill"]) {
                yield* write.exec(`DELETE FROM "${table}"`);
            }
        }

        const ctx = IngestContext.make({
            cwd: opts.cwd,
            since: sinceDays === undefined ? new Date(0) : new Date(now.getTime() - sinceDays * 86400 * 1000),
            debug: opts.debug ?? opts.args.includes("--debug"),
            runId,
            ...(opts.repoPaths ? { repoPaths: [...opts.repoPaths] } : {}),
            ...(opts.claudeProject ? { claudeProject: opts.claudeProject } : {}),
        });

        const wrappedStages = selectedStages.map((stageDef) =>
            wrapStage(runId, stageDef as StageDef<BaseStageStats, AxConfig | ProcessService, IngestStageError>)
        );

        const stageStats = yield* runPipeline(
            wrappedStages,
            ctx,
            write,
            {
                ...(deadlineMs === undefined ? {} : { deadlineMs }),
                recordStageOutcome: recordRunnerStageOutcome(runId, write),
            },
        ).pipe(
            LiveTrace.withTrace({
                traceId: `ingest:${runId}`,
                label: `ingest ${selectedStages.map((s) => s.meta.key).join(",")}`,
                scope: { type: "user", id: process.env.USER ?? "local" },
            }),
            withIngestRunFinish(write, runId),
            Effect.provideService(References.MinimumLogLevel, opts.verbose ? "Debug" : "Info"),
        );

        const totals: Record<string, number> = {};
        for (const stats of stageStats) {
            for (const [key, value] of Object.entries(stats)) {
                if (key === "durationMs" || typeof value !== "number" || !Number.isFinite(value)) continue;
                totals[key] = (totals[key] ?? 0) + value;
            }
        }

        // Correlation is best-effort by design (idempotent, re-drawn every run,
        // and a miss only costs one run's telemetry edges), so it stays ignored.
        yield* correlateOrphanOtel(write).pipe(Effect.ignore);
        // Retention is NOT: a failure here means OTLP rows accumulate forever.
        // Captured and reported through the caller's maintenance summary rather
        // than ignored, while still running inside the run so its DELETEs are in
        // the snapshot this run publishes.
        const otelRetention: OtelRetentionOutcome = yield* retainRecentOtel(write).pipe(
            Effect.map((result): OtelRetentionOutcome => ({ result })),
            Effect.catch((error): Effect.Effect<OtelRetentionOutcome> =>
                Effect.succeed({ error: errorText(error) })),
        );
        yield* buildFtsIndexes(write);
        return {
            runId,
            selectedStages: selectedStages.map((s) => s.meta.key),
            status: "ok" as const,
            totals,
            otelRetention,
        };
            }),
        );
    });
