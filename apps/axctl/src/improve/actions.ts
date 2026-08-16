/**
 * Shared business logic for the `axctl improve` mutations. Phase C10
 * needed accept/reject/verdict callable from both the CLI handler and the
 * dashboard HTTP endpoint, so the SurrealQL + scaffold orchestration lives
 * here in one place. Each function takes the proposal's `dedupe_sig`
 * (preferred) or full record id and returns a structured result the caller
 * (CLI or HTTP) can render however it likes.
 */

import { Effect, FileSystem, type PlatformError } from "effect";
import { Judgment, type JudgmentError, type JudgmentService } from "@ax/lib/sqlite";
import { stableId } from "@ax/lib/stable-id";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import {
    type InterventionSafetyContract,
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
        if (acceptPlan.status !== "ok") {
            return {
                status: acceptPlan.status,
                message: acceptPlan.message,
            };
        }
        const experimentStatus = acceptPlan.experimentStatus;

        const experimentKey = stableId("experiment", [proposalKey]);
        const experimentId = `experiment:${experimentKey}`;
        const judgment = yield* Judgment;

        // autoScaffold=true && form=skill: legacy direct-write path
        if (opts.autoScaffold && row.form === "skill") {
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
        if (opts.autoScaffold && shouldScaffoldWorkflowSkill(row)) {
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
        const taskDir = opts.taskDir ?? defaultTaskDir();
        const taskPath = posixPath.join(taskDir, `${row.dedupe_sig}.md`);

        // existsSync probe: any fault → treat as absent (orAbsent(false)).
        const taskExists = yield* fs.exists(taskPath).pipe(orAbsent(false));
        if (taskExists && !opts.force) {
            return {
                status: "scaffold_exists",
                message: `task brief already exists at ${taskPath} (pass force=true to overwrite)`,
                task_path: taskPath,
            };
        }

        const taskInput = buildTaskInput(row, experimentId);
        const taskContent = renderTaskFile(taskInput);

        // mkdir + tmp write propagate (original used bare mkdirSync/writeFileSync).
        yield* fs.makeDirectory(taskDir, { recursive: true });
        // Atomic write: stage content in a temp file first, commit to final path only
        // after the DB update succeeds. This avoids orphan task files when the DB
        // query fails after the write.
        const tmpPath = `${taskPath}.tmp.${process.pid}`;
        yield* fs.writeFileString(tmpPath, taskContent);

        yield* saveAcceptedExperiment(judgment, proposalKey, experimentKey, experimentStatus, { taskPath }).pipe(
            // Best-effort cleanup of the staged temp file on DB failure (matches
            // main's `try { unlinkSync(tmpPath); } catch {}`): force tolerates an
            // already-absent temp and `ignore` swallows any other fault so the
            // original DbError still propagates.
            Effect.tapError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
        );

        // Commit the staged write to its final path. Propagates on failure
        // (original used bare renameSync, no try/catch).
        yield* fs.rename(tmpPath, taskPath);

        return {
            status: "ok",
            proposal_id: `proposal:${proposalKey}`,
            experiment_id: experimentId,
            task_path: taskPath,
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
