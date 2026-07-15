// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, FileSystem, Option, Path } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import { SkillName } from "@ax/lib/brands";
import { AxConfig } from "@ax/lib/config";
import type { DbError } from "@ax/lib/errors";
import { findCommitWindow } from "@ax/lib/git-window";
import { prettyPrint } from "@ax/lib/json";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import { encodeClaudeProjectSlug } from "@ax/lib/transcript-locator";
import { detectStaleness } from "@ax/lib/transcript-staleness";
import { fetchSessionCompare } from "../../dashboard/session-compare.ts";
import { normalizeSessionViewInput } from "../../dashboard/session-view.ts";
import { fetchEnrichedSession } from "../../queries/enriched-session.ts";
import {
    listSessionsHere,
    listSessionsAround,
    listSessionsNear,
    findSessionIdsByPrefix,
    normalizeSessionsAroundOpts,
    type SessionRow,
} from "../../dashboard/sessions-query.ts";
import { ingestTranscripts } from "../../ingest/transcripts.ts";
import {
    AGGREGATE_LEGEND,
    GROUP_BY_KEYS,
    aggregateGroups,
    applyAggregateFilters,
    computeSkillEfficacy,
    fetchAggregateRows,
    fetchSkillSessionSet,
    formatGroupAggregates,
    formatSkillEfficacy,
    type GroupByKey,
} from "../../metrics/aggregates.ts";
import { fetchSessionDurabilityDetail } from "../../metrics/reverted-commits.ts";
import { fetchSessionChurnSummary, formatSessionChurnSummary } from "../../metrics/session-churn.ts";
import { fetchSessionMetrics } from "../../metrics/session-metrics-query.ts";
import { formatSessionMetrics, SESSION_METRICS_LEGEND } from "../../metrics/util.ts";
import { buildSessionsNext, buildSessionShowNext } from "../../nav/next-links.ts";
import { resolveStudioTarget } from "../../dashboard/serve-instance.ts";
import { resolvePwdRepository, type PwdResolution } from "../../pwd.ts";
import { printNextLinks } from "../next-format.ts";
import { catchDbErrorAndExit, stderrExit, wantsJsonFlag } from "../output.ts";
import { renderCompareTable, renderCompareJson } from "../session-compare-format.ts";
import { renderSessionMarkdown, renderSessionJson } from "../session-show-format.ts";
import type { RuntimeManifest } from "./manifest.ts";
import {
    fail,
    jsonFlag,
    optionalSince,
    optionValue,
    positiveLimit,
    requireOptionalPositiveInt,
    requirePositiveInt,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// ax sessions - windowed session queries (F2, F3)
// ---------------------------------------------------------------------------

export const projectRootForHere = (
    pwd: Pick<PwdResolution, "repoRoot" | "mainRepoRoot">,
): string => {
    const { repoRoot, mainRepoRoot } = pwd;
    if (!mainRepoRoot || mainRepoRoot === repoRoot) return repoRoot;
    // `sessionProjectClause` filters by cwd path-prefix, so rolling `--here` up
    // to the primary checkout only works when this worktree physically lives
    // under it (the common `.claude/worktrees/*` layout). An external/bare
    // worktree - or a mis-derived `--git-common-dir` (submodule `.git/modules/*`
    // etc.) - keeps its own root, otherwise its sessions would be silently
    // filtered out of `sessions metrics/churn --here`.
    const prefix = mainRepoRoot.endsWith("/") ? mainRepoRoot : `${mainRepoRoot}/`;
    return repoRoot.startsWith(prefix) ? mainRepoRoot : repoRoot;
};

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
        // Floor the summary at 60 chars: on narrow terminals the column math
        // left ~9 chars ("You are r"), making the listing useless for id
        // resolution (dogfood retro R2). Wrapping beats unreadable.
        const summaryWidth = Math.max(60, termWidth - 26 - 1 - 18 - 1 - 16 - 1 - 20 - 1 - 5 - 2);
        const summary = msg.slice(0, summaryWidth);
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

/**
 * Hard ceiling on the convenience auto-backfill in `maybeAutoIngestStale`.
 * Past this the backfill is interrupted and the query proceeds with whatever
 * is already ingested - the read must never be held hostage by ingest.
 */
const AUTO_BACKFILL_TIMEOUT_SECONDS = 20;

interface StaleCheckOpts {
    readonly noStaleCheck: boolean;
    readonly staleThreshold: number | undefined;
}

const maybeAutoIngestStale = (
    cmdLabel: string,
    repoRoot: string,
    opts: StaleCheckOpts,
): Effect.Effect<void, DbError, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (opts.noStaleCheck) return;
        const threshold =
            requireOptionalPositiveInt(cmdLabel, "stale-threshold", opts.staleThreshold)
                ?? STALE_THRESHOLD_DEFAULT;

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
            // A genuine FS failure during auto-backfill (the vanished-file
            // case is already caught+skipped inside ingestTranscripts) dies as
            // a defect rather than masquerading as a recoverable DbError.
            //
            // Timebox it: the backfill is a convenience, not the point of the
            // command. If the DB is busy (e.g. the ax-watch daemon is mid-ingest
            // of a large live transcript) an unbounded backfill would hang the
            // whole query indefinitely. On timeout we interrupt it and fall
            // through to the read with possibly-stale data, telling the user how
            // to finish the backfill explicitly.
            const outcome = yield* ingestTranscripts({ project, sinceDays: 7 }).pipe(
                Effect.catchTag("PlatformError", (e) => Effect.die(e)),
                Effect.timeoutOption(`${AUTO_BACKFILL_TIMEOUT_SECONDS} seconds`),
            );
            if (Option.isNone(outcome)) {
                process.stderr.write(
                    `axctl ${cmdLabel}: auto-backfill exceeded ${AUTO_BACKFILL_TIMEOUT_SECONDS}s and was cancelled; ` +
                        `showing possibly-stale results. Run \`axctl ingest here --since=7\` to finish, ` +
                        `or pass --no-stale-check to skip this check.\n`,
                );
            }
        } else {
            process.stderr.write(
                `axctl ${cmdLabel}: ${report.newFiles.length} new transcript(s) on disk not yet ingested ` +
                    `(threshold=${threshold}). Run \`axctl ingest here --since=7\` to backfill, ` +
                    `or pass --no-stale-check to suppress this warning.\n`,
            );
        }
    });

interface SessionsHereInput {
    readonly days: number;
    readonly limit: number | undefined;
    readonly includeSubagents: boolean;
    readonly json: boolean;
    readonly staleCheck: StaleCheckOpts;
}

const cmdSessionsHere = (input: SessionsHereInput) =>
    Effect.gen(function* () {
        const days = requirePositiveInt("sessions here", "days", input.days);
        const json = wantsJsonFlag(input.json);
        const includeSubagents = input.includeSubagents;
        const limit = input.limit === undefined
            ? null
            : requirePositiveInt("sessions here", "limit", input.limit);

        const pwdResolution = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                stderrExit(`axctl sessions here: not in a git repository (cwd=${err.cwd})\n`, 2),
            ),
        );

        const repositoryKey = pwdResolution.repositoryRecordId.id as string;
        yield* maybeAutoIngestStale("sessions here", pwdResolution.repoRoot, input.staleCheck);
        const allRows = yield* listSessionsHere({ repositoryKey, days });

        // claude-subagent sessions are orchestrated children and routinely
        // outnumber real sessions by 10x+; hide them by default (mirrors
        // `retro pending`). --include-subagents restores them. (#178)
        const visible = includeSubagents
            ? allRows
            : allRows.filter((r) => r.source !== "claude-subagent");
        const hiddenSubagents = allRows.length - visible.length;
        const rows = limit === null ? visible : visible.slice(0, limit);
        const studio = yield* Effect.promise(() => resolveStudioTarget());
        const { sessions, next } = buildSessionsNext(rows, { studio });

        if (json) {
            console.log(prettyPrint({ sessions, next }));
            return;
        }
        printNextLinks(next);
        console.log(formatSessionsTable(rows));
        const notes: string[] = [];
        if (hiddenSubagents > 0) {
            notes.push(`${hiddenSubagents} subagent session(s) hidden - pass --include-subagents to show`);
        }
        if (limit !== null && visible.length > rows.length) {
            notes.push(`showing ${rows.length} of ${visible.length} - raise --limit`);
        }
        if (notes.length > 0) console.log(`(${notes.join("; ")})`);
    });

// --- sessions around ---

const cmdSessionsAround = (input: {
    readonly date: string;
    readonly days: number;
    readonly project: string | undefined;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        // Required Argument.string("date") makes the old missing-date guard unreachable.
        const positional = input.date;
        // Parse date: YYYY-MM-DD or full ISO8601. Require the YYYY-MM-DD
        // prefix explicitly - a bare `new Date(positional)` accepts junk like
        // "1" (V8 parses it as year 2001), silently querying an empty window
        // instead of erroring.
        let date: Date;
        if (/^\d{4}-\d{2}-\d{2}$/.test(positional)) {
            date = new Date(`${positional}T00:00:00.000Z`);
        } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(positional)) {
            date = new Date(positional);
        } else {
            fail(`axctl sessions around: invalid date "${positional}" (expected YYYY-MM-DD or ISO8601)`);
        }
        if (isNaN(date.getTime())) {
            fail(`axctl sessions around: invalid date "${positional}" (expected YYYY-MM-DD or ISO8601)`);
        }

        const days = requirePositiveInt("sessions around", "days", input.days);
        const json = wantsJsonFlag(input.json);
        const projectRaw = input.project;
        // Resolve --project: accept encoded slug or absolute path
        let project: string | null = null;
        if (projectRaw) {
            project = projectRaw.startsWith("/")
                ? encodeClaudeProjectSlug(projectRaw)
                : projectRaw;
        }

        const rows = yield* listSessionsAround(
            normalizeSessionsAroundOpts({ date, days, project }),
        );
        const studio = yield* Effect.promise(() => resolveStudioTarget());
        const { sessions, next } = buildSessionsNext(rows, {
            date: positional,
            days,
            project,
            studio,
        });

        if (json) {
            console.log(prettyPrint({ sessions, next }));
            return;
        }
        printNextLinks(next);
        console.log(formatSessionsTable(rows));
    });

// --- sessions near ---

const cmdSessionsNear = (input: {
    readonly sha: string;
    readonly json: boolean;
    readonly staleCheck: StaleCheckOpts;
}) =>
    Effect.gen(function* () {
        // Required Argument.string("sha") makes the old missing-sha guard unreachable.
        const sha = input.sha;
        const json = wantsJsonFlag(input.json);

        // Resolve repository via pwd (near is always pwd-scoped)
        const pwdResolution = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                stderrExit(`axctl sessions near: not in a git repository (cwd=${err.cwd})\n`, 2),
            ),
        );

        const repoRoot = pwdResolution.repoRoot;
        const repositoryKey = pwdResolution.repositoryRecordId.id as string;

        yield* maybeAutoIngestStale("sessions near", repoRoot, input.staleCheck);

        // Resolve commit window
        const window = yield* findCommitWindow(repoRoot, sha).pipe(
            Effect.catchTag("ProcessError", () =>
                Effect.sync(() => {
                    fail(`axctl sessions near: unknown sha ${sha}`);
                    return { kind: "not_found" as const };
                }),
            ),
        );

        if (window.kind === "not_found") {
            fail(`axctl sessions near: unknown sha ${sha}`);
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
        const studio = yield* Effect.promise(() => resolveStudioTarget());
        const { sessions, next } = buildSessionsNext(rows, { studio });

        if (json) {
            console.log(prettyPrint({ sessions, next }));
            return;
        }
        printNextLinks(next);
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
const cmdSessionShow = (input: {
    readonly id: string;
    readonly expand: ReadonlyArray<string>;
    readonly all: boolean;
    readonly byRole: boolean;
    readonly turns: boolean | "full";
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        // Required Argument.string("id") makes the old missing-id guard unreachable.
        const sessionId = input.id;

        const useJson = wantsJsonFlag(input.json);

        // The Enriched Session facade (`fetchEnrichedSession`) is the single
        // home for assembling a session's read model. The CLI base is the full
        // Session View (expand + by-role + compactions). Metrics are fetched in
        // a distinct step below rather than via `includeMetrics`, because the
        // durability drill-down must run against the prefix-RESOLVED id; folding
        // it into this probe would re-issue it on the unresolved id and add a
        // query (the `ax sessions` hang guard - each caller keeps its exact
        // query set). `includeInsights` stays off: the CLI never fetched them.
        let resolvedId = sessionId;
        const viewBase = {
            kind: "view",
            ...normalizeSessionViewInput({
                expand: input.expand,
                expandAll: input.all,
                byRole: input.byRole,
                turns: input.turns,
            }),
        } as const;
        let enriched = yield* fetchEnrichedSession({
            sessionId,
            base: viewBase,
        }).pipe(
            catchDbErrorAndExit("axctl session show"),
        );
        let payload = enriched.view!;

        // Prefix fallback: agents paste the short ids shown in listings
        // (dogfood retro R2). Unambiguous prefix → resolve + proceed;
        // ambiguous → list candidates; no match → teach the lookup path.
        if (payload.session.overview === null && sessionId.length >= 4) {
            const candidates = yield* findSessionIdsByPrefix(sessionId).pipe(
                catchDbErrorAndExit("axctl session show"),
            );
            if (candidates.length === 1) {
                resolvedId = candidates[0]!;
                process.stderr.write(`resolved id prefix ${sessionId} → ${resolvedId}\n`);
                enriched = yield* fetchEnrichedSession({
                    sessionId: resolvedId,
                    base: viewBase,
                }).pipe(catchDbErrorAndExit("axctl session show"));
                payload = enriched.view!;
            } else if (candidates.length > 1) {
                process.stderr.write(
                    `session id prefix "${sessionId}" is ambiguous:\n` +
                        candidates.map((c) => `  ax sessions show ${c}`).join("\n") +
                        "\n",
                );
                process.exit(1);
            }
        }

        if (payload.session.overview === null) {
            process.stderr.write(
                `session ${sessionId} not found. Find the full id with ` +
                    "`ax recall \"<query>\"` or `ax sessions here --days=7`.\n",
            );
            process.exit(1);
        }

        // #176: durability drill-down - the commits behind durability_ratio
        // (reverted commits + their later_fixed_by fix chains). Bounded to this
        // session's produced edges; null only when the id fails validation
        // (already excluded above by the not-found check).
        const metrics = yield* fetchSessionDurabilityDetail(resolvedId).pipe(
            catchDbErrorAndExit("axctl session show"),
        );

        const studio = yield* Effect.promise(() => resolveStudioTarget());
        const next = buildSessionShowNext(payload, studio);

        if (useJson) {
            console.log(renderSessionJson(payload, { metrics, next }));
        } else {
            printNextLinks(next);
            console.log(renderSessionMarkdown(payload, { metrics, next }));
        }
    });

export const sessionTurnsFlag = Flag.choice("turns", ["full"] as const).pipe(
    Flag.withMetavar("[=full]"),
    Flag.orElse(() => Flag.boolean("turns")),
);

/** Exported for the help-copy test: keeps the advertised flag forms
 *  (`--turns`, `--turns=full`) asserted without spawning the CLI. */
export const SESSION_SHOW_DESCRIPTION =
    "Display a session's timeline (tool calls + subagent spawns) plus a Metrics " +
    "block showing the commits behind durability_ratio (reverted commits + the " +
    "commits that fixed them). " +
    "--expand=<uuid> (repeatable) or --all expands subagent timelines inline. " +
    "--by-role groups the Top skills section by role. " +
    "--turns includes normalized cross-harness excerpts; --turns=full includes full text. " +
    "Auto markdown on TTY, JSON when piped. --json forces JSON. " +
    "Output ends with a `next:` footer of copy-paste follow-up commands (resume in harness, open parent, expand subagents).";

const sessionShowCommand = Command.make(
    "show",
    {
        id: Argument.string("id"),
        expand: Flag.string("expand").pipe(Flag.atLeast(0)),
        all: Flag.boolean("all").pipe(Flag.withDefault(false)),
        byRole: Flag.boolean("by-role").pipe(Flag.withDefault(false)),
        turns: sessionTurnsFlag,
        json: jsonFlag,
    },
    ({ id, expand, all, byRole, turns, json }) =>
        cmdSessionShow({ id, expand, all, byRole, turns, json }),
).pipe(
    Command.withDescription(SESSION_SHOW_DESCRIPTION),
);

// Effect/CLI Command definitions for sessions subcommands

// Shared opt-out flags for the auto-backfill that `here`/`near` run before
// reading. `maybeAutoIngestStale` receives them as a typed StaleCheckOpts;
// they must be declared on the Command or the CLI parser rejects them as
// unrecognized (the documented `--no-stale-check` escape hatch was previously
// dead for exactly this reason).
const noStaleCheckFlag = Flag.boolean("no-stale-check").pipe(Flag.withDefault(false));
const staleThresholdFlag = Flag.integer("stale-threshold").pipe(Flag.optional);

const sessionsHereCommand = Command.make(
    "here",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
        limit: Flag.integer("limit").pipe(Flag.optional),
        includeSubagents: Flag.boolean("include-subagents").pipe(Flag.withDefault(false)),
        json: jsonFlag,
        noStaleCheck: noStaleCheckFlag,
        staleThreshold: staleThresholdFlag,
    },
    ({ days, limit, includeSubagents, json, noStaleCheck, staleThreshold }) =>
        cmdSessionsHere({
            days,
            limit: optionValue(limit),
            includeSubagents,
            json,
            staleCheck: { noStaleCheck, staleThreshold: optionValue(staleThreshold) },
        }),
).pipe(Command.withDescription(
    "List sessions for the current git repository (default: last 14 days). "
    + "Subagent (claude-subagent) sessions are hidden by default - --include-subagents shows them; "
    + "--limit N caps the rows printed. "
    + "Output ends with a `next:` footer of copy-paste follow-up commands (drill-in, harness resume); --json carries the same links as a {sessions, next} envelope.",
));

const sessionsAroundCommand = Command.make(
    "around",
    {
        date: Argument.string("date"),
        days: Flag.integer("days").pipe(Flag.withDefault(3)),
        project: Flag.string("project").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ date, days, project, json }) =>
        cmdSessionsAround({
            date,
            days,
            project: optionValue(project),
            json,
        }),
).pipe(Command.withDescription(
    "List sessions in a ±N-day window around a date (YYYY-MM-DD or ISO8601). "
    + "Output ends with a `next:` footer of copy-paste follow-up commands (drill-in, harness resume); --json carries the same links as a {sessions, next} envelope.",
));

const sessionsNearCommand = Command.make(
    "near",
    {
        sha: Argument.string("sha"),
        json: jsonFlag,
        noStaleCheck: noStaleCheckFlag,
        staleThreshold: staleThresholdFlag,
    },
    ({ sha, json, noStaleCheck, staleThreshold }) =>
        cmdSessionsNear({
            sha,
            json,
            staleCheck: { noStaleCheck, staleThreshold: optionValue(staleThreshold) },
        }),
).pipe(Command.withDescription(
    "List sessions that overlapped with a git commit window (from the predecessor commit's timestamp to this commit's timestamp). " +
    "Pass a full or short SHA. Must be inside the target git repo. " +
    "See the ax:extract-workflow skill for narrating workflows around a sha. " +
    "Output ends with a `next:` footer of copy-paste follow-up commands; --json carries the same links as a {sessions, next} envelope.",
));

// ---------------------------------------------------------------------------
// ax sessions compare <idA> <idB> [...] - side-by-side run comparison (P0)
// ---------------------------------------------------------------------------

/**
 * `ax sessions compare <idA> <idB> [<idC> ...] [--json]`
 *
 * Lines up 2+ sessions on headline metrics (duration, tokens, cost, turns,
 * errors, corrections, commits) and stars the winner per ranked axis. Answers
 * "same task, which run was faster / cheaper / cleaner?". --turns adds an
 * index-aligned per-turn appendix (tokens/gap per turn). Auto table on TTY,
 * --json (or piped) for machine output.
 *
 * Duration / gap are wall-clock; transcripts carry no model latency.
 */
const cmdSessionsCompare = (input: {
    readonly ids: ReadonlyArray<string>;
    readonly turns: boolean;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        // Argument.variadic({ min: 2 }) makes the old "< 2 ids" guard
        // unreachable; the post-fetch length check below stays (unknown ids
        // can still resolve to fewer than 2 sessions).
        const ids = input.ids;
        const useJson = wantsJsonFlag(input.json);
        const includeTurns = input.turns;
        const payload = yield* fetchSessionCompare(ids, { includeTurns }).pipe(
            catchDbErrorAndExit("axctl sessions compare"),
        );

        if (payload.sessions.length < 2) {
            process.stderr.write(
                `axctl sessions compare: resolved only ${payload.sessions.length} session(s); need 2+. ` +
                    `not found: ${payload.not_found.join(", ") || "(none)"}\n`,
            );
            process.exit(1);
        }

        if (useJson) {
            console.log(renderCompareJson(payload));
        } else {
            console.log(renderCompareTable(payload));
        }
    });

const sessionsCompareCommand = Command.make(
    "compare",
    {
        ids: Argument.string("ids").pipe(Argument.variadic({ min: 2 })),
        turns: Flag.boolean("turns").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ ids, turns, json }) => cmdSessionsCompare({ ids, turns, json }),
).pipe(
    Command.withDescription(
        "Compare 2+ sessions side by side (duration, tokens, cost, turns, errors, " +
        "corrections, commits). Stars the winner per axis - answers which run was " +
        "faster / cheaper / cleaner. --turns adds a per-turn appendix. " +
        "Auto table on TTY, --json for machine output.",
    ),
);

// ---------------------------------------------------------------------------
// ax sessions metrics - graph-derived per-session metrics listing
// ---------------------------------------------------------------------------

// Table formatting (metricPct/metricMs/formatSessionMetrics + legend) lives in
// ../metrics/util.ts so the pure helpers stay unit-testable.

const cmdSessionsMetrics = (input: {
    readonly sinceDays: number | null;
    readonly project: string | null;
    readonly here: boolean;
    readonly limit: number;
    readonly fullIds: boolean;
    readonly json: boolean;
    readonly groupBy: GroupByKey | null;
    readonly skill: string | null;
    readonly source: string | null;
    readonly minCost: number | null;
}) =>
    Effect.gen(function* () {
        // --group-by values are validated by Flag.choice (GROUP_BY_KEYS).
        const groupBy = input.groupBy;
        if (groupBy !== null && input.skill !== null) {
            fail("axctl sessions metrics: --group-by and --skill are exclusive (--skill is its own with/without comparison).");
        }
        const aggregateMode = groupBy !== null || input.skill !== null;
        if (!aggregateMode && (input.source !== null || input.minCost !== null)) {
            fail("axctl sessions metrics: --source/--min-cost filter the aggregate scan; combine them with --group-by or --skill.");
        }
        let project = input.project;
        if (input.here) {
            const pwd = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (err) =>
                    stderrExit(`axctl sessions metrics: --here requires a git repository (cwd=${err.cwd})\n`, 2),
                ),
            );
            project = projectRootForHere(pwd);
        }
        const since = input.sinceDays === null
            ? null
            : new Date(Date.now() - Math.min(Math.max(Math.trunc(input.sinceDays), 1), 3650) * 86400 * 1000);

        if (aggregateMode) {
            // Aggregates join the STORED session_metrics scalars (one bounded
            // scan + JS group-by, issue #177) - never per-edge derefs over the
            // ~87k-edge invoked/edited graph (docs/metrics.md + ADR-0011).
            const all = yield* fetchAggregateRows({ since, project });
            const rows = applyAggregateFilters(all, { source: input.source, minCostUsd: input.minCost });
            if (input.skill !== null) {
                // CLI flag is a user-supplied skill name: brand at the input
                // boundary via the schema constructor.
                const skillSessions = yield* fetchSkillSessionSet(SkillName.make(input.skill));
                const efficacy = computeSkillEfficacy(rows, skillSessions, input.skill);
                if (input.json) {
                    console.log(prettyPrint(efficacy));
                    return;
                }
                console.log(formatSkillEfficacy(efficacy));
            } else if (groupBy !== null) {
                const groups = aggregateGroups(rows, groupBy, input.limit);
                if (input.json) {
                    console.log(prettyPrint(groups));
                    return;
                }
                console.log(formatGroupAggregates(groups, groupBy));
            }
            if (process.stdout.isTTY) {
                console.log(`\n${AGGREGATE_LEGEND}`);
            }
            return;
        }

        const rows = yield* fetchSessionMetrics({ since, limit: input.limit, project });
        if (input.json) {
            console.log(prettyPrint(rows));
            return;
        }
        console.log(formatSessionMetrics(rows, { fullIds: input.fullIds }));
        // Column names alone are too terse (dogfood finding #178); explain them
        // on interactive output only - piped consumers get just the table.
        if (rows.length > 0 && process.stdout.isTTY) {
            console.log(`\n${SESSION_METRICS_LEGEND}`);
        }
    });

const sessionsMetricsCommand = Command.make(
    "metrics",
    {
        since: optionalSince,
        project: Flag.string("project").pipe(Flag.optional),
        here: Flag.boolean("here").pipe(Flag.withDefault(false)),
        limit: positiveLimit(50),
        fullIds: Flag.boolean("full-ids").pipe(Flag.withDefault(false)),
        json: jsonFlag,
        groupBy: Flag.choice("group-by", GROUP_BY_KEYS).pipe(Flag.optional),
        skill: Flag.string("skill").pipe(Flag.optional),
        source: Flag.string("source").pipe(Flag.optional),
        minCost: Flag.float("min-cost").pipe(Flag.optional),
    },
    ({ since, project, here, limit, fullIds, json, groupBy, skill, source, minCost }) =>
        cmdSessionsMetrics({
            sinceDays: optionValue(since) ?? null,
            project: optionValue(project) ?? null,
            here,
            limit,
            fullIds,
            json,
            groupBy: optionValue(groupBy) ?? null,
            skill: optionValue(skill) ?? null,
            source: optionValue(source) ?? null,
            minCost: optionValue(minCost) ?? null,
        }),
).pipe(Command.withDescription(
    "Graph-derived per-session metrics: durab (commits not later reverted / produced), "
    + "land (first commit→PR merge; squash merges legitimately land at ~0 → \"<1m\"), lines added/removed, "
    + "1st-edit (session start→first Edit/Write), reads (Read/Grep/Glob before first edit), "
    + "deleg% (subagent-produced commits / all). Sorted by produced commits, then most fragile first. "
    + "--here scopes to the pwd repo, --since N days, --full-ids prints untruncated session ids "
    + "(feed into `ax sessions show` / `compare`), --json for machine output. "
    + "Aggregates: --group-by=model|repo|source|week folds sessions into per-group durability/commit/"
    + "correction/cost rollups (week = ISO-week trend, oldest→newest); --skill=<name> compares sessions "
    + "that invoked the skill vs not (skill_durability_efficacy). --source=<provider> and --min-cost=<usd> "
    + "filter the aggregate scan; --limit caps groups. "
    + "See `ax signals` for cross-session relation signals (e.g. fragility cascades).",
));

// ---------------------------------------------------------------------------
// ax sessions churn - verification failures plus repair/edit churn
// ---------------------------------------------------------------------------

export const cmdSessionsChurn = (input: {
    readonly sinceDays: number | null;
    readonly project: string | null;
    readonly here: boolean;
    readonly source: string | null;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        let project = input.project;
        if (input.here) {
            const pwd = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (err) =>
                    stderrExit(`axctl sessions churn: --here requires a git repository (cwd=${err.cwd})\n`, 2),
                ),
            );
            project = projectRootForHere(pwd);
        }

        // Default window keeps the all-session fan-out bounded on mature DBs;
        // pass a larger --since (up to 3650) for deeper history.
        const sinceDays = input.sinceDays ?? 30;
        const since = new Date(Date.now() - Math.min(Math.max(Math.trunc(sinceDays), 1), 3650) * 86400 * 1000);

        const summary = yield* fetchSessionChurnSummary({
            since,
            project,
            source: input.source,
            limit: input.limit,
        });
        if (input.json) {
            console.log(prettyPrint(summary));
            return;
        }
        console.log(formatSessionChurnSummary(summary));
    });

export const sessionsChurnCommand = Command.make(
    "churn",
    {
        since: optionalSince,
        project: Flag.string("project").pipe(Flag.optional),
        here: Flag.boolean("here").pipe(Flag.withDefault(false)),
        source: Flag.string("source").pipe(Flag.optional),
        limit: positiveLimit(20),
        json: jsonFlag,
    },
    ({ since, project, here, source, limit, json }) =>
        cmdSessionsChurn({
            sinceDays: optionValue(since) ?? null,
            project: optionValue(project) ?? null,
            here,
            source: optionValue(source) ?? null,
            limit,
            json,
        }),
).pipe(Command.withDescription(
    "Summarize verification churn by session/source: edit LOC, landed LOC, failed/passed checks, "
    + "episodes opened by failures after edits, and repair LOC before passes. "
    + "--here scopes to the pwd repo, --project filters session.project/cwd, --source filters provider, "
    + "--since N days (default 30, max 3650), --limit caps hot sessions, --json for machine output.",
));

export const sessionsCommand = Command.make("sessions").pipe(
    Command.withDescription("Windowed session queries: here (pwd-repo), around (date), near (sha), show (detail), compare (side-by-side), metrics (graph-derived), churn (verification repair churn)"),
    Command.withSubcommands([
        sessionsHereCommand,
        sessionsAroundCommand,
        sessionsNearCommand,
        sessionShowCommand,
        sessionsCompareCommand,
        sessionsMetricsCommand,
        sessionsChurnCommand,
    ]),
);

export const sessionsRuntime: RuntimeManifest = {
    sessions: "db",
};
