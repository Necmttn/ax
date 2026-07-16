import { Cause, Effect, Exit, Option, References } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { LiveTrace } from "@ax/lib/live-traces/index";
import { TraceSink } from "@ax/lib/live-traces/Sink";
import { ProcessService } from "@ax/lib/process";
import {
    buildIngestEventStatement,
    buildIngestRunFinishStatement,
    buildIngestRunStartStatement,
    buildIngestStageFinishStatement,
    buildIngestStageStartStatement,
    makeIngestEvent,
    publishIngestEvent,
} from "../dashboard/telemetry.ts";
import { runPipeline } from "./stage/runner.ts";
import { selectByKeys, selectByTag } from "./stage/select.ts";
import { StageRegistry, type StageRegistryShape } from "./stage/registry.ts";
import { BaseStageStats, IngestContext, type StageDef } from "./stage/types.ts";

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
 * The finalizer runs while the SurrealClient scope is still open (inner
 * scope unwinds before the layer closes the connection), so the last write
 * has a live connection. The interruption arm requires the process main
 * fiber to actually be interrupted on SIGINT - see BunRuntime.runMain in
 * cli/index.ts. A hard kill (SIGKILL/power loss) runs no finalizer at all;
 * `ax doctor`'s stale-run check catches those rows.
 */
export const withIngestRunFinish = (db: SurrealClientShape, runId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DbError, R> =>
        Effect.onExit(effect, (exit): Effect.Effect<void, DbError> => {
            if (Exit.isSuccess(exit)) {
                return db.query(buildIngestRunFinishStatement({ runId, status: "ok" }))
                    .pipe(Effect.asVoid);
            }
            // Read the cause before the `hasInterrupts` guard: its negative
            // branch would otherwise narrow `exit` to `never`.
            const cause = exit.cause;
            if (Exit.hasInterrupts(exit)) {
                return db.query(buildIngestRunFinishStatement({
                    runId,
                    status: "partial",
                    metrics: { error: "interrupted" },
                })).pipe(Effect.ignore);
            }
            const failure = Cause.findErrorOption(cause);
            if (Option.isSome(failure)) {
                return db.query(buildIngestRunFinishStatement({
                    runId,
                    status: "error",
                    metrics: { error: errorText(failure.value) },
                })).pipe(Effect.asVoid);
            }
            // Defect: still settle the row (never leave "running"), best
            // effort; the defect itself propagates past this finalizer.
            return db.query(buildIngestRunFinishStatement({
                runId,
                status: "error",
                metrics: { error: errorText(Cause.squash(cause)) },
            })).pipe(Effect.ignore);
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
): ReadonlyArray<StageDef<BaseStageStats, unknown>> => {
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

const writeIngestEvent = (
    db: SurrealClientShape,
    input: {
        readonly runId: string;
        readonly source: string;
        readonly stage: string;
        readonly level: "debug" | "info" | "warn" | "error";
        readonly message: string;
        readonly counts?: Record<string, number>;
    },
): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
        const event = makeIngestEvent({ ...input, counts: input.counts ?? {} });
        yield* db.query(buildIngestEventStatement(event));
        publishIngestEvent(event);
    }).pipe(Effect.asVoid);

const wrapStage = (
    db: SurrealClientShape,
    runId: string,
    stageDef: StageDef<BaseStageStats, SurrealClient | AxConfig | ProcessService>,
): StageDef<BaseStageStats, SurrealClient | AxConfig | ProcessService> => {
    const eventName = stageEventName(stageDef.meta.key);
    return {
        ...stageDef,
        run: (ctx: IngestContext) =>
            Effect.gen(function* () {
                yield* db.query(buildIngestStageStartStatement({
                    runId,
                    source: eventName.source,
                    stage: eventName.stage,
                }));

                return yield* stageDef.run(ctx).pipe(
                    Effect.tap((value) => {
                        const counts = numericCounts(value);
                        return Effect.gen(function* () {
                            yield* db.query(buildIngestStageFinishStatement({
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                status: "ok",
                                counts,
                            }));
                            yield* writeIngestEvent(db, {
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                level: "info",
                                message: `${eventName.source} ${eventName.stage} complete`,
                                counts,
                            });
                        });
                    }),
                    Effect.catch((error) =>
                        Effect.gen(function* () {
                            const message = errorText(error);
                            yield* db.query(buildIngestStageFinishStatement({
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                status: "error",
                                counts: {},
                                errorText: message,
                            }));
                            yield* writeIngestEvent(db, {
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                level: "error",
                                message,
                            });
                            return yield* error;
                        }),
                    ),
                );
            }),
    };
};

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

export interface RunIngestResult {
    readonly runId: string;
    readonly selectedStages: readonly string[];
    readonly status: "ok";
    /** Numeric stage stats summed across all stages (e.g. `sessions`,
     *  `failedFiles` from the per-file isolation guards). `durationMs` is
     *  excluded - summing wall-clocks across concurrent stages is noise. */
    readonly totals: Record<string, number>;
}

const defaultRunId = (command: string): string =>
    Bun.hash(`${command}|${Date.now()}|${Math.random()}`).toString(16).padStart(16, "0");

export const runIngest = (
    opts: RunIngestOptions,
): Effect.Effect<RunIngestResult, DbError, SurrealClient | AxConfig | ProcessService | StageRegistry | TraceSink> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const registry = yield* StageRegistry;
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

        yield* db.query(buildIngestRunStartStatement({
            runId,
            command: opts.command,
            ...(sinceDays === undefined ? {} : { sinceDays }),
        }));

        if (opts.args.includes("--reset")) {
            yield* db.query("DELETE invoked; DELETE loaded; DELETE proposed; DELETE concerns; DELETE recovered_by; DELETE skill_paired; DELETE skill;");
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
            wrapStage(
                db,
                runId,
                stageDef as StageDef<BaseStageStats, SurrealClient | AxConfig | ProcessService>,
            )
        );

        const stageStats = yield* runPipeline(
            wrappedStages,
            ctx,
            deadlineMs === undefined ? {} : { deadlineMs },
        ).pipe(
            LiveTrace.withTrace({
                traceId: `ingest:${runId}`,
                label: `ingest ${selectedStages.map((s) => s.meta.key).join(",")}`,
                scope: { type: "user", id: process.env.USER ?? "local" },
            }),
            withIngestRunFinish(db, runId),
            Effect.provideService(References.MinimumLogLevel, opts.verbose ? "Debug" : "Info"),
        );

        const totals: Record<string, number> = {};
        for (const stats of stageStats) {
            for (const [key, value] of Object.entries(stats)) {
                if (key === "durationMs" || typeof value !== "number" || !Number.isFinite(value)) continue;
                totals[key] = (totals[key] ?? 0) + value;
            }
        }

        return {
            runId,
            selectedStages: selectedStages.map((s) => s.meta.key),
            status: "ok" as const,
            totals,
        };
    });
