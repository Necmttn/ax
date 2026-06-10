#!/usr/bin/env bun
import { Cause, Effect, Layer, Option, Path, References } from "effect";
import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun";
import { Command, Flag } from "effect/unstable/cli";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { AxConfig } from "@ax/lib/config";
import { ProcessService } from "@ax/lib/process";
import { prettyPrint } from "@ax/lib/json";
import { AppLayer } from "@ax/lib/layers";
import { cmdShare } from "./share.ts";
import { cmdStar, maybePrintStarNudge } from "./star-nudge.ts";
import { ingestClaudeInsights } from "../ingest/claude-insights.ts";
// backfillInvokedPositions - Phase B will register this as invokedPositionsStage.
import { deriveSignals } from "../ingest/derive-signals.ts";
import { deriveTurnIntents } from "../ingest/derive-intents.ts";
import { cmdDaemon, cmdDoctor, cmdInstall, cmdSetup, cmdUninstall } from "./install.ts";
import { insightsCommand, reportCommand, timelineCommand, reportRuntime } from "./commands/report.ts";
import { signalsCommand, signalsRuntime } from "./commands/signals.ts";
import { evidenceCommand, evidenceRuntime } from "./commands/evidence.ts";
import { contextCommand, contextRuntime } from "./commands/context.ts";
import { projectCommand, projectRuntime } from "./commands/project.ts";
import { serveCommand, mcpCommand, tuiCommand, serveRuntime } from "./commands/serve.ts";
import { shareCommand, shareRuntime } from "./commands/share.ts";
import { dogfoodCommand, dogfoodRuntime } from "./commands/dogfood.ts";
import { costsGroupCommand, locCommand, pricingCommand, costsRuntime } from "./commands/costs.ts";
import { recallCommand, recallRuntime } from "./commands/recall.ts";
import { hookCommand, hooksCommand, hooksRuntime } from "./commands/hooks.ts";
import { retroCommand, retroRuntime } from "./commands/retro.ts";
import { improveCommand, improveRuntime } from "./commands/improve.ts";
import { sessionsCommand, sessionsRuntime } from "./commands/sessions.ts";
import { skillsCommand, rolesCommand, skillsRuntime } from "./commands/skills.ts";
import { classifiersCommand, classifiersRuntime, classifiersPackageOperationsNeedsDb } from "./commands/classifiers.ts";
import type { RuntimeManifest } from "./commands/manifest.ts";
import { resolvePwdRepository } from "../pwd.ts";
import { estimateIngest, formatDryRun } from "../ingest/dry-run.ts";
import { encodeClaudeProjectSlug } from "@ax/lib/transcript-locator";
import {
    createProgressReporter,
    parseProgressMode,
    type ProgressReporter,
} from "./progress.ts";
import { AX_VERSION, liveVersionDeps, printVersion, updateAxctl } from "./version.ts";
import { agentsCommand } from "../agents/cli.ts";
import {
    buildIngestEventStatement,
    buildIngestRunStartStatement,
    buildIngestStageFinishStatement,
    buildIngestStageStartStatement,
    makeIngestEvent,
    publishIngestEvent,
} from "../dashboard/telemetry.ts";
import type { DbError } from "@ax/lib/errors";
import { ALL_STAGES, StageRegistry, type StageRegistryShape } from "../ingest/stage/registry.ts";
import { IngestRuntimeLayer, ingestRuntimeLayerWith } from "../ingest/stage/runtime.ts";
import { withIngestLock } from "../ingest/ingest-lock.ts";
import { ConsoleTransportLayer } from "@ax/lib/live-traces/transports/console";
import { pipelineTraceTransportLayer, tuiTraceTransportLayer } from "./ingest-trace-progress.ts";
import type { ProgressStage } from "./progress.ts";
import { selectByKeys, selectByTag } from "../ingest/stage/select.ts";
import { type BaseStageStats, type StageDef } from "../ingest/stage/types.ts";
import { runIngest, withIngestRunFinish } from "../ingest/run.ts";
import {
    boolArg,
    intArg,
    jsonFlag,
    optionValue,
    optionalSince,
    stringArg,
} from "./commands/shared.ts";

function flag(name: string, args: string[]): string | undefined {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found?.split("=")[1];
}

/**
 * Optional positive-integer flag (for `--since`-style values that may be
 * omitted entirely). Returns undefined when not present; errors on garbage.
 * (The required-variant parsePositiveIntFlag is gone - every remaining
 * string-parsing handler validates via requirePositiveInt in commands/shared.ts.)
 */
function parseOptionalPositiveIntFlag(
    cmd: string,
    flagName: string,
    args: string[],
): number | undefined {
    const raw = flag(flagName, args);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        console.error(
            `axctl ${cmd}: --${flagName} must be a positive integer (got "${raw}")`,
        );
        process.exit(2);
    }
    return n;
}

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

function progressModeFor(command: string, args: string[]) {
    try {
        return parseProgressMode(flag("progress", args));
    } catch (err) {
        console.error(`axctl ${command}: ${(err as Error).message}`);
        process.exit(2);
    }
}

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

const telemetryStage = <A, R = SurrealClient | AxConfig | ProcessService>(
    db: SurrealClientShape,
    runId: string,
    source: string,
    stage: string,
    program: Effect.Effect<A, DbError, R>,
    progress?: ProgressReporter,
): Effect.Effect<A, DbError, R | SurrealClient | AxConfig | ProcessService> =>
    Effect.gen(function* () {
        progress?.start({ source, stage });
        yield* db.query(buildIngestStageStartStatement({ runId, source, stage }));
        const result = yield* program.pipe(
            Effect.tap((value) => {
                const counts = numericCounts(value);
                return Effect.gen(function* () {
                    progress?.finish({ source, stage }, counts);
                    yield* db.query(buildIngestStageFinishStatement({
                        runId,
                        source,
                        stage,
                        status: "ok",
                        counts,
                    }));
                    yield* writeIngestEvent(db, {
                        runId,
                        source,
                        stage,
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
                    yield* db.query(buildIngestStageFinishStatement({
                        runId,
                        source,
                        stage,
                        status: "error",
                        counts: {},
                        errorText: message,
                    }));
                    yield* writeIngestEvent(db, {
                        runId,
                        source,
                        stage,
                        level: "error",
                        message,
                    });
                    return yield* error;
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
): ReadonlyArray<StageDef<BaseStageStats, unknown>> => {
    const stagesArg = args.find((a) => a.startsWith("--stages="));
    if (stagesArg) {
        const raw = stagesArg
            .slice("--stages=".length)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        try {
            return selectByKeys(registry, raw);
        } catch (err) {
            process.stderr.write(`axctl ingest: ${(err as Error).message}\n`);
            process.exit(2);
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
 * Extra grace beyond the hard ingest timeout (`AxConfig.knobs.ingestTimeoutSeconds`)
 * before a held lock is deemed stale and stolen: the owner should have
 * self-cancelled at the timeout, so anything older is genuinely dead.
 */
const INGEST_LOCK_STALE_GRACE_MS = 60_000;

const cmdIngest = (args: string[], opts: IngestCommandOpts = {}) =>
    Effect.gen(function* () {
        const commandName = opts.command ?? "ingest";
        const cfg = yield* AxConfig;
        const path = yield* Path.Path;
        const lockPath = path.join(cfg.paths.dataDir, "ingest.lock");
        const timeoutSeconds = cfg.knobs.ingestTimeoutSeconds;

        const work = runIngest({
            command: commandName,
            args,
            cwd: opts.cwd ?? process.cwd(),
            ...(opts.repoPaths ? { repoPaths: opts.repoPaths } : {}),
            ...(opts.claudeProject ? { claudeProject: opts.claudeProject } : {}),
            debug: args.includes("--debug"),
            verbose: args.includes("--verbose"),
        }).pipe(Effect.asVoid);

        // Single-flight + hard wall-clock cap, both owned by the lock. While one
        // ingest holds the lock another SKIPS (the watcher re-fires anyway, so a
        // redundant run is harmless and avoids the pile-up that wedges the DB).
        // The timeout lives inside the lock so that a timed-out run LEAVES its
        // lock to age into a cooldown - interrupting the fiber doesn't prove
        // SurrealDB stopped server-side, so the next ingest must hold off until
        // the lock goes stale rather than charging a still-busy DB.
        yield* withIngestLock(
            {
                lockPath,
                command: commandName,
                staleMs: timeoutSeconds * 1000 + INGEST_LOCK_STALE_GRACE_MS,
                timeoutSeconds,
                onBusy: (holder) =>
                    Effect.sync(() =>
                        process.stderr.write(
                            `axctl ${commandName}: another ingest (pid ${holder.pid}, ${holder.command}) ` +
                                `is in progress; skipping.\n`,
                        )
                    ),
                onTimeout: () =>
                    Effect.sync(() =>
                        process.stderr.write(
                            `axctl ${commandName}: ingest exceeded ${timeoutSeconds}s and was cancelled; ` +
                                `lock held as cooldown. Raise AX_INGEST_TIMEOUT_SECONDS for a large first backfill.\n`,
                        )
                    ),
            },
            work,
        );
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
        const pwd = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                Effect.sync(() => {
                    process.stderr.write(
                        `axctl ingest here: not in a git repository (cwd=${err.cwd})\n`,
                    );
                    process.exit(2);
                }),
            ),
        );

        const scopedArgs = hasStagesArg
            ? args
            : [
                ...args,
                `--stages=${registry
                    .all()
                    .map((s) => s.meta.key)
                    .filter((key) => !["codex", "pi", "opencode", "cursor"].includes(key))
                    .join(",")}`,
            ];
        if (!hasStagesArg) {
            process.stderr.write(
                "axctl ingest here: codex, pi, opencode, cursor stages skipped - no cwd filter yet\n",
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

const cmdDeriveSignals = (args: string[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const runId = runIdFor("derive-signals");
        const progressMode = progressModeFor("derive-signals", args);
        const verbose = args.includes("--verbose");
        const sinceDays = parseOptionalPositiveIntFlag(
            "derive-signals",
            "since",
            [...args],
        );
        yield* db.query(buildIngestRunStartStatement({
            runId,
            command: "derive-signals",
            ...(sinceDays === undefined ? {} : { sinceDays }),
        }));
        const progress = createProgressReporter({
            command: "derive-signals",
            mode: progressMode,
            runId,
            stages: [{ source: "signals", stage: "derive" }],
        });
        yield* telemetryStage(
            db,
            runId,
            "signals",
            "derive",
            deriveSignals({ sinceDays, onProgress: progressUpdater(progress, "signals", "derive") }),
            progress,
        ).pipe(
            withIngestRunFinish(db, runId),
            Effect.provideService(References.MinimumLogLevel, verbose ? "Debug" : "Info"),
            Effect.ensuring(Effect.sync(() => progress.stop())),
        );
    });

const cmdIngestInsights = (args: string[] = []) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const runId = runIdFor("ingest-insights");
        const progressMode = progressModeFor("ingest-insights", args);
        const verbose = args.includes("--verbose");
        yield* db.query(buildIngestRunStartStatement({ runId, command: "ingest-insights" }));
        const progress = createProgressReporter({
            command: "ingest-insights",
            mode: progressMode,
            runId,
            stages: [
                { source: "claude", stage: "insights" },
            ],
        });
        const program = Effect.gen(function* () {
            yield* telemetryStage(db, runId, "claude", "insights", ingestClaudeInsights(), progress);
        });
        yield* program.pipe(
            withIngestRunFinish(db, runId),
            Effect.provideService(References.MinimumLogLevel, verbose ? "Debug" : "Info"),
            Effect.ensuring(Effect.sync(() => progress.stop())),
            // ingestClaudeInsights now reads via @effect/platform FileSystem +
            // Path. Provide the Bun-backed layers here so this command's R stays
            // aligned with the sibling `cmdIngest` branch in the `ax ingest`
            // handler (AppLayer also supplies them at the top level; these pure
            // leaf layers are idempotent to re-provide).
            Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        );
    }).pipe(Effect.asVoid);

const checkFlag = Flag.boolean("check").pipe(Flag.withDefault(false));
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


const ingestHereCommand = Command.make(
    "here",
    {
        since: optionalSince,
        stages: Flag.string("stages").pipe(Flag.optional),
        progress: progressFlag,
        verbose: verboseFlag,
        debug: debugFlag,
    },
    ({ since, stages, progress, verbose, debug }) =>
        cmdIngestHere([
            ...intArg("since", optionValue(since)),
            ...stringArg("stages", optionValue(stages)),
            `--progress=${progress}`,
            ...boolArg("verbose", verbose),
            ...boolArg("debug", debug),
        ]),
).pipe(Command.withDescription(
    "Ingest only the git repository at $PWD. Restricts the claude stage to the matching " +
        "~/.claude/projects/<slug>/ transcript dir, restricts git history to this repo path. " +
        "Codex, Pi, OpenCode, and Cursor are skipped by default (no cwd filter yet). " +
        "--stages=<a,b,c> overrides the default set.",
));

const ingestCommand = Command.make(
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
        json: Flag.boolean("json").pipe(Flag.withDefault(false)),
        since: optionalSince,
        progress: progressFlag,
        verbose: verboseFlag,
        debug: debugFlag,
    },
    ({ insightsOnly, stages, deriveOnly, reset, dryRun, json, since, progress, verbose, debug }) => {
        if (dryRun) {
            // Same runtime layer (IngestRuntimeLayer via withIngest) provides
            // estimateIngest's services (AxConfig/FS/Path/SurrealClient); the cast
            // aligns this branch's requirement set with the other ingest branches
            // so Command.make infers one handler return type.
            return Effect.gen(function* () {
                const result = yield* estimateIngest({
                    sinceDays: Option.getOrUndefined(since),
                });
                console.log(formatDryRun(result, json));
            }) as ReturnType<typeof cmdIngest>;
        }
        if (insightsOnly) {
            if (reset) {
                console.error("axctl ingest: --reset cannot be combined with --insights-only");
                process.exit(2);
            }
            const conflicts = insightsOnlyConflicts({
                hasSince: Option.isSome(since),
            });
            if (conflicts.length > 0) {
                console.error(
                    `axctl ingest: --insights-only is mutually exclusive with ${conflicts.join(", ")}`,
                );
                process.exit(2);
            }
            return cmdIngestInsights([
                `--progress=${progress}`,
                ...boolArg("verbose", verbose),
                ...boolArg("debug", debug),
            ]);
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
            "Use --reset to wipe the skill graph first and rebuild it clean.",
    ),
    Command.withSubcommands([ingestHereCommand]),
);

// Shared flag specs + handlers for the derive verbs. They back BOTH the flat
// top-level commands (`derive-signals` / `derive-intents` - hardcoded in the
// installed LaunchAgent plists, MUST keep working) AND the grouped
// `derive signals` / `derive intents` forms under the `derive` parent.
const deriveSignalsFlags = { since: optionalSince, progress: progressFlag, verbose: verboseFlag } as const;
const handleDeriveSignals = ({ since, progress, verbose }: {
    since: Option.Option<number>;
    progress: string;
    verbose: boolean;
}) =>
    cmdDeriveSignals([...intArg("since", optionValue(since)), `--progress=${progress}`, ...boolArg("verbose", verbose)]);

const deriveIntentsFlags = {
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
} as const;
const handleDeriveIntents = ({ dryRun, json }: { dryRun: boolean; json: boolean }) =>
    Effect.gen(function* () {
        const summary = yield* deriveTurnIntents({ dryRun });
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
const deriveSignalsCommand = Command.make("derive-signals", deriveSignalsFlags, handleDeriveSignals)
    .pipe(Command.withDescription(deriveSignalsDescription));

const deriveIntentsCommand = Command.make("derive-intents", deriveIntentsFlags, handleDeriveIntents)
    .pipe(Command.withDescription(deriveIntentsDescription));

// Grouped forms: `axctl derive signals` / `axctl derive intents`. Same handlers,
// shorter sub-names, surfaced under one `derive` entry in the top-level index.
const deriveCommand = Command.make("derive").pipe(
    Command.withDescription("Derive signals and intents from ingested turns"),
    Command.withSubcommands([
        Command.make("signals", deriveSignalsFlags, handleDeriveSignals)
            .pipe(Command.withDescription(deriveSignalsDescription)),
        Command.make("intents", deriveIntentsFlags, handleDeriveIntents)
            .pipe(Command.withDescription(deriveIntentsDescription)),
    ]),
);

const bannerFlag = Flag.boolean("banner").pipe(Flag.withDefault(false));

const versionCommand = Command.make(
    "version",
    {
        check: checkFlag,
        json: jsonFlag,
        banner: bannerFlag,
    },
    ({ check, json, banner }) =>
        Effect.promise(() =>
            printVersion(
                [...boolArg("check", check), ...boolArg("json", json), ...boolArg("banner", banner)],
                liveVersionDeps,
            ),
        ),
).pipe(Command.withDescription("Print the installed version and optionally check GitHub releases"));

const updateCommand = Command.make(
    "update",
    {
        check: checkFlag,
        json: jsonFlag,
    },
    ({ check, json }) =>
        Effect.promise(() =>
            updateAxctl([...boolArg("check", check), ...boolArg("json", json)], liveVersionDeps),
        ),
).pipe(Command.withDescription("Update axctl from the latest GitHub release"));

const installCommand = Command.make("install", {}, () =>
    cmdInstall(),
).pipe(Command.withDescription("One-shot setup: daemon, watcher, symlink (then runs `ax setup`)"));

const setupCommand = Command.make(
    "setup",
    {
        agents: Flag.string("agents").pipe(Flag.optional),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
        agentPrompt: Flag.boolean("agent-prompt").pipe(Flag.withDefault(false)),
    },
    ({ agents, yes, agentPrompt }) =>
        cmdSetup({
            ...(agents._tag === "Some"
                ? { agents: agents.value.split(",").map((s) => s.trim()).filter(Boolean) }
                : {}),
            yes,
            agentPromptOnly: agentPrompt,
        }),
).pipe(
    Command.withDescription(
        "Install the agent skills and verify; hands ingest to your agent via the onboarding brief. " +
        "--agents=claude-code,codex  --yes  --agent-prompt (print just the paste-to-agent block)",
    ),
);

const daemonStatusCommand = Command.make(
    "status",
    { json: jsonFlag },
    ({ json }) => cmdDaemon(["status", ...boolArg("json", json)]),
).pipe(Command.withDescription("Show daemon and watcher status"));

const daemonStartCommand = Command.make("start", {}, () =>
    cmdDaemon(["start"]),
).pipe(Command.withDescription("Start the daemon and watcher"));

const daemonStopCommand = Command.make("stop", {}, () =>
    cmdDaemon(["stop"]),
).pipe(Command.withDescription("Stop the daemon and watcher without deleting plists"));

const daemonRestartCommand = Command.make("restart", {}, () =>
    cmdDaemon(["restart"]),
).pipe(Command.withDescription("Restart the daemon and watcher"));

const daemonCommand = Command.make("daemon").pipe(
    Command.withDescription("Manage local launchd services"),
    Command.withSubcommands([
        daemonStatusCommand,
        daemonStartCommand,
        daemonStopCommand,
        daemonRestartCommand,
    ]),
);

const doctorCommand = Command.make(
    "doctor",
    { json: jsonFlag },
    ({ json }) => cmdDoctor(boolArg("json", json)),
).pipe(Command.withDescription("Check local installation health"));

const uninstallCommand = Command.make(
    "uninstall",
    { purge: Flag.boolean("purge").pipe(Flag.withDefault(false)) },
    ({ purge }) => cmdUninstall(purge),
).pipe(
    Command.withDescription(
        "Remove launchd plists and the axctl symlink (--purge also deletes ~/.local/share/ax: binary + data)",
    ),
);

const devOnlyCommands = process.env.AX_DEV === "1" ? [dogfoodCommand] : [];

export const rootCommand = Command.make("axctl").pipe(
    Command.withDescription("ax local memory and telemetry for coding agents"),
    Command.withSubcommands([
        // Common verbs - shown in `axctl --help`. Keep this list short; it is the
        // human's mental map of the tool. Everything else is hidden (still fully
        // invokable by exact name - agents, plists, and docs use the names) so the
        // default help stays lean. Full command reference lives in the README.
        ingestCommand,
        sessionsCommand,
        improveCommand,
        retroCommand,
        recallCommand,
        skillsCommand,
        signalsCommand,
        rolesCommand,
        hooksCommand,
        serveCommand,
        mcpCommand,
        tuiCommand,
        shareCommand,
        installCommand,
        setupCommand,
        // Visibility policy (#173): read-only insight surfaces (sessions, recall,
        // skills, signals, roles, hooks) MUST be visible - a hidden command is
        // invisible to agents discovering the tool via --help, so it never gets
        // used (blind-dogfood finding). Hide only mutating / maintenance /
        // plumbing verbs. `withHidden` omits a command from `--help`, shell
        // completions, and "did you mean?" while leaving it callable by exact
        // name. `derive-signals`/`derive-intents` MUST stay callable - the
        // installed LaunchAgent plists invoke them by name.
        Command.withHidden(deriveCommand),
        Command.withHidden(deriveSignalsCommand),
        Command.withHidden(deriveIntentsCommand),
        Command.withHidden(insightsCommand),
        Command.withHidden(classifiersCommand),
        Command.withHidden(reportCommand),
        Command.withHidden(costsGroupCommand),
        Command.withHidden(locCommand),
        Command.withHidden(pricingCommand),
        Command.withHidden(contextCommand),
        Command.withHidden(hookCommand), // harness plumbing (invoked by hook configs), not for humans
        Command.withHidden(agentsCommand),
        Command.withHidden(projectCommand),
        Command.withHidden(evidenceCommand),
        Command.withHidden(timelineCommand),
        Command.withHidden(versionCommand),
        Command.withHidden(updateCommand),
        Command.withHidden(daemonCommand),
        Command.withHidden(doctorCommand),
        Command.withHidden(uninstallCommand),
        ...devOnlyCommands,
    ]),
);

/**
 * Run the CLI command tree. Returns an Effect typed as needing only
 * `SurrealClient`; the cast bridges an Effect v4 beta gap where
 * `Command.runWith`'s `Environment` services (Stdio/Path/FileSystem/
 * Terminal/ChildProcessSpawner) are surfaced as compile-time requirements
 * even though they are satisfied implicitly at runtime. This is the only
 * place the cast lives - callers stay type-safe.
 */
export const runCli = (args: ReadonlyArray<string>): Effect.Effect<void, unknown, SurrealClient> =>
    Command.runWith(rootCommand, { version: AX_VERSION })(args) as unknown as Effect.Effect<void, unknown, SurrealClient>;

/** CLI invocation that has had its `SurrealClient` requirement satisfied. */
type CliProgram = Effect.Effect<void, unknown, never>;

/**
 * Provide AppLayer (SurrealClient + AxConfig + ProcessService) and a
 * scope so handlers that allocate scoped resources work. Used by commands
 * whose handlers actually touch SurrealDB.
 */
const withDb = (args: ReadonlyArray<string>): CliProgram =>
    runCli(args).pipe(Effect.provide(AppLayer), Effect.scoped);

/**
 * Provide IngestRuntimeLayer (AppLayer + StageRegistryDefault) for the
 * ingest command so the CLI handler can yield* StageRegistry.
 *
 * Transport selection for the ingest live-trace spans:
 *   - `--debug`            → ConsoleTransport (raw JSON events to stderr)
 *   - interactive terminal → PipelineTraceTransport (animated step pipeline)
 *   - piped / CI / AX_PROGRESS=off → silent NoopTransport (from AppLayer), so
 *     machine-readable stdout (e.g. `--progress=json`) stays clean.
 * All transports write to **stderr**, never stdout.
 */
/** The stages a run will execute, resolved synchronously for sizing the
 *  OpenTUI progress footer. Mirrors `resolveIngestStages` against the default
 *  registry; over-estimates for `ingest here` (its --stages is injected later),
 *  which only means a slightly taller footer. */
const resolveProgressStages = (args: ReadonlyArray<string>): ProgressStage[] => {
    const stagesArg = args.find((a) => a.startsWith("--stages="));
    const keys = stagesArg
        ? stagesArg.slice("--stages=".length).split(",").map((s) => s.trim()).filter(Boolean)
        : args.includes("--derive-only")
            ? ALL_STAGES.filter((s) => s.meta.tags.includes("derive")).map((s) => s.meta.key)
            : ALL_STAGES.map((s) => s.meta.key);
    return keys.map((key) => ({ source: "ingest", stage: key }));
};

const withIngest = (args: ReadonlyArray<string>): CliProgram => {
    const debug = args.includes("--debug");
    const interactive = process.stderr.isTTY === true;
    const progressEnv = (process.env.AX_PROGRESS ?? "").toLowerCase();
    const progressFlag = (args.find((a) => a.startsWith("--progress=")) ?? "")
        .slice("--progress=".length)
        .toLowerCase();
    const mode = progressFlag || progressEnv; // "", off, on, pipeline, plain
    const wantPlain = mode === "plain";
    // Force progress even when stderr isn't an interactive TTY (piped, tmux, a
    // terminal that doesn't report a TTY).
    const force =
        process.env.AXCTL_PROGRESS_FORCE_PIPELINE === "1" ||
        mode === "on" || mode === "pipeline" || mode === "plain";

    // Renderer selection:
    //   --debug             -> raw trace JSON (console)
    //   AX_PROGRESS=off      -> silent
    //   --progress=plain     -> plain per-stage lines (any terminal)
    //   interactive TTY      -> OpenTUI split-footer board (the rich default)
    //   forced, non-TTY      -> plain per-stage lines
    //   non-TTY, no force    -> silent
    // OpenTUI renders into a stdout split-footer, so it needs BOTH streams on a
    // TTY; otherwise fall back to plain stderr lines.
    const tuiCapable = interactive && process.stdout.isTTY === true;
    const transport = debug
        ? ConsoleTransportLayer
        : mode === "off"
            ? undefined
            : wantPlain
                ? pipelineTraceTransportLayer("plain", resolveProgressStages(args))
                : tuiCapable
                    ? tuiTraceTransportLayer(resolveProgressStages(args))
                    : interactive || force
                        ? pipelineTraceTransportLayer("plain", resolveProgressStages(args))
                        : undefined;
    // The transport must be wired BENEATH TraceSinkLive (via ingestRuntimeLayerWith),
    // not merged on top of the already-built AppLayer - otherwise the sink keeps
    // its default NoopTransport and every event is dropped (no animation, no --debug).
    const layer = transport ? ingestRuntimeLayerWith(transport) : IngestRuntimeLayer;
    return runCli(args).pipe(Effect.provide(layer), Effect.scoped);
};

/**
 * Provide a sentinel SurrealClient that panics on access. Used by lifecycle
 * commands (install/daemon/doctor/uninstall/version/update) and unknown
 * commands / typos - none of these should reach the DB, so accidental
 * access is a bug worth surfacing loudly.
 */
const withoutDb = (args: ReadonlyArray<string>): CliProgram => {
    const stub: SurrealClientShape = new Proxy({} as SurrealClientShape, {
        get(_target, prop) {
            throw new Error(
                `axctl: SurrealClient.${String(prop)} accessed on the no-DB code path - this command was routed without AppLayer`,
            );
        },
    });
    // Lifecycle commands (install/setup/daemon/doctor/uninstall) are now
    // @effect/platform-native and require FileSystem + Path. Provide the real
    // Bun-backed layers here (no DB), so they run without dragging in AppLayer's
    // SurrealClient connect path.
    return runCli(args).pipe(
        Effect.provideService(SurrealClient, stub),
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    );
};

// Names not yet migrated to a commands/<family>.ts module. Shrinks each task;
// deleted in the final cleanup task. Mirrors the legacy DB_COMMANDS exactly.
const LEGACY_RUNTIME: RuntimeManifest = {
    ingest: "ingest",
    derive: "db",
    "derive-signals": "db",
    "derive-intents": "db",
    agents: "db",
};

export const RUNTIME_BY_COMMAND: RuntimeManifest = {
    ...LEGACY_RUNTIME,
    ...reportRuntime,
    ...signalsRuntime,
    ...evidenceRuntime,
    ...contextRuntime,
    ...projectRuntime,
    ...serveRuntime,
    ...shareRuntime,
    ...dogfoodRuntime,
    ...costsRuntime,
    ...recallRuntime,
    ...hooksRuntime,
    ...retroRuntime,
    ...improveRuntime,
    ...sessionsRuntime,
    ...skillsRuntime,
    ...classifiersRuntime,
};

// Commands whose handlers reach into SurrealClient via AppLayer (or the
// ingest superset layer). Anything outside this set runs through `withoutDb`
// so the user gets fast, honest errors (e.g. "unknown command") instead of a
// 5s connect timeout. Derived - do not hand-edit; declare runtime in the
// owning commands/<family>.ts manifest instead.
export const DB_COMMANDS: ReadonlySet<string> = new Set(
    Object.entries(RUNTIME_BY_COMMAND)
        .filter(([, runtime]) => runtime === "db" || runtime === "ingest")
        .map(([name]) => name),
);

// Moved to commands/classifiers.ts (Phase 2 CLI split); re-exported here for
// the existing test contract (effect-cli.test.ts imports it from index.ts).
export { classifiersPackageOperationsNeedsDb } from "./commands/classifiers.ts";

/**
 * Route raw argv to a CLI program. Mirrors the routing that used to live in
 * an async `main()` that `Effect.runPromise`d each branch - now every branch
 * RETURNS its Effect so the whole invocation runs as ONE main fiber under
 * `BunRuntime.runMain`. That makes SIGINT/SIGTERM interrupt the fiber, which
 * lets finalizers actually run (SurrealDB close, TraceSink/OTLP flush, the
 * ingest_run finish row + ingest-lock release) instead of hard-killing
 * mid-run and stranding `ingest_run` rows in status "running".
 *
 * Non-Effect legacy commands (version/star/share) are wrapped in
 * `Effect.promise`; a rejection becomes a defect and flows through the same
 * `reportCliFailure` path the old `.catch` handled.
 */
const dispatch = (args: ReadonlyArray<string>): Effect.Effect<void, unknown> => {
    if (args[0] === undefined) {
        // Bare `ax`: brand landing (ASCII wordmark) then the command list.
        return Effect.gen(function* () {
            const { formatLandingBanner } = yield* Effect.promise(() => import("./banner.ts"));
            process.stdout.write(formatLandingBanner(AX_VERSION, process.stdout.isTTY === true) + "\n");
            yield* withoutDb(["--help"]);
        });
    }
    if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
        return withoutDb(["--help"]);
    }
    if (args[0] === "-V" || args[0] === "-v" || args[0] === "--version") {
        return Effect.promise(() => printVersion(args.slice(1), liveVersionDeps));
    }
    if (args[0] === "upgrade") {
        return withoutDb(["update", ...args.slice(1)]);
    }
    if (args[0] === "star") {
        return Effect.promise(() => cmdStar(args.slice(1)));
    }
    if (args[0] === "ingest") {
        // Effect's CLI parser silently ignores unknown flags, so the removed
        // `--*-only` flags would otherwise no-op into a full ingest. Reject
        // them up-front against raw argv before Effect strips them. Nothing
        // has been acquired yet, so a direct exit(2) is finalizer-safe.
        const removed = detectRemovedIngestFlag(args.slice(1));
        if (removed) {
            return Effect.sync(() => {
                console.error(
                    `axctl ingest: ${removed.flag} was removed. Use ${removed.replacement} instead.`,
                );
                process.exit(2);
            });
        }
        return withIngest(args);
    }
    if (
        args[0] === "classifiers" &&
        (classifiersPackageOperationsNeedsDb(args) ||
            args[1] === "graph" ||
            args[1] === "lifecycle")
    ) {
        return withDb(args);
    }
    if (args[0] === "classifiers" && (args[1] === "eval" || args[1] === "list" || args[1] === "package-operations")) {
        return withoutDb(args);
    }
    if (args[0] === "share") {
        if (args[1] === "--help" || args[1] === "-h") {
            return withoutDb(args);
        }
        return Effect.promise(() => cmdShare(args.slice(1)));
    }
    if (DB_COMMANDS.has(args[0] ?? "")) {
        return withDb(args);
    }
    return withoutDb(args);
};

/**
 * Legacy `axctl error:` reporting, run INSIDE the effect so `runMain`
 * (invoked with `disableErrorReporting: true`) never pretty-logs the cause
 * itself. Stays silent for:
 *   - interruption-only causes (Ctrl-C): no error banner, `defaultTeardown`
 *     maps them to exit 130;
 *   - `ShowHelp`: `Command.runWith` already rendered help + the ERROR block;
 *     the failure still propagates so `defaultTeardown` exits 1, matching the
 *     old `.catch` path for usage errors.
 */
const reportCliFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Effect.sync(() => {
        if (Cause.hasInterruptsOnly(cause)) return;
        const err = Cause.squash(cause);
        if (err && typeof err === "object" && "_tag" in err && err._tag === "ShowHelp") return;
        console.error("axctl error:", err);
    });

if (import.meta.main) {
    const args = process.argv.slice(2);
    // BunRuntime.runMain makes the CLI the process main fiber: SIGINT/SIGTERM
    // interrupt it (finalizers run), then Runtime.defaultTeardown picks the
    // exit code - 0 success, 1 failure (incl. ShowHelp usage errors), 130 for
    // interruption-only (Ctrl-C). On success with exit code 0 it does NOT call
    // process.exit, so long-lived fire-and-forget commands (`serve`, `mcp`)
    // keep running on their own handles and keep owning their SIGINT shutdown
    // (runMain removes its signal listeners once the main fiber completes).
    // v4 beta runMain has no `disablePrettyLogger` option (only
    // disableErrorReporting + teardown); reportCliFailure owns all
    // user-facing error output.
    BunRuntime.runMain(
        dispatch(args).pipe(
            Effect.tap(() => Effect.promise(() => maybePrintStarNudge(args))),
            Effect.tapCause(reportCliFailure),
        ),
        { disableErrorReporting: true },
    );
}
