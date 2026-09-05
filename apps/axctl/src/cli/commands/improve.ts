// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Judgment } from "@ax/lib/sqlite";
import { prettyPrint } from "@ax/lib/json";
import { decodeJsonOrNull } from "@ax/lib/decode";
import { homedir } from "node:os";
import { deriveCheckpoints, type DeriveCheckpointsStats } from "../../ingest/derive-checkpoints.ts";
import { runAgentAccept } from "../../improve/agent-accept.ts";
import { acceptProposal, rejectProposal, setVerdict } from "../../improve/actions.ts";
import { lintFiles } from "../../improve/lint.ts";
import { listProposals, normalizeListProposalsInput, type ProposalRow } from "../../improve/list.ts";
import { recommend, normalizeRecommendInput, formatRecommendations, copyToClipboard, selectByIndices, parseIndexInput } from "../../improve/recommend.ts";
import { showExperiment, formatShow } from "../../improve/show.ts";
import { listVerdicts, showVerdict } from "../../improve/verdicts.ts";
import { renderAnalyzeBrief } from "../../improve/analyze-brief.ts";
import { runPropose } from "../../improve/propose.ts";
import { runHousekeep } from "../../improve/housekeep.ts";
import { buildImproveProposalsNext } from "../../nav/next-links.ts";
import { printNextLinks } from "../next-format.ts";
import { compactPrint } from "../render.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue, parseFileHints, positiveLimit, requireOptionalPositiveInt, requirePositiveInt } from "./shared.ts";

class ImproveProposeJsonError extends Schema.TaggedErrorClass<ImproveProposeJsonError>(
    "ImproveProposeJsonError",
)("ImproveProposeJsonError", {
    source: Schema.String,
    message: Schema.String,
}) {}

/**
 * axctl improve - surface the experiment-loop proposal shortlist.
 * Phase C2 ships read-only `list` + `show`. accept/reject/verdict land in
 * C3/C4/C8 with the scaffold-on-accept fix that closes the
 * manual-step-dropout problem the adversarial review flagged.
 */
const formatProposalLine = (row: ProposalRow): string => {
    const freq = String(row.frequency).padStart(6);
    const conf = (row.confidence ?? "").padEnd(6);
    const status = (row.status ?? "").padEnd(10);
    const form = (row.form ?? "").padEnd(11);
    const sig = (row.dedupe_sig ?? "").padEnd(24);
    return `${freq}  ${conf}  ${status}  ${form}  ${sig}  ${row.title}`;
};

const cmdImproveList = (input: {
    readonly limit: number;
    readonly form: string | undefined;
    readonly status: string | undefined;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const json = input.json;
        // Transport-local validation (exit 2 with usage wording) stays here; the
        // status default + presence rules come from the shared normalizer.
        const limit = requirePositiveInt("improve list", "limit", input.limit);
        const rows = yield* listProposals(
            normalizeListProposalsInput({
                ...(input.status !== undefined ? { status: input.status } : {}),
                ...(input.form !== undefined ? { form: input.form } : {}),
                limit,
            }),
        );
        if (json) {
            console.log(prettyPrint(rows));
            return;
        }
        const improveNext = buildImproveProposalsNext(
            rows.map((r) => ({ sig: r.dedupe_sig, title: r.title })),
        );
        if (rows.length === 0) {
            console.log("(no proposals match filter)");
            printNextLinks(improveNext);
            return;
        }
        printNextLinks(improveNext);
        console.log(`  freq  conf    status      form         dedupe_sig                title`);
        for (const row of rows) console.log(formatProposalLine(row));
    });

const cmdImproveShow = (input: {
    readonly id: string;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const json = input.json;
        const positional = input.id;
        // id is required by Argument.string("id"); the old missing-id guard is unreachable.
        const result = yield* showExperiment({ sigOrId: positional });
        if (json) {
            console.log(prettyPrint(result));
            return;
        }
        if (result === null) {
            fail(`no proposal matched ${positional}`);
        }
        console.log(formatShow(result));
    });

const cmdImproveLint = (input: {
    readonly roots: ReadonlyArray<string>;
    readonly json: boolean;
    readonly staleDays: number;
}) =>
    Effect.gen(function* () {
        const json = input.json;
        const staleDays = requirePositiveInt("improve lint", "stale-days", input.staleDays);
        const roots = input.roots;
        const report = yield* lintFiles({
            ...(roots.length > 0 ? { roots } : {}),
            staleDays,
        });
        if (json) {
            console.log(prettyPrint(report));
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

const cmdImproveRecommend = (input: {
    readonly limit: number;
    readonly forms: ReadonlyArray<string>;
    readonly sinceDays: number | undefined;
    readonly json: boolean;
    readonly noClipboard: boolean;
    readonly apply: boolean;
}) =>
    Effect.gen(function* () {
        const json = input.json;
        const noClipboard = input.noClipboard;
        const apply = input.apply;
        const limit = requirePositiveInt("improve recommend", "limit", input.limit);
        const sinceDays = requireOptionalPositiveInt("improve recommend", "since", input.sinceDays);
        const forms = input.forms.flatMap((v) => parseFileHints(Option.some(v)));
        // Validation (exit 2) stays here; the CLI limit default is 5 (MCP's is
        // 10), both passed into the shared normalizer so the constructed input
        // shape cannot drift between transports.
        const items = yield* recommend(
            normalizeRecommendInput(
                {
                    limit,
                    ...(forms.length > 0 ? { forms } : {}),
                    ...(sinceDays === undefined ? {} : { sinceDays }),
                },
                5,
            ),
        );
        if (json) {
            console.log(prettyPrint(items));
            return;
        }
        printNextLinks(
            buildImproveProposalsNext(
                items.map((i) => ({ sig: i.shortId, title: i.title })),
            ),
        );
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
            const answer = yield* Effect.promise(
                () =>
                    new Promise<string>((resolve) => {
                        process.stdin.once("data", (b) => {
                            resolve(b.toString().trim());
                            process.stdin.pause();
                        });
                        process.stdin.resume();
                    }),
            );
            const picked = selectByIndices(items, parseIndexInput(answer, items.length));
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
        json: jsonFlag,
        noClipboard: Flag.boolean("no-clipboard").pipe(Flag.withDefault(false)),
        apply: Flag.boolean("apply").pipe(
            Flag.withDefault(false),
            Flag.withDescription("Interactive: pick a proposal from the printed list and accept inline (loops until you quit). Combine with --with-agent on the accept side via the prompt."),
        ),
    },
    ({ limit, form, since, json, noClipboard, apply }) =>
        cmdImproveRecommend({
            limit,
            forms: form,
            sinceDays: optionValue(since),
            json,
            noClipboard,
            apply,
        }),
).pipe(Command.withDescription("Rank open proposals by confidence × recency × frequency and print the top N as paste-ready blocks (with `<!--ax:id-->` provenance markers). --apply for interactive accept loop."));

const improveLintCommand = Command.make(
    "lint",
    {
        root: Flag.string("root").pipe(Flag.atLeast(0)),
        json: jsonFlag,
        staleDays: Flag.integer("stale-days").pipe(Flag.withDefault(7)),
    },
    ({ root, json, staleDays }) =>
        cmdImproveLint({
            roots: root,
            json,
            staleDays,
        }),
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
        cmdImproveList({
            limit,
            form: optionValue(form),
            status: optionValue(status),
            json,
        }),
).pipe(Command.withDescription("List open experiment-loop proposals (ranked by frequency)"));

const improveShowCommand = Command.make(
    "show",
    {
        id: Argument.string("id"),
        json: jsonFlag,
    },
    ({ id, json }) => cmdImproveShow({ id, json }),
).pipe(Command.withDescription("Show experiment evidence + status for one proposal id"));

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
                fail(result.message ?? `no proposal matched ${id}`);
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
            if (result.status === "verdict_locked") {
                // The brief may be on disk, but the experiment was judged and
                // must not be moved - never print this as an emitted task.
                console.error(result.message ?? "experiment verdict already locked");
                process.exit(2);
            }
            if (result.status === "unsupported_form") {
                fail(result.message ?? "unsupported form");
            }
            if (result.status === "missing_payload") {
                fail(result.message ?? "missing payload");
            }
            if (result.status === "scaffold_exists") {
                fail(result.message ?? "scaffold already exists (use --force to overwrite)");
            }

            // status === "ok"
            // Set only when this run finished an interrupted publication.
            if (result.message) console.log(result.message);
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
                    // Parse failure → null: baseline shape may evolve.
                    const parsed = decodeJsonOrNull(baselineRaw) as {
                        tool?: string;
                        sessionKeys?: unknown;
                        frequency?: number;
                    } | null;
                    if (parsed && Array.isArray(parsed.sessionKeys)) {
                        const tool = parsed.tool ?? "tool";
                        retroSummaries = parsed.sessionKeys
                            .filter((s): s is string => typeof s === "string")
                            .slice(0, 5)
                            .map((s) => `session ${s}: top tool ${tool} failed (cluster freq=${parsed.frequency ?? "?"})`);
                    }
                }
                console.log("");
                console.log("spawning claude subagent to enrich the stub…");
                const agentResult = yield* runAgentAccept({
                    skillPath: result.artifact_path!,
                    proposalTitle: result.proposal!.title,
                    hypothesis: result.proposal!.hypothesis,
                    triggerPattern: result.proposal!.triggerPattern ?? "",
                    proposedBehavior: result.proposal!.proposedBehavior,
                    retroSummaries,
                    relatedSkillsDir: process.env.AX_SKILLS_SCAFFOLD_DIR ?? `${homedir()}/.claude/skills`,
                });
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

const cmdImproveReject = (input: {
    readonly id: string;
    readonly reason: string | undefined;
}) =>
    Effect.gen(function* () {
        const positional = input.id;
        const reason = input.reason ?? "not_worth_packaging";
        const result = yield* rejectProposal({ sigOrId: positional, reason });
        if (result.status !== "ok") {
            fail(result.message ?? `failed to reject proposal ${positional}`);
        }
        console.log(`proposal status -> rejected (reason: ${result.reason})`);
    });

const improveRejectCommand = Command.make(
    "reject",
    {
        id: Argument.string("id"),
        reason: Flag.string("reason").pipe(Flag.optional),
    },
    ({ id, reason }) => cmdImproveReject({ id, reason: optionValue(reason) }),
).pipe(Command.withDescription("Reject a proposal (dedupe blocks future re-proposal of same trigger)"));

const ALLOWED_VERDICTS: ReadonlySet<string> = new Set([
    "adopted", "ignored", "regressed", "partial", "no_longer_needed",
]);

/**
 * Short, honest text for a missing recommendation (#1134).
 *
 * Two different absences share this table: a MEASUREMENT gap (nothing to
 * measure, no detector, evidence that needs re-deriving) and a LIFECYCLE state
 * (never installed, retired). Neither is "waiting for more sessions", and
 * saying so would send the user off to generate exposure that no detector will
 * ever read.
 */
const MEASUREMENT_REASON_TEXT: Readonly<Record<string, string>> = {
    no_opportunities: "no opportunities in the window",
    detector_unavailable: "no detector for this form",
    artifact_unavailable: "no installed artifact recorded",
    refresh_required: "opportunity evidence needs derivation",
    no_checkpoint: "no checkpoint yet",
    not_started: "artifact not installed yet",
    retired: "experiment retired",
    regressed: "experiment marked regressed",
    not_accepted: "proposal not accepted",
    locked: "verdict locked",
};

export const measurementReasonText = (reason: string | null | undefined): string | null =>
    typeof reason === "string" ? MEASUREMENT_REASON_TEXT[reason] ?? reason : null;

/** Reasons that describe the EXPERIMENT rather than a measured window - they
 *  read as a state, not as "insufficient data". */
const LIFECYCLE_REASONS: ReadonlySet<string> = new Set([
    "no_checkpoint", "not_started", "retired", "regressed", "not_accepted", "locked",
]);

const currentBadge = (row: Record<string, unknown>): string => {
    const checkpoint = row.latest_checkpoint as Record<string, unknown> | null | undefined;
    const kind = checkpoint ? String(checkpoint.kind ?? "?") : null;
    const suggested = checkpoint?.suggested ?? null;
    if (suggested !== null && suggested !== undefined) return `${kind} suggested: ${String(suggested)}`;
    const reason = typeof row.current_reason === "string" ? row.current_reason : null;
    const text = measurementReasonText(reason) ?? "insufficient data";
    if (reason !== null && LIFECYCLE_REASONS.has(reason)) return text;
    return kind === null ? `insufficient data: ${text}` : `${kind} insufficient data: ${text}`;
};

/** One row of `ax improve verdict` (no positional argument). */
export const formatVerdictListLine = (row: Record<string, unknown>): string => {
    const badge = row.locked_verdict
        ? `locked: ${String(row.locked_verdict)}`
        : currentBadge(row);
    return `  ${String(row.dedupe_sig ?? "?")}  [${badge}]  ${String(row.title ?? "?")}`;
};

/** The CURRENT recommendation line in `ax improve verdict <id>`, printed above
 *  the stored history so the two are never confused. */
export const formatCurrentVerdictLine = (row: Record<string, unknown>): string => {
    const checkpoint = row.latest_checkpoint as Record<string, unknown> | null | undefined;
    const suggested = checkpoint?.suggested ?? null;
    if (suggested !== null && suggested !== undefined) {
        return `  current       ${String(checkpoint?.kind ?? "?")} suggested: ${String(suggested)}` +
            " (observed use, not proven improvement)";
    }
    const reason = typeof row.current_reason === "string" ? row.current_reason : null;
    const text = measurementReasonText(reason);
    if (reason !== null && LIFECYCLE_REASONS.has(reason)) return `  current       ${text}`;
    return `  current       insufficient data${text === null ? "" : ` - ${text}`}`;
};

/**
 * Is this stored row the one the CURRENT recommendation came from?
 *
 * Kind equality alone is not enough. When the projection suppresses the newest
 * row's suggestion, that row is evidence like any other - matching it by kind
 * would leave an old positive answer standing unlabelled at the bottom of the
 * output, which is the exact confusion the current/history split exists to end.
 * So: only a live recommendation (a suggestion, and no reason withholding it)
 * marks its row current.
 */
export const isCurrentCheckpointRow = (
    row: Record<string, unknown>,
    checkpoint: Record<string, unknown>,
): boolean => {
    const latest = row.latest_checkpoint as Record<string, unknown> | null | undefined;
    if (latest == null) return false;
    if (latest.suggested === null || latest.suggested === undefined) return false;
    if (row.current_reason !== null && row.current_reason !== undefined) return false;
    return checkpoint.kind === latest.kind;
};

/** One stored checkpoint in the history block. `isCurrent` marks the row the
 *  current recommendation came from; every other row is labelled historical so
 *  an old positive answer cannot be mistaken for today's advice. */
export const formatCheckpointHistoryLine = (
    checkpoint: Record<string, unknown>,
    isCurrent: boolean,
): string => {
    const measured = checkpoint.measured as Record<string, unknown> | string | undefined;
    const fields = typeof measured === "object" && measured !== null ? measured : {};
    const opportunities = Number(fields.opportunities ?? 0);
    const addressed = Number(fields.addressed ?? 0);
    const reasonText = measurementReasonText(
        typeof fields.reason === "string" ? fields.reason : null,
    );
    const verdict = checkpoint.suggested
        ? `suggested: ${String(checkpoint.suggested)}`
        : `insufficient data${reasonText === null ? "" : `: ${reasonText}`}`;
    return `    ${String(checkpoint.kind ?? "?")}  observed=${String(checkpoint.observed_at ?? "?")}  ` +
        `opportunities=${opportunities} addressed=${addressed}  ${verdict}  ` +
        `user_verdict=${checkpoint.user_verdict ? String(checkpoint.user_verdict) : "(none)"}` +
        `${isCurrent ? "" : "  (historical)"}`;
};

/**
 * The `ax improve checkpoint` summary.
 *
 * A run that writes nothing has to say WHICH nothing it hit. "No new windows
 * due" used to be printed even when every experiment was excluded, or when the
 * opportunity evidence itself needed re-deriving - two states the user can act
 * on, reported as one they cannot.
 */
export const formatCheckpointSummary = (stats: DeriveCheckpointsStats): string[] => {
    const lines = [
        `checkpoints scanned: ${stats.experimentsScanned} eligible experiment(s)`,
        `checkpoints excluded: ${stats.experimentsExcluded} (not installed, retired, regressed or locked)`,
        `checkpoints inserted: ${stats.checkpointsInserted}`,
        `checkpoints refreshed: ${stats.checkpointsRefreshed}`,
        `checkpoints skipped: ${stats.checkpointsSkipped}`,
    ];
    if (stats.insufficientData > 0) {
        lines.push(`insufficient data: ${stats.insufficientData} window(s) - stored with no suggested verdict`);
    }
    if (stats.checkpointsInserted + stats.checkpointsRefreshed > 0) return lines;
    lines.push("");
    if (stats.cacheRefreshRequired > 0) {
        lines.push(
            `${stats.cacheRefreshRequired} experiment(s) need opportunity derivation - ` +
            "run `ax ingest`, then re-run this command",
        );
    } else if (stats.experimentsScanned === 0) {
        lines.push(
            `No eligible experiments: ${stats.experimentsExcluded} excluded ` +
            "(run `ax improve lint` to record an installed artifact)",
        );
    } else {
        lines.push("No new windows due. Re-run with --force to refresh unreviewed checkpoints");
        lines.push("(use `axctl improve verdict <id>` to see suggested verdicts).");
    }
    return lines;
};

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
const cmdImproveVerdict = (input: {
    readonly id: string | undefined;
    readonly set: string | undefined;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const positional = input.id;
        const setValue = input.set;
        const json = input.json;
        if (positional === undefined) {
            const list = yield* listVerdicts();
            if (json) { console.log(prettyPrint(list)); return; }
            if (list.length === 0) {
                console.log("(no experiments yet - accept a proposal first via `axctl improve accept <sig>`)");
                return;
            }
            console.log("Current experiments (newest first):");
            for (const row of list) console.log(formatVerdictListLine(row));
            console.log("");
            console.log("Run `axctl improve checkpoint` to refresh due windows.");
            console.log("Run `axctl improve verdict <sig> --set <verdict>` to lock.");
            return;
        }
        const row = yield* showVerdict(positional);
        if (!row) {
            fail(`no experiment matched ${positional} (check \`axctl improve list --status=accepted\`)`);
        }
        const checkpoints = (row.checkpoints as Array<Record<string, unknown>> | undefined) ?? [];

        if (setValue !== undefined) {
            if (!ALLOWED_VERDICTS.has(setValue)) {
                fail(`--set must be one of: ${[...ALLOWED_VERDICTS].sort().join(", ")}`);
            }
            if (row.locked_verdict) {
                fail(`experiment already locked: ${String(row.locked_verdict)}`);
            }
            yield* setVerdict({ sigOrId: positional, verdict: setValue });
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
        console.log(formatCurrentVerdictLine(row));
        if (checkpoints.length === 0) {
            console.log(`  checkpoints   none (run \`axctl improve checkpoint\` once due windows pass)`);
        } else {
            // History below the current state, and marked as history: only a
            // LIVE recommendation claims a row as current.
            console.log(`  checkpoints:`);
            for (const cp of checkpoints) {
                console.log(formatCheckpointHistoryLine(cp, isCurrentCheckpointRow(row, cp)));
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
    ({ id, set, json }) =>
        cmdImproveVerdict({
            id: optionValue(id),
            set: optionValue(set),
            json,
        }),
).pipe(Command.withDescription("Show experiment verdict state; --set adopted|ignored|regressed|partial|no_longer_needed locks it"));

/**
 * `axctl improve reset --yes` - delete every sidecar experiment-loop row.
 *
 * Destructive. Used by UAT to start from a clean slate before re-running
 * the full propose -> accept -> verdict flow. Wipes the eight judgment
 * tables in dependency order; underlying evidence (friction_event,
 * skill_candidate, etc) is left alone so re-derivation can rebuild
 * proposals against the same signal.
 */
const cmdImproveReset = (input: { readonly yes: boolean }) =>
    Effect.gen(function* () {
        if (!input.yes) {
            fail(
                "ax improve reset: refusing to wipe without --yes\n" +
                "  drops: checkpoint, experiment, skill_proposal,\n" +
                "         subagent_proposal, hook_proposal,\n" +
                "         guidance_proposal, automation_proposal, proposal",
            );
        }
        const judgment = yield* Judgment;
        // Delete child judgment rows before their proposal owner.
        yield* judgment.transaction((transaction) => Effect.gen(function* () {
            for (const table of [
                "checkpoint", "experiment", "skill_proposal", "subagent_proposal",
                "hook_proposal", "guidance_proposal", "automation_proposal", "proposal",
            ]) {
                yield* transaction.exec(`DELETE FROM ${table}`);
            }
        }));
        console.log("experiment-loop state cleared. Run \`ax ingest --stages=proposals,opportunities\` to rebuild.");
    });

const improveResetCommand = Command.make(
    "reset",
    {
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ yes }) => cmdImproveReset({ yes }),
).pipe(Command.withDescription("Wipe all experiment-loop state (proposals/experiments/checkpoints). Requires --yes."));

const cmdImproveCheckpoint = (input: {
    readonly force: boolean;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const force = input.force;
        const json = input.json;
        const stats = yield* deriveCheckpoints({ force });
        if (json) {
            console.log(prettyPrint(stats));
            return;
        }
        for (const line of formatCheckpointSummary(stats)) console.log(line);
    });

const improveCheckpointCommand = Command.make(
    "checkpoint",
    {
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ force, json }) => cmdImproveCheckpoint({ force, json }),
).pipe(Command.withDescription("Compute checkpoint snapshots at +3/+10/+30 sessions for active experiments (session-count windows, not calendar days - see issue #83)"));

const cmdImprovePropose = (input: { readonly file: string | undefined; readonly json: boolean }) =>
    Effect.gen(function* () {
        const raw = input.file !== undefined
            ? yield* Effect.tryPromise(() => Bun.file(input.file as string).text())
            : yield* Effect.tryPromise(() => Bun.stdin.text());
	        const parsed = yield* Effect.try({
	            try: () => JSON.parse(raw) as unknown,
	            catch: (err) =>
	                new ImproveProposeJsonError({
	                    source: input.file ? input.file : "stdin",
	                    message: err instanceof Error ? err.message : String(err),
	                }),
	        });
        const result = yield* runPropose(parsed);
        if (input.json) {
            console.log(compactPrint(result));
        } else {
            console.log(`${result.status}: ${result.form} proposal "${result.title}" (sig=${result.sig})`);
            console.log("next: ax improve list - or review it in the dashboard Improve tab");
        }
    });

const improveProposeCommand = Command.make(
    "propose",
    {
        file: Flag.string("file").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ file, json }) => cmdImprovePropose({ file: optionValue(file), json }),
).pipe(Command.withDescription("Agent write-path: read one proposal as JSON (stdin or --file), validate, and insert it with origin 'agent'. Same title bumps frequency instead of duplicating."));

const cmdImproveAnalyze = (input: { readonly force: boolean }) =>
    Effect.gen(function* () {
        const date = new Date().toISOString().slice(0, 10);
        const dir = ".ax/tasks";
        const path = `${dir}/analyze-improve-${date}.md`;
        const exists = yield* Effect.tryPromise(() => Bun.file(path).exists());
        if (exists && !input.force) {
            console.log(`already exists: ${path} (re-run with --force to overwrite)`);
            return;
        }
        // Bun.write creates parent directories itself - no fs import needed
        // (repo gate: check:no-node-fs).
        yield* Effect.tryPromise(() => Bun.write(path, renderAnalyzeBrief({ date })));
        console.log(`analysis brief written: ${path}`);
        console.log("hand it to an agent session; findings come back via `ax improve propose`");
    });

const improveAnalyzeCommand = Command.make(
    "analyze",
    {
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
    },
    ({ force }) => cmdImproveAnalyze({ force }),
).pipe(Command.withDescription("Emit .ax/tasks/analyze-improve-<date>.md - a deep-analysis brief instructing an agent to mine the graph and write proposals back via `ax improve propose`."));

const cmdImproveHousekeep = (input: { readonly days: number; readonly dryRun: boolean; readonly json: boolean }) =>
    Effect.gen(function* () {
        const report = yield* runHousekeep({ days: input.days, dryRun: input.dryRun });
        if (input.json) {
            console.log(compactPrint(report));
            return;
        }
        if (report.staleProposals.length === 0 && report.removedTaskFiles.length === 0) {
            console.log(`clean: no open proposals or task briefs older than ${input.days}d`);
            return;
        }
        for (const row of report.staleProposals) {
            console.log(`${input.dryRun ? "would expire" : "expired"}: [${row.form}] ${row.title} (sig=${row.dedupe_sig})`);
        }
        for (const f of report.removedTaskFiles) {
            console.log(`${input.dryRun ? "would remove" : "removed"}: ${f}`);
        }
        if (input.dryRun) console.log("re-run without --dry-run to apply");
        else console.log("anything still real gets re-mined on the next ingest (same dedupe_sig).");
    });

const improveHousekeepCommand = Command.make(
    "housekeep",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ days, dryRun, json }) => cmdImproveHousekeep({ days, dryRun, json }),
).pipe(Command.withDescription("Sweep loop staleness: open proposals not re-observed in --days (default 30) are superseded; stale .ax/tasks briefs are deleted. Signals that still recur get re-mined automatically."));

export const improveCommand = Command.make("improve").pipe(
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
        improveProposeCommand,
        improveAnalyzeCommand,
        improveHousekeepCommand,
    ]),
);

export const improveRuntime: RuntimeManifest = {
    improve: {
        kind: "db-conditional",
        fallback: "cache",
        subcommands: {
            recommend: "cache",
            lint: "cache",
            list: "cache",
            show: "cache",
            accept: (args) => args.includes("--with-agent") ? "cache" : "cache",
            reject: "cache",
            verdict: "cache",
            reset: "cache",
            checkpoint: "cache",
            propose: "cache",
            analyze: "none",
            housekeep: "cache",
        },
    },
};
