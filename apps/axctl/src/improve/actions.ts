/**
 * Shared business logic for the `axctl improve` mutations. Phase C10
 * needed accept/reject/verdict callable from both the CLI handler and the
 * dashboard HTTP endpoint, so the query + scaffold orchestration lives
 * here in one place. Each function takes the proposal's `dedupe_sig`
 * (preferred) or full record id and returns a structured result the caller
 * (CLI or HTTP) can render however it likes.
 */

import { Effect, FileSystem, Option, type PlatformError, Schema } from "effect";
import { Judgment, TextColumn, type JudgmentError, type JudgmentService } from "@ax/lib/sqlite";
import { stableId } from "@ax/lib/stable-id";
import { isAlreadyExists, orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import {
    type InterventionSafetyContract,
    EXPERIMENT_STATUS_PUBLISHING,
    EXPERIMENT_STATUS_TASK_EMITTED,
    PROPOSAL_STATUS_ACCEPTED,
    PROPOSAL_STATUS_REJECTED,
    planAcceptCandidate,
    planLockVerdict,
    planRejectCandidate,
} from "./lifecycle.ts";
import { interventionFormSpec, isInterventionForm, type InterventionForm } from "./intervention-forms.ts";
import { scaffoldSkill, type ScaffoldInput, type ScaffoldResult } from "./skill-scaffold.ts";
import { renderTaskFile, type TaskInput } from "./task-template.ts";
import { findStoredProposal, type StoredProposal } from "./judgment-proposals.ts";

export type ImproveActionStatus =
    | "ok"
    | "not_found"
    | "wrong_status"
    | "unsupported_form"
    | "missing_payload"
    | "scaffold_exists"
    | "verdict_locked"
    | "invalid_verdict";

export interface AcceptResult {
    readonly status: ImproveActionStatus;
    readonly proposal_id?: string;
    readonly experiment_id?: string;
    readonly artifact_path?: string;
    readonly task_path?: string;
    readonly existing_experiment?: {
        readonly id: string;
        readonly artifact_path: string | null;
        readonly scaffolded_at: string | null;
        readonly locked_verdict: string | null;
    };
    readonly message?: string;
    /** Populated only when autoScaffold=true so callers can drive --with-agent enrichment. */
    readonly proposal?: {
        readonly title: string;
        readonly hypothesis: string;
        readonly triggerPattern: string | null;
        readonly proposedBehavior: string;
        readonly baseline: string | null;
    };
}

export interface RejectResult {
    readonly status: ImproveActionStatus;
    readonly proposal_id?: string;
    readonly reason?: string;
    readonly message?: string;
}

export interface VerdictResult {
    readonly status: ImproveActionStatus;
    readonly experiment_id?: string;
    readonly verdict?: string;
    readonly message?: string;
}

type ProposalRow = StoredProposal;
type FullProposalRow = StoredProposal;

// Shared inner: wrap a scaffoldSkill call in the PlatformError→{error} recovery
// so callers can map filesystem faults to a `missing_payload` result rather than
// propagating up the E channel.
const runSafeScaffold = (
    skillInput: ScaffoldInput,
    opts: AcceptOptions,
): Effect.Effect<{ result: ScaffoldResult } | { error: string }, never, FileSystem.FileSystem> =>
    scaffoldSkill({
        input: skillInput,
        ...(opts.scaffoldBaseDir === undefined ? {} : { baseDir: opts.scaffoldBaseDir }),
        ...(opts.force === undefined ? {} : { force: opts.force }),
    }).pipe(
        Effect.map((result) => ({ result }) as { result: ScaffoldResult } | { error: string }),
        Effect.catchTag("PlatformError", (err) =>
            Effect.succeed({ error: err.message } as { result: ScaffoldResult } | { error: string }),
        ),
    );

// Build ScaffoldInput from a skill_payload proposal row; delegates to runSafeScaffold.
const trySafeScaffold = (
    row: ProposalRow,
    payload: NonNullable<ProposalRow["skill_payload"]>,
    opts: AcceptOptions,
): Effect.Effect<{ result: ScaffoldResult } | { error: string }, never, FileSystem.FileSystem> =>
    runSafeScaffold({
        title: row.title,
        hypothesis: row.hypothesis,
        proposedBehavior: String(payload.proposed_behavior ?? ""),
        triggerPattern: payload.trigger_pattern == null ? null : String(payload.trigger_pattern),
        expectedImpact: payload.expected_impact == null ? null : String(payload.expected_impact),
        dedupeSig: row.dedupe_sig,
        nowIso: new Date().toISOString(),
    }, opts);

/**
 * Pure routing predicate: should this proposal auto-scaffold a SKILL.md instead
 * of emitting a .ax/tasks/ brief?
 *
 * True only for form="guidance" + section="workflows" (milestone B, #588).
 * All other guidance sections (e.g. "directives") and all other forms stay on
 * the existing brief/inline-marker path.
 */
export const shouldScaffoldWorkflowSkill = (
    row: { readonly form: string; readonly guidance_payload?: { readonly section?: string | null } | null },
): boolean =>
    row.form === "guidance" && row.guidance_payload?.section === "workflows";

const fetchFullProposal = findStoredProposal;

/** Default directory for .ax/tasks/ task brief files. */
const defaultTaskDir = (): string =>
    process.env.AX_TASK_DIR ?? posixPath.join(process.cwd(), ".ax", "tasks");

interface TaskBuildContext {
    readonly shortId: string;
    readonly proposalId: string;
}

type TaskInputBuilder = (
    row: FullProposalRow,
    experimentId: string,
    ctx: TaskBuildContext,
) => TaskInput;

const taskInputBuilders = {
    guidance: (row, experimentId, { shortId, proposalId }) => ({
        form: "guidance",
        experimentId,
        proposalId,
        shortId,
        title: row.title,
        targetPath: row.guidance_payload?.file_target ?? "~/.claude/CLAUDE.md",
        section: row.guidance_payload?.section ?? null,
        suggestedBody: row.guidance_payload?.suggested_text ?? row.hypothesis,
        proposedBehavior: null,
        confidence: row.confidence ?? "medium",
        frequency: row.frequency ?? 0,
        evidence: row.hypothesis,
    }),
    skill: (row, experimentId, { shortId, proposalId }) => ({
        form: "skill",
        experimentId,
        proposalId,
        shortId,
        title: row.title,
        targetPath: `~/.claude/skills/${row.dedupe_sig}/SKILL.md`,
        section: null,
        suggestedBody: "",
        proposedBehavior: String(row.skill_payload?.proposed_behavior ?? ""),
        confidence: row.confidence ?? "medium",
        frequency: row.frequency ?? 0,
        evidence: row.hypothesis,
    }),
    harness_check: (row, experimentId, { shortId, proposalId }) => {
        const baselineEvidence = typeof row.baseline === "string" && row.baseline.trim().length > 0
            ? `\n\nBaseline evidence:\n${row.baseline}`
            : "";
        const evidence = `${row.hypothesis}${baselineEvidence}`;
        return {
            form: "harness_check",
            experimentId,
            proposalId,
            shortId,
            title: row.title,
            targetPath: `tests/harness/${row.dedupe_sig}.md`,
            section: null,
            suggestedBody: evidence,
            proposedBehavior: evidence,
            confidence: row.confidence ?? "medium",
            frequency: row.frequency ?? 0,
            evidence,
        };
    },
    subagent: (row, experimentId, { shortId, proposalId }) => ({
        form: "subagent",
        experimentId,
        proposalId,
        shortId,
        title: row.title,
        targetPath: `~/.claude/agents/${row.dedupe_sig}.md`,
        section: null,
        suggestedBody: [
            row.subagent_payload?.bounded_role ? `Role: ${row.subagent_payload.bounded_role}` : null,
            row.subagent_payload?.delegation_trigger ? `Delegation trigger: ${row.subagent_payload.delegation_trigger}` : null,
            row.hypothesis,
        ].filter((line): line is string => line !== null).join("\n\n"),
        proposedBehavior: null,
        confidence: "medium",
        frequency: 0,
        evidence: row.hypothesis,
    }),
    hook: (row, experimentId, { shortId, proposalId }) => ({
        form: "hook",
        experimentId,
        proposalId,
        shortId,
        title: row.title,
        targetPath: "~/.claude/settings.json",
        section: row.hook_payload?.event_name ?? "PreToolUse",
        suggestedBody: row.hook_payload?.hook_command ?? `see proposal: ${row.dedupe_sig}`,
        proposedBehavior: row.hook_payload?.target_tool ?? null,
        confidence: "medium",
        frequency: 0,
        evidence: row.hypothesis,
        safety: safetyContractFromPayload(row.hook_payload),
    }),
    automation: (row, experimentId, { shortId, proposalId }) => ({
        form: "automation",
        experimentId,
        proposalId,
        shortId,
        title: row.title,
        targetPath: `.ax/interventions/${row.dedupe_sig}/AUTOMATION.md`,
        section: row.automation_payload?.schedule ?? null,
        suggestedBody: row.automation_payload?.action ?? `see proposal: ${row.dedupe_sig}`,
        proposedBehavior: row.automation_payload?.trigger_signal ?? null,
        confidence: "medium",
        frequency: 0,
        evidence: row.hypothesis,
        safety: safetyContractFromPayload(row.automation_payload),
    }),
} satisfies Record<InterventionForm, TaskInputBuilder>;

/**
 * Map a full proposal row + experimentId to a TaskInput for renderTaskFile.
 */
const buildTaskInput = (row: FullProposalRow, experimentId: string): TaskInput => {
    const shortId = row.dedupe_sig;
    const proposalId = `proposal:${row.id}`;
    if (!isInterventionForm(row.form)) {
        throw new Error(`unsupported proposal form: ${row.form}`);
    }
    return taskInputBuilders[row.form](row, experimentId, { shortId, proposalId });
};

const safetyContractFromPayload = (
    payload: {
        readonly recovery_path?: string | null;
        readonly smoke_test_command?: string | null;
        readonly disable_command?: string | null;
        readonly failure_mode?: string | null;
    } | null | undefined,
): InterventionSafetyContract => ({
    recoveryPath: payload?.recovery_path ?? null,
    smokeTestCommand: payload?.smoke_test_command ?? null,
    disableCommand: payload?.disable_command ?? null,
    failureMode: payload?.failure_mode ?? null,
});

const safetyContractForRow = (row: FullProposalRow): InterventionSafetyContract | null => {
    const payloadKey = interventionFormSpec(row.form)?.safetyPayloadKey;
    if (payloadKey === "hook_payload") return safetyContractFromPayload(row.hook_payload);
    if (payloadKey === "automation_payload") return safetyContractFromPayload(row.automation_payload);
    return null;
};

export interface AcceptOptions {
    readonly sigOrId: string;
    readonly force?: boolean;
    readonly autoScaffold?: boolean;     // skill form only - preserves existing direct-write path
    readonly scaffoldBaseDir?: string;   // forwarded to scaffoldSkill when autoScaffold=true
    readonly taskDir?: string;           // override .ax/tasks/ output dir
}

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

const SAFE_SIG = /^[a-z0-9_-]+$/i;

const validateSig = (sig: string): void => {
    if (!SAFE_SIG.test(sig)) {
        throw new Error(`unsafe dedupe_sig for filename: ${sig.slice(0, 40)}...`);
    }
};

const saveAcceptedExperiment = (
    judgment: JudgmentService,
    proposalId: string,
    experimentId: string,
    status: string,
    values: { readonly artifactPath?: string; readonly taskPath?: string },
) => judgment.transaction((transaction) => Effect.gen(function* () {
    const now = new Date();
    yield* transaction.exec(
        "UPDATE proposal SET status = ?, updated_at = ? WHERE id = ?",
        [PROPOSAL_STATUS_ACCEPTED, now, proposalId],
    );
    yield* transaction.put("experiment", {
        id: experimentId,
        proposal: proposalId,
        artifact: null,
        artifact_path: values.artifactPath ?? null,
        scaffolded_at: values.artifactPath === undefined ? null : now,
        created_at: now,
        locked_verdict: null,
        status,
        task_path: values.taskPath ?? null,
    });
}));

/** Whether the experiment reached `task_emitted`, and why not when it did not. */
type PublicationFinish =
    | { readonly finished: true }
    | { readonly finished: false; readonly locked: boolean; readonly reason: string };

const ExperimentStateRow = Schema.Struct({
    status: TextColumn,
    locked_verdict: Schema.NullOr(TextColumn),
});

/**
 * Move an experiment off `publishing` once its brief is on disk.
 *
 * BOTH predicates are load-bearing. `status = 'publishing'` stops a second retry
 * and a concurrent retire from being re-opened; `locked_verdict IS NULL` stops a
 * row somebody judged BETWEEN the plan read and this update from being written
 * at all - the status test alone cannot see that, because a locked row can still
 * read `publishing`.
 *
 * A no-op update is ambiguous on its own, so the row is re-read to tell the two
 * apart: another attempt that already finished the publication (complete), or a
 * locked/retired row this attempt must not claim (incomplete). Callers must not
 * report a completed publication for the second.
 */
const finishPublication = (
    judgment: JudgmentService,
    experimentKey: string,
): Effect.Effect<PublicationFinish, JudgmentError> =>
    Effect.gen(function* () {
        const changed = yield* judgment.exec(
            "UPDATE experiment SET status = ? WHERE id = ? AND status = ? AND locked_verdict IS NULL",
            [EXPERIMENT_STATUS_TASK_EMITTED, experimentKey, EXPERIMENT_STATUS_PUBLISHING],
        );
        if (changed > 0) return { finished: true };
        const current = yield* judgment.first(
            ExperimentStateRow,
            "SELECT status, locked_verdict FROM experiment WHERE id = ? LIMIT 1",
            [experimentKey],
        );
        const row = Option.getOrUndefined(current);
        if (row === undefined) {
            return { finished: false, locked: false, reason: `experiment ${experimentKey} is gone` };
        }
        // Another attempt got there first: the publication IS complete.
        if (row.status !== EXPERIMENT_STATUS_PUBLISHING) return { finished: true };
        return row.locked_verdict === null
            ? { finished: false, locked: false, reason: `experiment ${experimentKey} could not be finished` }
            : { finished: false, locked: true, reason: `experiment verdict already locked: ${row.locked_verdict}` };
    });

/** What a publish attempt did with the task path. */
type PublishOutcome = "published" | "kept_existing";

/**
 * Decide what an exclusive publish's `AlreadyExists` actually found.
 *
 * `stat` FOLLOWS symlinks, which is what makes it the right probe here: a
 * symlink resolving to a regular file is a brief the operator chose to keep, and
 * a DANGLING symlink reports NotFound and is rejected. A directory reports its
 * own type and is rejected. Either way the path is left untouched - this only
 * decides whether the caller may treat the publication as finished.
 */
const keepUsableDestination = (
    fs: FileSystem.FileSystem,
    taskPath: string,
    alreadyExists: PlatformError.PlatformError,
): Effect.Effect<PublishOutcome, PlatformError.PlatformError> =>
    fs.stat(taskPath).pipe(
        Effect.map((info) => info.type === "File"),
        // Any fault (a dangling symlink's NotFound, a permission error) means
        // "cannot confirm a readable brief", which is not a finished publication.
        orAbsent(false),
        Effect.flatMap((usable) =>
            usable ? Effect.succeed("kept_existing" as PublishOutcome) : Effect.fail(alreadyExists),
        ),
    );

/**
 * Stage the rendered brief beside its target, then publish it in one step.
 *
 * The staging name carries BOTH the pid and a uuid, so it belongs to exactly one
 * attempt: two concurrent accepts of the same proposal never share it, and the
 * `ensuring` below removes only the file this attempt created. Nothing ever
 * deletes a staging file by pattern - a name alone cannot prove ownership, and a
 * pattern sweep would delete a live attempt's in-progress file.
 *
 * `replace` picks how the staged file lands, and the two modes are not
 * interchangeable:
 *   - `true` - ONLY a first accept carrying an explicit `force`. That flag is the
 *     operator's authority to overwrite; `rename` then swaps the target
 *     atomically. An earlier "the path was free" probe is NOT authority - the
 *     path can fill between the probe and the publish - so ordinary acceptance
 *     publishes exclusively too.
 *   - `false` - a RESUMED publication, which has no such authority. `link`
 *     creates the target ONLY if nothing is there and fails with `AlreadyExists`
 *     otherwise. There is deliberately no stat first: a file can appear between a
 *     probe and a rename, and the rename would then destroy it. The exclusive
 *     create IS the check.
 *
 * `AlreadyExists` alone does not mean "a brief is already published". It also
 * describes a DIRECTORY on the path and a DANGLING SYMLINK - `link` refuses
 * both, and neither is a task file anyone can read. So the destination is
 * validated AFTER the refusal, which is safe precisely because the exclusive
 * create already failed: whatever is there was not put there by this attempt and
 * is left exactly as found. A regular file (or a symlink resolving to one) is
 * reported as `kept_existing`; anything else re-raises the `AlreadyExists`
 * failure, so the caller cannot mistake an unusable path for a finished
 * publication.
 *
 * `beforePublish` runs after the staged file is complete and before it lands, so
 * a failure there aborts with the target untouched.
 *
 * Sibling of `@ax/lib/staged-rename`, which owns the replace-only form of this
 * dance; it has no exclusive mode, and adding one would change the signature its
 * snapshot/dylib callers depend on.
 */
const publishTaskBrief = <E, R>(input: {
    readonly taskPath: string;
    readonly content: string;
    readonly replace: boolean;
    readonly beforePublish?: Effect.Effect<void, E, R>;
}): Effect.Effect<PublishOutcome, E | PlatformError.PlatformError, R | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const staging = `${input.taskPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const publish = Effect.gen(function* () {
            yield* fs.makeDirectory(posixPath.dirname(input.taskPath), { recursive: true });
            yield* fs.writeFileString(staging, input.content);
            if (input.beforePublish !== undefined) yield* input.beforePublish;
            if (input.replace) {
                yield* fs.rename(staging, input.taskPath);
                return "published" as PublishOutcome;
            }
            return yield* fs.link(staging, input.taskPath).pipe(
                Effect.as("published" as PublishOutcome),
                Effect.catchTag("PlatformError", (err) =>
                    isAlreadyExists(err)
                        ? keepUsableDestination(fs, input.taskPath, err)
                        : Effect.fail(err),
                ),
            );
        });
        // Every exit path drops THIS attempt's staging file: after a successful
        // rename it is already gone, after a successful link it is the spare
        // name for the published inode, and after any failure it is the partial
        // write nobody else can claim. It must not mask the primary error.
        return yield* publish.pipe(
            Effect.ensuring(fs.remove(staging, { force: true }).pipe(Effect.ignore)),
        );
    });

export const acceptProposal = (
    opts: AcceptOptions,
): Effect.Effect<AcceptResult, JudgmentError | PlatformError.PlatformError, Judgment | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const row = yield* fetchFullProposal(opts.sigOrId);
        if (!row) return { status: "not_found", message: `no proposal matched ${opts.sigOrId}` };
        const proposalKey = row.id;
        const acceptPlan = planAcceptCandidate({
            form: row.form,
            proposalStatus: row.status,
            autoScaffold: Boolean(opts.autoScaffold),
            safetyContract: safetyContractForRow(row),
            experiment: row.experiment === null ? null : {
                status: row.experiment.status,
                taskPath: row.experiment.task_path,
                lockedVerdict: row.experiment.locked_verdict,
            },
        });
        if (acceptPlan.status === "wrong_status") {
            const existing = row.experiment;
            const result: AcceptResult = {
                status: "wrong_status",
                message: acceptPlan.message,
            };
            if (existing) {
                return {
                    ...result,
                    existing_experiment: {
                        id: `experiment:${existing.id}`,
                        artifact_path: existing.artifact_path,
                        scaffolded_at: existing.scaffolded_at?.toISOString() ?? null,
                        locked_verdict: existing.locked_verdict,
                    },
                };
            }
            return result;
        }
        if (acceptPlan.status !== "ok" && acceptPlan.status !== "resume_publication") {
            return {
                status: acceptPlan.status,
                message: acceptPlan.message,
            };
        }
        const experimentStatus = acceptPlan.experimentStatus;

        // A resumed accept finishes the publication the earlier run committed:
        // same experiment row, same intended path, no second proposal update.
        const resumed = acceptPlan.status === "resume_publication" ? row.experiment : null;
        const experimentKey = resumed?.id ?? stableId("experiment", [proposalKey]);
        const experimentId = `experiment:${experimentKey}`;
        const judgment = yield* Judgment;

        // autoScaffold=true && form=skill: legacy direct-write path.
        // Both scaffold paths write the artifact BEFORE they commit, so they can
        // never leave a `publishing` row - a resume always belongs to the task path.
        if (opts.autoScaffold && row.form === "skill" && resumed === null) {
            validateSig(row.dedupe_sig);
            const payload = row.skill_payload ?? null;
            if (!payload) {
                return { status: "missing_payload", message: "skill_proposal payload missing" };
            }
            const scaffoldOutcome = yield* trySafeScaffold(row, payload, opts);
            if ("error" in scaffoldOutcome) {
                return {
                    status: "missing_payload",
                    message: `scaffold failed: ${scaffoldOutcome.error}`,
                };
            }
            const scaffold: ScaffoldResult = scaffoldOutcome.result;
            if (scaffold.skipped) {
                return {
                    status: "scaffold_exists",
                    message: `existing scaffold at ${scaffold.path} (pass force=true to overwrite)`,
                    artifact_path: scaffold.path,
                };
            }
            yield* saveAcceptedExperiment(judgment, proposalKey, experimentKey, experimentStatus, {
                artifactPath: scaffold.path,
            });
            return {
                status: "ok",
                proposal_id: `proposal:${proposalKey}`,
                experiment_id: experimentId,
                artifact_path: scaffold.path,
                proposal: {
                    title: row.title,
                    hypothesis: row.hypothesis,
                    triggerPattern: payload.trigger_pattern == null ? null : String(payload.trigger_pattern),
                    proposedBehavior: String(payload.proposed_behavior ?? ""),
                    baseline: typeof (row as unknown as Record<string, unknown>).baseline === "string"
                        ? String((row as unknown as Record<string, unknown>).baseline)
                        : null,
                },
            };
        }

        // autoScaffold=true && form=guidance && section=workflows: scaffold SKILL.md stub (#588)
        // Uses suggested_text (the arc "plan → tdd → review → commit") as the stub body.
        // Directives and all other guidance sections fall through to the brief path below.
        if (opts.autoScaffold && shouldScaffoldWorkflowSkill(row) && resumed === null) {
            validateSig(row.dedupe_sig);
            const scaffoldOutcome = yield* runSafeScaffold({
                title: row.title,
                hypothesis: row.hypothesis,
                proposedBehavior: row.guidance_payload?.suggested_text ?? row.hypothesis,
                dedupeSig: row.dedupe_sig,
                nowIso: new Date().toISOString(),
            }, opts);
            if ("error" in scaffoldOutcome) {
                return {
                    status: "missing_payload",
                    message: `scaffold failed: ${scaffoldOutcome.error}`,
                };
            }
            const wfScaffold: ScaffoldResult = scaffoldOutcome.result;
            if (wfScaffold.skipped) {
                return {
                    status: "scaffold_exists",
                    message: `existing scaffold at ${wfScaffold.path} (pass force=true to overwrite)`,
                    artifact_path: wfScaffold.path,
                };
            }
            yield* saveAcceptedExperiment(judgment, proposalKey, experimentKey, experimentStatus, {
                artifactPath: wfScaffold.path,
            });
            return {
                status: "ok",
                proposal_id: `proposal:${proposalKey}`,
                experiment_id: experimentId,
                artifact_path: wfScaffold.path,
                proposal: {
                    title: row.title,
                    hypothesis: row.hypothesis,
                    triggerPattern: null,
                    proposedBehavior: row.guidance_payload?.suggested_text ?? "",
                    baseline: null,
                },
            };
        }

        // Default path for all v0 forms: emit .ax/tasks/<dedupe_sig>.md
        validateSig(row.dedupe_sig);
        // A resume keeps the path the interrupted run recorded, even when the
        // caller's taskDir has since changed.
        const taskPath = resumed?.task_path
            ?? posixPath.join(opts.taskDir ?? defaultTaskDir(), `${row.dedupe_sig}.md`);

        if (resumed === null) {
            // existsSync probe: any fault → treat as absent (orAbsent(false)).
            const taskExists = yield* fs.exists(taskPath).pipe(orAbsent(false));
            if (taskExists && !opts.force) {
                return {
                    status: "scaffold_exists",
                    message: `task brief already exists at ${taskPath} (pass force=true to overwrite)`,
                    task_path: taskPath,
                };
            }
        }

        const taskInput = buildTaskInput(row, experimentId);
        const taskContent = renderTaskFile(taskInput);

        // Phase 1 (first accept only): accept the proposal and record the path
        // this run intends to publish, as `publishing`. That status is what a
        // later retry reads to tell an interrupted publication from a completed
        // acceptance. It runs between the staged write and the publish, so a DB
        // failure leaves neither a brief nor a staging file behind.
        // Phase 2: land the staged file. The first accept may replace (the guard
        // above authorized it); a resume publishes exclusively and keeps whatever
        // is already there. A failure propagates with the experiment still
        // `publishing`, so the next accept resumes instead of refusing.
        const outcome = yield* publishTaskBrief({
            taskPath,
            content: taskContent,
            // Replacement needs the operator's explicit force on a first accept.
            // Everything else - ordinary acceptance included - publishes
            // exclusively and keeps whatever it finds.
            replace: resumed === null && opts.force === true,
            ...(resumed === null
                ? {
                    beforePublish: saveAcceptedExperiment(
                        judgment,
                        proposalKey,
                        experimentKey,
                        EXPERIMENT_STATUS_PUBLISHING,
                        { taskPath },
                    ),
                }
                : {}),
        });

        // Phase 3: a readable brief is on disk - this attempt's, or the one it
        // refused to replace - so the publication can be finished. This path
        // always emits a task, including when a resume arrives with
        // --auto-scaffold, so the final status is task_emitted either way.
        const finish = yield* finishPublication(judgment, experimentKey);
        if (!finish.finished) {
            // The brief is published, but this experiment must not be moved.
            // Reporting "ok" here would claim a completed acceptance for a row
            // somebody already judged.
            return {
                status: finish.locked ? "verdict_locked" : "wrong_status",
                proposal_id: `proposal:${proposalKey}`,
                experiment_id: experimentId,
                task_path: taskPath,
                message: `${finish.reason}; the brief at ${taskPath} was left in place and the acceptance was not finished`,
            };
        }

        const keptMessage = resumed === null
            ? `a task brief appeared at ${taskPath} first; kept it (pass force=true to overwrite)`
            : `finished the interrupted publication; kept the existing brief at ${taskPath}`;
        return {
            status: "ok",
            proposal_id: `proposal:${proposalKey}`,
            experiment_id: experimentId,
            task_path: taskPath,
            ...(outcome === "kept_existing"
                ? { message: keptMessage }
                : resumed === null
                    ? {}
                    : { message: `finished the interrupted publication at ${taskPath}` }),
        };
    });

export interface RejectOptions {
    readonly sigOrId: string;
    readonly reason?: string;
}

export const rejectProposal = (
    opts: RejectOptions,
): Effect.Effect<RejectResult, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const row = yield* fetchFullProposal(opts.sigOrId);
        if (!row) return { status: "not_found", message: `no proposal matched ${opts.sigOrId}` };
        const rejectPlan = planRejectCandidate({
            proposalStatus: row.status,
            ...(opts.reason === undefined ? {} : { reason: opts.reason }),
        });
        if (rejectPlan.status === "wrong_status") {
            return { status: "wrong_status", message: rejectPlan.message };
        }
        const proposalKey = row.id;
        const judgment = yield* Judgment;
        yield* judgment.exec(
            "UPDATE proposal SET status = ?, reject_reason = ?, updated_at = ? WHERE id = ?",
            [PROPOSAL_STATUS_REJECTED, rejectPlan.reason, new Date(), proposalKey],
        );
        return {
            status: "ok",
            proposal_id: `proposal:${proposalKey}`,
            reason: rejectPlan.reason,
        };
    });

export interface SetVerdictOptions {
    readonly sigOrId: string;
    readonly verdict: string;
}

export const setVerdict = (
    opts: SetVerdictOptions,
): Effect.Effect<VerdictResult, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const verdictPlan = planLockVerdict({
            requestedVerdict: opts.verdict,
            lockedVerdict: null,
        });
        if (verdictPlan.status === "invalid_verdict") {
            return {
                status: "invalid_verdict",
                message: verdictPlan.message,
            };
        }
        const proposal = yield* findStoredProposal(opts.sigOrId);
        const row = proposal?.experiment;
        if (!row) {
            return { status: "not_found", message: `no experiment matched ${opts.sigOrId}` };
        }
        const lockPlan = planLockVerdict({
            requestedVerdict: opts.verdict,
            lockedVerdict: row.locked_verdict,
        });
        if (lockPlan.status !== "ok") {
            return { status: lockPlan.status, message: lockPlan.message };
        }
        const lockedVerdict = lockPlan.verdict;
        const judgment = yield* Judgment;
        const latestCp = row.checkpoints.at(-1);
        yield* judgment.transaction((transaction) => Effect.gen(function* () {
            yield* transaction.exec("UPDATE experiment SET locked_verdict = ? WHERE id = ?", [lockedVerdict, row.id]);
            if (latestCp) {
                yield* transaction.exec("UPDATE checkpoint SET user_verdict = ? WHERE id = ?", [lockedVerdict, latestCp.id]);
            }
        }));
        return { status: "ok", experiment_id: `experiment:${row.id}`, verdict: lockedVerdict };
    });
