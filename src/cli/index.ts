#!/usr/bin/env bun
import { Effect, Layer, Option, References } from "effect";
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
import { deriveCheckpoints } from "../ingest/derive-checkpoints.ts";
import { retroFromSession, upsertRetro, type RetroSource } from "../ingest/retro.ts";
import { runAgentAccept } from "../improve/agent-accept.ts";
import { acceptProposal, rejectProposal } from "../improve/actions.ts";
import { lintFiles } from "../improve/lint.ts";
import { recommend, formatRecommendations, copyToClipboard, selectByIndices, parseIndexInput } from "../improve/recommend.ts";
import { showExperiment, formatShow } from "../improve/show.ts";
import { cmdRetroReflect } from "./retro-reflect.ts";
import { cmdRetroMeta } from "./retro-meta.ts";
import { cmdRetroPlan } from "./retro-plan.ts";
import { cmdShare } from "./share.ts";
import { cmdSkillsClassify } from "./skills-classify.ts";
import { cmdSkillsTag } from "./skills-tag.ts";
import { cmdSkillsLint } from "./skills-lint.ts";
import { cmdClassifiersEval } from "./classifiers-eval.ts";
import { cmdClassifiersList } from "./classifiers-list.ts";
import {
    runClassifiersLifecycle,
    runClassifiersPackageOperations,
    runClassifiersPackagesOperations,
} from "./classifiers-package-operations.ts";
import {
    runClassifiersWorkflowCandidates,
    type WorkflowCandidatePromotionMode,
    type WorkflowCandidateProposalStatusFilter,
    type WorkflowCandidateTaskLikeMode,
} from "./classifiers-workflow-candidates.ts";
import { ClassifierPackageServiceLive } from "../classifiers/package-service.ts";
import { fetchClassifierExplain } from "../dashboard/classifier-explain.ts";
import {
    renderClassifierExplainJson,
    renderClassifierExplainMarkdown,
} from "./classifiers-explain-format.ts";
import { fetchSkillsWeighted } from "../dashboard/skills-weighted.ts";
import { renderWeightedTable, renderWeightedJson } from "./skills-weighted-format.ts";
import {
    fetchSkillsByRole,
    fetchRolesForSkill,
    fetchAllRoles,
} from "../dashboard/role-queries.ts";
import {
    renderSkillsByRoleTable,
    renderSkillsByRoleJson,
    renderRolesForSkillTable,
    renderRolesForSkillJson,
    renderAllRolesTable,
    renderAllRolesJson,
} from "./role-format.ts";
import { homedir } from "node:os";
import { recordRef, surrealString } from "../lib/shared/surql.ts";
import { ingestClaudeInsights } from "../ingest/claude-insights.ts";
// backfillInvokedPositions - Phase B will register this as invokedPositionsStage.
import { deriveSignals } from "../ingest/derive-signals.ts";
import { deriveTurnIntents } from "../ingest/derive-intents.ts";
import { INSIGHT_VIEWS, insightSqlForView, isInsightView } from "../queries/insights.ts";
import { formatInsightRows } from "./insights-format.ts";
import { writeDashboard } from "../dashboard/report.ts";
import { serveDashboard } from "../dashboard/server.ts";
import { fetchRecall, type RecallSource, type RecallScope } from "../dashboard/recall.ts";
import { fetchSessionShow } from "../dashboard/session-show.ts";
import { fetchCostSummary, type CostSummary } from "../dashboard/cost-query.ts";
import { renderSessionMarkdown, renderSessionJson } from "./session-show-format.ts";
import { cmdDaemon, cmdDoctor, cmdInstall, cmdUninstall } from "./install.ts";
import { resolvePwdRepository } from "../lib/pwd.ts";
import { detectStaleness } from "../lib/transcript-staleness.ts";
import { ingestTranscripts } from "../ingest/transcripts.ts";
import { encodeClaudeProjectSlug } from "../lib/transcript-locator.ts";
import {
    createProgressReporter,
    parseProgressMode,
    type ProgressReporter,
} from "./progress.ts";
import { cmdProject } from "./project.ts";
import { AX_VERSION, liveVersionDeps, printVersion, updateAxctl } from "./version.ts";
import { wantsJson, catchDbErrorAndExit } from "./output.ts";
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
import { StageRegistry, type StageRegistryShape } from "../ingest/stage/registry.ts";
import { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
import { ConsoleTransportLayer } from "../lib/live-traces/transports/console.ts";
import { selectByKeys, selectByTag } from "../ingest/stage/select.ts";
import { type BaseStageStats, type StageDef } from "../ingest/stage/types.ts";
import { runIngest } from "../ingest/run.ts";

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

const cmdIngest = (args: string[], opts: IngestCommandOpts = {}) => {
    const commandName = opts.command ?? "ingest";
    return runIngest({
        command: commandName,
        args,
        cwd: opts.cwd ?? process.cwd(),
        ...(opts.repoPaths ? { repoPaths: opts.repoPaths } : {}),
        ...(opts.claudeProject ? { claudeProject: opts.claudeProject } : {}),
        debug: args.includes("--debug"),
        verbose: args.includes("--verbose"),
    }).pipe(Effect.asVoid);
};

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
        const json = args.includes("--json");
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            insightSqlForView(rawView, limit),
        );
        console.log(formatInsightRows(rawView, result?.[0] ?? [], { json }));
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
                repositoryKey: resolution.repositoryRecordId.id as string,
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

const cmdSkillsWeighted = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("skills weighted", "limit", args, 25);
        const windowDays = parseOptionalPositiveIntFlag("skills weighted", "window", args);
        const doctorThreshold = parsePositiveIntFlag("skills weighted", "doctor-threshold", args, 5);
        const json = args.includes("--json");

        // --window=0 is invalid: parseOptionalPositiveIntFlag rejects it (n <= 0).
        // If the user passes --window, but 0 or negative, process.exit(2) already fired.

        const result = yield* fetchSkillsWeighted({
            ...(windowDays !== undefined ? { windowDays } : {}),
            limit,
            doctorThreshold,
        }).pipe(
            catchDbErrorAndExit("axctl skills weighted"),
        );

        if (json) {
            console.log(renderWeightedJson(result));
        } else {
            console.log(renderWeightedTable(result));
        }
    });

// ---------------------------------------------------------------------------
// P3.7: Role read commands
// ---------------------------------------------------------------------------

/**
 * `ax skills by-role <role> [--json] [--limit=N]`
 * List skills classified as a given role, ranked by invocations.
 */
const cmdSkillsByRole = (args: string[]) =>
    Effect.gen(function* () {
        const positionals = args.filter((a) => !a.startsWith("--"));
        const role = positionals[0];
        if (!role) {
            console.error("axctl skills by-role: missing <role-name>");
            process.exit(2);
        }
        const json = wantsJson(args);
        const limit = parsePositiveIntFlag("skills by-role", "limit", args, 50);

        const result = yield* fetchSkillsByRole({ role, limit }).pipe(
            catchDbErrorAndExit("axctl skills by-role"),
        );

        if (json) {
            console.log(renderSkillsByRoleJson(result, role));
        } else {
            console.log(renderSkillsByRoleTable(result, role));
        }
    });

/**
 * `ax skills roles <skill> [--json]`
 * List all roles for a given skill.
 */
const cmdRolesForSkill = (args: string[]) =>
    Effect.gen(function* () {
        const positionals = args.filter((a) => !a.startsWith("--"));
        const skill = positionals[0];
        if (!skill) {
            console.error("axctl skills roles: missing <skill-name>");
            process.exit(2);
        }
        const json = wantsJson(args);

        const result = yield* fetchRolesForSkill({ skill }).pipe(
            catchDbErrorAndExit("axctl skills roles"),
        );

        if (!result.skillExists) {
            process.stderr.write(`axctl skills roles: unknown skill "${skill}"\n`);
            process.exit(2);
        }

        if (json) {
            console.log(renderRolesForSkillJson(result, skill));
        } else {
            console.log(renderRolesForSkillTable(result, skill));
        }
    });

/**
 * `ax roles [--json]`
 * List all roles with skill counts.
 */
const cmdRoles = (args: string[]) =>
    Effect.gen(function* () {
        const json = wantsJson(args);

        const result = yield* fetchAllRoles().pipe(
            catchDbErrorAndExit("axctl roles"),
        );

        if (json) {
            console.log(renderAllRolesJson(result));
        } else {
            console.log(renderAllRolesTable(result));
        }
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
        since: optionalSince,
        progress: progressFlag,
        verbose: verboseFlag,
        debug: debugFlag,
    },
    ({ insightsOnly, stages, deriveOnly, reset, since, progress, verbose, debug }) => {
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
            "Use --stages=<a,b,c> for a custom subset, or --derive-only to run every stage tagged `derive` " +
            "(see ADR-0009; canonical list lives in src/ingest/stage/registry.ts). " +
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
        json: jsonFlag,
    },
    ({ view, limit, json }) => cmdInsights([view, `--limit=${limit}`, ...boolArg("json", json)]),
).pipe(Command.withDescription("Run built-in graph insight queries"));

const classifiersEvalCommand = Command.make(
    "eval",
    {
        path: Flag.string("path").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ path, json }) => Effect.promise(() =>
        cmdClassifiersEval([...stringArg("path", optionValue(path)), ...boolArg("json", json)]),
    ),
).pipe(Command.withDescription("Run classifier golden fixture evaluations"));

const classifiersListCommand = Command.make(
    "list",
    {
        json: jsonFlag,
    },
    ({ json }) => Effect.promise(() => cmdClassifiersList(boolArg("json", json))),
).pipe(Command.withDescription("List registered classifiers and fixture coverage"));

const cmdClassifiersExplain = (args: string[]) =>
    Effect.gen(function* () {
        const positionals = args.filter((arg) => !arg.startsWith("--"));
        const turnId = positionals[0];
        if (!turnId) {
            console.error("axctl classifiers explain: missing <turn-id>");
            console.error("  usage: axctl classifiers explain <turn-id> [--json]");
            process.exit(2);
        }

        const forceJson = args.includes("--json");
        const useJson = forceJson || process.stdout.isTTY === false;
        const payload = yield* fetchClassifierExplain(turnId).pipe(
            catchDbErrorAndExit("axctl classifiers explain"),
        );

        if (payload.turn === null) {
            process.stderr.write(`turn ${turnId} not found\n`);
            process.exit(1);
        }

        console.log(useJson ? renderClassifierExplainJson(payload) : renderClassifierExplainMarkdown(payload));
    });

const classifiersExplainCommand = Command.make(
    "explain",
    {
        turnId: Argument.string("turn-id"),
        json: jsonFlag,
    },
    ({ turnId, json }) => cmdClassifiersExplain([
        turnId,
        ...boolArg("json", json),
    ]),
).pipe(Command.withDescription("Explain classifier results attached to a turn"));

const classifiersPackageOperationsCommand = Command.make(
    "package-operations",
    {
        allowExpensive: Flag.boolean("allow-expensive").pipe(Flag.withDefault(false)),
        applyWritePlan: Flag.boolean("apply-write-plan").pipe(Flag.withDefault(false)),
        all: Flag.boolean("all").pipe(Flag.withDefault(false)),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        execute: Flag.boolean("execute").pipe(Flag.withDefault(false)),
        facts: Flag.boolean("facts").pipe(Flag.withDefault(false)),
        graphHealth: Flag.boolean("graph-health").pipe(Flag.withDefault(false)),
        graphMode: Flag.choice("graph-mode", ["summary", "guarded", "changed-artifacts", "evidence", "lifecycle", "embedding-helper"] as const).pipe(Flag.withDefault("summary")),
        history: Flag.boolean("history").pipe(Flag.withDefault(false)),
        manifest: Flag.string("manifest").pipe(Flag.withDefault("packages/ax-classifier-session-sections/ax.classifier.json")),
        operation: Flag.string("operation").pipe(Flag.optional),
        artifact: Flag.string("artifact").pipe(Flag.optional),
        sourceKind: Flag.string("source-kind").pipe(Flag.optional),
        factKind: Flag.string("fact-kind").pipe(Flag.optional),
        status: Flag.string("status").pipe(Flag.optional),
        sourceFixture: Flag.string("source-fixture").pipe(Flag.optional),
        proposedLabel: Flag.string("proposed-label").pipe(Flag.optional),
        threshold: Flag.string("threshold").pipe(Flag.optional),
        minNearestSimilarity: Flag.float("min-nearest-similarity").pipe(Flag.optional),
        nearestFixture: Flag.string("nearest-fixture").pipe(Flag.optional),
        predicate: Flag.string("predicate").pipe(Flag.optional),
        subject: Flag.string("subject").pipe(Flag.optional),
        valueContains: Flag.string("value-contains").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        preflight: Flag.boolean("preflight").pipe(Flag.withDefault(false)),
        root: Flag.string("root").pipe(Flag.optional),
        workflowStatus: Flag.string("workflow-status").pipe(Flag.optional),
        writePlan: Flag.boolean("write-plan").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ allowExpensive, applyWritePlan, all, dryRun, execute, facts, graphHealth, graphMode, history, manifest, operation, artifact, sourceKind, factKind, status, sourceFixture, proposedLabel, threshold, minNearestSimilarity, nearestFixture, predicate, subject, valueContains, out, preflight, root, workflowStatus, writePlan, json }) => {
        const operationId = optionValue(operation);
        const artifactPath = optionValue(artifact);
        const sourceKindName = optionValue(sourceKind);
        const factKindName = optionValue(factKind);
        const statusName = optionValue(status);
        const sourceFixtureId = optionValue(sourceFixture);
        const proposedLabelName = optionValue(proposedLabel);
        const thresholdName = optionValue(threshold);
        const minNearestSimilarityValue = optionValue(minNearestSimilarity);
        const nearestFixtureId = optionValue(nearestFixture);
        const predicateName = optionValue(predicate);
        const subjectName = optionValue(subject);
        const valueContainsText = optionValue(valueContains);
        const outPath = optionValue(out);
        const rootPath = optionValue(root);
        const workflowStatusPath = optionValue(workflowStatus);
        if (all) {
            return runClassifiersPackagesOperations({
                ...(rootPath === undefined ? {} : { root: rootPath }),
                ...(outPath === undefined ? {} : { out: outPath }),
                json,
            }).pipe(Effect.provide(ClassifierPackageServiceLive));
        }
        return runClassifiersPackageOperations({
            manifestPath: manifest,
            ...(operationId === undefined ? {} : { operationId }),
            ...(outPath === undefined ? {} : { out: outPath }),
            allowExpensive,
            applyWritePlan,
            dryRun,
            execute,
            facts,
            graphHealth,
            graphMode,
            history,
            ...(artifactPath === undefined ? {} : { artifact: artifactPath }),
            ...(sourceKindName === undefined ? {} : { sourceKind: sourceKindName }),
            ...(factKindName === undefined ? {} : { factKind: factKindName }),
            ...(statusName === undefined ? {} : { status: statusName }),
            ...(sourceFixtureId === undefined ? {} : { sourceFixture: sourceFixtureId }),
            ...(proposedLabelName === undefined ? {} : { proposedLabel: proposedLabelName }),
            ...(thresholdName === undefined ? {} : { threshold: thresholdName }),
            ...(minNearestSimilarityValue === undefined ? {} : { minNearestSimilarity: minNearestSimilarityValue }),
            ...(nearestFixtureId === undefined ? {} : { nearestFixture: nearestFixtureId }),
            ...(predicateName === undefined ? {} : { predicate: predicateName }),
            ...(subjectName === undefined ? {} : { subject: subjectName }),
            ...(valueContainsText === undefined ? {} : { valueContains: valueContainsText }),
            preflight,
            ...(rootPath === undefined ? {} : { root: rootPath }),
            ...(workflowStatusPath === undefined ? {} : { workflowStatusPath }),
            writePlan,
            json,
        }).pipe(Effect.provide(ClassifierPackageServiceLive));
    },
).pipe(Command.withDescription("Inspect operations declared by a classifier package manifest"));

const classifiersGraphCommand = Command.make(
    "graph",
    {
        mode: Flag.choice("mode", ["summary", "guarded", "changed-artifacts", "evidence", "lifecycle", "embedding-helper"] as const).pipe(Flag.withDefault("summary")),
        operation: Flag.string("operation").pipe(Flag.optional),
        artifact: Flag.string("artifact").pipe(Flag.optional),
        sourceKind: Flag.string("source-kind").pipe(Flag.optional),
        factKind: Flag.string("fact-kind").pipe(Flag.optional),
        status: Flag.string("status").pipe(Flag.optional),
        sourceFixture: Flag.string("source-fixture").pipe(Flag.optional),
        proposedLabel: Flag.string("proposed-label").pipe(Flag.optional),
        threshold: Flag.string("threshold").pipe(Flag.optional),
        minNearestSimilarity: Flag.float("min-nearest-similarity").pipe(Flag.optional),
        nearestFixture: Flag.string("nearest-fixture").pipe(Flag.optional),
        predicate: Flag.string("predicate").pipe(Flag.optional),
        subject: Flag.string("subject").pipe(Flag.optional),
        valueContains: Flag.string("value-contains").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ mode, operation, artifact, sourceKind, factKind, status, sourceFixture, proposedLabel, threshold, minNearestSimilarity, nearestFixture, predicate, subject, valueContains, out, json }) => {
        const operationId = optionValue(operation);
        const artifactPath = optionValue(artifact);
        const sourceKindName = optionValue(sourceKind);
        const factKindName = optionValue(factKind);
        const statusName = optionValue(status);
        const sourceFixtureId = optionValue(sourceFixture);
        const proposedLabelName = optionValue(proposedLabel);
        const thresholdName = optionValue(threshold);
        const minNearestSimilarityValue = optionValue(minNearestSimilarity);
        const nearestFixtureId = optionValue(nearestFixture);
        const predicateName = optionValue(predicate);
        const subjectName = optionValue(subject);
        const valueContainsText = optionValue(valueContains);
        const outPath = optionValue(out);
        return runClassifiersPackageOperations({
            manifestPath: "packages/ax-classifier-session-sections/ax.classifier.json",
            graphHealth: true,
            graphMode: mode,
            ...(operationId === undefined ? {} : { operationId }),
            ...(artifactPath === undefined ? {} : { artifact: artifactPath }),
            ...(sourceKindName === undefined ? {} : { sourceKind: sourceKindName }),
            ...(factKindName === undefined ? {} : { factKind: factKindName }),
            ...(statusName === undefined ? {} : { status: statusName }),
            ...(sourceFixtureId === undefined ? {} : { sourceFixture: sourceFixtureId }),
            ...(proposedLabelName === undefined ? {} : { proposedLabel: proposedLabelName }),
            ...(thresholdName === undefined ? {} : { threshold: thresholdName }),
            ...(minNearestSimilarityValue === undefined ? {} : { minNearestSimilarity: minNearestSimilarityValue }),
            ...(nearestFixtureId === undefined ? {} : { nearestFixture: nearestFixtureId }),
            ...(predicateName === undefined ? {} : { predicate: predicateName }),
            ...(subjectName === undefined ? {} : { subject: subjectName }),
            ...(valueContainsText === undefined ? {} : { valueContains: valueContainsText }),
            ...(outPath === undefined ? {} : { out: outPath }),
            json,
        }).pipe(Effect.provide(ClassifierPackageServiceLive));
    },
).pipe(Command.withDescription("Query persisted classifier lifecycle graph health"));

const classifiersLifecycleCommand = Command.make(
    "lifecycle",
    {
        root: Flag.string("root").pipe(Flag.optional),
        workflowStatus: Flag.string("workflow-status").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ root, workflowStatus, out, json }) => {
        const rootPath = optionValue(root);
        const workflowStatusPath = optionValue(workflowStatus);
        const outPath = optionValue(out);
        return runClassifiersLifecycle({
            ...(rootPath === undefined ? {} : { root: rootPath }),
            ...(workflowStatusPath === undefined ? {} : { workflowStatusPath }),
            ...(outPath === undefined ? {} : { out: outPath }),
            json,
        }).pipe(Effect.provide(ClassifierPackageServiceLive));
    },
).pipe(Command.withDescription("Summarize classifier package readiness, graph health, and review blockers"));

const classifiersWorkflowCandidatesCommand = Command.make(
    "workflow-candidates",
    {
        sourceKind: Flag.string("source-kind").pipe(Flag.withDefault("transcript_classifier_projection")),
        action: Flag.string("action").pipe(Flag.optional),
        classifier: Flag.string("classifier").pipe(Flag.optional),
        search: Flag.string("search").pipe(Flag.optional),
        taskLike: Flag.choice("task-like", ["include", "exclude", "only"] as const).pipe(Flag.withDefault("include")),
        topicReport: Flag.boolean("topic-report").pipe(Flag.withDefault(false)),
        listProposals: Flag.boolean("list-proposals").pipe(Flag.withDefault(false)),
        listHarnessFacts: Flag.boolean("list-harness-facts").pipe(Flag.withDefault(false)),
        reviewCoverage: Flag.boolean("review-coverage").pipe(Flag.withDefault(false)),
        includeHarnessFacts: Flag.boolean("include-harness-facts").pipe(Flag.withDefault(false)),
        includeHelperFacts: Flag.boolean("include-helper-facts").pipe(Flag.withDefault(false)),
        includeReviewFacts: Flag.boolean("include-review-facts").pipe(Flag.withDefault(false)),
        proposalStatus: Flag.choice("proposal-status", ["all", "open", "accepted", "rejected"] as const).pipe(Flag.withDefault("all")),
        expandEvidence: Flag.boolean("expand-evidence").pipe(Flag.withDefault(false)),
        evidencePack: Flag.string("evidence-pack").pipe(Flag.optional),
        classifierFixturePack: Flag.string("classifier-fixture-pack").pipe(Flag.optional),
        coverageFixturePack: Flag.string("coverage-fixture-pack").pipe(Flag.optional),
        coverageReviewPack: Flag.string("coverage-review-pack").pipe(Flag.optional),
        coverageReviewBrief: Flag.string("coverage-review-brief").pipe(Flag.optional),
        syncCoverageReviewBrief: Flag.string("sync-coverage-review-brief").pipe(Flag.optional),
        harnessFacts: Flag.string("harness-facts").pipe(Flag.optional),
        harnessWritePlan: Flag.string("harness-write-plan").pipe(Flag.optional),
        applyHarnessFacts: Flag.boolean("apply-harness-facts").pipe(Flag.withDefault(false)),
        reviewFacts: Flag.string("review-facts").pipe(Flag.optional),
        reviewWritePlan: Flag.string("review-write-plan").pipe(Flag.optional),
        applyReviewFacts: Flag.boolean("apply-review-facts").pipe(Flag.withDefault(false)),
        requireReviewProvenance: Flag.boolean("require-review-provenance").pipe(Flag.withDefault(false)),
        requireReviewHandoff: Flag.boolean("require-review-handoff").pipe(Flag.withDefault(false)),
        reviewProvenanceReviewer: Flag.string("review-provenance-reviewer").pipe(Flag.optional),
        reviewProvenanceReviewedAt: Flag.string("review-provenance-reviewed-at").pipe(Flag.optional),
        reviewPipelineLifecycle: Flag.boolean("review-pipeline-lifecycle").pipe(Flag.withDefault(false)),
        reviewPipelineVerifyOutputs: Flag.boolean("review-pipeline-verify-outputs").pipe(Flag.withDefault(false)),
        reviewPipelineReviewer: Flag.string("review-pipeline-reviewer").pipe(Flag.optional),
        reviewPipelineReviewedAt: Flag.string("review-pipeline-reviewed-at").pipe(Flag.optional),
        limit: positiveLimit(10),
        examples: Flag.integer("examples").pipe(Flag.withDefault(3)),
        out: Flag.string("out").pipe(Flag.optional),
        brief: Flag.string("brief").pipe(Flag.optional),
        syncBrief: Flag.string("sync-brief").pipe(Flag.optional),
        promoteTasks: Flag.boolean("promote-tasks").pipe(Flag.withDefault(false)),
        emitAdjacentTasks: Flag.boolean("emit-adjacent-tasks").pipe(Flag.withDefault(false)),
        promoteHarnessProposals: Flag.boolean("promote-harness-proposals").pipe(Flag.withDefault(false)),
        requireHarnessChecks: Flag.boolean("require-harness-checks").pipe(Flag.withDefault(false)),
        promoteProposals: Flag.boolean("promote-proposals").pipe(Flag.withDefault(false)),
        proposalDryRun: Flag.boolean("proposal-dry-run").pipe(Flag.withDefault(false)),
        promotionMode: Flag.choice("promotion-mode", ["per-candidate", "merge-evidence"] as const).pipe(Flag.withDefault("per-candidate")),
        taskDir: Flag.string("task-dir").pipe(Flag.optional),
        proposalTarget: Flag.string("proposal-target").pipe(Flag.optional),
        proposalSection: Flag.string("proposal-section").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ sourceKind, action, classifier, search, taskLike, topicReport, listProposals, listHarnessFacts, reviewCoverage, includeHarnessFacts, includeHelperFacts, includeReviewFacts, proposalStatus, expandEvidence, evidencePack, classifierFixturePack, coverageFixturePack, coverageReviewPack, coverageReviewBrief, syncCoverageReviewBrief, harnessFacts, harnessWritePlan, applyHarnessFacts, reviewFacts, reviewWritePlan, applyReviewFacts, requireReviewProvenance, requireReviewHandoff, reviewProvenanceReviewer, reviewProvenanceReviewedAt, reviewPipelineLifecycle, reviewPipelineVerifyOutputs, reviewPipelineReviewer, reviewPipelineReviewedAt, limit, examples, out, brief, syncBrief, promoteTasks, emitAdjacentTasks, promoteHarnessProposals, requireHarnessChecks, promoteProposals, proposalDryRun, promotionMode, taskDir, proposalTarget, proposalSection, json }) => {
        const actionValue = optionValue(action);
        const classifierValue = optionValue(classifier);
        const searchValue = optionValue(search);
        const outPath = optionValue(out);
        const briefPath = optionValue(brief);
        const syncBriefPath = optionValue(syncBrief);
        const evidencePackPath = optionValue(evidencePack);
        const classifierFixturePackPath = optionValue(classifierFixturePack);
        const coverageFixturePackPath = optionValue(coverageFixturePack);
        const coverageReviewPackPath = optionValue(coverageReviewPack);
        const coverageReviewBriefPath = optionValue(coverageReviewBrief);
        const syncCoverageReviewBriefPath = optionValue(syncCoverageReviewBrief);
        const harnessFactsPath = optionValue(harnessFacts);
        const harnessWritePlanPath = optionValue(harnessWritePlan);
        const reviewFactsPath = optionValue(reviewFacts);
        const reviewWritePlanPath = optionValue(reviewWritePlan);
        const reviewProvenanceReviewerValue = optionValue(reviewProvenanceReviewer);
        const reviewProvenanceReviewedAtValue = optionValue(reviewProvenanceReviewedAt);
        const reviewPipelineReviewerValue = optionValue(reviewPipelineReviewer);
        const reviewPipelineReviewedAtValue = optionValue(reviewPipelineReviewedAt);
        const taskDirPath = optionValue(taskDir);
        const proposalTargetPath = optionValue(proposalTarget);
        const proposalSectionValue = optionValue(proposalSection);
        return runClassifiersWorkflowCandidates({
            sourceKind,
            limit,
            examples,
            ...(actionValue === undefined ? {} : { action: actionValue }),
            ...(classifierValue === undefined ? {} : { classifier: classifierValue }),
            ...(searchValue === undefined ? {} : { search: searchValue }),
            taskLike: taskLike as WorkflowCandidateTaskLikeMode,
            topicReport,
            listProposals,
            listHarnessFacts,
            reviewCoverage,
            includeHarnessFacts,
            includeHelperFacts,
            includeReviewFacts,
            proposalStatus: proposalStatus as WorkflowCandidateProposalStatusFilter,
            expandEvidence,
            ...(evidencePackPath === undefined ? {} : { evidencePack: evidencePackPath }),
            ...(classifierFixturePackPath === undefined ? {} : { classifierFixturePack: classifierFixturePackPath }),
            ...(coverageFixturePackPath === undefined ? {} : { coverageFixturePack: coverageFixturePackPath }),
            ...(coverageReviewPackPath === undefined ? {} : { coverageReviewPack: coverageReviewPackPath }),
            ...(coverageReviewBriefPath === undefined ? {} : { coverageReviewBrief: coverageReviewBriefPath }),
            ...(syncCoverageReviewBriefPath === undefined ? {} : { syncCoverageReviewBrief: syncCoverageReviewBriefPath }),
            ...(harnessFactsPath === undefined ? {} : { harnessFacts: harnessFactsPath }),
            ...(harnessWritePlanPath === undefined ? {} : { harnessWritePlan: harnessWritePlanPath }),
            applyHarnessFacts,
            ...(reviewFactsPath === undefined ? {} : { reviewFacts: reviewFactsPath }),
            ...(reviewWritePlanPath === undefined ? {} : { reviewWritePlan: reviewWritePlanPath }),
            applyReviewFacts,
            requireReviewProvenance,
            requireReviewHandoff,
            ...(reviewProvenanceReviewerValue === undefined ? {} : { reviewProvenanceReviewer: reviewProvenanceReviewerValue }),
            ...(reviewProvenanceReviewedAtValue === undefined ? {} : { reviewProvenanceReviewedAt: reviewProvenanceReviewedAtValue }),
            reviewPipelineLifecycle,
            reviewPipelineVerifyOutputs,
            ...(reviewPipelineReviewerValue === undefined ? {} : { reviewPipelineReviewer: reviewPipelineReviewerValue }),
            ...(reviewPipelineReviewedAtValue === undefined ? {} : { reviewPipelineReviewedAt: reviewPipelineReviewedAtValue }),
            ...(outPath === undefined ? {} : { out: outPath }),
            ...(briefPath === undefined ? {} : { brief: briefPath }),
            ...(syncBriefPath === undefined ? {} : { syncBrief: syncBriefPath }),
            promoteTasks,
            emitAdjacentTasks,
            promoteHarnessProposals,
            requireHarnessChecks,
            promoteProposals,
            proposalDryRun,
            promotionMode: promotionMode as WorkflowCandidatePromotionMode,
            ...(taskDirPath === undefined ? {} : { taskDir: taskDirPath }),
            ...(proposalTargetPath === undefined ? {} : { proposalTarget: proposalTargetPath }),
            ...(proposalSectionValue === undefined ? {} : { proposalSection: proposalSectionValue }),
            json,
        });
    },
).pipe(Command.withDescription("Rank transcript-backed workflow candidates from classifier graph facts"));

const classifiersCommand = Command.make("classifiers").pipe(
    Command.withDescription("Develop and evaluate ax classifiers"),
    Command.withSubcommands([
        classifiersListCommand,
        classifiersEvalCommand,
        classifiersExplainCommand,
        classifiersGraphCommand,
        classifiersLifecycleCommand,
        classifiersPackageOperationsCommand,
        classifiersWorkflowCandidatesCommand,
    ]),
);

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
            ...(roots.length > 0 ? { roots } : {}),
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
            ...(forms.length > 0 ? { forms } : {}),
            ...(sinceDays === undefined ? {} : { sinceDays }),
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
        apply: Flag.boolean("apply").pipe(
            Flag.withDefault(false),
            Flag.withDescription("Interactive: pick a proposal from the printed list and accept inline (loops until you quit). Combine with --with-agent on the accept side via the prompt."),
        ),
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
).pipe(Command.withDescription("Rank open proposals by confidence × recency × frequency and print the top N as paste-ready blocks (with `<!--ax:id-->` provenance markers). --apply for interactive accept loop."));

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
).pipe(Command.withDescription("Scan grounded agent files (AGENTS.md / CLAUDE.md / skills) for `<!--ax:id-->` markers, reconcile against the DB, remove consumed `.ax/tasks/<id>.md` briefs, warn on orphans + tasks older than --stale-days (default 7)."));

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

const cmdImproveReject = (args: string[]) =>
    Effect.gen(function* () {
        const positional = args.filter((a) => !a.startsWith("--"))[0];
        if (positional === undefined) {
            console.error("axctl improve reject: missing <id>");
            process.exit(2);
        }
        const reason = flag("reason", args) ?? "not_worth_packaging";
        const result = yield* rejectProposal({ sigOrId: positional, reason });
        if (result.status !== "ok") {
            console.error(result.message ?? `failed to reject proposal ${positional}`);
            process.exit(2);
        }
        console.log(`proposal status -> rejected (reason: ${result.reason})`);
    });

const improveAcceptCommand = Command.make(
    "accept",
    {
        id: Argument.string("id"),
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
        withAgent: Flag.boolean("with-agent").pipe(
            Flag.withDefault(false),
            Flag.withDescription("After scaffold, spawn a `claude -p` subagent to read the stub + sibling skills and rewrite SKILL.md with concrete guidance. Streams to terminal. Implies --auto-scaffold."),
        ),
        autoScaffold: Flag.boolean("auto-scaffold").pipe(
            Flag.withDefault(false),
            Flag.withDescription("Skip the `.ax/tasks/<id>.md` brief and write SKILL.md directly (skill form only). Use when you want the file now, not a brief to hand to your agent."),
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
).pipe(Command.withDescription("Accept a proposal. Default emits a `.ax/tasks/<id>.md` brief to hand to your agent (Claude Code, Codex). --auto-scaffold writes SKILL.md directly. --with-agent dispatches a subagent to enrich the stub."));

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
).pipe(Command.withDescription("Compute checkpoint snapshots at +3/+10/+30 sessions for active experiments (session-count windows, not calendar days - see issue #83)"));

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

// --- sessions here ---

/**
 * Auto-delta ingest: when the project's transcript dir has new jsonl files
 * the DB hasn't seen yet, either silently backfill (small delta) or warn
 * the user (large delta). Threshold default 5; tunable via --stale-threshold=N.
 * Pass --no-stale-check to skip entirely. (P1.4)
 */
const STALE_THRESHOLD_DEFAULT = 5;

const maybeAutoIngestStale = (
    cmdLabel: string,
    repoRoot: string,
    args: ReadonlyArray<string>,
): Effect.Effect<void, DbError, SurrealClient | AxConfig> =>
    Effect.gen(function* () {
        if (args.includes("--no-stale-check")) return;
        const threshold = parsePositiveIntFlag(
            cmdLabel,
            "stale-threshold",
            [...args],
            STALE_THRESHOLD_DEFAULT,
        );

        const cfg = yield* AxConfig;
        const project = encodeClaudeProjectSlug(repoRoot);
        const report = yield* detectStaleness({
            transcriptsDir: cfg.paths.transcriptsDir,
            project,
        });

        if (report.newFiles.length === 0) return;

        if (report.newFiles.length <= threshold) {
            // Silent backfill: ingest only this project, recent transcripts.
            process.stderr.write(
                `axctl ${cmdLabel}: backfilling ${report.newFiles.length} new transcript(s) for ${project}\n`,
            );
            yield* ingestTranscripts({ project, sinceDays: 7 });
        } else {
            process.stderr.write(
                `axctl ${cmdLabel}: ${report.newFiles.length} new transcript(s) on disk not yet ingested ` +
                    `(threshold=${threshold}). Run \`axctl ingest here --since=7\` to backfill, ` +
                    `or pass --no-stale-check to suppress this warning.\n`,
            );
        }
    });

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

        const repositoryKey = pwdResolution.repositoryRecordId.id as string;
        yield* maybeAutoIngestStale("sessions here", pwdResolution.repoRoot, args);
        const rows = yield* listSessionsHere({ repositoryKey, days });

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
        const repositoryKey = pwdResolution.repositoryRecordId.id as string;

        yield* maybeAutoIngestStale("sessions near", repoRoot, args);

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

        const rows = yield* listSessionsNear({ from, to, repositoryKey });

        if (json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
        }
        console.log(formatSessionsTable(rows));
    });

// ---------------------------------------------------------------------------
// ax session show <id> - single-session detail with subagent timeline (P2.2)
// ---------------------------------------------------------------------------

/**
 * `ax session show <id> [--expand=<uuid>] [--all] [--by-role] [--json]`
 *
 * Displays a session's invoked + tool_call timeline. Collapses subagent
 * sessions to one-line summaries by default. --expand=<uuid> (repeatable)
 * or --all drills into subagent contents inline.
 *
 * P3.7: --by-role groups the Top skills section by role instead of flat list.
 * Skills without a role appear in "(unclassified)".
 *
 * Auto markdown (TTY) vs JSON (piped). --json forces JSON output.
 */
const cmdSessionShow = (args: string[]) =>
    Effect.gen(function* () {
        const positionals = args.filter((a) => !a.startsWith("--"));
        const sessionId = positionals[0];
        if (!sessionId) {
            console.error("axctl session show: missing <id>");
            console.error("  usage: axctl session show <uuid|claude-subagent-<id>|session:⟨...⟩>");
            process.exit(2);
        }

        const forceJson = args.includes("--json");
        const expandAll = args.includes("--all");
        const byRole = args.includes("--by-role");
        const useJson = forceJson || process.stdout.isTTY === false;

        // Collect --expand=<uuid> values (repeatable)
        const expandSet = new Set<string>();
        for (const a of args) {
            if (a.startsWith("--expand=")) {
                const val = a.slice("--expand=".length).trim();
                if (val.length > 0) expandSet.add(val);
            }
        }

        const payload = yield* fetchSessionShow({
            sessionId,
            expand: expandSet,
            expandAll,
            byRole,
        }).pipe(
            catchDbErrorAndExit("axctl session show"),
        );

        if (payload.session.overview === null) {
            process.stderr.write(`session ${sessionId} not found\n`);
            process.exit(1);
        }

        if (useJson) {
            console.log(renderSessionJson(payload));
        } else {
            console.log(renderSessionMarkdown(payload));
        }
    });

const sessionShowCommand = Command.make(
    "show",
    {
        id: Argument.string("id"),
        expand: Flag.string("expand").pipe(Flag.atLeast(0)),
        all: Flag.boolean("all").pipe(Flag.withDefault(false)),
        byRole: Flag.boolean("by-role").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ id, expand, all, byRole, json }) =>
        cmdSessionShow([
            id,
            ...[...expand].map((e) => `--expand=${e}`),
            ...boolArg("all", all),
            ...boolArg("by-role", byRole),
            ...boolArg("json", json),
        ]),
).pipe(
    Command.withDescription(
        "Display a session's timeline (tool calls + subagent spawns). " +
        "--expand=<uuid> (repeatable) or --all expands subagent timelines inline. " +
        "--by-role groups the Top skills section by role. " +
        "Auto markdown on TTY, JSON when piped. --json forces JSON.",
    ),
);

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
).pipe(Command.withDescription(
    "List sessions that overlapped with a git commit window (from the predecessor commit's timestamp to this commit's timestamp). " +
    "Pass a full or short SHA. Must be inside the target git repo. " +
    "See the ax:extract-workflow skill for narrating workflows around a sha.",
));

const sessionsCommand = Command.make("sessions").pipe(
    Command.withDescription("Windowed session queries: here (pwd-repo), around (date), near (sha), show (detail)"),
    Command.withSubcommands([
        sessionsHereCommand,
        sessionsAroundCommand,
        sessionsNearCommand,
        sessionShowCommand,
    ]),
);

const improveCommand = Command.make("improve").pipe(
    Command.withDescription("Experiment loop: rank proposals (recommend), accept (emit task brief or scaffold + dispatch subagent), lint grounded agent files, track verdicts at +3/+10/+30 sessions after accept."),
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

/**
 * `ax retro pending` - sessions that lack a `reviewed` edge to any retro.
 *
 * A session is "pending retro" when:
 *   - it has no outbound `reviewed` edge, AND
 *   - it looks finished: either `ended_at` is set, or the last turn was
 *     more than --idle-min minutes ago (user closed the tab, no explicit
 *     end marker).
 *
 * Drives the quota-arbitrage flow: idle Opus budget chews through the
 * backlog via the retro-reviewer subagent.
 */
interface PendingSessionRow {
    readonly id: string | { tb: string; id: string };
    readonly project: string | null;
    readonly source: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly last_turn_at: string | null;
    readonly turns: number;
}

interface PendingSession {
    readonly sessionId: string;     // `session:<key>` record id
    readonly key: string;           // bare key (UUID, no prefix)
    readonly project: string | null;
    readonly source: string | null;
    readonly model: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly lastTurnAt: string | null;
    readonly turns: number;
    readonly reason: "ended_at" | "idle";
}

/**
 * Two-pass query so we don't pay for per-session turn subqueries on the
 * common path:
 *
 *   1. Sessions with `ended_at` set in the window. Cheap. Most rows.
 *   2. Sessions w/o `ended_at` whose `started_at` is older than the idle
 *      threshold. Approximation - assumes "no end marker AND old start"
 *      means the user walked away. Fast.
 *
 * `turns` is fetched lazily inside `ax retro brief`, not here, because
 * the per-session `count(turn)` subquery is what blew up the v0 query.
 */
interface PendingQueryOpts {
    readonly sinceDays: number;
    readonly idleMinutes: number;
    readonly includeSubagents: boolean;
    readonly limit: number;
}

const queryPendingSessions = (opts: PendingQueryOpts) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // claude-subagent sessions are orchestrated children; their retros
        // belong to the parent session's review. Exclude unless asked.
        const subagentFilter = opts.includeSubagents ? "" : "AND source != 'claude-subagent'";
        const endedRows = yield* db.query<[Array<{
            id: PendingSessionRow["id"]; project: string | null; source: string | null;
            model: string | null; started_at: string | null; ended_at: string | null;
        }>]>(`
            SELECT id, project, source, model,
                type::string(started_at) AS started_at,
                type::string(ended_at) AS ended_at
            FROM session
            WHERE count(->reviewed) = 0
              AND ended_at != NONE
              AND ended_at > time::now() - ${opts.sinceDays}d
              ${subagentFilter}
            ORDER BY ended_at DESC
            LIMIT ${opts.limit};
        `);
        const idleRows = yield* db.query<[Array<{
            id: PendingSessionRow["id"]; project: string | null; source: string | null;
            model: string | null; started_at: string | null;
        }>]>(`
            SELECT id, project, source, model,
                type::string(started_at) AS started_at
            FROM session
            WHERE count(->reviewed) = 0
              AND ended_at = NONE
              AND started_at != NONE
              AND started_at > time::now() - ${opts.sinceDays}d
              AND started_at < time::now() - ${opts.idleMinutes}m
              ${subagentFilter}
            ORDER BY started_at DESC
            LIMIT ${opts.limit};
        `);

        const recordIdOf = (id: PendingSessionRow["id"]): string =>
            typeof id === "string" ? id : `session:${id.id}`;
        const keyOf = (recordId: string): string =>
            recordId.startsWith("session:")
                ? recordId.slice("session:".length).replace(/`/g, "")
                : recordId;

        const out: PendingSession[] = [];
        for (const row of (endedRows?.[0] ?? [])) {
            const sessionRecordId = recordIdOf(row.id);
            out.push({
                sessionId: sessionRecordId,
                key: keyOf(sessionRecordId),
                project: row.project,
                source: row.source,
                model: row.model,
                startedAt: row.started_at,
                endedAt: row.ended_at,
                lastTurnAt: null,
                turns: 0,
                reason: "ended_at",
            });
        }
        for (const row of (idleRows?.[0] ?? [])) {
            const sessionRecordId = recordIdOf(row.id);
            out.push({
                sessionId: sessionRecordId,
                key: keyOf(sessionRecordId),
                project: row.project,
                source: row.source,
                model: row.model,
                startedAt: row.started_at,
                endedAt: null,
                lastTurnAt: null,
                turns: 0,
                reason: "idle",
            });
        }
        return out;
    });

const cmdRetroPending = (args: string[]) =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const includeSubagents = args.includes("--include-subagents");
        const sinceFlag = flag("since", args);
        const idleFlag = flag("idle-min", args);
        const limitFlag = flag("limit", args);
        const sinceDays = sinceFlag ? Math.max(1, parseInt(sinceFlag, 10) || 7) : 7;
        const idleMinutes = idleFlag ? Math.max(1, parseInt(idleFlag, 10) || 30) : 30;
        const limit = limitFlag ? Math.max(1, parseInt(limitFlag, 10) || 20) : 20;
        const pending = yield* queryPendingSessions({ sinceDays, idleMinutes, includeSubagents, limit });
        if (json) {
            console.log(prettyPrint(pending));
            return;
        }
        if (pending.length === 0) {
            console.log(`(no pending retros in last ${sinceDays}d${includeSubagents ? "" : ", excluding subagents"})`);
            return;
        }
        const subAgentHint = includeSubagents ? "" : " (subagents hidden - pass --include-subagents to show)";
        console.log(`${pending.length} session(s) pending retro, since=${sinceDays}d limit=${limit}${subAgentHint}:`);
        for (const s of pending) {
            const proj = s.project ? prettifyProjectSlug(s.project) : "?";
            const when = s.endedAt ?? s.startedAt ?? "?";
            console.log(`  ${s.sessionId}  [${s.source ?? "?"}]  ${proj}  ${s.reason}=${when}`);
        }
    });

/**
 * `ax retro brief --session=<id>` - write `.ax/tasks/retro/<key>.md` brief
 * the retro-reviewer subagent consumes.
 *
 * Suggested-model heuristic: short, error-free sessions → haiku; sessions
 * with many turns, corrections, or tool errors → opus. The brief embeds
 * the suggestion as advisory metadata; the dispatcher picks the model.
 */
const formatRetroBrief = (s: PendingSession, transcriptPath: string | null, suggestedModel: string): string => {
    const fm = [
        "---",
        "kind: retro",
        `session_id: ${s.sessionId}`,
        `session_key: ${s.key}`,
        s.project ? `project: ${s.project}` : null,
        s.source ? `source: ${s.source}` : null,
        s.model ? `model_used: ${s.model}` : null,
        `turns: ${s.turns}`,
        s.startedAt ? `started_at: ${s.startedAt}` : null,
        (s.endedAt ?? s.lastTurnAt) ? `ended_at: ${s.endedAt ?? s.lastTurnAt}` : null,
        `pending_reason: ${s.reason}`,
        `suggested_model: ${suggestedModel}`,
        transcriptPath ? `transcript: ${transcriptPath}` : null,
        "status: pending",
        "---",
    ].filter((line): line is string => line !== null).join("\n");

    const body = `# Retro: ${s.sessionId}

Review the prior session and emit findings. Source of truth is the
transcript at \`${transcriptPath ?? "(unknown - check raw_file on the session record)"}\`.

## What to look for

- **Worked**: which moves landed; which skills/tools fired and helped.
- **Failed**: corrections, retries, dead-ends, tool errors. Pattern over single events.
- **Model fit**: was \`${s.model ?? "?"}\` overkill (cheap rote work) or undersized (visible struggle)?
- **Missing scaffolding**: behaviors a skill / hook / subagent would've prevented.

## Required output

Run these from the repo whose session this was:

\`\`\`bash
ax retro emit --session=${s.sessionId} --source=manual --from-file=<path-to-json>
\`\`\`

…where the JSON file contains \`{tried, worked, failed, next}\`. If you
spot a repeated pattern (≥2 occurrences in this session, or rhymes with
prior retros), also call:

\`\`\`bash
ax improve recommend ...
\`\`\`

When done, update this file's frontmatter \`status: completed\`. The next
\`ax retro pending\` call will exclude this session because the
\`reviewed\` edge now exists.
`;
    return `${fm}\n\n${body}`;
};

const suggestModelFor = (s: PendingSession): string => {
    if (s.turns >= 40) return "opus";
    if (s.turns <= 5) return "haiku";
    return "sonnet";
};

const cmdRetroBrief = (args: string[]) =>
    Effect.gen(function* () {
        const sessionFlag = flag("session", args);
        const outDirFlag = flag("out-dir", args);
        const json = args.includes("--json");
        if (!sessionFlag) {
            console.error("ax retro brief: --session=<id> required");
            process.exit(2);
        }
        const rawSession = sessionFlag.startsWith("session:")
            ? sessionFlag.slice("session:".length).replace(/`/g, "")
            : sessionFlag;
        const sessionRef = recordRef("session", rawSession);
        const sessionRecordId = `session:${rawSession}`;
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<{
            id: string | { tb: string; id: string };
            project: string | null;
            source: string | null;
            model: string | null;
            started_at: string | null;
            ended_at: string | null;
            raw_file: string | null;
            last_turn_at: string | null;
            turns: number;
        }>]>(`
            SELECT
                id, project, source, model, raw_file,
                type::string(started_at) AS started_at,
                type::string(ended_at) AS ended_at,
                type::string((SELECT VALUE math::max(ts) FROM turn WHERE session = $parent.id GROUP ALL)[0]) AS last_turn_at,
                (SELECT count() FROM turn WHERE session = $parent.id GROUP ALL)[0].count ?? 0 AS turns
            FROM ${sessionRef} LIMIT 1;
        `);
        const row = (rows?.[0] ?? [])[0];
        if (!row) {
            console.error(`ax retro brief: session ${sessionRecordId} not found`);
            process.exit(2);
        }
        const idStr = typeof row.id === "string" ? row.id : `session:${row.id.id}`;
        const key = idStr.startsWith("session:") ? idStr.slice("session:".length).replace(/`/g, "") : idStr;
        const session: PendingSession = {
            sessionId: idStr,
            key,
            project: row.project,
            source: row.source,
            model: row.model,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            lastTurnAt: row.last_turn_at,
            turns: row.turns ?? 0,
            reason: row.ended_at ? "ended_at" : "idle",
        };
        const suggested = suggestModelFor(session);
        const transcriptPath = row.raw_file ?? null;
        const body = formatRetroBrief(session, transcriptPath, suggested);

        const { mkdir, writeFile } = yield* Effect.promise(() => import("node:fs/promises"));
        const { join, resolve } = yield* Effect.promise(() => import("node:path"));
        const outDir = resolve(outDirFlag ?? join(process.cwd(), ".ax", "tasks", "retro"));
        yield* Effect.promise(() => mkdir(outDir, { recursive: true }));
        const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
        const filePath = join(outDir, `${safeKey}.md`);
        yield* Effect.promise(() => writeFile(filePath, body, "utf8"));

        if (json) {
            console.log(prettyPrint({ session: idStr, path: filePath, suggested_model: suggested, transcript: transcriptPath }));
            return;
        }
        console.log(`brief: ${filePath}`);
        console.log(`  session=${idStr}  turns=${session.turns}  suggested_model=${suggested}`);
        if (transcriptPath) console.log(`  transcript=${transcriptPath}`);
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

const retroPendingCommand = Command.make(
    "pending",
    {
        since: Flag.integer("since").pipe(Flag.withDefault(7)),
        idleMin: Flag.integer("idle-min").pipe(Flag.withDefault(30)),
        limit: Flag.integer("limit").pipe(Flag.withDefault(20)),
        includeSubagents: Flag.boolean("include-subagents").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ since, idleMin, limit, includeSubagents, json }) => cmdRetroPending([
        `--since=${since}`,
        `--idle-min=${idleMin}`,
        `--limit=${limit}`,
        ...boolArg("include-subagents", includeSubagents),
        ...boolArg("json", json),
    ]),
).pipe(Command.withDescription("List sessions in the last N days that have no `reviewed` edge yet - the retro backlog the /retro skill drains. Excludes claude-subagent rows by default."));

const retroBriefCommand = Command.make(
    "brief",
    {
        session: Flag.string("session"),
        outDir: Flag.string("out-dir").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ session, outDir, json }) => cmdRetroBrief([
        `--session=${session}`,
        ...stringArg("out-dir", optionValue(outDir)),
        ...boolArg("json", json),
    ]),
).pipe(Command.withDescription("Write a task brief for one session to .ax/tasks/retro/<key>.md - hands off to the retro-reviewer subagent"));

const retroCommand = Command.make("retro").pipe(
    Command.withDescription("Session retros: structured reflections (tried · worked · failed · next) that drive the experiment loop"),
    Command.withSubcommands([retroEmitCommand, retroListCommand, retroPendingCommand, retroBriefCommand, retroReflectCommand, retroMetaCommand, retroPlanCommand]),
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

const usd = (value: unknown): string => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? `$${n.toFixed(4)}` : "$0.0000";
};

const integer = (value: unknown): string => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : "0";
};

const cmdCosts = (input: { readonly limit: number; readonly source: string | null; readonly sinceDays: number | null; readonly json: boolean }) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const where = ["estimated_cost_usd != NONE"];
        if (input.source) where.push(`source = ${surrealLiteral(input.source)}`);
        if (input.sinceDays !== null) {
            const since = Math.min(Math.max(Math.trunc(input.sinceDays), 1), 3650);
            where.push(`ts > time::now() - ${since}d`);
        }
        const whereClause = `WHERE ${where.join(" AND ")}`;
        const [totals, byModel, recent] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(`
SELECT count() AS sessions, math::sum(estimated_tokens) AS tokens, math::sum(prompt_tokens) AS prompt_tokens,
       math::sum(completion_tokens) AS completion_tokens, math::sum(cache_creation_input_tokens) AS cache_creation_input_tokens,
       math::sum(cache_read_input_tokens) AS cache_read_input_tokens, math::sum(estimated_cost_usd) AS cost
FROM session_token_usage
${whereClause}
GROUP ALL;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<Record<string, unknown>>]>(`
SELECT source, model, pricing_source, count() AS sessions, math::sum(estimated_tokens) AS tokens,
       math::sum(prompt_tokens) AS prompt_tokens, math::sum(completion_tokens) AS completion_tokens,
       math::sum(cache_creation_input_tokens) AS cache_creation_input_tokens,
       math::sum(cache_read_input_tokens) AS cache_read_input_tokens,
       math::sum(estimated_cost_usd) AS cost
FROM session_token_usage
${whereClause}
GROUP BY source, model, pricing_source
ORDER BY cost DESC
LIMIT ${Math.min(Math.max(input.limit, 1), 200)};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<Record<string, unknown>>]>(`
SELECT session, source, model, estimated_tokens, estimated_cost_usd, pricing_source, type::string(ts) AS ts
FROM session_token_usage
${whereClause}
ORDER BY ts DESC
LIMIT ${Math.min(Math.max(input.limit, 1), 200)};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 3 });
        const payload = { totals: totals[0] ?? null, byModel, recent };
        if (input.json) {
            console.log(prettyPrint(payload));
            return;
        }
        const total = totals[0];
        if (!total) {
            console.log("(no priced session token usage yet)");
            return;
        }
        console.log(`cost ${usd(total.cost)}  sessions ${integer(total.sessions)}  tokens ${integer(total.tokens)}`);
        console.log("");
        console.log(`${"source".padEnd(12)} ${"model".padEnd(30)} ${"sessions".padStart(8)} ${"tokens".padStart(14)} ${"cost".padStart(10)}  pricing`);
        for (const row of byModel) {
            console.log(
                `${String(row.source ?? "").padEnd(12)} ` +
                `${String(row.model ?? "<none>").slice(0, 30).padEnd(30)} ` +
                `${integer(row.sessions).padStart(8)} ` +
                `${integer(row.tokens).padStart(14)} ` +
                `${usd(row.cost).padStart(10)}  ` +
                `${String(row.pricing_source ?? "")}`,
            );
        }
    });

const costsSummaryCommand = Command.make(
    "summary",
    {
        limit: positiveLimit(20),
        source: Flag.string("source").pipe(Flag.optional),
        since: optionalSince,
        json: jsonFlag,
    },
    ({ limit, source, since, json }) =>
        cmdCosts({
            limit,
            source: optionValue(source) ?? null,
            sinceDays: optionValue(since) ?? null,
            json,
        }),
).pipe(Command.withDescription("Summarize estimated session token cost by provider/model"));

const formatCostSummary = (summary: CostSummary): string => {
    const lines: string[] = [];
    lines.push(`selector ${summary.selector}`);
    lines.push(`evidence ${summary.evidence}`);
    lines.push(
        `cost ${usd(summary.totals.estimatedCostUsd)}  sessions ${integer(summary.totals.sessions)}  tokens ${integer(summary.totals.estimatedTokens)}`,
    );
    lines.push(
        `prompt ${integer(summary.totals.promptTokens)}  output ${integer(summary.totals.completionTokens)}  cache_write ${integer(summary.totals.cacheCreationInputTokens)}  cache_read ${integer(summary.totals.cacheReadInputTokens)}`,
    );
    lines.push("");
    lines.push(`${"source".padEnd(12)} ${"model".padEnd(30)} ${"sessions".padStart(8)} ${"tokens".padStart(14)} ${"cost".padStart(10)}`);
    for (const row of summary.byModel) {
        lines.push(
            `${row.source.padEnd(12)} ` +
            `${String(row.model ?? "<none>").slice(0, 30).padEnd(30)} ` +
            `${integer(row.sessions).padStart(8)} ` +
            `${integer(row.estimatedTokens).padStart(14)} ` +
            `${usd(row.estimatedCostUsd).padStart(10)}`,
        );
    }
    lines.push("");
    lines.push("sessions");
    for (const row of summary.sessions.slice(0, 20)) {
        lines.push(
            `- ${row.session.replace(/^session:/, "")}  ${row.source}  ${row.model ?? "?"}  ${integer(row.estimated_tokens)} tokens  ${usd(row.estimated_cost_usd)}`,
        );
    }
    return lines.join("\n");
};

const splitCostTerms = (value: string | null): string[] =>
    value === null
        ? []
        : value.split(",").map((term) => term.trim()).filter((term) => term.length > 0);

const costQueryTerms = (query: string | null, terms: string | null): string[] => {
    const parsedTerms = splitCostTerms(terms);
    if (parsedTerms.length > 0) return parsedTerms;
    return query === null ? [] : [query];
};

const cmdCostsFor = (input: {
    readonly session: string | null;
    readonly query: string | null;
    readonly terms: string | null;
    readonly commit: string | null;
    readonly branch: string | null;
    readonly sinceDays: number | null;
    readonly project: string | null;
    readonly here: boolean;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        let repositoryKey: string | null = null;
        if (input.commit || input.branch || input.here) {
            const pwdResolution = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (err) =>
                    Effect.sync(() => {
                        process.stderr.write(`axctl costs for: --here/--commit/--branch requires a git repository (cwd=${err.cwd})\n`);
                        process.exit(2);
                    }),
                ),
            );
            repositoryKey = pwdResolution.repositoryRecordId.id as string;
        }
        const since = input.sinceDays === null
            ? null
            : new Date(Date.now() - Math.min(Math.max(Math.trunc(input.sinceDays), 1), 3650) * 86400 * 1000);
        const terms = costQueryTerms(input.query, input.terms);
        const selected =
            input.session ? { kind: "session" as const, sessionId: input.session } :
            terms.length > 0 ? {
                kind: "query" as const,
                terms,
                limit: input.limit,
                since,
                project: input.project,
                repositoryKey,
            } :
            input.commit ? { kind: "commit" as const, sha: input.commit, repositoryKey } :
            input.branch ? { kind: "branch" as const, branch: input.branch, repositoryKey, limit: input.limit } :
            null;
        if (!selected) {
            console.error("axctl costs for: pass one of --session, --query, --terms, --commit, --branch");
            process.exit(2);
        }
        const summary = yield* fetchCostSummary(selected);
        if (input.json) {
            console.log(prettyPrint(summary));
            return;
        }
        console.log(formatCostSummary(summary));
    });

const costsForCommand = Command.make(
    "for",
    {
        session: Flag.string("session").pipe(Flag.optional),
        query: Flag.string("query").pipe(Flag.optional),
        terms: Flag.string("terms").pipe(Flag.optional),
        commit: Flag.string("commit").pipe(Flag.optional),
        branch: Flag.string("branch").pipe(Flag.optional),
        since: optionalSince,
        project: Flag.string("project").pipe(Flag.optional),
        here: Flag.boolean("here").pipe(Flag.withDefault(false)),
        limit: positiveLimit(50),
        json: jsonFlag,
    },
    ({ session, query, terms, commit, branch, since, project, here, limit, json }) =>
        cmdCostsFor({
            session: optionValue(session) ?? null,
            query: optionValue(query) ?? null,
            terms: optionValue(terms) ?? null,
            commit: optionValue(commit) ?? null,
            branch: optionValue(branch) ?? null,
            sinceDays: optionValue(since) ?? null,
            project: optionValue(project) ?? null,
            here,
            limit,
            json,
        }),
).pipe(Command.withDescription("Estimate cost for a session, text query, commit, or branch"));

const costsGroupCommand = Command.make("costs").pipe(
    Command.withDescription("Summarize and explain estimated token costs"),
    Command.withSubcommands([costsSummaryCommand, costsForCommand]),
);

const cmdPricing = (input: { readonly limit: number; readonly query: string | null; readonly json: boolean }) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT name, provider, display_name, input_per_million_usd, output_per_million_usd,
       cache_creation_per_million_usd, cache_read_per_million_usd,
       fast_multiplier, context_window, pricing_source
FROM agent_model
ORDER BY provider, name
LIMIT 5000;`).pipe(Effect.map((result) => result?.[0] ?? []));
        const q = input.query?.trim().toLowerCase() ?? "";
        const filtered = (q.length === 0
            ? rows
            : rows.filter((row) =>
                String(row.name ?? "").toLowerCase().includes(q) ||
                String(row.provider ?? "").toLowerCase().includes(q) ||
                String(row.display_name ?? "").toLowerCase().includes(q)
            )).slice(0, Math.min(Math.max(input.limit, 1), 500));
        if (input.json) {
            console.log(prettyPrint(filtered));
            return;
        }
        if (filtered.length === 0) {
            console.log("(no model prices match)");
            return;
        }
        console.log(`${"provider".padEnd(14)} ${"model".padEnd(36)} ${"in/M".padStart(8)} ${"out/M".padStart(8)} ${"cache/M".padStart(8)} ${"ctx".padStart(8)}  source`);
        for (const row of filtered) {
            console.log(
                `${String(row.provider ?? "").padEnd(14)} ` +
                `${String(row.name ?? "").slice(0, 36).padEnd(36)} ` +
                `${String(row.input_per_million_usd ?? "-").padStart(8)} ` +
                `${String(row.output_per_million_usd ?? "-").padStart(8)} ` +
                `${String(row.cache_read_per_million_usd ?? "-").padStart(8)} ` +
                `${String(row.context_window ?? "-").padStart(8)}  ` +
                `${String(row.pricing_source ?? "")}`,
            );
        }
    });

const pricingCommand = Command.make(
    "pricing",
    {
        query: Flag.string("query").pipe(Flag.optional),
        limit: positiveLimit(30),
        json: jsonFlag,
    },
    ({ query, limit, json }) =>
        cmdPricing({
            query: optionValue(query) ?? null,
            limit,
            json,
        }),
).pipe(Command.withDescription("Inspect imported model pricing rows"));

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
        "Cross-session text search (BM25). --sources=turn,commit,skill chooses record types (default turn). " +
        "--scope=here filters to the current repo (auto-detected); --scope=all overrides. " +
        "--project=? / --skill=? opens an interactive picker. " +
        "See the ax:extract-workflow skill for narrating workflows behind shipped artifacts.",
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

const classifyCommand = Command.make(
    "classify",
    {
        names: Argument.string("skill").pipe(Argument.variadic({ min: 0 })),
        outDir: Flag.string("out-dir").pipe(Flag.withDefault(".ax/tasks")),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ names, outDir, dryRun, json }) =>
        cmdSkillsClassify({
            names: [...names],
            outDir,
            dryRun,
            json,
        }),
).pipe(
    Command.withDescription(
        "Emit classify-brief task files for unclassified skills with ≥3 invocations. " +
        "With skill names: emit briefs for those specific skills (no threshold). " +
        "--out-dir=<path> (default .ax/tasks)  --dry-run  --json",
    ),
);

const tagCommand = Command.make(
    "tag",
    {
        skill: Argument.string("skill"),
        role: Argument.string("role"),
        confidence: Flag.float("confidence").pipe(Flag.withDefault(1.0)),
        rationale: Flag.string("rationale").pipe(Flag.optional),
        remove: Flag.boolean("remove").pipe(Flag.withDefault(false)),
    },
    ({ skill, role, confidence, rationale, remove }) =>
        cmdSkillsTag({
            skillName: skill,
            roleName: role,
            confidence,
            rationale: optionValue(rationale),
            remove,
        }).pipe(
            catchDbErrorAndExit("axctl skills tag"),
        ),
).pipe(
    Command.withDescription(
        "Manually assign a role to a skill (writes a plays_role edge with source=user). " +
        "Idempotent. Use --remove to delete an existing user-source edge. " +
        "--confidence=N (0–1, default 1.0)  --rationale=\"...\""
    ),
);

const skillsLintCommand = Command.make(
    "lint",
    {
        taskDir: Flag.string("task-dir").pipe(Flag.withDefault(".ax/tasks")),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ taskDir, dryRun, json }) =>
        cmdSkillsLint({ taskDir, dryRun, json }).pipe(
            catchDbErrorAndExit("axctl skills lint"),
        ),
).pipe(
    Command.withDescription(
        "Read filled classify briefs from --task-dir (default .ax/tasks) and write plays_role " +
        "edges with source=\"brief\". Removes applied brief files. " +
        "--dry-run  --json  --task-dir=<path>",
    ),
);

const weightedCommand = Command.make(
    "weighted",
    {
        window: Flag.integer("window").pipe(Flag.optional),
        limit: positiveLimit(25),
        doctorThreshold: Flag.integer("doctor-threshold").pipe(Flag.withDefault(5)),
        json: jsonFlag,
    },
    ({ window, limit, doctorThreshold, json }) =>
        cmdSkillsWeighted([
            `--limit=${limit}`,
            ...intArg("window", optionValue(window)),
            `--doctor-threshold=${doctorThreshold}`,
            ...boolArg("json", json),
        ]),
).pipe(
    Command.withDescription(
        "Rank skills by usage × role-weight (classified skills score higher). " +
        "Doctor mode warns when many skills are unclassified. " +
        "--window=Nd  --limit=N  --doctor-threshold=N  --json",
    ),
);

// P3.7: ax skills by-role <role>
const byRoleCommand = Command.make(
    "by-role",
    {
        role: Argument.string("role"),
        limit: positiveLimit(50),
        json: jsonFlag,
    },
    ({ role, limit, json }) =>
        cmdSkillsByRole([role, `--limit=${limit}`, ...boolArg("json", json)]),
).pipe(
    Command.withDescription(
        "List skills classified as <role>, ranked by invocations. " +
        "--limit=N  --json",
    ),
);

// P3.7: ax skills roles <skill>
const rolesForSkillCommand = Command.make(
    "roles",
    {
        skill: Argument.string("skill"),
        json: jsonFlag,
    },
    ({ skill, json }) => cmdRolesForSkill([skill, ...boolArg("json", json)]),
).pipe(
    Command.withDescription(
        "List all roles assigned to <skill>. Exit 2 if skill is unknown. --json",
    ),
);

const skillsCommand = Command.make("skills").pipe(
    Command.withDescription("Skill-graph queries: search, stats, usage, pairs, recovery, classify, tag, lint, weighted, by-role, roles"),
    Command.withSubcommands([
        searchCommand,
        statsCommand,
        recentCommand,
        unusedCommand,
        tasteCommand,
        weightedCommand,
        pairsCommand,
        recoveryCommand,
        classifyCommand,
        tagCommand,
        skillsLintCommand,
        byRoleCommand,
        rolesForSkillCommand,
    ]),
);

// P3.7: ax roles (top-level)
const rolesCommand = Command.make(
    "roles",
    { json: jsonFlag },
    ({ json }) => cmdRoles([...boolArg("json", json)]),
).pipe(
    Command.withDescription(
        "List all roles with skill counts (includes roles with 0 skills). " +
        "Role labels are semantic categories (framing, execution, verification...) tagged on skills via plays_role edges. " +
        "--json",
    ),
);

const shareCommand = Command.make(
    "share",
    {
        args: Argument.string("arg").pipe(Argument.variadic({ min: 0 })),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        open: Flag.boolean("open").pipe(Flag.withDefault(false)),
        public: Flag.boolean("public").pipe(Flag.withDefault(false)),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ args, dryRun, open, public: publicGist, yes }) =>
        Effect.promise(() =>
            cmdShare([
                ...args,
                ...boolArg("dry-run", dryRun),
                ...boolArg("open", open),
                ...boolArg("public", publicGist),
                ...boolArg("yes", yes),
            ]),
        ),
).pipe(
    Command.withDescription("Publish a redacted session share Gist"),
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
        classifiersCommand,
        sessionsCommand,
        improveCommand,
        retroCommand,
        serveCommand,
        reportCommand,
        costsGroupCommand,
        pricingCommand,
        recallCommand,
        shareCommand,
        skillsCommand,
        rolesCommand,
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
 * Provide IngestRuntimeLayer (AppLayer + StageRegistryDefault) for the
 * ingest command so the CLI handler can yield* StageRegistry.
 *
 * When `--debug` is present in argv, layer `ConsoleTransportLayer` on top
 * so trace events stream to **stderr**. Default (no --debug) keeps the
 * silent NoopTransport from AppLayer so stdout stays clean for
 * machine-readable output (e.g. `--progress=json`).
 */
const withIngest = (args: ReadonlyArray<string>): CliProgram => {
    const debug = args.includes("--debug");
    const layer = debug
        ? Layer.provideMerge(IngestRuntimeLayer, ConsoleTransportLayer)
        : IngestRuntimeLayer;
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
    "classifiers",
    "sessions",
    "improve",
    "retro",
    "report",
    "costs",
    "pricing",
    "recall",
    "skills",
    "roles",
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
    if (args[0] === "ingest") {
        // Effect's CLI parser silently ignores unknown flags, so the removed
        // `--*-only` flags would otherwise no-op into a full ingest. Reject
        // them up-front against raw argv before Effect strips them.
        const removed = detectRemovedIngestFlag(args.slice(1));
        if (removed) {
            console.error(
                `axctl ingest: ${removed.flag} was removed. Use ${removed.replacement} instead.`,
            );
            process.exit(2);
        }
        await Effect.runPromise(withIngest(args));
        return;
    }
    if (
        args[0] === "classifiers" &&
        ((args[1] === "package-operations" && (args.includes("--apply-write-plan") || args.includes("--graph-health"))) ||
            args[1] === "graph" ||
            args[1] === "lifecycle")
    ) {
        await Effect.runPromise(withDb(args));
        return;
    }
    if (args[0] === "classifiers" && (args[1] === "eval" || args[1] === "list" || args[1] === "package-operations")) {
        await Effect.runPromise(withoutDb(args));
        return;
    }
    if (args[0] === "share") {
        if (args[1] === "--help" || args[1] === "-h") {
            await Effect.runPromise(withoutDb(args));
            return;
        }
        await cmdShare(args.slice(1));
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
