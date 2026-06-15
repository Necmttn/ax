#!/usr/bin/env bun
import { Cause, Effect, Layer } from "effect";
import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun";
import { Command } from "effect/unstable/cli";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { maybePrintStarNudge } from "./star-nudge.ts";
import { insightsCommand, reportCommand, timelineCommand, reportRuntime } from "./commands/report.ts";
import { signalsCommand, signalsRuntime } from "./commands/signals.ts";
import { evidenceCommand, evidenceRuntime } from "./commands/evidence.ts";
import { contextCommand, contextRuntime } from "./commands/context.ts";
import { projectCommand, projectRuntime } from "./commands/project.ts";
import { serveCommand, mcpCommand, tuiCommand, serveRuntime } from "./commands/serve.ts";
import { shareCommand, shareRuntime } from "./commands/share.ts";
import { starCommand, starRuntime } from "./commands/star.ts";
import { dogfoodCommand, dogfoodRuntime } from "./commands/dogfood.ts";
import { costsGroupCommand, locCommand, pricingCommand, costsRuntime } from "./commands/costs.ts";
import { costCommand, axCostRuntime } from "./commands/ax-cost.ts";
import { quotaCommand, quotaRuntime } from "./commands/quota.ts";
import { dojoCommand, dojoRuntime } from "./commands/dojo.ts";
import { profileCommand, axProfileRuntime } from "./commands/profile.ts";
import { dispatchesRootCommand, axDispatchesRuntime } from "./commands/ax-dispatches.ts";
import { routingRootCommand, axRoutingRuntime } from "./commands/ax-routing.ts";
import { thinkingCommand, axThinkingRuntime } from "./commands/ax-thinking.ts";
import { digestCommand, digestRuntime } from "./commands/digest.ts";
import { recallCommand, recallRuntime } from "./commands/recall.ts";
import { hookCommand, hooksCommand, hooksRuntime } from "./commands/hooks.ts";
import { retroCommand, retroRuntime } from "./commands/retro.ts";
import { improveCommand, improveRuntime } from "./commands/improve.ts";
import { wrappedCommand, wrappedRuntime } from "./commands/wrapped.ts";
import { sessionsCommand, sessionsRuntime } from "./commands/sessions.ts";
import { skillsCommand, rolesCommand, skillsRuntime } from "./commands/skills.ts";
import { classifiersCommand, classifiersRuntime } from "./commands/classifiers.ts";
import {
    ingestCommand,
    deriveCommand,
    deriveSignalsCommand,
    deriveIntentsCommand,
    ingestRuntime,
    detectRemovedIngestFlag,
} from "./commands/ingest.ts";
import { entryHidden, entryRuntime, resolveRuntime, type RuntimeManifest } from "./commands/manifest.ts";
import { parseCsvFlag } from "./commands/shared.ts";
import {
    versionCommand,
    updateCommand,
    installCommand,
    setupCommand,
    daemonCommand,
    doctorCommand,
    uninstallCommand,
    lifecycleRuntime,
} from "./commands/lifecycle.ts";
import { AX_VERSION, liveVersionDeps, printVersion } from "./version.ts";
import { stderrExit } from "./output.ts";
import { agentsCommand, agentsRuntime } from "../agents/cli.ts";
import { correlateOrphanOtel } from "../otel/correlate.ts";
import { ALL_STAGES } from "../ingest/stage/registry.ts";
import { IngestRuntimeLayer, ingestRuntimeLayerWith } from "../ingest/stage/runtime.ts";
import { ConsoleTransportLayer } from "@ax/lib/live-traces/transports/console";
import { pipelineTraceTransportLayer, tuiTraceTransportLayer } from "./ingest-trace-progress.ts";
import type { ProgressStage } from "./progress.ts";

const devOnlyCommands = process.env.AX_DEV === "1" ? [dogfoodCommand] : [];

// Spread of every family RuntimeManifest (18 commands/<family>.ts modules +
// src/agents/cli.ts). effect-cli.test.ts enforces that every registered
// top-level command appears here, so new families can't silently fall through
// to the no-DB Proxy at runtime. Each entry carries BOTH facets of the
// per-command metadata: routing (runtime) and visibility (hidden) - see
// commands/manifest.ts for the entry shape (#248).
export const RUNTIME_BY_COMMAND: RuntimeManifest = {
    ...agentsRuntime,
    ...reportRuntime,
    ...signalsRuntime,
    ...evidenceRuntime,
    ...contextRuntime,
    ...projectRuntime,
    ...serveRuntime,
    ...shareRuntime,
    ...starRuntime,
    ...dogfoodRuntime,
    ...costsRuntime,
    ...axCostRuntime,
    ...quotaRuntime,
    ...dojoRuntime,
    ...axProfileRuntime,
    ...axDispatchesRuntime,
    ...axRoutingRuntime,
    ...axThinkingRuntime,
    ...digestRuntime,
    ...recallRuntime,
    ...hooksRuntime,
    ...retroRuntime,
    ...improveRuntime,
    ...wrappedRuntime,
    ...sessionsRuntime,
    ...skillsRuntime,
    ...classifiersRuntime,
    ...ingestRuntime,
    ...lifecycleRuntime,
};

// Registration order, not metadata: the first block is the common verbs shown
// in `axctl --help` - keep it short; it is the human's mental map of the tool
// (full command reference lives in the README). Whether a command is hidden
// is NOT decided here: visibility lives next to routing in each family's
// RuntimeManifest (#248) and is applied by the uniform loop below. Visibility
// policy itself (#173) is documented on `CommandMeta` in commands/manifest.ts.
const registeredCommands: ReadonlyArray<Command.Command.Any> = [
    // Common verbs - shown in `axctl --help`.
    ingestCommand,
    sessionsCommand,
    improveCommand,
    wrappedCommand,
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
    costCommand,
    quotaCommand,
    dojoCommand,
    profileCommand,
    dispatchesRootCommand,
    routingRootCommand,
    thinkingCommand,
    digestCommand,
    // Maintenance / plumbing verbs - hidden via their family manifests.
    deriveCommand,
    deriveSignalsCommand,
    deriveIntentsCommand,
    insightsCommand,
    classifiersCommand,
    reportCommand,
    costsGroupCommand,
    locCommand,
    pricingCommand,
    contextCommand,
    hookCommand,
    agentsCommand,
    projectCommand,
    evidenceCommand,
    timelineCommand,
    versionCommand,
    updateCommand,
    daemonCommand,
    doctorCommand,
    uninstallCommand,
    starCommand,
    ...devOnlyCommands,
];

/**
 * Uniform manifest-driven registration (#248): apply each command's
 * manifest-declared visibility at assembly time. A command missing from
 * RUNTIME_BY_COMMAND registers visible - and fails the effect-cli.test.ts
 * exhaustiveness guard, so it can't ship undeclared.
 */
const withManifestVisibility = (command: Command.Command.Any): Command.Command.Any => {
    const entry = RUNTIME_BY_COMMAND[command.name];
    return entry !== undefined && entryHidden(entry) ? Command.withHidden(command) : command;
};

export const rootCommand = Command.make("axctl").pipe(
    Command.withDescription("ax local memory and telemetry for coding agents"),
    Command.withSubcommands(registeredCommands.map(withManifestVisibility)),
);

/**
 * Run the CLI command tree. Returns an Effect typed as needing only
 * `SurrealClient`; the cast bridges an Effect v4 beta gap where
 * `Command.runWith`'s `Environment` services (Stdio/Path/FileSystem/
 * Terminal/ChildProcessSpawner) are surfaced as compile-time requirements
 * even though they are satisfied implicitly at runtime. This is the only
 * place the cast lives - callers stay type-safe.
 */
const runCli = (args: ReadonlyArray<string>): Effect.Effect<void, unknown, SurrealClient> =>
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
        ? parseCsvFlag(stagesArg.slice("--stages=".length))
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
    return runCli(args).pipe(
        // After ingest completes successfully, link orphan OTLP rows to their
        // sessions via telemetry_of edges. Best-effort: never fails the ingest.
        Effect.tap(() => Effect.ignore(correlateOrphanOtel())),
        Effect.provide(layer),
        Effect.scoped,
    );
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

// Commands whose handlers reach into SurrealClient via AppLayer (or the
// ingest superset layer). Anything outside this set runs through `withoutDb`
// so the user gets fast, honest errors (e.g. "unknown command") instead of a
// 5s connect timeout. Derived - do not hand-edit; declare runtime in the
// owning commands/<family>.ts manifest instead. db-conditional families are
// excluded: dispatch resolves them per-invocation via resolveRuntime.
export const DB_COMMANDS: ReadonlySet<string> = new Set(
    Object.entries(RUNTIME_BY_COMMAND)
        .map(([name, entry]) => [name, entryRuntime(entry)] as const)
        .filter(([, runtime]) => runtime === "db" || runtime === "ingest")
        .map(([name]) => name),
);

// Moved to commands/ingest.ts (Phase 2 CLI split); re-exported here for the
// existing test contract (effect-cli.test.ts imports them from index.ts).
export { resolveIngestStages, detectRemovedIngestFlag, insightsOnlyConflicts } from "./commands/ingest.ts";

/**
 * Route raw argv to a CLI program. Mirrors the routing that used to live in
 * an async `main()` that `Effect.runPromise`d each branch - now every branch
 * RETURNS its Effect so the whole invocation runs as ONE main fiber under
 * `BunRuntime.runMain`. That makes SIGINT/SIGTERM interrupt the fiber, which
 * lets finalizers actually run (SurrealDB close, TraceSink/OTLP flush, the
 * ingest_run finish row + ingest-lock release) instead of hard-killing
 * mid-run and stranding `ingest_run` rows in status "running".
 *
 * The one remaining non-Effect legacy path (`-V`/`--version` flag printing)
 * is wrapped in `Effect.promise`; a rejection becomes a defect and flows
 * through the same `reportCliFailure` path the old `.catch` handled.
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
    if (args[0] === "ingest") {
        // Effect's CLI parser silently ignores unknown flags, so the removed
        // `--*-only` flags would otherwise no-op into a full ingest. Reject
        // them up-front against raw argv before Effect strips them. Nothing
        // has been acquired yet, so a direct exit(2) is finalizer-safe.
        const removed = detectRemovedIngestFlag(args.slice(1));
        if (removed) {
            return stderrExit(
                `axctl ingest: ${removed.flag} was removed. Use ${removed.replacement} instead.\n`,
                2,
            );
        }
        return withIngest(args);
    }
    // Routing is manifest-owned: resolve the family's declared entry (static,
    // db-conditional, or metadata-wrapped - see commands/manifest.ts) to the
    // concrete runtime for this invocation, so dispatch never hard-codes
    // command or subcommand names. Unknown commands / typos fall through to
    // withoutDb for a fast "unknown command" instead of a DB connect timeout.
    const declared = RUNTIME_BY_COMMAND[args[0]];
    if (declared !== undefined) {
        const runtime = resolveRuntime(declared, args);
        return runtime === "db"
            ? withDb(args)
            : runtime === "ingest"
                ? withIngest(args)
                : withoutDb(args);
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
