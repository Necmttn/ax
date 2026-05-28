#!/usr/bin/env bun
import { Effect, Option, References } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { listSessionsHere, listSessionsAround, listSessionsNear, type SessionRow } from "../dashboard/sessions-query.ts";
import { findCommitWindow } from "../lib/git-window.ts";
import { AxConfig } from "../lib/config.ts";
import { safeJsonParse } from "../lib/shared/safe-json.ts";
import { ProcessService } from "../lib/process.ts";
import { prettyPrint, surrealLiteral } from "../lib/json.ts";
import { prettifyProjectSlug } from "../lib/shared/project-slug.ts";
import { AppLayer } from "../lib/layers.ts";
import { ingestSkills } from "../ingest/skills.ts";
import { ingestCommands } from "../ingest/commands.ts";
import { ingestTranscripts } from "../ingest/transcripts.ts";
import { ingestCodex } from "../ingest/codex.ts";
import { ingestGit } from "../ingest/git.ts";
import { ingestHarness } from "../ingest/harness.ts";
import { deriveOutcomes } from "../ingest/outcomes.ts";
import { deriveSessionHealth } from "../ingest/session-health.ts";
import { deriveClosure } from "../ingest/closure.ts";
import { deriveProposals } from "../ingest/derive-proposals.ts";
import { deriveOpportunities } from "../ingest/derive-opportunities.ts";
import { deriveRetroProposals } from "../ingest/derive-retro-proposals.ts";
import { deriveCheckpoints } from "../ingest/derive-checkpoints.ts";
import { retroFromSession, upsertRetro, type RetroSource } from "../ingest/retro.ts";
import { scaffoldSkill } from "../improve/skill-scaffold.ts";
import { runAgentAccept } from "../improve/agent-accept.ts";
import { acceptProposal } from "../improve/actions.ts";
import { lintFiles } from "../improve/lint.ts";
import { recommend, formatRecommendations, copyToClipboard, selectByIndices, parseIndexInput } from "../improve/recommend.ts";
import { showExperiment, formatShow } from "../improve/show.ts";
import { cmdRetroReflect } from "./retro-reflect.ts";
import { cmdRetroMeta } from "./retro-meta.ts";
import { cmdRetroPlan } from "./retro-plan.ts";
import { homedir } from "node:os";
import { recordKeyPart } from "../lib/shared/derive-keys.ts";
import { recordRef, surrealString } from "../lib/shared/surql.ts";
import { ingestClaudeInsights } from "../ingest/claude-insights.ts";
import { deriveSignals } from "../ingest/derive-signals.ts";
import { deriveTurnIntents } from "../ingest/derive-intents.ts";
import { deriveSpawned } from "../ingest/derive-spawned.ts";
import { deriveClaudeSubagents } from "../ingest/derive-claude-subagents.ts";
import { INSIGHT_VIEWS, insightSqlForView, isInsightView } from "../queries/insights.ts";
import { writeDashboard } from "../dashboard/report.ts";
import { serveDashboard } from "../dashboard/server.ts";
import { fetchRecall, type RecallSource, type RecallScope } from "../dashboard/recall.ts";
import { cmdDaemon, cmdDoctor, cmdInstall, cmdUninstall } from "./install.ts";
import { resolvePwdRepository } from "../lib/pwd.ts";
import { encodeClaudeProjectSlug } from "../lib/transcript-locator.ts";
import {
    createProgressReporter,
    parseProgressMode,
    type ProgressReporter,
    type ProgressStage,
} from "./progress.ts";
import { initTuiProgress, shouldUseTui } from "./progress-tui.tsx";
import { cmdProject } from "./project.ts";
import { AX_VERSION, liveVersionDeps, printVersion, updateAxctl } from "./version.ts";
import { cmdDogfoodTerminal } from "../dogfood/wterm.ts";
import { buildFileContextPack } from "../context/file-context.ts";
import {
    buildFileContextHookResponse,
    parseFileContextHookFlags,
    parseFileContextHookStdin,
    type FileContextHookInput,
} from "../hooks/file-context-hook.ts";
import { recordHookFire } from "../hooks/telemetry.ts";
import type { TelemetryHarness } from "../lib/telemetry-base.ts";
import { formatHookLogRowsTsv, queryHookLog } from "../hooks/log.ts";
import {
    formatHookInvocationRows,
    formatHookSummaryRows,
    queryHookInvocations,
    queryHookSession,
    queryHookSummary,
} from "../queries/hooks.ts";
import {
    backtestEnforceWorktreeCase,
    formatFeedbackBacktestSummary,
} from "../queries/feedback-cases.ts";
import { guidanceNext, parseSelfImproveArgs, selfImproveWeekly, sessionSummary } from "../self-improve/commands.ts";
import {
    buildIngestEventStatement,
    buildIngestRunFinishStatement,
    buildIngestRunStartStatement,
    buildIngestStageFinishStatement,
    buildIngestStageStartStatement,
    makeIngestEvent,
    publishIngestEvent,
} from "../dashboard/telemetry.ts";
import type { DbError } from "../lib/errors.ts";
import {
    type IngestStageKey,
    ALL_STAGE_KEYS,
    INGEST_STAGE_DEPS,
    deriveOnlyKeys,
    selectStages,
    runPipeline,
    type StageSpec,
} from "../ingest/pipeline.ts";

const boolArg = (name: string, enabled: boolean): string[] =>
    enabled ? [`--${name}`] : [];

const intArg = (name: string, value: number | undefined): string[] =>
    value === undefined ? [] : [`--${name}=${value}`];

const stringArg = (name: string, value: string | undefined): string[] =>
    value === undefined ? [] : [`--${name}=${value}`];

const optionValue = <A>(value: Option.Option<A>): A | undefined =>
    Option.getOrUndefined(value);

function flag(name: string, args: string[]): string | undefined {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found?.split("=")[1];
}

/**
 * Parse a positive-integer CLI flag. Rejects NaN, ≤0 and (when a default is
 * not provided) absent values. Exits 2 with a clear message instead of letting
 * the bad value reach the SQL layer (which leaks bunfs source paths in errors -
 * see issues #38, #45).
 */
function parsePositiveIntFlag(
    cmd: string,
    flagName: string,
    args: string[],
    fallback?: number,
): number {
    const raw = flag(flagName, args);
    if (raw === undefined) {
        if (fallback !== undefined) return fallback;
        console.error(
            `axctl ${cmd}: --${flagName} is required (must be a positive integer)`,
        );
        process.exit(2);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        console.error(
            `axctl ${cmd}: --${flagName} must be a positive integer (got "${raw}")`,
        );
        process.exit(2);
    }
    return n;
}

/**
 * Optional positive-integer flag (for `--since`-style values that may be
 * omitted entirely). Returns undefined when not present; errors on garbage.
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

/**
 * Format a numeric counter with thousand-separators (issue #46). Keeps short
 * values short; long ones become e.g. `597,508` rather than blowing the
 * column.
 */
function fmtCount(v: unknown): string {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return "0";
    return n.toLocaleString("en-US");
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

const telemetryStage = <A>(
    db: SurrealClientShape,
    runId: string,
    source: string,
    stage: string,
    program: Effect.Effect<A, DbError, SurrealClient | AxConfig | ProcessService>,
    progress?: ProgressReporter,
): Effect.Effect<A, DbError, SurrealClient | AxConfig | ProcessService> =>
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

/** Legacy `--X-only` flags expressed as explicit stage sets, preserving their
 *  historical behaviour. New code should prefer `--stages=` / `--derive-only`. */
const LEGACY_ONLY_SETS: Record<string, readonly IngestStageKey[]> = {
    "skills-only": ["skills", "commands"],
    "transcripts-only": ["claude", "subagents", "spawned", ...deriveOnlyKeys()],
    "claude-only": ["skills", "commands", "claude", "subagents", "spawned", ...deriveOnlyKeys()],
    "codex-only": ["codex", "spawned", ...deriveOnlyKeys()],
    "git-only": ["git"],
};

/** ProgressStage descriptor for each stage key, in execution order. */
const STAGE_PROGRESS: Record<IngestStageKey, ProgressStage> = {
    skills: { source: "skills", stage: "upsert" },
    commands: { source: "commands", stage: "upsert" },
    claude: { source: "claude", stage: "transcripts" },
    codex: { source: "codex", stage: "sessions" },
    subagents: { source: "claude", stage: "subagents" },
    spawned: { source: "signals", stage: "spawned" },
    git: { source: "git", stage: "history" },
    signals: { source: "signals", stage: "derive" },
    outcomes: { source: "outcomes", stage: "derive" },
    "session-health": { source: "session-health", stage: "derive" },
    closure: { source: "closure", stage: "derive" },
    proposals: { source: "proposals", stage: "derive" },
    opportunities: { source: "opportunities", stage: "derive" },
    "retro-proposals": { source: "retro-proposals", stage: "derive" },
    harness: { source: "harness", stage: "doctor" },
};

/** Resolve which ingest stages to run from CLI args. Precedence:
 *  `--stages=` (explicit list) > `--derive-only` > a legacy `--X-only` > all.
 *  Exits with code 2 on an unknown `--stages=` value. */
export const resolveIngestStages = (args: string[]): IngestStageKey[] => {
    const stagesArg = args.find((a) => a.startsWith("--stages="));
    if (stagesArg) {
        const raw = stagesArg
            .slice("--stages=".length)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        try {
            return selectStages(raw);
        } catch (err) {
            process.stderr.write(`axctl ingest: ${(err as Error).message}\n`);
            process.exit(2);
        }
    }
    if (args.includes("--derive-only")) return deriveOnlyKeys();
    for (const [flagName, set] of Object.entries(LEGACY_ONLY_SETS)) {
        if (args.includes(`--${flagName}`)) {
            process.stderr.write(
                `axctl ingest: --${flagName} is deprecated; use --stages=${set.join(",")} or --derive-only\n`,
            );
            return [...set];
        }
    }
    return ALL_STAGE_KEYS;
};


const cmdIngest = (args: string[]) => {
    // Validate + resolve stages synchronously before any Effect/DB work so that
    // flag errors and deprecation warnings print even when the daemon is down.
    // Issue #44: silent contradictions like `--codex-only --claude-only`
    // turn the command into a no-op. Bail loudly instead.
    const setOnly = Object.keys(LEGACY_ONLY_SETS)
        .map((f) => `--${f}`)
        .filter((f) => args.includes(f));
    if (setOnly.length > 1) {
        console.error(
            `axctl ingest: ${setOnly.join(", ")} are mutually exclusive (each is a complete-source filter)`,
        );
        process.exit(2);
    }
    const hasStagesArg = args.some((a) => a.startsWith("--stages="));
    const hasDeriveOnly = args.includes("--derive-only");
    if ((hasStagesArg || hasDeriveOnly) && setOnly.length > 0) {
        console.error(
            `axctl ingest: ${hasStagesArg ? "--stages" : "--derive-only"} cannot be combined with ${setOnly.join(", ")}`,
        );
        process.exit(2);
    }
    if (hasStagesArg && hasDeriveOnly) {
        console.error("axctl ingest: --stages and --derive-only are mutually exclusive");
        process.exit(2);
    }
    // `--reset` clears the skill graph so a full re-ingest rebuilds it from
    // scratch (drops ghost `scope=unknown` rows whose invocations now resolve
    // onto real skills). It only makes sense with a complete ingest run.
    const wantReset = args.includes("--reset");
    if (wantReset && (hasStagesArg || hasDeriveOnly || setOnly.length > 0)) {
        console.error(
            "axctl ingest: --reset rebuilds the whole skill graph and cannot be combined with stage filters",
        );
        process.exit(2);
    }
    // Single source of truth for which stages run; see resolveIngestStages.
    // Also prints deprecation warnings for legacy --X-only flags.
    const sel = resolveIngestStages(args);
    const stages = sel.map((k) => STAGE_PROGRESS[k]);
    return Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (wantReset) {
            // Edges before nodes. `skill_triage_decision` is keyed by skill
            // name (not a record link) so user keep/archive decisions survive.
            yield* db.query(
                "DELETE invoked; DELETE proposed; DELETE concerns; DELETE recovered_by; DELETE skill_paired; DELETE skill;",
            );
            console.log(
                "reset: cleared skill graph (skill, invoked, proposed, concerns, recovered_by, skill_paired)",
            );
        }
        const runId = runIdFor("ingest");
        const progressMode = progressModeFor("ingest", args);
        const verbose = args.includes("--verbose");
        const sinceDays = parseOptionalPositiveIntFlag("ingest", "since", args);
        yield* db.query(buildIngestRunStartStatement({
            runId,
            command: "ingest",
            ...(sinceDays === undefined ? {} : { sinceDays }),
        }));
        const useTui = shouldUseTui(process.stdout.isTTY ?? false, progressMode);
        const tuiHandle = useTui
            ? yield* Effect.tryPromise({
                try: () => initTuiProgress({ command: "ingest", runId, stages }),
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined;
        const progress: ProgressReporter = tuiHandle?.progress ?? createProgressReporter({
            command: "ingest",
            mode: progressMode,
            runId,
            stages,
        });
        // Resolve services up front so stage lambdas can close over them and
        // return Effect.Effect<unknown, DbError, never> (matching StageSpec.run).
        const config = yield* AxConfig;
        const proc = yield* ProcessService;
        const withServices = <A>(
            eff: Effect.Effect<A, DbError, SurrealClient | AxConfig | ProcessService>,
        ): Effect.Effect<A, DbError, never> =>
            eff.pipe(
                Effect.provideService(SurrealClient, db),
                Effect.provideService(AxConfig, config),
                Effect.provideService(ProcessService, proc),
            );

        // Build stage run map: each key maps to a thunk returning a fully-
        // provided Effect with R=never so it satisfies StageSpec.run.
        const stageRun: Record<IngestStageKey, () => Effect.Effect<unknown, DbError, never>> = {
            skills: () => withServices(telemetryStage(db, runId, "skills", "upsert", ingestSkills(), progress)),
            // Slash commands live in `~/.claude/commands/` (and plugin
            // command dirs) and aren't indexed by ingestSkills. Without
            // this, every Skill-tool call against a slash command becomes
            // an orphan `invoked` edge. See issues #41 / #42.
            commands: () => withServices(telemetryStage(db, runId, "commands", "upsert", ingestCommands(), progress)),
            claude: () => withServices(telemetryStage(
                db,
                runId,
                "claude",
                "transcripts",
                ingestTranscripts({ sinceDays, onProgress: progressUpdater(progress, "claude", "transcripts") }),
                progress,
            )),
            codex: () => withServices(telemetryStage(
                db,
                runId,
                "codex",
                "sessions",
                ingestCodex({ sinceDays, onProgress: progressUpdater(progress, "codex", "sessions") }),
                progress,
            )),
            // Subagent stages run AFTER the parent transcript stages so the
            // parent sessions are already in the DB. Without this ordering
            // every spawn-derived edge would skip via missingParent.
            subagents: () => withServices(telemetryStage(
                db,
                runId,
                "claude",
                "subagents",
                deriveClaudeSubagents({ onProgress: progressUpdater(progress, "claude", "subagents") }),
                progress,
            )),
            spawned: () => withServices(telemetryStage(
                db,
                runId,
                "signals",
                "spawned",
                deriveSpawned(),
                progress,
            )),
            git: () => withServices(telemetryStage(
                db,
                runId,
                "git",
                "history",
                ingestGit({ sinceDays, onProgress: progressUpdater(progress, "git", "history") }),
                progress,
            )),
            // Derive stages re-read already-ingested turn/session rows, so they
            // can run standalone via `--stages=` / `--derive-only` against an
            // existing DB without re-parsing transcripts.
            signals: () => withServices(telemetryStage(
                db,
                runId,
                "signals",
                "derive",
                deriveSignals({ sinceDays, onProgress: progressUpdater(progress, "signals", "derive") }),
                progress,
            )),
            outcomes: () => withServices(telemetryStage(
                db,
                runId,
                "outcomes",
                "derive",
                deriveOutcomes({ sinceDays }),
                progress,
            )),
            "session-health": () => withServices(telemetryStage(
                db,
                runId,
                "session-health",
                "derive",
                deriveSessionHealth({ sinceDays }),
                progress,
            )),
            closure: () => withServices(telemetryStage(
                db,
                runId,
                "closure",
                "derive",
                deriveClosure(),
                progress,
            )),
            proposals: () => withServices(telemetryStage(
                db,
                runId,
                "proposals",
                "derive",
                deriveProposals(),
                progress,
            )),
            opportunities: () => withServices(telemetryStage(
                db,
                runId,
                "opportunities",
                "derive",
                deriveOpportunities(),
                progress,
            )),
            "retro-proposals": () => withServices(telemetryStage(
                db,
                runId,
                "retro-proposals",
                "derive",
                deriveRetroProposals(),
                progress,
            )),
            harness: () => withServices(telemetryStage(db, runId, "harness", "doctor", ingestHarness(), progress)),
        };

        const specs: StageSpec[] = sel.map((key) => ({
            key,
            deps: INGEST_STAGE_DEPS[key],
            run: stageRun[key],
        }));

        const program = Effect.gen(function* () {
            yield* runPipeline(specs);
        }).pipe(
            Effect.tap(() => db.query(buildIngestRunFinishStatement({ runId, status: "ok" })).pipe(Effect.asVoid)),
            Effect.catch((error) =>
                Effect.gen(function* () {
                    yield* db.query(buildIngestRunFinishStatement({
                        runId,
                        status: "error",
                        metrics: { error: errorText(error) },
                    }));
                    return yield* error;
                }),
            ),
            Effect.provideService(References.MinimumLogLevel, verbose ? "Debug" : "Info"),
            Effect.ensuring(
                tuiHandle
                    ? Effect.promise(() => tuiHandle.teardown())
                    : Effect.sync(() => progress.stop()),
            ),
        );
        yield* program;
    });
};

// Default stages for `ingest here`: all stages except codex (no cwd filter in v0).
const HERE_DEFAULT_STAGES: IngestStageKey[] = ALL_STAGE_KEYS.filter((k) => k !== "codex");

/**
 * `axctl ingest here [--since=Nd]` - scope ingest to the git repository at $PWD.
 *
 * Resolves $PWD to a repo root, then runs the full ingest pipeline with:
 *   - `claude` stage filtered to the matching `~/.claude/projects/<slug>/` dir
 *   - `git` stage restricted to just that repo path
 *   - `codex` stage SKIPPED (no cwd filter available in v0)
 *   - `skills`, `commands`, and all derive stages run unfiltered
 *
 * Honors `--stages=` to override the default set, `--since=Nd`, `--verbose`.
 */
const cmdIngestHere = (args: string[]) =>
    Effect.gen(function* () {
        // Validate stage flags before hitting the DB (same guard as cmdIngest).
        const hasStagesArg = args.some((a) => a.startsWith("--stages="));

        // Resolve the cwd git repo before DB work.
        const pwdResolution = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                Effect.sync(() => {
                    process.stderr.write(
                        `axctl ingest here: not in a git repository (cwd=${err.cwd})\n`,
                    );
                    process.exit(2);
                }),
            ),
        );

        const repoRoot = pwdResolution.repoRoot;
        const claudeSlug = encodeClaudeProjectSlug(repoRoot);

        // Resolve stages: user --stages= overrides, otherwise use HERE_DEFAULT_STAGES.
        const sel: IngestStageKey[] = hasStagesArg
            ? resolveIngestStages(args)
            : HERE_DEFAULT_STAGES;

        if (!hasStagesArg) {
            // Inform the user that codex is skipped.
            process.stderr.write("ingest here: codex stage skipped - no cwd filter yet\n");
        }

        const stages = sel.map((k) => STAGE_PROGRESS[k]);
        const db = yield* SurrealClient;
        const runId = runIdFor("ingest-here");
        const progressMode = progressModeFor("ingest here", args);
        const verbose = args.includes("--verbose");
        const sinceDays = parseOptionalPositiveIntFlag("ingest here", "since", args);

        yield* db.query(buildIngestRunStartStatement({
            runId,
            command: "ingest-here",
            ...(sinceDays === undefined ? {} : { sinceDays }),
        }));

        const useTui = shouldUseTui(process.stdout.isTTY ?? false, progressMode);
        const tuiHandle = useTui
            ? yield* Effect.tryPromise({
                try: () => initTuiProgress({ command: "ingest-here", runId, stages }),
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined;
        const progress: ProgressReporter = tuiHandle?.progress ?? createProgressReporter({
            command: "ingest-here",
            mode: progressMode,
            runId,
            stages,
        });

        const config = yield* AxConfig;
        const proc = yield* ProcessService;
        const withServices = <A>(
            eff: Effect.Effect<A, DbError, SurrealClient | AxConfig | ProcessService>,
        ): Effect.Effect<A, DbError, never> =>
            eff.pipe(
                Effect.provideService(SurrealClient, db),
                Effect.provideService(AxConfig, config),
                Effect.provideService(ProcessService, proc),
            );

        // Mirror of cmdIngest.stageRun - keep in sync. Differences: claude stage passes project:, git stage passes repoPaths:.
        const stageRun: Record<IngestStageKey, () => Effect.Effect<unknown, DbError, never>> = {
            skills: () => withServices(telemetryStage(db, runId, "skills", "upsert", ingestSkills(), progress)),
            commands: () => withServices(telemetryStage(db, runId, "commands", "upsert", ingestCommands(), progress)),
            claude: () => withServices(telemetryStage(
                db,
                runId,
                "claude",
                "transcripts",
                ingestTranscripts({
                    sinceDays,
                    project: claudeSlug,
                    onProgress: progressUpdater(progress, "claude", "transcripts"),
                }),
                progress,
            )),
            codex: () => withServices(telemetryStage(
                db,
                runId,
                "codex",
                "sessions",
                ingestCodex({ sinceDays, onProgress: progressUpdater(progress, "codex", "sessions") }),
                progress,
            )),
            subagents: () => withServices(telemetryStage(
                db,
                runId,
                "claude",
                "subagents",
                deriveClaudeSubagents({ onProgress: progressUpdater(progress, "claude", "subagents") }),
                progress,
            )),
            spawned: () => withServices(telemetryStage(db, runId, "signals", "spawned", deriveSpawned(), progress)),
            git: () => withServices(telemetryStage(
                db,
                runId,
                "git",
                "history",
                ingestGit({
                    sinceDays,
                    repoPaths: [repoRoot],
                    onProgress: progressUpdater(progress, "git", "history"),
                }),
                progress,
            )),
            signals: () => withServices(telemetryStage(
                db,
                runId,
                "signals",
                "derive",
                deriveSignals({ sinceDays, onProgress: progressUpdater(progress, "signals", "derive") }),
                progress,
            )),
            outcomes: () => withServices(telemetryStage(db, runId, "outcomes", "derive", deriveOutcomes({ sinceDays }), progress)),
            "session-health": () => withServices(telemetryStage(db, runId, "session-health", "derive", deriveSessionHealth({ sinceDays }), progress)),
            closure: () => withServices(telemetryStage(db, runId, "closure", "derive", deriveClosure(), progress)),
            proposals: () => withServices(telemetryStage(db, runId, "proposals", "derive", deriveProposals(), progress)),
            opportunities: () => withServices(telemetryStage(db, runId, "opportunities", "derive", deriveOpportunities(), progress)),
            "retro-proposals": () => withServices(telemetryStage(db, runId, "retro-proposals", "derive", deriveRetroProposals(), progress)),
            harness: () => withServices(telemetryStage(db, runId, "harness", "doctor", ingestHarness(), progress)),
        };

        const specs: StageSpec[] = sel.map((key) => ({
            key,
            deps: INGEST_STAGE_DEPS[key],
            run: stageRun[key],
        }));

        const program = Effect.gen(function* () {
            yield* runPipeline(specs);
        }).pipe(
            Effect.tap(() => db.query(buildIngestRunFinishStatement({ runId, status: "ok" })).pipe(Effect.asVoid)),
            Effect.catch((error) =>
                Effect.gen(function* () {
                    yield* db.query(buildIngestRunFinishStatement({
                        runId,
                        status: "error",
                        metrics: { error: errorText(error) },
                    }));
                    return yield* error;
                }),
            ),
            Effect.provideService(References.MinimumLogLevel, verbose ? "Debug" : "Info"),
            Effect.ensuring(
                tuiHandle
                    ? Effect.promise(() => tuiHandle.teardown())
                    : Effect.sync(() => progress.stop()),
            ),
        );
        yield* program;
    });

const cmdDeriveSignals = (args: string[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const runId = runIdFor("derive-signals");
        const progressMode = progressModeFor("derive-signals", args);
        const verbose = args.includes("--verbose");
        const sinceDays = parseOptionalPositiveIntFlag(
            "derive-signals",
            "since",
            args,
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
            Effect.tap(() => db.query(buildIngestRunFinishStatement({ runId, status: "ok" })).pipe(Effect.asVoid)),
            Effect.catch((error) =>
                Effect.gen(function* () {
                    yield* db.query(buildIngestRunFinishStatement({
                        runId,
                        status: "error",
                        metrics: { error: errorText(error) },
                    }));
                    return yield* error;
                }),
            ),
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
            Effect.tap(() => db.query(buildIngestRunFinishStatement({ runId, status: "ok" })).pipe(Effect.asVoid)),
            Effect.catch((error) =>
                Effect.gen(function* () {
                    yield* db.query(buildIngestRunFinishStatement({
                        runId,
                        status: "error",
                        metrics: { error: errorText(error) },
                    }));
                    return yield* error;
                }),
            ),
            Effect.provideService(References.MinimumLogLevel, verbose ? "Debug" : "Info"),
            Effect.ensuring(Effect.sync(() => progress.stop())),
        );
    }).pipe(Effect.asVoid);

const cmdInsights = (args: string[]) =>
    Effect.gen(function* () {
        const rawView =
            args.filter((a) => !a.startsWith("--"))[0] ?? "repositories";
        if (!isInsightView(rawView)) {
            console.error(
                `axctl insights: unknown view "${rawView}" (expected ${INSIGHT_VIEWS.join(", ")})`,
            );
            process.exit(2);
        }
        const limit = parsePositiveIntFlag("insights", "limit", args, 20);
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            insightSqlForView(rawView, limit),
        );
        console.log(prettyPrint(result?.[0] ?? []));
    });

const cmdReport = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("report", "limit", args, 12);
        const out = flag("out", args);
        const result = yield* writeDashboard({ out, limit });
        console.log(`report: ${result.url}`);
        console.log(
            `evidence: tools=${fmtCount(result.data.counts.toolCalls)} plans=${fmtCount(
                result.data.counts.planSnapshots,
            )} friction=${fmtCount(
                result.data.counts.frictionEvents,
            )} sessions=${fmtCount(result.data.counts.sessions)}`,
        );
    });

const VALID_SOURCES: ReadonlySet<string> = new Set(["turn", "commit", "skill"]);

function parseSourcesFlag(raw: string | null): ReadonlyArray<RecallSource> | null {
    if (!raw) return null;
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = parts.filter((p) => !VALID_SOURCES.has(p));
    if (invalid.length > 0) {
        console.error(
            `axctl recall: unknown source(s): ${invalid.join(", ")}. Valid: turn, commit, skill`,
        );
        process.exit(2);
    }
    return parts as RecallSource[];
}

interface RecallCliOpts {
    readonly query: string;
    readonly project: string | null;
    readonly skill: string | null;
    readonly since: string | null;
    readonly sources: string | null;
    readonly scopeFlag: string | null;
    readonly json: boolean;
}

/**
 * Resolve `--scope` flag + cwd into a RecallScope.
 *
 * Rules:
 *  - `--scope=all`  → { kind: "all" } (no DB lookup)
 *  - `--scope=here` → look up cwd repository; error if not a git repo
 *  - omitted        → auto-detect: try `here`; fall back to `all` silently
 */
const resolveScope = (
    scopeFlag: string | null,
): Effect.Effect<RecallScope, DbError | import("../lib/process.ts").ProcessError, SurrealClient | ProcessService> =>
    Effect.gen(function* () {
        if (scopeFlag === "all") return { kind: "all" } as RecallScope;

        if (scopeFlag === "here" || scopeFlag === null) {
            const resolution = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (err) => {
                    if (scopeFlag === "here") {
                        // explicit --scope=here outside a git repo → error
                        process.stderr.write(`axctl recall: --scope=here requires a git repo (cwd=${err.cwd})\n`);
                        process.exit(2);
                    }
                    // auto-detect: not a git repo → silent fall-through to all
                    return Effect.succeed(null as import("../lib/pwd.ts").PwdResolution | null);
                }),
            );
            if (resolution === null) return { kind: "all" } as RecallScope;
            return {
                kind: "here",
                repositoryRecordId: String(resolution.repositoryRecordId),
            } as RecallScope;
        }

        console.error(`axctl recall: unknown --scope value "${scopeFlag}". Valid: here, all`);
        process.exit(2);
    });

/**
 * Resolve a user-supplied filter (project slug, skill name) into the
 * canonical value stored in the DB. Three behaviours:
 *  - exact match → return immediately
 *  - "?" or empty value with TTY → interactive picker (numbered list)
 *  - substring → match against pretty + raw forms; on 0/many, list & exit
 */
async function pickFromList(
    label: string,
    candidates: ReadonlyArray<{ readonly value: string; readonly hint: string }>,
): Promise<string | null> {
    if (!process.stdin.isTTY) {
        console.error(
            `axctl recall: --${label} requires a value (stdin is not a TTY)`,
        );
        process.exit(2);
    }
    if (candidates.length === 0) {
        console.error(`no ${label}s found`);
        process.exit(2);
    }
    process.stderr.write(`\nPick a ${label}:\n`);
    candidates.forEach((c, i) => {
        const idx = String(i + 1).padStart(2);
        process.stderr.write(`  ${idx}. ${c.value}  \x1b[2m${c.hint}\x1b[0m\n`);
    });
    process.stderr.write(`\nNumber (or empty to skip): `);
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    const answer = (await rl.question("")).trim();
    rl.close();
    if (!answer) return null;
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
        console.error(`invalid selection: ${answer}`);
        process.exit(2);
    }
    return candidates[n - 1]!.value;
}

const resolveProject = (input: string | null) =>
    Effect.gen(function* () {
        if (input === null) return null;
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT project, count() AS c FROM session
             WHERE project IS NOT NONE
             GROUP BY project ORDER BY c DESC LIMIT 200;`,
        );
        const all = (rows?.[0] ?? [])
            .map((r) => ({
                slug: String(r.project ?? ""),
                count: Number(r.c ?? 0),
            }))
            .filter((r) => r.slug.length > 0);
        const trimmed = input.trim();
        if (trimmed === "" || trimmed === "?") {
            return yield* Effect.promise(() =>
                pickFromList(
                    "project",
                    all.slice(0, 30).map((r) => ({
                        value: r.slug,
                        hint: `${prettifyProjectSlug(r.slug)} · ${r.count} sessions`,
                    })),
                ),
            );
        }
        const exact = all.find((r) => r.slug === trimmed);
        if (exact) return exact.slug;
        const lower = trimmed.toLowerCase();
        const matches = all.filter(
            (r) =>
                r.slug.toLowerCase().includes(lower) ||
                prettifyProjectSlug(r.slug).toLowerCase().includes(lower),
        );
        if (matches.length === 1) return matches[0]!.slug;
        if (matches.length === 0) {
            console.error(
                `axctl recall: no project matches "${trimmed}". Try: axctl recall ... --project=?`,
            );
            process.exit(2);
        }
        return yield* Effect.promise(() =>
            pickFromList(
                "project",
                matches.slice(0, 30).map((r) => ({
                    value: r.slug,
                    hint: `${prettifyProjectSlug(r.slug)} · ${r.count} sessions`,
                })),
            ),
        );
    });

const resolveSkill = (input: string | null) =>
    Effect.gen(function* () {
        if (input === null) return null;
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT out.name AS name, count() AS c FROM invoked
             WHERE out.name IS NOT NONE
             GROUP BY name ORDER BY c DESC LIMIT 500;`,
        );
        const all = (rows?.[0] ?? [])
            .map((r) => ({ name: String(r.name ?? ""), count: Number(r.c ?? 0) }))
            .filter((r) => r.name.length > 0);
        const trimmed = input.trim();
        if (trimmed === "" || trimmed === "?") {
            return yield* Effect.promise(() =>
                pickFromList(
                    "skill",
                    all.slice(0, 30).map((r) => ({
                        value: r.name,
                        hint: `${r.count} invocations`,
                    })),
                ),
            );
        }
        const exact = all.find((r) => r.name === trimmed);
        if (exact) return exact.name;
        const lower = trimmed.toLowerCase();
        const matches = all.filter((r) => r.name.toLowerCase().includes(lower));
        if (matches.length === 1) return matches[0]!.name;
        if (matches.length === 0) {
            console.error(
                `axctl recall: no skill matches "${trimmed}". Try: axctl recall ... --skill=?`,
            );
            process.exit(2);
        }
        return yield* Effect.promise(() =>
            pickFromList(
                "skill",
                matches.slice(0, 30).map((r) => ({
                    value: r.name,
                    hint: `${r.count} invocations`,
                })),
            ),
        );
    });

const cmdRecall = (opts: RecallCliOpts) =>
    Effect.gen(function* () {
        if (!opts.query.trim()) {
            console.error("axctl recall: missing query");
            process.exit(1);
        }
        const project = yield* resolveProject(opts.project);
        const skill = yield* resolveSkill(opts.skill);
        const sources = parseSourcesFlag(opts.sources);
        const scope = yield* resolveScope(opts.scopeFlag);
        const result = yield* fetchRecall({
            q: opts.query,
            project,
            skill,
            since: opts.since,
            ...(sources !== null ? { sources } : {}),
            scope,
        });
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }

        const multiSource = (result.commits.length > 0 || result.skills.length > 0);

        // --- turns section ---
        if (result.hits.length === 0 && !multiSource) {
            console.log(`no matches for "${opts.query}"`);
            return;
        }
        if (result.hits.length > 0) {
            if (multiSource) console.log("\n\x1b[1mturns\x1b[0m");
            const more = result.total_count > result.hits.length
                ? ` (showing first ${result.hits.length} of ${result.total_count})`
                : "";
            console.log(`${result.hits.length} match${result.hits.length === 1 ? "" : "es"}${more}`);
            for (const hit of result.hits) {
                const ts = hit.ts ?? "?";
                const proj = hit.project ? prettifyProjectSlug(hit.project) : "?";
                const sid = hit.session_id
                    .replace(/^session:⟨/, "")
                    .replace(/⟩$/, "")
                    .slice(0, 12);
                const role = (hit.role ?? "?").padEnd(9);
                const src = (hit.source ?? "?").padEnd(15);
                console.log(`\n\x1b[2m${ts}  ${src} ${role} ${proj}  ${sid}\x1b[0m`);
                const snippet = hit.snippet.replace(/\s+/g, " ").trim();
                console.log(`  ${snippet}`);
            }
        }

        // --- commits section ---
        if (result.commits.length > 0) {
            console.log(`\n\x1b[1mcommits\x1b[0m`);
            const more = result.total_counts.commit > result.commits.length
                ? ` (showing first ${result.commits.length} of ${result.total_counts.commit})`
                : "";
            console.log(`${result.commits.length} match${result.commits.length === 1 ? "" : "es"}${more}`);
            for (const hit of result.commits) {
                const ts = hit.ts ?? "?";
                const repo = hit.repo ?? "?";
                const sha = hit.sha.slice(0, 8);
                console.log(`\n\x1b[2m${ts}  ${repo}  ${sha}\x1b[0m`);
                const snippet = hit.snippet.replace(/\s+/g, " ").trim();
                console.log(`  ${snippet}`);
            }
        }

        // --- skills section ---
        if (result.skills.length > 0) {
            console.log(`\n\x1b[1mskills\x1b[0m`);
            const more = result.total_counts.skill > result.skills.length
                ? ` (showing first ${result.skills.length} of ${result.total_counts.skill})`
                : "";
            console.log(`${result.skills.length} match${result.skills.length === 1 ? "" : "es"}${more}`);
            for (const hit of result.skills) {
                const desc = hit.description ? `  \x1b[2m${hit.description.slice(0, 80)}\x1b[0m` : "";
                console.log(`  ${hit.name}${desc}`);
                if (hit.snippet && hit.snippet !== hit.name) {
                    const snippet = hit.snippet.replace(/\s+/g, " ").trim();
                    console.log(`    ${snippet}`);
                }
            }
        }

    });

const cmdSearch = (args: string[]) =>
    Effect.gen(function* () {
        const query = args
            .filter((a) => !a.startsWith("--"))
            .join(" ");
        const limit = parsePositiveIntFlag("search", "limit", args, 10);
        if (!query) {
            console.error("axctl skills search: missing query");
            process.exit(1);
        }
        const db = yield* SurrealClient;
        // Primary path: SurrealDB v3 BM25 FTS via the skill_search_name +
        // skill_search_desc indexes (defined in schema/schema.surql with
        // ngram(2, 8) tokenisation, so "test" hits "test-driven"). The
        // `@N@` matches operator references an index by *position in the
        // WHERE clause* (not field), and `search::score(N)` returns the
        // BM25 score for predicate N. Combined score = sum of name +
        // description BM25 scores; either side is NONE when only one
        // matched, so we coerce via `math::max([score, 0])`.
        //
        // Time-window counts use explicit `invoked WHERE out = $parent.id`
        // form rather than `<-invoked WHERE ts > ...`. The graph-traversal
        // form materialises edges first then the WHERE drops every row
        // (returns 0 even when matches exist). See issue #15.
        // PERF (issue #31): The per-row `(SELECT count() FROM invoked
        // WHERE out = $parent.id AND ts > 30d ...)` subquery costs ~1.5s
        // per matched skill that happens to be one of the high-volume
        // ones (e.g. codex:exec_command @ ~500k edges). For a search hit
        // that includes them, total runtime jumps to 30s+. The fix is the
        // same as cmdTaste: do the per-skill recent counters in one
        // GROUP BY scan, then merge with the FTS-ranked result list.
        const ftsSql = `
SELECT
    id,
    name,
    scope,
    description,
    (math::max([search::score(0), 0.0]) + math::max([search::score(1), 0.0])) AS score
FROM skill
WHERE name @0@ $q OR description @1@ $q
ORDER BY score DESC
LIMIT ${limit};`;
        const legacySql = `
SELECT
    id,
    name,
    scope,
    description,
    (IF string::lowercase(name) CONTAINS $q THEN 2.0 ELSE 0.0 END
     + IF string::lowercase(description ?? '') CONTAINS $q THEN 1.0 ELSE 0.0 END) AS score
FROM skill
WHERE
    string::lowercase(name) CONTAINS $q
    OR string::lowercase(description ?? '') CONTAINS $q
ORDER BY score DESC
LIMIT ${limit};`;
        // Per-skill aggregates over `invoked` in one full scan
        // (~1-2s) - cheap relative to repeating it per matched skill.
        const aggSql = `
SELECT
    out AS skill_id,
    count() AS total_inv,
    math::sum(IF ts > time::now() - 30d THEN 1 ELSE 0 END) AS inv_30d,
    math::max(ts) AS last_used
FROM invoked
GROUP BY out;`;
        const matchResult = yield* db
            .query<[Array<Record<string, unknown>>]>(ftsSql, { q: query })
            .pipe(
                Effect.catch(() =>
                    db.query<[Array<Record<string, unknown>>]>(legacySql, {
                        q: query.toLowerCase(),
                    }),
                ),
            );
        const aggResult = yield* db.query<[Array<Record<string, unknown>>]>(aggSql);
        const matched = (matchResult?.[0] ?? []) as Array<Record<string, unknown>>;
        const aggMap = new Map<string, Record<string, unknown>>();
        for (const a of (aggResult?.[0] ?? []) as Array<Record<string, unknown>>) {
            aggMap.set(String(a.skill_id ?? ""), a);
        }
        const rows = matched
            .map((m) => {
                const agg = aggMap.get(String(m.id ?? ""));
                return {
                    name: m.name,
                    scope: m.scope,
                    description: m.description,
                    score: m.score,
                    total_inv: agg ? Number(agg.total_inv ?? 0) : 0,
                    inv_30d: agg ? Number(agg.inv_30d ?? 0) : 0,
                    last_used: agg?.last_used ?? null,
                };
            })
            .sort((a, b) => {
                const ds = Number(b.score ?? 0) - Number(a.score ?? 0);
                if (ds !== 0) return ds;
                const d30 = b.inv_30d - a.inv_30d;
                if (d30 !== 0) return d30;
                return b.total_inv - a.total_inv;
            });
        if (!rows || rows.length === 0) {
            console.log("(no matches)");
            return;
        }
        for (const r of rows) {
            const score = Number(r.score ?? 0);
            const scoreStr = score.toFixed(2);
            const usage = `${fmtCount(r.inv_30d ?? 0)}×30d / ${fmtCount(r.total_inv ?? 0)}×total`;
            const desc = (r.description as string | null) ?? "";
            const truncDesc = desc.length > 100 ? desc.slice(0, 97) + "…" : desc;
            console.log(`${r.name}  [${r.scope}]  score=${scoreStr}  ${usage}`);
            if (truncDesc) console.log(`  ${truncDesc}`);
        }
    });

/**
 * Issue #40: Pre-flight existence check so unknown skill names get a
 * dedicated error instead of an empty-but-success rendering. Returns true
 * if the skill exists. Pulls the SurrealClient itself rather than taking
 * it as a parameter so the helper composes naturally inside Effect.gen.
 */
const skillExists = (name: string) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[unknown[]]>(
            "SELECT id FROM skill WHERE name = $name LIMIT 1;",
            { name },
        );
        const rows = result?.[0];
        return Array.isArray(rows) && rows.length > 0;
    });

const cmdStats = (args: string[]) =>
    Effect.gen(function* () {
        const name = args.filter((a) => !a.startsWith("--"))[0];
        if (!name) {
            console.error("axctl skills stats: missing skill name");
            process.exit(1);
        }
        const db = yield* SurrealClient;
        const exists = yield* skillExists(name);
        if (!exists) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            console.error(
                `axctl: no skill named "${name}". try: axctl skills search "${hint}"`,
            );
            process.exit(2);
        }
        // Issue #43: order recent_sessions by ts DESC (verified server-side),
        // include the session id so we can de-dup in TS, and capture cwd so
        // we can render a human-friendly project label rather than the raw
        // Claude slug.
        const sql = `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
        d7:    array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 7d)),
        d30:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 30d)),
        d90:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 90d)),
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
    recent_sessions: (
        SELECT
            in.session AS session_id,
            in.session.project AS project_slug,
            in.session.cwd AS cwd,
            ts
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 50
    )
};`;
        const result = yield* db.query<unknown[]>(sql, { name });
        const payload = (Array.isArray(result)
            ? [...result].reverse().find((r) => r != null)
            : result) as
            | {
                  skill?: { dir_path?: string | null } | null;
                  recent_sessions?: Array<Record<string, unknown>>;
              }
            | undefined;

        // Dedupe + cap to the most recent 5 distinct sessions, then prettify.
        if (payload?.recent_sessions) {
            const seen = new Set<string>();
            const clean: Array<{
                project: string;
                ts: unknown;
            }> = [];
            for (const row of payload.recent_sessions) {
                const sid = String(row.session_id ?? "");
                if (sid && seen.has(sid)) continue;
                if (sid) seen.add(sid);
                // cwd may come back as an array (per-edge projection) - take
                // the first scalar for display purposes.
                const cwdRaw = Array.isArray(row.cwd) ? row.cwd[0] : row.cwd;
                const slugRaw = Array.isArray(row.project_slug)
                    ? row.project_slug[0]
                    : row.project_slug;
                let project: string;
                if (typeof cwdRaw === "string" && cwdRaw.length > 0) {
                    // Mirrors path.basename without pulling node:path here.
                    const parts = cwdRaw.split("/").filter((p) => p.length > 0);
                    project = parts.length > 0 ? parts[parts.length - 1] : cwdRaw;
                } else {
                    project = prettifyProjectSlug(slugRaw);
                }
                clean.push({ project, ts: row.ts });
                if (clean.length >= 5) break;
            }
            (payload as Record<string, unknown>).recent_sessions = clean;
        }

        // Read body lazily from disk via dir_path (DB no longer stores body -
        // multi-file skills + cache-staleness make on-disk the canonical source).
        const dirPath = payload?.skill?.dir_path;
        // Issue #36: codex-side tools are recorded with a synthetic dir_path
        // sentinel. They have no SKILL.md, so skip the disk read entirely
        // instead of letting Effect.promise(...) crash with ENOENT.
        if (
            typeof dirPath === "string" &&
            dirPath.length > 0 &&
            dirPath !== "(synthetic)"
        ) {
            // Use plain Effect.promise with an inner try/catch that resolves
            // to `null` on read failures (e.g. SKILL.md missing for the rare
            // legacy plugin row whose dir_path is stale). Avoids tripping
            // tryPromise's typed-error machinery when we just want a fall
            // through. Catches issue #36 too: synthetic dir_path was already
            // skipped above, but defence-in-depth keeps a future "(synthetic-
            // like)" sentinel from regressing.
            const body = yield* Effect.promise(async () => {
                try {
                    const { readFile } = await import("node:fs/promises");
                    const { join } = await import("node:path");
                    return await readFile(join(dirPath, "SKILL.md"), "utf8");
                } catch {
                    return null;
                }
            });
            if (body !== null) {
                const m = body.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                const trimmed = (m?.[1] ?? body).trim();
                if (trimmed.length > 0) {
                    const excerpt =
                        trimmed.length > 500 ? trimmed.slice(0, 500) + "…" : trimmed;
                    console.log("--- body excerpt ---");
                    console.log(excerpt);
                    console.log("--- end body ---\n");
                }
            }
        }
        console.log(prettyPrint(payload));
    });

const cmdRecent = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("recent", "limit", args, 20);
        const db = yield* SurrealClient;
        const sql = `
SELECT ts, out.name AS skill, in.session.project AS project
FROM invoked
ORDER BY ts DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        for (const r of rows ?? []) {
            console.log(
                `${r.ts}  ${r.skill}  (${prettifyProjectSlug(r.project)})`,
            );
        }
    });

const cmdUnused = (args: string[]) =>
    Effect.gen(function* () {
        const days = parsePositiveIntFlag("unused", "days", args, 7);
        const db = yield* SurrealClient;
        // PERF (issue #31): Previous form ran a correlated subquery per skill
        // (`SELECT count() FROM invoked WHERE out = $parent.id AND ts > N`).
        // On the largest skill (~500k invoked edges) the index walk took
        // ~1.5s × 137 skills = enough to make this multi-minute.
        //
        // Now we (a) compute the recent-active set in one full-scan
        // GROUP BY over `invoked`, (b) compute total_inv + last_used in
        // bulk, (c) anti-join in TS. Net round-trip: ~2 cheap queries.
        const recentSql = `
SELECT out AS skill_id, count() AS recent
FROM invoked
WHERE ts > time::now() - ${days}d
GROUP BY out;`;
        // Issue #34: `out.name AS name` over a GROUP BY scan returns the
        // per-edge name array (e.g. ~500k entries for codex:exec_command).
        // String() of that is a 17 MB single line. Aggregate over the edge
        // table only, then look up the skill row by id in a separate cheap
        // query and merge in TS.
        const summarySql = `
SELECT
    out AS skill_id,
    count() AS total_inv,
    math::max(ts) AS last_used
FROM invoked
GROUP BY out;`;
        const skillSql = `SELECT id, name, scope FROM skill;`;
        // Skills with literally zero invocations don't show up in the
        // GROUP BY scan; pull them straight from the skill table so the
        // "never used" rows still appear.
        const noInvSql = `
SELECT name, scope FROM skill WHERE array::len(<-invoked) = 0;`;
        const [recentRes, summaryRes, skillRes, noInvRes] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(recentSql),
                db.query<[Array<Record<string, unknown>>]>(summarySql),
                db.query<[Array<Record<string, unknown>>]>(skillSql),
                db.query<[Array<Record<string, unknown>>]>(noInvSql),
            ],
            { concurrency: 4 },
        );
        const recent = new Set<string>(
            (recentRes?.[0] ?? []).map((r) => String(r.skill_id ?? "")),
        );
        const skillById = new Map<
            string,
            { name: string; scope: string }
        >();
        for (const s of (skillRes?.[0] ?? []) as Array<Record<string, unknown>>) {
            skillById.set(String(s.id ?? ""), {
                name: String(s.name ?? ""),
                scope: String(s.scope ?? ""),
            });
        }
        const summary = (summaryRes?.[0] ?? []) as Array<Record<string, unknown>>;
        const fmtTs = (v: unknown): string => {
            if (v == null) return "never";
            // SurrealDB's math::max returns -Infinity for empty groups; surface
            // it as "never" rather than the literal "-Infinity" string.
            if (typeof v === "number" && !Number.isFinite(v)) return "never";
            if (typeof v === "string") return v;
            if (v instanceof Date) return v.toISOString();
            return String(v);
        };
        const unused: Array<{
            name: string;
            scope: string;
            total_inv: number;
            last_used: string;
        }> = [];
        for (const r of summary) {
            const id = String(r.skill_id ?? "");
            if (recent.has(id)) continue;
            const meta = skillById.get(id);
            // Drop orphan invocations whose target skill never had a row
            // UPSERTed (matches the original FROM-skill behaviour, which
            // started from skill rows and naturally excluded these).
            if (!meta || !meta.name) continue;
            unused.push({
                name: meta.name,
                scope: meta.scope,
                total_inv: Number(r.total_inv ?? 0),
                last_used: fmtTs(r.last_used),
            });
        }
        for (const r of (noInvRes?.[0] ?? []) as Array<Record<string, unknown>>) {
            unused.push({
                name: String(r.name ?? ""),
                scope: String(r.scope ?? ""),
                total_inv: 0,
                last_used: "never",
            });
        }
        unused.sort(
            (a, b) =>
                a.total_inv - b.total_inv || a.name.localeCompare(b.name),
        );
        for (const r of unused) {
            console.log(
                `${r.name}  [${r.scope}]  total=${fmtCount(r.total_inv)}  last=${r.last_used}`,
            );
        }
        console.log(`\n${unused.length} skills unused in last ${days} days.`);
    });

const cmdTaste = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("taste", "limit", args, 30);
        const db = yield* SurrealClient;
        // Composite signal: invocations (positive), errors near invocation
        // (negative), corrections within 3 turns of invocation in the same
        // session (negative - user pushed back), commits produced by sessions
        // that invoked this skill (positive - led to a real change), and
        // proposed-but-not-invoked (negative - assistant suggested it but
        // never fired, wasted suggestion).
        //
        // `corrections` counts invocations where the next user turn within 3
        // seq steps in the same session triggered a corrected_by edge.
        // `commits_after` counts `produced` edges from sessions that invoked
        // this skill (proxy for "skill use led to a commit").
        // `proposals` counts proposed edges into this skill.
        // taste_score = inv_total - 2*corrections + commits_after - 0.5*proposals
        //
        // PERF (issue #31): The previous form ran 4-5 correlated subqueries
        // per skill (`WHERE out = $parent.id AND <pred>`), each forcing the
        // index scan to walk every edge for that skill. On the largest skill
        // (codex:exec_command, ~500k edges) every subquery cost ~1.5-2s,
        // putting the total at ~167s for 137 skills. SurrealDB's optimiser
        // doesn't push graph traversal `<-invoked WHERE ...` past the edge
        // materialisation either, so neither FETCH nor inline graph-WHERE
        // helped meaningfully (~90s).
        //
        // Current form does the heavy aggregation in ONE pass over the
        // `invoked` table via `GROUP BY out` with conditional `math::sum`.
        // This requires two new denormalised fields on the edge:
        //   - `turn_has_error` (set at ingest from the source turn)
        //   - `was_corrected`  (set by derive-signals when a corrected_by
        //                       edge falls within +3 seq of the invocation)
        // so that the `clean_inv` / `corrections` predicates become pure
        // edge-field filters. End-to-end taste runtime drops to ~13s.
        //
        // The query runs in three server-side stages plus a client-side
        // merge so that *every* skill row gets a slot, not just those with
        // invoked or proposed edges (issue #47):
        //   (a) AGGREGATES_SQL  - per-skill counters from the invoked scan,
        //                         then enriches with `<-proposed` /
        //                         `<-invoked.in.session` traversals and
        //                         `produced` join.
        //   (b) PROPOSED_ONLY_SQL - skills with no invocations but with
        //                           proposals, contributing the negative
        //                           taste_score floor (-0.5 * proposals).
        //   (c) ZERO_SQL          - skills with neither invocations nor
        //                           proposals; rendered with score 0 so the
        //                           total skill count is honest.
        // Results are concatenated and sorted in TS to mirror the original
        // ORDER BY taste_score DESC, inv_30d DESC, inv_total DESC.
        const aggregatesSql = `
SELECT
    name,
    scope,
    inv_total,
    inv_7d,
    inv_30d,
    clean_inv,
    corrections,
    proposals,
    array::len((
        SELECT id FROM produced WHERE in IN $parent.skill_sessions
    )) AS commits_after,
    (
        inv_total
        - 2 * corrections
        + array::len((SELECT id FROM produced WHERE in IN $parent.skill_sessions))
        - 0.5 * proposals
    ) AS taste_score
FROM (
    SELECT
        skill_id.name AS name,
        skill_id.scope AS scope,
        inv_total,
        inv_7d,
        inv_30d,
        clean_inv,
        corrections,
        array::len(skill_id<-proposed) AS proposals,
        array::distinct(skill_id<-invoked.in.session ?? []) AS skill_sessions
    FROM (
        SELECT
            out AS skill_id,
            count() AS inv_total,
            math::sum(IF ts > time::now() - 7d  THEN 1 ELSE 0 END) AS inv_7d,
            math::sum(IF ts > time::now() - 30d THEN 1 ELSE 0 END) AS inv_30d,
            math::sum(IF turn_has_error = false THEN 1 ELSE 0 END) AS clean_inv,
            math::sum(IF was_corrected   = true  THEN 1 ELSE 0 END) AS corrections
        FROM invoked
        GROUP BY out
    )
    -- Drop orphan invocations whose target skill never had its row UPSERTed
    -- (matches the original cmdTaste behaviour, which started FROM skill and
    -- thus naturally excluded these). Currently happens for a handful of
    -- legacy plugin/built-in tool names that didn't get recorded as skills.
    WHERE skill_id.name IS NOT NONE
);`;

        // Skills with proposals but no invocations - the GROUP BY scan
        // doesn't see them. Cheap: 137-skill count + per-skill proposal
        // count, all via graph traversal.
        const proposedOnlySql = `
SELECT
    name,
    scope,
    0 AS inv_total,
    0 AS inv_7d,
    0 AS inv_30d,
    0 AS clean_inv,
    0 AS corrections,
    array::len(<-proposed) AS proposals,
    0 AS commits_after,
    -0.5 * array::len(<-proposed) AS taste_score
FROM skill
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) > 0;`;

        // Issue #47: skills with neither invocations nor proposals get
        // dropped entirely from the merged set, so `taste --limit=200`
        // returns ~35 rows instead of all 137. Pull them in with a flat
        // zero score so the table reflects the real catalog.
        const zeroSql = `
SELECT
    name,
    scope,
    0 AS inv_total,
    0 AS inv_7d,
    0 AS inv_30d,
    0 AS clean_inv,
    0 AS corrections,
    0 AS proposals,
    0 AS commits_after,
    0 AS taste_score
FROM skill
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) = 0;`;

        const [aggResult, propResult, zeroResult] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(aggregatesSql),
                db.query<[Array<Record<string, unknown>>]>(proposedOnlySql),
                db.query<[Array<Record<string, unknown>>]>(zeroSql),
            ],
            { concurrency: 3 },
        );
        const aggRows = aggResult?.[0] ?? [];
        const propRows = propResult?.[0] ?? [];
        const zeroRows = zeroResult?.[0] ?? [];
        // Merge + sort to mirror original ORDER BY (server-side ORDER BY
        // would force a second pass over the merged set, simpler in TS).
        const score = (r: Record<string, unknown>) => Number(r.taste_score ?? 0);
        const merged = [...aggRows, ...propRows, ...zeroRows].sort((a, b) => {
            const ds = score(b) - score(a);
            if (ds !== 0) return ds;
            const d30 = Number(b.inv_30d ?? 0) - Number(a.inv_30d ?? 0);
            if (d30 !== 0) return d30;
            return Number(b.inv_total ?? 0) - Number(a.inv_total ?? 0);
        });
        const totalRows = merged.length;
        const rows = merged.slice(0, limit);
        const fmtScore = (n: unknown): string => {
            const v = Number(n ?? 0);
            return Number.isInteger(v) ? fmtCount(v) : v.toFixed(1);
        };
        // Issue #46: pre-compute column widths from the displayed rows so
        // 6+ digit values (e.g. codex:exec_command at 597,508) don't bleed
        // into the next column. Header width sets the floor.
        const cols = [
            { key: "score", header: "score", get: (r: Record<string, unknown>) => fmtScore(r.taste_score) },
            { key: "7d", header: "7d", get: (r: Record<string, unknown>) => fmtCount(r.inv_7d) },
            { key: "30d", header: "30d", get: (r: Record<string, unknown>) => fmtCount(r.inv_30d) },
            { key: "total", header: "total", get: (r: Record<string, unknown>) => fmtCount(r.inv_total) },
            { key: "clean", header: "clean", get: (r: Record<string, unknown>) => fmtCount(r.clean_inv) },
            { key: "corr", header: "corr", get: (r: Record<string, unknown>) => fmtCount(r.corrections ?? 0) },
            { key: "prop", header: "prop", get: (r: Record<string, unknown>) => fmtCount(r.proposals ?? 0) },
            { key: "cmts", header: "cmts", get: (r: Record<string, unknown>) => fmtCount(r.commits_after ?? 0) },
        ];
        const widths = cols.map((c) =>
            Math.max(c.header.length, ...rows.map((r) => c.get(r).length)),
        );
        const headerCells = cols.map((c, i) => c.header.padStart(widths[i])).join("  ");
        console.log(
            `${"skill".padEnd(50)}  ${"scope".padEnd(16)}  ${headerCells}`,
        );
        for (const r of rows ?? []) {
            const cells = cols.map((c, i) => c.get(r).padStart(widths[i])).join("  ");
            console.log(
                `${String(r.name).padEnd(50)}  ${String(r.scope).padEnd(16)}  ${cells}`,
            );
        }
        console.log(`\n(${rows.length} / ${totalRows} skills shown)`);
    });

const cmdPairs = (args: string[]) =>
    Effect.gen(function* () {
        const name = args.filter((a) => !a.startsWith("--"))[0];
        if (!name) {
            console.error("axctl skills pairs: missing skill name");
            process.exit(1);
        }
        const limit = parsePositiveIntFlag("pairs", "limit", args, 20);
        const db = yield* SurrealClient;
        const exists = yield* skillExists(name);
        if (!exists) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            console.error(
                `axctl: no skill named "${name}". try: axctl skills search "${hint}"`,
            );
            process.exit(2);
        }
        // Pairs are stored undirected (lexicographically lo->hi). Look the
        // skill up on either endpoint so callers don't have to know the
        // canonical direction. Combine both legs into a single ranked list.
        // Pairs are stored undirected (lexicographically lo->hi), so the
        // queried skill could be on either endpoint. Use IF/ELSE to pick the
        // partner regardless of position; SurrealDB lacks UNION on SELECTs.
        const sql = `
LET $s = (SELECT id FROM skill WHERE name = $name)[0].id;
SELECT
    (IF in = $s THEN out.name ELSE in.name END) AS partner,
    count,
    last_seen
FROM skill_paired
WHERE in = $s OR out = $s
ORDER BY count DESC
LIMIT ${limit};`;
        const result = yield* db.query<unknown[]>(sql, { name });
        const arr = Array.isArray(result)
            ? [...result].reverse().find((r) => Array.isArray(r) && (r as unknown[]).length > 0)
            : undefined;
        const rows = (arr as Array<Record<string, unknown>> | undefined) ?? [];
        if (rows.length === 0) {
            console.log("(no co-occurring skills)");
            return;
        }
        console.log(`${"partner".padEnd(50)}  count  last_seen`);
        for (const r of rows) {
            console.log(
                `${String(r.partner).padEnd(50)}  ${String(r.count).padStart(5)}  ${r.last_seen ?? "-"}`,
            );
        }
    });

const cmdRecovery = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("recovery", "limit", args, 20);
        const db = yield* SurrealClient;
        const sql = `
SELECT out.name AS skill, count() AS hits
FROM recovered_by
GROUP BY skill
ORDER BY hits DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        if (!rows || rows.length === 0) {
            console.log("(no recovery edges)");
            return;
        }
        console.log(`${"skill".padEnd(50)}  hits`);
        for (const r of rows) {
            console.log(`${String(r.skill).padEnd(50)}  ${String(r.hits).padStart(4)}`);
        }
    });

const positiveLimit = (fallback: number) =>
    Flag.integer("limit").pipe(Flag.withDefault(fallback));
const optionalSince = Flag.integer("since").pipe(Flag.optional);
const jsonFlag = Flag.boolean("json").pipe(Flag.withDefault(false));
const checkFlag = Flag.boolean("check").pipe(Flag.withDefault(false));
const verboseFlag = Flag.boolean("verbose").pipe(Flag.withDefault(false));
const progressFlag = Flag.choice("progress", ["auto", "pipeline", "plain", "json", "off"] as const).pipe(
    Flag.withDefault("auto"),
);

/**
 * `--insights-only` short-circuits to `cmdIngestInsights`, bypassing
 * `cmdIngest`'s `--*-only` mutual-exclusion check. Without this helper,
 * `axctl ingest --insights-only --codex-only --since=7` silently ignores
 * `--codex-only` and `--since`. Exported for unit testing.
 */
export const insightsOnlyConflicts = (opts: {
    skillsOnly: boolean;
    transcriptsOnly: boolean;
    codexOnly: boolean;
    gitOnly: boolean;
    claudeOnly: boolean;
    hasSince: boolean;
}): string[] => {
    const conflicts: string[] = [];
    if (opts.skillsOnly) conflicts.push("--skills-only");
    if (opts.transcriptsOnly) conflicts.push("--transcripts-only");
    if (opts.codexOnly) conflicts.push("--codex-only");
    if (opts.gitOnly) conflicts.push("--git-only");
    if (opts.claudeOnly) conflicts.push("--claude-only");
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
    },
    ({ since, stages, progress, verbose }) =>
        cmdIngestHere([
            ...intArg("since", optionValue(since)),
            ...stringArg("stages", optionValue(stages)),
            `--progress=${progress}`,
            ...boolArg("verbose", verbose),
        ]),
).pipe(Command.withDescription(
    "Ingest only the git repository at $PWD. Filters claude transcripts to this project, " +
    "restricts git history to this repo. Codex stage is skipped (no cwd filter in v0). " +
    "Use --stages=<a,b,c> to run a subset.",
));

const ingestCommand = Command.make(
    "ingest",
    {
        skillsOnly: Flag.boolean("skills-only").pipe(Flag.withDefault(false)),
        transcriptsOnly: Flag.boolean("transcripts-only").pipe(Flag.withDefault(false)),
        codexOnly: Flag.boolean("codex-only").pipe(Flag.withDefault(false)),
        gitOnly: Flag.boolean("git-only").pipe(Flag.withDefault(false)),
        claudeOnly: Flag.boolean("claude-only").pipe(Flag.withDefault(false)),
        insightsOnly: Flag.boolean("insights-only").pipe(Flag.withDefault(false)),
        // Run a chosen subset of stages, e.g. --stages=signals,outcomes.
        stages: Flag.string("stages").pipe(Flag.optional),
        // Shortcut: only the DB-derive stages (signals/outcomes/session-health/
        // closure) - skips the slow transcript + git parse.
        deriveOnly: Flag.boolean("derive-only").pipe(Flag.withDefault(false)),
        // Wipe the skill graph before a full re-ingest so it rebuilds clean.
        reset: Flag.boolean("reset").pipe(Flag.withDefault(false)),
        since: optionalSince,
        progress: progressFlag,
        verbose: verboseFlag,
    },
    ({ skillsOnly, transcriptsOnly, codexOnly, gitOnly, claudeOnly, insightsOnly, stages, deriveOnly, reset, since, progress, verbose }) => {
        if (insightsOnly) {
            if (reset) {
                console.error("axctl ingest: --reset cannot be combined with --insights-only");
                process.exit(2);
            }
            const conflicts = insightsOnlyConflicts({
                skillsOnly,
                transcriptsOnly,
                codexOnly,
                gitOnly,
                claudeOnly,
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
            ]);
        }
        return cmdIngest([
            ...boolArg("skills-only", skillsOnly),
            ...boolArg("transcripts-only", transcriptsOnly),
            ...boolArg("codex-only", codexOnly),
            ...boolArg("git-only", gitOnly),
            ...boolArg("claude-only", claudeOnly),
            ...stringArg("stages", optionValue(stages)),
            ...boolArg("derive-only", deriveOnly),
            ...boolArg("reset", reset),
            ...intArg("since", optionValue(since)),
            `--progress=${progress}`,
            ...boolArg("verbose", verbose),
        ]);
    },
).pipe(
    Command.withDescription(
        "Ingest skills, transcripts, Codex sessions, git history, and insight artifacts. " +
            "Use --stages=<a,b,c> or --derive-only to run a subset against an already-ingested DB. " +
            "Use --reset to wipe the skill graph first and rebuild it clean.",
    ),
    Command.withSubcommands([ingestHereCommand]),
);

const deriveSignalsCommand = Command.make(
    "derive-signals",
    { since: optionalSince, progress: progressFlag, verbose: verboseFlag },
    ({ since, progress, verbose }) =>
        cmdDeriveSignals([...intArg("since", optionValue(since)), `--progress=${progress}`, ...boolArg("verbose", verbose)]),
).pipe(Command.withDescription("Derive friction, diagnostic, recommendation, and recovery signals"));

const deriveIntentsCommand = Command.make(
    "derive-intents",
    {
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ dryRun, json }) =>
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
        }),
).pipe(Command.withDescription("Re-run intent classification over existing turn rows; updates intent_kind in place"));

const insightView = Argument.choice("view", INSIGHT_VIEWS).pipe(Argument.withDefault("repositories"));

const insightsCommand = Command.make(
    "insights",
    {
        view: insightView,
        limit: positiveLimit(20),
    },
    ({ view, limit }) => cmdInsights([view, `--limit=${limit}`]),
).pipe(Command.withDescription("Run built-in graph insight queries"));

/**
 * axctl improve - surface the experiment-loop proposal shortlist.
 * Phase C2 ships read-only `list` + `show`. accept/reject/verdict land in
 * C3/C4/C8 with the scaffold-on-accept fix that closes the
 * manual-step-dropout problem the adversarial review flagged.
 */
interface ProposalRow {
    readonly id: { tb: string; id: string } | string;
    readonly form: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly dedupe_sig: string;
    readonly frequency: number;
    readonly confidence: string;
    readonly status: string;
    readonly created_at?: string;
}

interface SkillProposalRow {
    readonly trigger_pattern: string;
    readonly suspected_gap: string;
    readonly proposed_behavior: string;
    readonly expected_impact: string | null;
}

const formatProposalLine = (row: ProposalRow): string => {
    const freq = String(row.frequency).padStart(6);
    const conf = (row.confidence ?? "").padEnd(6);
    const status = (row.status ?? "").padEnd(10);
    const form = (row.form ?? "").padEnd(11);
    const sig = (row.dedupe_sig ?? "").padEnd(24);
    return `${freq}  ${conf}  ${status}  ${form}  ${sig}  ${row.title}`;
};

const cmdImproveList = (args: string[]) =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const limit = parsePositiveIntFlag("improve list", "limit", args, 30);
        const formFilter = flag("form", args);
        const statusFilter = flag("status", args) ?? "open";
        const db = yield* SurrealClient;
        const where: string[] = [];
        if (statusFilter !== "all") {
            where.push(`status = ${surrealLiteral(statusFilter)}`);
        }
        if (formFilter !== undefined) {
            where.push(`form = ${surrealLiteral(formFilter)}`);
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const sql = `SELECT id, form, title, hypothesis, dedupe_sig, frequency, confidence, status, type::string(created_at) AS created_at FROM proposal ${whereClause} ORDER BY frequency DESC, created_at DESC LIMIT ${limit};`;
        const result = yield* db.query<[ProposalRow[]]>(sql);
        const rows = result?.[0] ?? [];
        if (json) {
            console.log(prettyPrint(rows));
            return;
        }
        if (rows.length === 0) {
            console.log("(no proposals match filter)");
            return;
        }
        console.log(`  freq  conf    status      form         dedupe_sig                title`);
        for (const row of rows) console.log(formatProposalLine(row));
    });

const cmdImproveShow = (args: string[]) =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const positional = args.filter((a) => !a.startsWith("--"))[0];
        if (positional === undefined) {
            console.error("axctl improve show: missing <id> (use a dedupe_sig from `axctl improve list`)");
            process.exit(2);
        }
        const result = yield* showExperiment({ sigOrId: positional });
        if (json) {
            console.log(prettyPrint(result));
            return;
        }
        if (result === null) {
            process.stderr.write(`no proposal matched ${positional}\n`);
            process.exit(2);
        }
        console.log(formatShow(result));
    });

const cmdImproveLint = (args: string[]) =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const staleDays = parsePositiveIntFlag("improve lint", "stale-days", args, 7);
        // Collect --root values (repeatable)
        const roots: string[] = [];
        for (const a of args) {
            if (a.startsWith("--root=")) roots.push(a.slice("--root=".length));
        }
        const report = yield* lintFiles({
            roots: roots.length > 0 ? roots : undefined,
            staleDays,
        });
        if (json) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            for (const f of report.errors) {
                console.log(`error  ${f.rule}: ${f.message} (${f.path})`);
            }
            for (const f of report.warnings) {
                console.log(`warn   ${f.rule}: ${f.message} (${f.path})`);
            }
            for (const f of report.infos) {
                console.log(`info   ${f.rule}: ${f.message} (${f.path})`);
            }
            for (const r of report.reconciled) {
                const suffix = r.taskDeleted ? ` (removed ${r.taskDeleted})` : "";
                console.log(`reconciled ${r.shortId}: ${r.previousStatus} -> ${r.nextStatus}${suffix}`);
            }
            const allEmpty =
                report.errors.length === 0 &&
                report.warnings.length === 0 &&
                report.infos.length === 0 &&
                report.reconciled.length === 0;
            if (allEmpty) console.log("clean.");
        }
        if (report.errors.length > 0) {
            process.exit(2);
        } else if (report.warnings.length > 0) {
            process.exitCode = 1;
        }
    });

const cmdImproveRecommend = (args: string[]) =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const noClipboard = args.includes("--no-clipboard");
        const apply = args.includes("--apply");
        const limit = parsePositiveIntFlag("improve recommend", "limit", args, 5);
        const sinceDays = parseOptionalPositiveIntFlag("improve recommend", "since", args);
        // Collect --form values (repeatable; also tolerate comma-separated)
        const forms: string[] = [];
        for (const a of args) {
            if (a.startsWith("--form=")) {
                const val = a.slice("--form=".length);
                for (const f of val.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
                    forms.push(f);
                }
            }
        }
        const items = yield* recommend({
            limit,
            forms: forms.length > 0 ? forms : undefined,
            sinceDays,
        });
        if (json) {
            console.log(JSON.stringify(items, null, 2));
            return;
        }
        const formatted = formatRecommendations(items);
        console.log(formatted);
        if (items.length > 0 && !noClipboard) {
            const copied = copyToClipboard(formatted);
            if (copied) console.log("\n[copied to clipboard]");
        }
        if (apply && items.length > 0) {
            // Print numbered list for reference
            process.stdout.write("\n");
            items.forEach((item, i) => {
                process.stdout.write(`  ${i + 1}. ${item.shortId}  ${item.title}\n`);
            });
            process.stdout.write(`\nPick indices to accept (e.g. \`1 3\` or \`1-3\`): `);
            const input = yield* Effect.promise(
                () =>
                    new Promise<string>((resolve) => {
                        process.stdin.once("data", (b) => {
                            resolve(b.toString().trim());
                            process.stdin.pause();
                        });
                        process.stdin.resume();
                    }),
            );
            const picked = selectByIndices(items, parseIndexInput(input, items.length));
            for (const item of picked) {
                const result = yield* acceptProposal({ sigOrId: item.shortId });
                const taskSuffix = result.task_path ? ` -> ${result.task_path}` : "";
                console.log(`${item.shortId}: ${result.status}${taskSuffix}`);
            }
        }
    });

const improveRecommendCommand = Command.make(
    "recommend",
    {
        limit: Flag.integer("limit").pipe(Flag.withDefault(5)),
        form: Flag.string("form").pipe(Flag.atLeast(0)),
        since: Flag.integer("since").pipe(Flag.optional),
        json: Flag.boolean("json").pipe(Flag.withDefault(false)),
        noClipboard: Flag.boolean("no-clipboard").pipe(Flag.withDefault(false)),
        apply: Flag.boolean("apply").pipe(Flag.withDefault(false)),
    },
    ({ limit, form, since, json, noClipboard, apply }) =>
        cmdImproveRecommend([
            `--limit=${limit}`,
            ...[...form].flatMap((f) => [`--form=${f}`]),
            ...intArg("since", optionValue(since)),
            ...boolArg("json", json),
            ...boolArg("no-clipboard", noClipboard),
            ...boolArg("apply", apply),
        ]),
).pipe(Command.withDescription("Rank open proposals by confidence × recency × frequency and print the top N (optionally copy to clipboard)"));

const improveLintCommand = Command.make(
    "lint",
    {
        root: Flag.string("root").pipe(Flag.atLeast(0)),
        json: jsonFlag,
        staleDays: Flag.integer("stale-days").pipe(Flag.withDefault(7)),
    },
    ({ root, json, staleDays }) =>
        cmdImproveLint([
            ...[...root].map((r) => `--root=${r}`),
            ...boolArg("json", json),
            `--stale-days=${staleDays}`,
        ]),
).pipe(Command.withDescription("Scan grounded agent files for marker issues; reconcile task_emitted experiments; warn on stale tasks"));

const improveListCommand = Command.make(
    "list",
    {
        limit: positiveLimit(30),
        form: Flag.string("form").pipe(Flag.optional),
        status: Flag.string("status").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ limit, form, status, json }) =>
        cmdImproveList([
            `--limit=${limit}`,
            ...stringArg("form", optionValue(form)),
            ...stringArg("status", optionValue(status)),
            ...boolArg("json", json),
        ]),
).pipe(Command.withDescription("List open experiment-loop proposals (ranked by frequency)"));

const improveShowCommand = Command.make(
    "show",
    {
        id: Argument.string("id"),
        json: jsonFlag,
    },
    ({ id, json }) => cmdImproveShow([id, ...boolArg("json", json)]),
).pipe(Command.withDescription("Show experiment evidence + status for one proposal id"));

const cmdImproveAccept = (args: string[]) =>
    Effect.gen(function* () {
        const positional = args.filter((a) => !a.startsWith("--"))[0];
        if (positional === undefined) {
            console.error("axctl improve accept: missing <id>");
            process.exit(2);
        }
        const force = args.includes("--force");
        const withAgent = args.includes("--with-agent");
        const db = yield* SurrealClient;
        const idLiteral = surrealLiteral(positional);
        const sql = `
            SELECT *, (SELECT * FROM skill_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS skill_payload
            FROM proposal WHERE dedupe_sig = ${idLiteral} OR id = ${idLiteral} LIMIT 1;
        `;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const row = (result?.[0] ?? [])[0];
        if (!row) {
            console.error(`no proposal matched ${positional}`);
            process.exit(2);
        }
        const proposalKey = recordKeyPart(row.id, "proposal");
        if (!proposalKey) {
            console.error("internal: proposal.id has unexpected shape");
            process.exit(2);
        }
        const status = String(row.status ?? "");
        if (status !== "open") {
            // Look up the existing experiment so the user sees what was
            // scaffolded last time (and where) instead of a bare refusal.
            // This SELECT also makes `experiment` a legitimately-read table
            // for the table-coverage CI gate.
            const existing = yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT id, artifact_path, type::string(scaffolded_at) AS scaffolded_at, type::string(created_at) AS created_at, locked_verdict FROM experiment WHERE proposal = ${recordRef("proposal", proposalKey)} LIMIT 1;`,
            );
            const existingExperiment = (existing?.[0] ?? [])[0];
            console.error(`proposal already ${status} (use \`axctl improve list --status=all\` to see)`);
            if (existingExperiment) {
                console.error(`  experiment   ${String(existingExperiment.id)}`);
                if (existingExperiment.artifact_path) {
                    console.error(`  scaffold     ${String(existingExperiment.artifact_path)}`);
                }
                if (existingExperiment.scaffolded_at) {
                    console.error(`  scaffolded   ${String(existingExperiment.scaffolded_at)}`);
                }
                if (existingExperiment.locked_verdict) {
                    console.error(`  verdict      ${String(existingExperiment.locked_verdict)}`);
                }
            }
            process.exit(2);
        }
        const form = String(row.form ?? "");
        if (form !== "skill") {
            console.error(`accept currently supports form=skill only (got ${form}); subagent/hook/guidance/automation land in later phases`);
            process.exit(2);
        }
        const payload = row.skill_payload as (Record<string, unknown> | null);
        if (!payload) {
            console.error("internal: skill_proposal payload missing for form=skill row");
            process.exit(2);
        }

        const scaffold = scaffoldSkill({
            input: {
                title: String(row.title),
                hypothesis: String(row.hypothesis),
                proposedBehavior: String(payload.proposed_behavior ?? ""),
                triggerPattern: payload.trigger_pattern == null ? null : String(payload.trigger_pattern),
                expectedImpact: payload.expected_impact == null ? null : String(payload.expected_impact),
                dedupeSig: String(row.dedupe_sig),
                nowIso: new Date().toISOString(),
            },
            force,
        });
        if (scaffold.skipped) {
            console.error(`refusing to clobber existing scaffold at ${scaffold.path} (use --force to overwrite)`);
            process.exit(2);
        }

        const experimentKey = `${proposalKey}__${Date.now().toString(36)}`;
        const update = `
            UPDATE ${recordRef("proposal", proposalKey)} SET status = 'accepted', updated_at = time::now();
            UPSERT ${recordRef("experiment", experimentKey)} MERGE {
                proposal: ${recordRef("proposal", proposalKey)},
                artifact_path: ${surrealLiteral(scaffold.path)},
                scaffolded_at: time::now()
            };
        `;
        yield* db.query(update);
        console.log(`scaffolded ${scaffold.path}`);
        console.log(`experiment ${recordRef("experiment", experimentKey)} created`);
        console.log(`proposal status -> accepted`);

        if (withAgent) {
            // Reach back into proposal.baseline (set by derive-retro-proposals)
            // for retro session summaries. For non-retro proposals it's null
            // and we just pass an empty list.
            let retroSummaries: readonly string[] = [];
            const baselineRaw = row.baseline;
            if (typeof baselineRaw === "string" && baselineRaw.length > 0) {
                const parsed = safeJsonParse<{ tool?: string; sessionKeys?: unknown; frequency?: number }>(baselineRaw);
                if (parsed && Array.isArray(parsed.sessionKeys)) {
                    const tool = parsed.tool ?? "tool";
                    retroSummaries = parsed.sessionKeys
                        .filter((s): s is string => typeof s === "string")
                        .slice(0, 5)
                        .map((s) => `session ${s}: top tool ${tool} failed (cluster freq=${parsed.frequency ?? "?"})`);
                }
                // baseline shape may evolve - null parse is ignored.
            }
            console.log("");
            console.log("spawning claude subagent to enrich the stub…");
            const result = yield* Effect.promise(() =>
                runAgentAccept({
                    skillPath: scaffold.path,
                    proposalTitle: String(row.title),
                    hypothesis: String(row.hypothesis),
                    triggerPattern: payload.trigger_pattern == null ? "" : String(payload.trigger_pattern),
                    proposedBehavior: String(payload.proposed_behavior ?? ""),
                    retroSummaries,
                    relatedSkillsDir: process.env.AX_SKILLS_SCAFFOLD_DIR ?? `${homedir()}/.claude/skills`,
                }),
            );
            if (result.skillEnriched) {
                console.log(`agent enriched ${scaffold.path}`);
            }
            if (result.planWritten && result.planPath) {
                console.log(`agent wrote plan ${result.planPath}`);
            }
            if (result.exitCode !== 0) {
                console.log(`agent exit code ${result.exitCode} (stub still scaffolded; experiment row unchanged)`);
            }
        }
    });

const cmdImproveReject = (args: string[]) =>
    Effect.gen(function* () {
        const positional = args.filter((a) => !a.startsWith("--"))[0];
        if (positional === undefined) {
            console.error("axctl improve reject: missing <id>");
            process.exit(2);
        }
        const reason = flag("reason", args) ?? "not_worth_packaging";
        const db = yield* SurrealClient;
        const idLiteral = surrealLiteral(positional);
        const sel = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, status FROM proposal WHERE dedupe_sig = ${idLiteral} OR id = ${idLiteral} LIMIT 1;`,
        );
        const row = (sel?.[0] ?? [])[0];
        if (!row) { console.error(`no proposal matched ${positional}`); process.exit(2); }
        const status = String(row.status ?? "");
        if (status !== "open") {
            console.error(`proposal already ${status}`);
            process.exit(2);
        }
        const proposalKey = recordKeyPart(row.id, "proposal");
        if (!proposalKey) { console.error("internal: proposal.id unexpected"); process.exit(2); }
        yield* db.query(
            `UPDATE ${recordRef("proposal", proposalKey)} SET status = 'rejected', reject_reason = ${surrealLiteral(reason)}, updated_at = time::now();`,
        );
        console.log(`proposal status -> rejected (reason: ${reason})`);
    });

const improveAcceptCommand = Command.make(
    "accept",
    {
        id: Argument.string("id"),
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
        withAgent: Flag.boolean("with-agent").pipe(Flag.withDefault(false)),
        autoScaffold: Flag.boolean("auto-scaffold").pipe(
            Flag.withDefault(false),
            Flag.withDescription("Skip task emission and directly scaffold the SKILL.md (skill form only)"),
        ),
    },
    ({ id, force, withAgent, autoScaffold }) =>
        Effect.gen(function* () {
            const result = yield* acceptProposal({ sigOrId: id, force, autoScaffold });

            if (result.status === "not_found") {
                console.error(result.message ?? `no proposal matched ${id}`);
                process.exit(2);
            }
            if (result.status === "wrong_status") {
                console.error(result.message ?? "proposal already processed");
                const ex = result.existing_experiment;
                if (ex) {
                    console.error(`  experiment   ${ex.id}`);
                    if (ex.artifact_path) console.error(`  scaffold     ${ex.artifact_path}`);
                    if (ex.scaffolded_at) console.error(`  scaffolded   ${ex.scaffolded_at}`);
                    if (ex.locked_verdict) console.error(`  verdict      ${ex.locked_verdict}`);
                }
                process.exit(2);
            }
            if (result.status === "unsupported_form") {
                console.error(result.message ?? "unsupported form");
                process.exit(2);
            }
            if (result.status === "missing_payload") {
                console.error(result.message ?? "missing payload");
                process.exit(2);
            }
            if (result.status === "scaffold_exists") {
                console.error(result.message ?? "scaffold already exists (use --force to overwrite)");
                process.exit(2);
            }

            // status === "ok"
            if (result.task_path) {
                console.log(`task emitted at ${result.task_path}`);
                console.log(`apply with your agent: \`claude "do ${result.task_path}"\``);
                console.log(`reconcile after edit: \`axctl improve lint\``);
            } else if (result.artifact_path) {
                console.log(`scaffolded ${result.artifact_path}`);
                console.log(`experiment ${result.experiment_id ?? ""} created`);
                console.log(`proposal status -> accepted`);
            }

            if (withAgent && result.artifact_path && result.proposal) {
                // Spawn the claude subagent to enrich the freshly-scaffolded SKILL.md.
                // We call runAgentAccept directly here rather than re-entering
                // cmdImproveAccept, which would hit the `status !== 'open'` guard
                // (the proposal was just marked accepted above).
                let retroSummaries: readonly string[] = [];
                const baselineRaw = result.proposal.baseline;
                if (typeof baselineRaw === "string" && baselineRaw.length > 0) {
                    try {
                        const parsed = JSON.parse(baselineRaw) as {
                            tool?: string;
                            sessionKeys?: unknown;
                            frequency?: number;
                        };
                        if (Array.isArray(parsed.sessionKeys)) {
                            const tool = parsed.tool ?? "tool";
                            retroSummaries = parsed.sessionKeys
                                .filter((s): s is string => typeof s === "string")
                                .slice(0, 5)
                                .map((s) => `session ${s}: top tool ${tool} failed (cluster freq=${parsed.frequency ?? "?"})`);
                        }
                    } catch {
                        // ignore - baseline shape may evolve
                    }
                }
                console.log("");
                console.log("spawning claude subagent to enrich the stub…");
                const agentResult = yield* Effect.promise(() =>
                    runAgentAccept({
                        skillPath: result.artifact_path!,
                        proposalTitle: result.proposal!.title,
                        hypothesis: result.proposal!.hypothesis,
                        triggerPattern: result.proposal!.triggerPattern ?? "",
                        proposedBehavior: result.proposal!.proposedBehavior,
                        retroSummaries,
                        relatedSkillsDir: process.env.AX_SKILLS_SCAFFOLD_DIR ?? `${homedir()}/.claude/skills`,
                    }),
                );
                if (agentResult.skillEnriched) {
                    console.log(`agent enriched ${result.artifact_path}`);
                }
                if (agentResult.planWritten && agentResult.planPath) {
                    console.log(`agent wrote plan ${agentResult.planPath}`);
                }
                if (agentResult.exitCode !== 0) {
                    console.log(`agent exit code ${agentResult.exitCode} (stub still scaffolded; experiment row unchanged)`);
                }
            }
        }),
).pipe(Command.withDescription("Accept a proposal: emit a task brief (default) or scaffold the SKILL.md directly (--auto-scaffold, skill form only)"));

const improveRejectCommand = Command.make(
    "reject",
    {
        id: Argument.string("id"),
        reason: Flag.string("reason").pipe(Flag.optional),
    },
    ({ id, reason }) => cmdImproveReject([id, ...stringArg("reason", optionValue(reason))]),
).pipe(Command.withDescription("Reject a proposal (dedupe blocks future re-proposal of same trigger)"));

const ALLOWED_VERDICTS: ReadonlySet<string> = new Set([
    "adopted", "ignored", "regressed", "partial", "no_longer_needed",
]);

/**
 * `axctl improve verdict` - surface checkpoint-derived suggested verdicts
 * for each active experiment, let the human lock the final one. Three modes:
 *
 *   axctl improve verdict
 *     -> tabular listing of every experiment with its newest suggested verdict
 *
 *   axctl improve verdict <id>
 *     -> drill-down for one experiment + each checkpoint snapshot
 *
 *   axctl improve verdict <id> --set <verdict>
 *     -> writes user_verdict on the most recent checkpoint AND
 *        locks experiment.locked_verdict so future derive runs stop scoring
 */
const cmdImproveVerdict = (args: string[]) =>
    Effect.gen(function* () {
        const positional = args.filter((a) => !a.startsWith("--"))[0];
        const setIdx = args.findIndex((a) => a === "--set" || a.startsWith("--set="));
        let setValue: string | undefined;
        if (setIdx >= 0) {
            const raw = args[setIdx];
            if (raw.startsWith("--set=")) setValue = raw.slice("--set=".length);
            else setValue = args[setIdx + 1];
        }
        const json = args.includes("--json");
        const db = yield* SurrealClient;
        if (positional === undefined) {
            const rows = yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT
                    proposal.title AS title,
                    proposal.dedupe_sig AS dedupe_sig,
                    artifact_path,
                    type::string(created_at) AS created_at,
                    type::string(scaffolded_at) AS scaffolded_at,
                    locked_verdict,
                    (SELECT kind, suggested, user_verdict, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC LIMIT 1)[0] AS latest_checkpoint
                FROM experiment ORDER BY created_at DESC LIMIT 30;`,
            );
            const list = rows?.[0] ?? [];
            if (json) { console.log(prettyPrint(list)); return; }
            if (list.length === 0) {
                console.log("(no experiments yet - accept a proposal first via `axctl improve accept <sig>`)");
                return;
            }
            console.log("Current experiments (newest first):");
            for (const row of list) {
                const cp = row.latest_checkpoint as Record<string, unknown> | null;
                const verdict = row.locked_verdict
                    ? `[locked: ${String(row.locked_verdict)}]`
                    : cp
                        ? `[${String(cp.kind ?? "?")} suggested: ${String(cp.suggested ?? "?")}]`
                        : "[no checkpoint yet]";
                console.log(`  ${String(row.dedupe_sig ?? "?")}  ${verdict}  ${String(row.title ?? "?")}`);
            }
            console.log("");
            console.log("Run `axctl improve checkpoint` to refresh due windows.");
            console.log("Run `axctl improve verdict <sig> --set <verdict>` to lock.");
            return;
        }
        const idLiteral = surrealLiteral(positional);
        const sel = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT
                id,
                proposal.title AS title,
                proposal.dedupe_sig AS dedupe_sig,
                proposal.status AS proposal_status,
                artifact_path,
                type::string(created_at) AS created_at,
                type::string(scaffolded_at) AS scaffolded_at,
                locked_verdict,
                (SELECT id, kind, suggested, user_verdict, measured, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC) AS checkpoints
            FROM experiment
            WHERE proposal.dedupe_sig = ${idLiteral} OR id = ${idLiteral}
            LIMIT 1;`,
        );
        const row = (sel?.[0] ?? [])[0];
        if (!row) {
            console.error(`no experiment matched ${positional} (check \`axctl improve list --status=accepted\`)`);
            process.exit(2);
        }
        const checkpoints = (row.checkpoints as Array<Record<string, unknown>> | undefined) ?? [];

        if (setValue !== undefined) {
            if (!ALLOWED_VERDICTS.has(setValue)) {
                console.error(`--set must be one of: ${[...ALLOWED_VERDICTS].sort().join(", ")}`);
                process.exit(2);
            }
            if (row.locked_verdict) {
                console.error(`experiment already locked: ${String(row.locked_verdict)}`);
                process.exit(2);
            }
            const experimentId = String(row.id ?? "");
            const latestCp = checkpoints[0];
            const stmts: string[] = [
                `UPDATE ${experimentId} SET locked_verdict = ${surrealString(setValue)};`,
            ];
            if (latestCp?.id) {
                stmts.push(`UPDATE ${String(latestCp.id)} SET user_verdict = ${surrealString(setValue)};`);
            }
            yield* db.query(stmts.join(""));
            console.log(`verdict locked: ${setValue}`);
            return;
        }

        if (json) { console.log(prettyPrint(row)); return; }
        console.log(`${String(row.title ?? "?")}`);
        console.log(`  dedupe_sig    ${String(row.dedupe_sig ?? "?")}`);
        console.log(`  experiment    ${String(row.id ?? "?")}`);
        console.log(`  status        ${String(row.proposal_status ?? "?")}`);
        console.log(`  artifact      ${String(row.artifact_path ?? "(none)")}`);
        console.log(`  scaffolded_at ${String(row.scaffolded_at ?? "(none)")}`);
        console.log(`  verdict       ${row.locked_verdict ? String(row.locked_verdict) + " (locked)" : "pending"}`);
        if (checkpoints.length === 0) {
            console.log(`  checkpoints   none (run \`axctl improve checkpoint\` once due windows pass)`);
        } else {
            console.log(`  checkpoints:`);
            for (const cp of checkpoints) {
                const measured = cp.measured as Record<string, unknown> | string | undefined;
                const opp = (typeof measured === "object" && measured) ? Number(measured.opportunities ?? 0) : 0;
                const add = (typeof measured === "object" && measured) ? Number(measured.addressed ?? 0) : 0;
                console.log(
                    `    ${String(cp.kind ?? "?")}  observed=${String(cp.observed_at ?? "?")}  ` +
                    `opportunities=${opp} addressed=${add}  suggested=${String(cp.suggested ?? "?")}  ` +
                    `user_verdict=${cp.user_verdict ? String(cp.user_verdict) : "(none)"}`,
                );
            }
        }
        console.log("");
        console.log(`Lock the verdict: \`axctl improve verdict ${String(row.dedupe_sig ?? "<sig>")} --set <verdict>\``);
        console.log(`  verdicts: ${[...ALLOWED_VERDICTS].sort().join(", ")}`);
    });

const improveVerdictCommand = Command.make(
    "verdict",
    {
        id: Argument.string("id").pipe(Argument.optional),
        set: Flag.string("set").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ id, set, json }) => {
        const idValue = optionValue(id);
        const setValue = optionValue(set);
        return cmdImproveVerdict([
            ...(idValue === undefined ? [] : [idValue]),
            ...stringArg("set", setValue),
            ...boolArg("json", json),
        ]);
    },
).pipe(Command.withDescription("Show experiment verdict state; --set adopted|ignored|regressed|partial|no_longer_needed locks it"));

/**
 * `axctl improve reset --yes` - drop every experiment-loop row in DB.
 *
 * Destructive. Used by UAT to start from a clean slate before re-running
 * the full propose -> accept -> verdict flow. Wipes the 9 experiment-loop
 * tables in dependency order; underlying evidence (friction_event,
 * skill_candidate, etc) is left alone so re-derivation can rebuild
 * proposals against the same signal.
 */
const cmdImproveReset = (args: string[]) =>
    Effect.gen(function* () {
        if (!args.includes("--yes")) {
            console.error("axctl improve reset: refusing to wipe without --yes");
            console.error("  drops: checkpoint, opportunity, experiment, cites_evidence,");
            console.error("         skill_proposal, subagent_proposal, hook_proposal,");
            console.error("         guidance_proposal, automation_proposal, proposal");
            process.exit(2);
        }
        const db = yield* SurrealClient;
        // Dependency order: checkpoint -> opportunity -> experiment ->
        // cites_evidence -> per-form payloads -> proposal. Relations cascade
        // via REFERENCE ON DELETE CASCADE on the schema, but we delete
        // bottom-up to keep this explicit + auditable.
        yield* db.query(`
            DELETE checkpoint;
            DELETE opportunity;
            DELETE experiment;
            DELETE cites_evidence;
            DELETE skill_proposal;
            DELETE subagent_proposal;
            DELETE hook_proposal;
            DELETE guidance_proposal;
            DELETE automation_proposal;
            DELETE proposal;
        `);
        console.log("experiment-loop state cleared. Run \`ax ingest --stages=proposals,opportunities\` to rebuild.");
    });

const improveResetCommand = Command.make(
    "reset",
    {
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ yes }) => cmdImproveReset([...boolArg("yes", yes)]),
).pipe(Command.withDescription("Wipe all experiment-loop state (proposals/experiments/checkpoints). Requires --yes."));

const cmdImproveCheckpoint = (args: string[]) =>
    Effect.gen(function* () {
        const force = args.includes("--force");
        const json = args.includes("--json");
        const stats = yield* deriveCheckpoints({ force });
        if (json) {
            console.log(prettyPrint(stats));
            return;
        }
        console.log(`checkpoints scanned: ${stats.experimentsScanned} experiments`);
        console.log(`checkpoints inserted: ${stats.checkpointsInserted}`);
        console.log(`checkpoints skipped: ${stats.checkpointsSkipped}`);
        if (stats.checkpointsInserted === 0) {
            console.log("");
            console.log("No new windows due. Re-run with --force to refresh existing checkpoints");
            console.log("(use `axctl improve verdict <id>` to see suggested verdicts).");
        }
    });

const improveCheckpointCommand = Command.make(
    "checkpoint",
    {
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ force, json }) =>
        cmdImproveCheckpoint([...boolArg("force", force), ...boolArg("json", json)]),
).pipe(Command.withDescription("Compute checkpoint snapshots at t+7/t+30/t+90 for active experiments"));

// ---------------------------------------------------------------------------
// ax sessions - windowed session queries (F2, F3)
// ---------------------------------------------------------------------------

/**
 * Format a list of SessionRows for TTY output as a compact table.
 * Falls back to 100 columns when process.stdout.columns is unavailable.
 */
function formatSessionsTable(rows: SessionRow[]): string {
    if (rows.length === 0) return "(no sessions found)";
    const termWidth = (process.stdout.columns ?? 100) as number;
    const lines: string[] = [];
    // Header
    lines.push(
        `${"started_at".padEnd(26)} ${"source".padEnd(18)} ${"repo".padEnd(16)} ${"project".padEnd(20)} ${"turns".padStart(5)}  summary`,
    );
    lines.push("-".repeat(Math.min(termWidth, 120)));
    for (const row of rows) {
        const started = (row.started_at ?? "?").slice(0, 25).padEnd(26);
        const source = (row.source ?? "?").slice(0, 17).padEnd(18);
        // Extract a short repo key from record id string
        const repoRaw = row.repository ?? "";
        const repoShort = repoRaw
            .replace(/^repository:/, "")
            .replace(/[⟨⟩]/g, "")
            .replace(/^(remote|initial)__/, "")
            .slice(-16)
            .padEnd(16);
        const project = prettifyProjectSlug(row.project ?? "").slice(0, 19).padEnd(20);
        const turns = String(row.turn_count ?? 0).padStart(5);
        const msg = (row.first_user_message ?? "").replace(/\s+/g, " ").trim();
        const summaryWidth = Math.max(0, termWidth - 26 - 1 - 18 - 1 - 16 - 1 - 20 - 1 - 5 - 2);
        const summary = summaryWidth > 0 ? msg.slice(0, summaryWidth) : msg.slice(0, 40);
        lines.push(`${started} ${source} ${repoShort} ${project} ${turns}  ${summary}`);
    }
    return lines.join("\n");
}

/**
 * Detect if output should be JSON: explicit --json flag, or non-TTY stdout.
 */
function wantsJson(args: string[]): boolean {
    return args.includes("--json") || process.stdout.isTTY === false;
}

// --- sessions here ---

const cmdSessionsHere = (args: string[]) =>
    Effect.gen(function* () {
        const days = parsePositiveIntFlag("sessions here", "days", args, 14);
        const json = wantsJson(args);

        const pwdResolution = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                Effect.sync(() => {
                    process.stderr.write(
                        `axctl sessions here: not in a git repository (cwd=${err.cwd})\n`,
                    );
                    process.exit(2);
                }),
            ),
        );

        const repositoryRecordId = String(pwdResolution.repositoryRecordId);
        const rows = yield* listSessionsHere({ repositoryRecordId, days });

        if (json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
        }
        console.log(formatSessionsTable(rows));
    });

// --- sessions around ---

const cmdSessionsAround = (args: string[]) =>
    Effect.gen(function* () {
        const positional = args.filter((a) => !a.startsWith("--"))[0];
        if (!positional) {
            console.error("axctl sessions around: missing <date> argument");
            process.exit(2);
        }
        // Parse date: YYYY-MM-DD or full ISO8601
        let date: Date;
        if (/^\d{4}-\d{2}-\d{2}$/.test(positional)) {
            date = new Date(`${positional}T00:00:00.000Z`);
        } else {
            date = new Date(positional);
        }
        if (isNaN(date.getTime())) {
            console.error(
                `axctl sessions around: invalid date "${positional}" (expected YYYY-MM-DD or ISO8601)`,
            );
            process.exit(2);
        }

        const days = parsePositiveIntFlag("sessions around", "days", args, 3);
        const json = wantsJson(args);
        const projectRaw = flag("project", args);
        // Resolve --project: accept encoded slug or absolute path
        let project: string | null = null;
        if (projectRaw) {
            project = projectRaw.startsWith("/")
                ? encodeClaudeProjectSlug(projectRaw)
                : projectRaw;
        }

        const rows = yield* listSessionsAround({ date, days, project });

        if (json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
        }
        console.log(formatSessionsTable(rows));
    });

// --- sessions near ---

const cmdSessionsNear = (args: string[]) =>
    Effect.gen(function* () {
        const sha = args.filter((a) => !a.startsWith("--"))[0];
        if (!sha) {
            console.error("axctl sessions near: missing <sha> argument");
            process.exit(2);
        }
        const json = wantsJson(args);

        // Resolve repository via pwd (near is always pwd-scoped)
        const pwdResolution = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                Effect.sync(() => {
                    process.stderr.write(
                        `axctl sessions near: not in a git repository (cwd=${err.cwd})\n`,
                    );
                    process.exit(2);
                }),
            ),
        );

        const repoRoot = pwdResolution.repoRoot;
        const repositoryRecordId = String(pwdResolution.repositoryRecordId);

        // Resolve commit window
        const window = yield* findCommitWindow(repoRoot, sha).pipe(
            Effect.catchTag("ProcessError", () =>
                Effect.sync(() => {
                    console.error(`axctl sessions near: unknown sha ${sha}`);
                    process.exit(2);
                    return { kind: "not_found" as const };
                }),
            ),
        );

        if (window.kind === "not_found") {
            console.error(`axctl sessions near: unknown sha ${sha}`);
            process.exit(2);
            return;
        }

        let from: Date;
        let to: Date;
        if (window.kind === "orphan") {
            // root commit: ±3 days around commitTs
            from = new Date(window.commitTs.getTime() - 3 * 24 * 60 * 60 * 1000);
            to = new Date(window.commitTs.getTime() + 3 * 24 * 60 * 60 * 1000);
        } else {
            from = window.from;
            to = window.to;
        }

        const rows = yield* listSessionsNear({ from, to, repositoryRecordId });

        if (json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
        }
        console.log(formatSessionsTable(rows));
    });

// Effect/CLI Command definitions for sessions subcommands

const sessionsHereCommand = Command.make(
    "here",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
        json: jsonFlag,
    },
    ({ days, json }) =>
        cmdSessionsHere([`--days=${days}`, ...boolArg("json", json)]),
).pipe(Command.withDescription("List sessions for the current git repository (default: last 14 days)"));

const sessionsAroundCommand = Command.make(
    "around",
    {
        date: Argument.string("date"),
        days: Flag.integer("days").pipe(Flag.withDefault(3)),
        project: Flag.string("project").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ date, days, project, json }) =>
        cmdSessionsAround([
            date,
            `--days=${days}`,
            ...stringArg("project", optionValue(project)),
            ...boolArg("json", json),
        ]),
).pipe(Command.withDescription("List sessions in a ±N-day window around a date (YYYY-MM-DD or ISO8601)"));

const sessionsNearCommand = Command.make(
    "near",
    {
        sha: Argument.string("sha"),
        json: jsonFlag,
    },
    ({ sha, json }) =>
        cmdSessionsNear([sha, ...boolArg("json", json)]),
).pipe(Command.withDescription("List sessions near a git commit (adaptive window: predecessor → commit)"));

const sessionsCommand = Command.make("sessions").pipe(
    Command.withDescription("Windowed session queries: here (pwd-repo), around (date), near (sha)"),
    Command.withSubcommands([
        sessionsHereCommand,
        sessionsAroundCommand,
        sessionsNearCommand,
    ]),
);

const improveCommand = Command.make("improve").pipe(
    Command.withDescription("Experiment loop: review proposals, accept skills, track verdicts"),
    Command.withSubcommands([
        improveRecommendCommand,
        improveLintCommand,
        improveListCommand,
        improveShowCommand,
        improveAcceptCommand,
        improveRejectCommand,
        improveCheckpointCommand,
        improveVerdictCommand,
        improveResetCommand,
    ]),
);

/**
 * `ax retro emit [--session=<id>] [--from-file=<path>]` - write a retro row.
 *
 * Two paths:
 *   - With no --from-file: run the heuristic emitter on the named session
 *     (defaults to the current $AX_SESSION_ID env, then most recent
 *     session). Deterministic, no LLM.
 *   - With --from-file=<path>: parse `{tried, worked, failed, next}` JSON
 *     from the file. Source defaults to claude_stop_hook unless
 *     --source=<value> overrides. The Stop hook recipe in docs/HOOKS.md
 *     uses this path.
 */
const cmdRetroEmit = (args: string[]) =>
    Effect.gen(function* () {
        const fromFile = flag("from-file", args);
        const sessionFlag = flag("session", args) ?? process.env.AX_SESSION_ID;
        const sourceFlag = (flag("source", args) ?? (fromFile ? "claude_stop_hook" : "heuristic")) as RetroSource;
        const json = args.includes("--json");
        const db = yield* SurrealClient;

        let sessionRecordId = sessionFlag;
        if (!sessionRecordId) {
            const latest = yield* db.query<[Array<{ id: string | { tb: string; id: string } }>]>(
                "SELECT id, started_at FROM session ORDER BY started_at DESC LIMIT 1;",
            );
            const row = (latest?.[0] ?? [])[0];
            if (!row) {
                console.error("ax retro emit: no session to retro on (no --session and no rows in DB)");
                process.exit(2);
            }
            const idStr = typeof row.id === "string" ? row.id : `session:${row.id.id}`;
            sessionRecordId = idStr;
        }
        if (!sessionRecordId.includes(":")) sessionRecordId = `session:${sessionRecordId}`;

        if (fromFile) {
            const raw = yield* Effect.promise(() => Bun.file(fromFile).text().catch((e) => {
                console.error(`ax retro emit: could not read --from-file=${fromFile}: ${e}`);
                process.exit(2);
                return "";
            }));
            const parsed = safeJsonParse<{ tried?: string; worked?: string; failed?: string; next?: string }>(raw);
            if (!parsed) {
                console.error(`ax retro emit: --from-file is not valid JSON`);
                process.exit(2);
                return;
            }
            if (!parsed.tried) {
                console.error("ax retro emit: payload missing required `tried` field");
                process.exit(2);
            }
            const sessionKey = sessionRecordId.split(":").slice(1).join(":").replace(/`/g, "");
            yield* upsertRetro({
                sessionId: sessionKey,
                source: sourceFlag,
                payload: {
                    tried: String(parsed.tried),
                    worked: parsed.worked ?? null,
                    failed: parsed.failed ?? null,
                    next: parsed.next ?? null,
                },
                raw,
            });
            if (json) {
                console.log(prettyPrint({ session: sessionRecordId, source: sourceFlag, payload: parsed }));
            } else {
                console.log(`retro ${sourceFlag} for ${sessionRecordId}: ${parsed.tried.slice(0, 80)}…`);
            }
            return;
        }

        const input = yield* retroFromSession(sessionRecordId);
        if (!input) {
            console.error(`ax retro emit: session ${sessionRecordId} not found`);
            process.exit(2);
        }
        yield* upsertRetro(input);
        if (json) {
            console.log(prettyPrint({ session: sessionRecordId, source: input.source, payload: input.payload }));
            return;
        }
        console.log(`retro ${input.source} for ${sessionRecordId}`);
        console.log(`  tried   ${input.payload.tried}`);
        if (input.payload.worked) console.log(`  worked  ${input.payload.worked}`);
        if (input.payload.failed) console.log(`  failed  ${input.payload.failed}`);
        if (input.payload.next) console.log(`  next    ${input.payload.next}`);
    });

const cmdRetroList = (args: string[]) =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const limit = parsePositiveIntFlag("retro list", "limit", args, 20);
        const since = flag("since", args);
        const db = yield* SurrealClient;
        const where = since ? `WHERE created_at > time::now() - ${parseInt(since, 10) || 7}d` : "";
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, session, source, tried, failed, next, type::string(created_at) AS created_at
             FROM retro ${where} ORDER BY created_at DESC LIMIT ${limit};`,
        );
        const list = rows?.[0] ?? [];
        if (json) { console.log(prettyPrint(list)); return; }
        if (list.length === 0) { console.log("(no retros yet - try `ax retro emit`)"); return; }
        for (const row of list) {
            const tried = String(row.tried ?? "").slice(0, 60);
            console.log(`${String(row.created_at ?? "?")}  [${String(row.source ?? "?")}]  ${String(row.session ?? "?")}`);
            console.log(`  ${tried}${tried.length >= 60 ? "…" : ""}`);
            if (row.failed) console.log(`  ! ${String(row.failed).slice(0, 60)}`);
            if (row.next) console.log(`  → ${String(row.next).slice(0, 60)}`);
        }
    });

const retroEmitCommand = Command.make(
    "emit",
    {
        session: Flag.string("session").pipe(Flag.optional),
        fromFile: Flag.string("from-file").pipe(Flag.optional),
        source: Flag.string("source").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ session, fromFile, source, json }) => cmdRetroEmit([
        ...stringArg("session", optionValue(session)),
        ...stringArg("from-file", optionValue(fromFile)),
        ...stringArg("source", optionValue(source)),
        ...boolArg("json", json),
    ]),
).pipe(Command.withDescription("Emit a retro for one session - heuristic by default, or --from-file=<path> to ingest agent JSON"));

const retroListCommand = Command.make(
    "list",
    {
        limit: positiveLimit(20),
        since: Flag.string("since").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ limit, since, json }) => cmdRetroList([
        `--limit=${limit}`,
        ...stringArg("since", optionValue(since)),
        ...boolArg("json", json),
    ]),
).pipe(Command.withDescription("List recent retros (tried · failed · next)"));

const retroReflectCommand = Command.make(
    "reflect",
    {
        since: Flag.integer("since").pipe(Flag.withDefault(30)),
        status: Flag.choice("status", ["open", "all"] as const).pipe(Flag.withDefault("open")),
        json: jsonFlag,
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ since, status, json, yes }) => cmdRetroReflect([
        `--since=${since}`,
        `--status=${status}`,
        ...boolArg("json", json),
        ...boolArg("yes", yes),
    ]),
).pipe(Command.withDescription("Walk clustered retro-derived proposals interactively (accept/reject/skip each pattern)"));

const retroMetaCommand = Command.make(
    "meta",
    {
        since: Flag.integer("since").pipe(Flag.withDefault(30)),
        limitRetros: Flag.integer("limit-retros").pipe(Flag.withDefault(50)),
        pretty: Flag.boolean("pretty").pipe(Flag.withDefault(false)),
    },
    ({ since, limitRetros, pretty }) => cmdRetroMeta([
        `--since=${since}`,
        `--limit-retros=${limitRetros}`,
        ...boolArg("pretty", pretty),
    ]),
).pipe(Command.withDescription("Emit a read-only investigation snapshot (JSON) for an external AI agent to drive a deep retro of retros"));

const retroPlanCommand = Command.make(
    "plan",
    {
        slug: Flag.string("slug"),
        form: Flag.choice("form", ["skill", "hook", "guidance", "automation"] as const),
        title: Flag.string("title"),
        hypothesis: Flag.string("hypothesis"),
        planPath: Flag.string("plan-path"),
        evidenceRetros: Flag.string("evidence-retros").pipe(Flag.optional),
        artifactPath: Flag.string("artifact-path").pipe(Flag.optional),
        confidence: Flag.choice("confidence", ["low", "medium", "high"] as const).pipe(Flag.withDefault("medium")),
        frequency: Flag.integer("frequency").pipe(Flag.withDefault(1)),
        json: jsonFlag,
        leaveOpen: Flag.boolean("leave-open").pipe(Flag.withDefault(false)),
    },
    ({ slug, form, title, hypothesis, planPath, evidenceRetros, artifactPath, confidence, frequency, json, leaveOpen }) =>
        cmdRetroPlan([
            `--slug=${slug}`,
            `--form=${form}`,
            `--title=${title}`,
            `--hypothesis=${hypothesis}`,
            `--plan-path=${planPath}`,
            ...stringArg("evidence-retros", optionValue(evidenceRetros)),
            ...stringArg("artifact-path", optionValue(artifactPath)),
            `--confidence=${confidence}`,
            `--frequency=${frequency}`,
            ...boolArg("json", json),
            ...boolArg("leave-open", leaveOpen),
        ]),
).pipe(Command.withDescription("Register an externally-drafted plan as proposal (+ experiment unless --leave-open). External agent calls this after user yes."));

const retroCommand = Command.make("retro").pipe(
    Command.withDescription("Session retros: structured reflections (tried · worked · failed · next) that drive the experiment loop"),
    Command.withSubcommands([retroEmitCommand, retroListCommand, retroReflectCommand, retroMetaCommand, retroPlanCommand]),
);

const serveCommand = Command.make(
    "serve",
    { port: Flag.integer("port").pipe(Flag.withDefault(1738)) },
    ({ port }) => Effect.sync(() => serveDashboard([`--port=${port}`])),
).pipe(Command.withDescription("Serve the live web dashboard locally"));

const reportCommand = Command.make(
    "report",
    {
        limit: positiveLimit(12),
        out: Flag.string("out").pipe(Flag.optional),
    },
    ({ limit, out }) => cmdReport([`--limit=${limit}`, ...stringArg("out", optionValue(out))]),
).pipe(Command.withDescription("Write a static evidence report (one-shot HTML snapshot)"));

const dogfoodTerminalCommand = Command.make(
    "terminal",
    {
        scenario: Flag.choice("scenario", ["axctl-setup", "interactive"] as const).pipe(Flag.withDefault("axctl-setup")),
        transport: Flag.choice("transport", ["auto", "pty", "process"] as const).pipe(Flag.withDefault("auto")),
        agent: Flag.choice("agent", ["shell", "claude", "codex", "opencode"] as const).pipe(Flag.optional),
        command: Flag.string("command").pipe(Flag.optional),
        successMarker: Flag.string("success-marker").pipe(Flag.optional),
        timeout: Flag.integer("timeout").pipe(Flag.optional),
        port: Flag.integer("port").pipe(Flag.withDefault(1742)),
        json: jsonFlag,
    },
    ({ scenario, transport, agent, command, successMarker, timeout, port, json }) =>
        Effect.promise(() =>
            cmdDogfoodTerminal([
                `--scenario=${scenario}`,
                `--transport=${transport}`,
                ...stringArg("agent", optionValue(agent)),
                ...stringArg("command", optionValue(command)),
                ...stringArg("success-marker", optionValue(successMarker)),
                ...(timeout._tag === "Some" ? [`--timeout=${timeout.value}`] : []),
                `--port=${port}`,
                ...boolArg("json", json),
            ]),
        ),
).pipe(Command.withDescription("Serve a wterm browser terminal dogfood scenario"));

const cmdDogfoodRuns = (args: string[]) =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const limit = parsePositiveIntFlag("dogfood runs", "limit", args, 30);
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, run_id, scenario, driver, status, agent, command, transport,
                marker_found, timed_out, timeout_seconds,
                type::string(started_at) AS started_at,
                type::string(ended_at) AS ended_at
            FROM dogfood_run
            ORDER BY ended_at DESC
            LIMIT ${limit};`,
        );
        const list = rows?.[0] ?? [];
        if (json) { console.log(prettyPrint(list)); return; }
        if (list.length === 0) {
            console.log("(no dogfood runs persisted yet)");
            return;
        }
        for (const row of list) {
            console.log(
                `${String(row.ended_at ?? "?")}  [${String(row.status ?? "?")}]  ` +
                `${String(row.scenario ?? "?")}  ${String(row.driver ?? "?")}  ` +
                `run_id=${String(row.run_id ?? "?")}`,
            );
        }
    });

const dogfoodRunsCommand = Command.make(
    "runs",
    {
        limit: positiveLimit(30),
        json: jsonFlag,
    },
    ({ limit, json }) => cmdDogfoodRuns([`--limit=${limit}`, ...boolArg("json", json)]),
).pipe(Command.withDescription("List recent dogfood scenario runs (passed/failed/error)"));

const dogfoodCommand = Command.make("dogfood").pipe(
    Command.withDescription("Run local dogfood harnesses"),
    Command.withSubcommands([dogfoodTerminalCommand, dogfoodRunsCommand]),
);

const searchCommand = Command.make(
    "search",
    {
        query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
        limit: positiveLimit(10),
    },
    ({ query, limit }) => cmdSearch([...query, `--limit=${limit}`]),
).pipe(Command.withDescription("Search skills by name or description"));

const recallCommand = Command.make(
    "recall",
    {
        query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
        project: Flag.string("project").pipe(Flag.optional),
        skill: Flag.string("skill").pipe(Flag.optional),
        since: Flag.string("since").pipe(Flag.optional),
        sources: Flag.string("sources").pipe(Flag.optional),
        scope: Flag.string("scope").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ query, project, skill, since, sources, scope, json }) =>
        cmdRecall({
            query: query.join(" "),
            project: Option.getOrNull(project),
            skill: Option.getOrNull(skill),
            since: Option.getOrNull(since),
            sources: Option.getOrNull(sources),
            scopeFlag: Option.getOrNull(scope),
            json,
        }),
).pipe(
    Command.withDescription(
        "Cross-session text search over turns, commits, and skills (BM25 FTS). " +
        "--sources=turn,commit,skill  --scope=here|all",
    ),
);

const statsCommand = Command.make(
    "stats",
    { skill: Argument.string("skill") },
    ({ skill }) => cmdStats([skill]),
).pipe(Command.withDescription("Show detailed stats for one skill"));

const recentCommand = Command.make(
    "recent",
    { limit: positiveLimit(20) },
    ({ limit }) => cmdRecent([`--limit=${limit}`]),
).pipe(Command.withDescription("Show recent skill invocations"));

const unusedCommand = Command.make(
    "unused",
    { days: Flag.integer("days").pipe(Flag.withDefault(7)) },
    ({ days }) => cmdUnused([`--days=${days}`]),
).pipe(Command.withDescription("List skills unused within a time window"));

const tasteCommand = Command.make(
    "taste",
    { limit: positiveLimit(30) },
    ({ limit }) => cmdTaste([`--limit=${limit}`]),
).pipe(Command.withDescription("Rank skills by usage, corrections, proposals, and produced commits"));

const pairsCommand = Command.make(
    "pairs",
    {
        skill: Argument.string("skill"),
        limit: positiveLimit(20),
    },
    ({ skill, limit }) => cmdPairs([skill, `--limit=${limit}`]),
).pipe(Command.withDescription("Show co-occurring skills"));

const recoveryCommand = Command.make(
    "recovery",
    { limit: positiveLimit(20) },
    ({ limit }) => cmdRecovery([`--limit=${limit}`]),
).pipe(Command.withDescription("Show skills that recovered failed work"));

const skillsCommand = Command.make("skills").pipe(
    Command.withDescription("Skill-graph queries: search, stats, usage, pairs, recovery"),
    Command.withSubcommands([
        searchCommand,
        statsCommand,
        recentCommand,
        unusedCommand,
        tasteCommand,
        pairsCommand,
        recoveryCommand,
    ]),
);

const projectContextCommand = Command.make(
    "context",
    { json: jsonFlag },
    ({ json }) => cmdProject(["context", ...boolArg("json", json)]),
).pipe(Command.withDescription("Print repo grounding context"));

const projectVerifyCommand = Command.make(
    "verify",
    { json: jsonFlag },
    ({ json }) => cmdProject(["verify", ...boolArg("json", json)]),
).pipe(Command.withDescription("Print verification checks for the current diff"));

const projectHarnessCommand = Command.make(
    "harness",
    { json: jsonFlag },
    ({ json }) => cmdProject(["harness", ...boolArg("json", json)]),
).pipe(Command.withDescription("Print Harness Doctor and local learning candidates"));

const projectCommand = Command.make("project").pipe(
    Command.withDescription("Ground agent work in the current repository"),
    Command.withSubcommands([projectContextCommand, projectVerifyCommand, projectHarnessCommand]),
);

const parseFileHints = (value: Option.Option<string>): readonly string[] =>
    (Option.getOrUndefined(value) ?? "")
        .split(",")
        .map((file) => file.trim())
        .filter((file) => file.length > 0);

const contextFileCommand = Command.make(
    "file",
    {
        query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
        files: Flag.string("files").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ query, files, json }) =>
        Effect.gen(function* () {
            const pack = yield* buildFileContextPack({
                q: query.join(" "),
                files: parseFileHints(files),
            });
            if (json) {
                console.log(prettyPrint(pack));
                return;
            }
            console.log(pack.ai_context);
            console.log("");
            console.log("Graph inspection query:");
            console.log(pack.graph_inspection_query);
        }),
).pipe(Command.withDescription("Build graph-derived file context for an agent task"));

const contextCommand = Command.make("context").pipe(
    Command.withDescription("Build just-in-time context packs for agents"),
    Command.withSubcommands([contextFileCommand]),
);

const readStdinAll = (): Promise<string> =>
    new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
    });

const mergeHookInputs = (
    base: FileContextHookInput,
    overrides: FileContextHookInput,
): FileContextHookInput => ({
    event: overrides.event !== "unknown" ? overrides.event : base.event,
    task: overrides.task ? overrides.task : base.task,
    files: overrides.files.length > 0 ? overrides.files : base.files,
    lookupPaths: overrides.files.length > 0 ? overrides.lookupPaths : base.lookupPaths,
    sessionId: overrides.sessionId ?? base.sessionId,
    format: overrides.format !== "plain" ? overrides.format : base.format,
});

const hookFileContextCommand = Command.make(
    "file-context",
    {
        event: Flag.string("event").pipe(Flag.optional),
        task: Flag.string("task").pipe(Flag.optional),
        file: Flag.string("file").pipe(Flag.optional),
        files: Flag.string("files").pipe(Flag.optional),
        sessionId: Flag.string("session-id").pipe(Flag.optional),
        format: Flag.string("format").pipe(Flag.optional),
        json: jsonFlag,
        stdin: Flag.boolean("stdin").pipe(Flag.withDefault(false)),
    },
    ({ event, task, file, files, sessionId, format, json, stdin }) =>
        Effect.gen(function* () {
            const flagFiles = [
                ...parseFileHints(file),
                ...parseFileHints(files),
            ];
            const flagInput = parseFileContextHookFlags({
                event: optionValue(event) ?? null,
                task: optionValue(task) ?? null,
                files: flagFiles,
                sessionId: optionValue(sessionId) ?? null,
                format: optionValue(format) ?? null,
            });
            const shouldReadStdin = stdin || !process.stdin.isTTY;
            const stdinInput = shouldReadStdin
                ? yield* Effect.promise(() => readStdinAll()).pipe(
                    Effect.map((text) =>
                        text.trim().length > 0 ? parseFileContextHookStdin(text) : null,
                    ),
                )
                : null;
            const merged = stdinInput ? mergeHookInputs(stdinInput, flagInput) : flagInput;
            const startMs = performance.now();
            const response = yield* buildFileContextHookResponse(merged);
            const latencyMs = Math.round(performance.now() - startMs);

            if (json || merged.format === "json") {
                console.log(prettyPrint(response));
            } else if (merged.format === "claude") {
                // Claude Code hook protocol: PreToolUse hook output is shown to
                // the user as plain stdout but is NOT injected into the model's
                // context unless wrapped as JSON with `hookSpecificOutput.
                // additionalContext`. Emit the envelope only when we have
                // something to inject; emit nothing otherwise so Claude Code
                // doesn't show an empty additionalContext block to the user.
                if (response.inject && response.context.length > 0) {
                    console.log(JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            additionalContext: response.context,
                        },
                    }));
                }
            } else if (response.inject && response.context.length > 0) {
                // Default plain format for shell/manual use: emit the raw memory block.
                console.log(response.context);
            }

            const harness: TelemetryHarness = merged.format === "claude" ? "claude" : "unknown";
            yield* recordHookFire({
                input: merged,
                decision: { inject: response.inject, reason: response.reason },
                priorSessions: response.evidence.prior_file_sessions,
                corrections: response.evidence.corrections,
                commits: response.evidence.commits,
                harness,
                latencyMs,
            });
        }),
).pipe(Command.withDescription("Decide and emit file-context memory for an agent harness hook"));

const hookLogCommand = Command.make(
    "log",
    {
        tail: Flag.integer("tail").pipe(Flag.withDefault(20)),
        since: Flag.integer("since").pipe(Flag.optional),
        reason: Flag.string("reason").pipe(Flag.optional),
        file: Flag.string("file").pipe(Flag.optional),
        inject: Flag.string("inject").pipe(Flag.optional),
        harness: Flag.string("harness").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ tail, since, reason, file, inject, harness, json }) =>
        Effect.gen(function* () {
            const injectStr = optionValue(inject);
            const rows = yield* queryHookLog({
                tail,
                sinceHours: optionValue(since),
                reason: optionValue(reason),
                file: optionValue(file),
                inject: injectStr === undefined ? undefined : injectStr === "true",
                harness: optionValue(harness),
            });
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookLogRowsTsv(rows));
        }),
).pipe(Command.withDescription("Tail and filter hook_fire telemetry rows"));

const hookCommand = Command.make("hook").pipe(
    Command.withDescription("Generic agent harness hooks (file-context, log, ...)"),
    Command.withSubcommands([hookFileContextCommand, hookLogCommand]),
);

const hooksSummaryCommand = Command.make(
    "summary",
    {
        since: Flag.integer("since").pipe(Flag.optional),
        tail: Flag.integer("tail").pipe(Flag.withDefault(20)),
        command: Flag.string("command").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ since, tail, command, json }) =>
        Effect.gen(function* () {
            const rows = yield* queryHookSummary({
                sinceDays: optionValue(since),
                tail,
                command: optionValue(command),
            });
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookSummaryRows(rows));
        }),
).pipe(Command.withDescription("Summarize native harness hook command invocations"));

const hooksInvocationsCommand = Command.make(
    "invocations",
    {
        since: Flag.integer("since").pipe(Flag.optional),
        tail: Flag.integer("tail").pipe(Flag.withDefault(50)),
        command: Flag.string("command").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ since, tail, command, json }) =>
        Effect.gen(function* () {
            const rows = yield* queryHookInvocations({
                sinceDays: optionValue(since),
                tail,
                command: optionValue(command),
            });
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookInvocationRows(rows));
        }),
).pipe(Command.withDescription("List native harness hook command invocations"));

const hooksSessionCommand = Command.make(
    "session",
    {
        sessionId: Argument.string("session-id"),
        json: jsonFlag,
    },
    ({ sessionId, json }) =>
        Effect.gen(function* () {
            const rows = yield* queryHookSession(sessionId);
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookInvocationRows(rows));
        }),
).pipe(Command.withDescription("List native harness hook command invocations for one session"));

const hooksBacktestCase = Argument.choice("case", ["enforce-worktree"] as const).pipe(
    Argument.withDefault("enforce-worktree"),
);

const hooksBacktestCommand = Command.make(
    "backtest",
    {
        caseName: hooksBacktestCase,
        since: Flag.integer("since").pipe(Flag.optional),
        tail: Flag.integer("tail").pipe(Flag.withDefault(100)),
        window: Flag.integer("window").pipe(Flag.withDefault(3)),
        noPersist: Flag.boolean("no-persist"),
        json: jsonFlag,
    },
    ({ since, tail, window, noPersist, json }) =>
        Effect.gen(function* () {
            const summary = yield* backtestEnforceWorktreeCase({
                sinceDays: optionValue(since),
                tail,
                window,
                persist: !noPersist,
            });
            if (json) {
                console.log(prettyPrint(summary));
                return;
            }
            console.log(formatFeedbackBacktestSummary(summary));
        }),
).pipe(Command.withDescription("Run deterministic feedback-case backtests for hook evidence"));

const hooksCommand = Command.make("hooks").pipe(
    Command.withDescription("Inspect native Claude/Codex harness hook evidence"),
    Command.withSubcommands([
        hooksSummaryCommand,
        hooksInvocationsCommand,
        hooksSessionCommand,
        hooksBacktestCommand,
    ]),
);

const jsonSelfImprove = (cmd: "guidance" | "session" | "self-improve", rest: string[]) => {
    const parsed = parseSelfImproveArgs(cmd, rest);
    const effect =
        parsed.command === "guidance-next" ? guidanceNext() :
        parsed.command === "session-summary" ? sessionSummary() :
        selfImproveWeekly();
    return Effect.gen(function* () {
        const result = yield* effect;
        console.log(prettyPrint(result));
    });
};

const evidenceGuidanceNextCommand = Command.make(
    "guidance-next",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("guidance", ["next", ...boolArg("json", json)]),
).pipe(Command.withDescription("Return the next self-improvement guidance"));

const evidenceSessionSummaryCommand = Command.make(
    "session-summary",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("session", ["summary", ...boolArg("json", json)]),
).pipe(Command.withDescription("Summarize recent session evidence"));

const evidenceWeeklyCommand = Command.make(
    "weekly",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("self-improve", ["weekly", ...boolArg("json", json)]),
).pipe(Command.withDescription("Run weekly self-improvement evidence query"));

const evidenceCommand = Command.make("evidence").pipe(
    Command.withDescription("Self-improvement evidence queries (guidance, session, weekly)"),
    Command.withSubcommands([
        evidenceGuidanceNextCommand,
        evidenceSessionSummaryCommand,
        evidenceWeeklyCommand,
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

const tuiCommand = Command.make("tui", {}, () =>
    Effect.promise(async () => {
        // TUI manages its own AppLayer scope so the SurrealDB connection
        // outlives the React tree. Dynamic import keeps React/opentui out
        // of the load path for non-TUI commands.
        const { runTui } = await import("../tui/index.tsx");
        await runTui();
    }),
).pipe(Command.withDescription("Open the interactive dashboard"));

const installCommand = Command.make("install", {}, () =>
    Effect.promise(() => cmdInstall()),
).pipe(Command.withDescription("One-shot setup: daemon, watcher, and symlink"));

const daemonStatusCommand = Command.make(
    "status",
    { json: jsonFlag },
    ({ json }) => Effect.promise(() => cmdDaemon(["status", ...boolArg("json", json)])),
).pipe(Command.withDescription("Show daemon and watcher status"));

const daemonStartCommand = Command.make("start", {}, () =>
    Effect.promise(() => cmdDaemon(["start"])),
).pipe(Command.withDescription("Start the daemon and watcher"));

const daemonStopCommand = Command.make("stop", {}, () =>
    Effect.promise(() => cmdDaemon(["stop"])),
).pipe(Command.withDescription("Stop the daemon and watcher without deleting plists"));

const daemonRestartCommand = Command.make("restart", {}, () =>
    Effect.promise(() => cmdDaemon(["restart"])),
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
    ({ json }) => Effect.promise(() => cmdDoctor(boolArg("json", json))),
).pipe(Command.withDescription("Check local installation health"));

const uninstallCommand = Command.make("uninstall", {}, () =>
    Effect.promise(() => cmdUninstall()),
).pipe(Command.withDescription("Remove launchd plists and the axctl symlink"));

const devOnlyCommands = process.env.AX_DEV === "1" ? [dogfoodCommand] : [];

export const rootCommand = Command.make("axctl").pipe(
    Command.withDescription("ax local memory and telemetry for coding agents"),
    Command.withSubcommands([
        ingestCommand,
        deriveSignalsCommand,
        deriveIntentsCommand,
        insightsCommand,
        sessionsCommand,
        improveCommand,
        retroCommand,
        serveCommand,
        reportCommand,
        recallCommand,
        skillsCommand,
        contextCommand,
        hookCommand,
        hooksCommand,
        projectCommand,
        evidenceCommand,
        versionCommand,
        updateCommand,
        tuiCommand,
        installCommand,
        daemonCommand,
        doctorCommand,
        uninstallCommand,
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
    return runCli(args).pipe(Effect.provideService(SurrealClient, stub));
};

// Commands whose handlers reach into SurrealClient via AppLayer. Anything
// outside this set runs through `withoutDb` so the user gets fast, honest
// errors (e.g. "unknown command") instead of a 5s connect timeout.
export const DB_COMMANDS: ReadonlySet<string> = new Set([
    "ingest",
    "derive-signals",
    "derive-intents",
    "insights",
    "sessions",
    "improve",
    "retro",
    "report",
    "recall",
    "skills",
    "project",
    "context",
    "hook",
    "hooks",
    "evidence",
    "tui",
    "dogfood",
]);

async function main() {
    const [, , ...args] = process.argv;
    if (args[0] === undefined || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
        await Effect.runPromise(withoutDb(["--help"]));
        return;
    }
    if (args[0] === "-V" || args[0] === "-v" || args[0] === "--version") {
        await printVersion(args.slice(1), liveVersionDeps);
        return;
    }
    if (args[0] === "upgrade") {
        await Effect.runPromise(withoutDb(["update", ...args.slice(1)]));
        return;
    }
    if (DB_COMMANDS.has(args[0] ?? "")) {
        await Effect.runPromise(withDb(args));
        return;
    }
    await Effect.runPromise(withoutDb(args));
}

if (import.meta.main) {
    main().catch((err) => {
        if (err && typeof err === "object" && "_tag" in err && err._tag === "ShowHelp") {
            process.exit(1);
        }
        console.error("axctl error:", err);
        process.exit(1);
    });
}
