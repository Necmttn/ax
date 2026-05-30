/**
 * Shared vocabulary and bounded transition rules for the improvement /
 * intervention lifecycle. Keep this module pure: callers own persistence,
 * rendering, and filesystem effects.
 */

export const PROPOSAL_STATUS_OPEN = "open";
export const PROPOSAL_STATUS_ACCEPTED = "accepted";
export const PROPOSAL_STATUS_REJECTED = "rejected";

export const GUIDANCE_STATUS_PROPOSED = "proposed";

export const ACCEPTED_PROPOSAL_FORMS = ["guidance", "skill"] as const;
export type AcceptedProposalForm = (typeof ACCEPTED_PROPOSAL_FORMS)[number];

export const EXPERIMENT_STATUS_TASK_EMITTED = "task_emitted";
export const EXPERIMENT_STATUS_SCAFFOLDED = "scaffolded";
export const LIFECYCLE_VERDICT_REGRESSED = "regressed";
export type ExperimentStatus =
    | typeof EXPERIMENT_STATUS_TASK_EMITTED
    | typeof EXPERIMENT_STATUS_SCAFFOLDED;

export const LIFECYCLE_VERDICTS = [
    "adopted",
    "ignored",
    "no_longer_needed",
    "partial",
    LIFECYCLE_VERDICT_REGRESSED,
] as const;
export type LifecycleVerdict = (typeof LIFECYCLE_VERDICTS)[number];

export const LIFECYCLE_VERDICT_SET: ReadonlySet<string> = new Set(LIFECYCLE_VERDICTS);

export type InterventionStrength = "advisory" | "workflow" | "automation" | "guardrail" | "hard_boundary";
export type InterventionObservationStatus = "not_started" | "observed" | "needs_more_evidence";
export type InterventionConfidence = "low" | "medium" | "high";

export const INTERVENTION_SAFETY_GATES = [
    "Recovery Path",
    "smoke test",
    "disable switch",
    "failure mode",
] as const;

export type InterventionSafetyGate = (typeof INTERVENTION_SAFETY_GATES)[number];
export type InterventionFailureMode = "fail_open" | "fail_closed";

export interface InterventionSafetyContract {
    readonly recoveryPath?: string | null;
    readonly smokeTestCommand?: string | null;
    readonly disableCommand?: string | null;
    readonly failureMode?: string | null;
}

const hasText = (value: string | null | undefined): boolean =>
    typeof value === "string" && value.trim().length > 0;

export function validateInterventionFailureMode(
    failureMode: string | null | undefined,
): failureMode is InterventionFailureMode {
    return failureMode === "fail_open" || failureMode === "fail_closed";
}

export function missingInterventionSafetyGates(
    contract: InterventionSafetyContract | null | undefined,
): InterventionSafetyGate[] {
    const missing: InterventionSafetyGate[] = [];
    if (!hasText(contract?.recoveryPath)) missing.push("Recovery Path");
    if (!hasText(contract?.smokeTestCommand)) missing.push("smoke test");
    if (!hasText(contract?.disableCommand)) missing.push("disable switch");
    if (!validateInterventionFailureMode(contract?.failureMode)) missing.push("failure mode");
    return missing;
}

export function interventionSafetyMessage(
    form: string,
    contract: InterventionSafetyContract | null | undefined,
): string {
    const missing = missingInterventionSafetyGates(contract);
    if (missing.length === 0) {
        return `${form} proposals remain candidate-only until their accept/scaffold adapter is wired`;
    }
    return `${form} proposals stay open until safety gates are modeled: ${missing.join(", ")}`;
}

export function isAcceptedProposalForm(form: string): form is AcceptedProposalForm {
    return (ACCEPTED_PROPOSAL_FORMS as readonly string[]).includes(form);
}

export function acceptanceFormError(form: string): string {
    return `accept supports form=guidance and form=skill (got ${form}); subagent/hook/automation land in later phases`;
}

export function acceptedExperimentStatus(input: {
    readonly form: string;
    readonly autoScaffold: boolean;
}): ExperimentStatus {
    return input.autoScaffold && input.form === "skill"
        ? EXPERIMENT_STATUS_SCAFFOLDED
        : EXPERIMENT_STATUS_TASK_EMITTED;
}

export type AcceptCandidatePlan =
    | {
        readonly status: "ok";
        readonly experimentStatus: ExperimentStatus;
    }
    | {
        readonly status: "wrong_status" | "unsupported_form";
        readonly message: string;
    };

export function planAcceptCandidate(input: {
    readonly form: string;
    readonly proposalStatus: string;
    readonly autoScaffold: boolean;
}): AcceptCandidatePlan {
    if (input.proposalStatus !== PROPOSAL_STATUS_OPEN) {
        return {
            status: "wrong_status",
            message: `proposal already ${input.proposalStatus}`,
        };
    }
    if (!isAcceptedProposalForm(input.form)) {
        return {
            status: "unsupported_form",
            message: acceptanceFormError(input.form),
        };
    }
    return {
        status: "ok",
        experimentStatus: acceptedExperimentStatus(input),
    };
}

export type RejectCandidatePlan =
    | {
        readonly status: "ok";
        readonly reason: string;
    }
    | {
        readonly status: "wrong_status";
        readonly message: string;
    };

export function planRejectCandidate(input: {
    readonly proposalStatus: string;
    readonly reason?: string;
}): RejectCandidatePlan {
    if (input.proposalStatus !== PROPOSAL_STATUS_OPEN) {
        return {
            status: "wrong_status",
            message: `proposal already ${input.proposalStatus}`,
        };
    }
    return {
        status: "ok",
        reason: input.reason ?? "not_worth_packaging",
    };
}

export type TaskScaffoldPlan =
    | {
        readonly status: "scaffold";
        readonly nextStatus: typeof EXPERIMENT_STATUS_SCAFFOLDED;
        readonly regressed: boolean;
    }
    | {
        readonly status: "noop";
        readonly regressed: boolean;
    };

export function planTaskScaffolded(input: {
    readonly experimentStatus: string;
    readonly lockedVerdict: string | null;
}): TaskScaffoldPlan {
    const regressed = input.lockedVerdict === LIFECYCLE_VERDICT_REGRESSED;
    if (input.experimentStatus === EXPERIMENT_STATUS_TASK_EMITTED) {
        return {
            status: "scaffold",
            nextStatus: EXPERIMENT_STATUS_SCAFFOLDED,
            regressed,
        };
    }
    return { status: "noop", regressed };
}

export type VerdictValidation =
    | { readonly valid: true; readonly verdict: LifecycleVerdict }
    | { readonly valid: false; readonly message: string };

export function validateLifecycleVerdict(verdict: string): VerdictValidation {
    if (LIFECYCLE_VERDICT_SET.has(verdict)) {
        return { valid: true, verdict: verdict as LifecycleVerdict };
    }
    return {
        valid: false,
        message: `verdict must be one of: ${LIFECYCLE_VERDICTS.join(", ")}`,
    };
}

export type LockVerdictPlan =
    | {
        readonly status: "ok";
        readonly verdict: LifecycleVerdict;
    }
    | {
        readonly status: "invalid_verdict" | "verdict_locked";
        readonly message: string;
    };

export function planLockVerdict(input: {
    readonly requestedVerdict: string;
    readonly lockedVerdict: string | null;
}): LockVerdictPlan {
    const verdict = validateLifecycleVerdict(input.requestedVerdict);
    if (!verdict.valid) {
        return {
            status: "invalid_verdict",
            message: verdict.message,
        };
    }
    if (input.lockedVerdict) {
        return {
            status: "verdict_locked",
            message: `experiment already locked: ${input.lockedVerdict}`,
        };
    }
    return {
        status: "ok",
        verdict: verdict.verdict,
    };
}

export type RetroPlanRegistrationPlan =
    | {
        readonly proposalStatus: typeof PROPOSAL_STATUS_ACCEPTED;
        readonly createExperiment: true;
        readonly experimentStatus: typeof EXPERIMENT_STATUS_SCAFFOLDED;
        readonly safetyMessage: null;
    }
    | {
        readonly proposalStatus: typeof PROPOSAL_STATUS_OPEN;
        readonly createExperiment: false;
        readonly experimentStatus: null;
        readonly safetyMessage: string | null;
    };

export function planRetroPlanRegistration(input: {
    readonly form: string;
    readonly leaveOpen: boolean;
    readonly safetyContract?: InterventionSafetyContract | null;
}): RetroPlanRegistrationPlan {
    if (input.leaveOpen) {
        return {
            proposalStatus: PROPOSAL_STATUS_OPEN,
            createExperiment: false,
            experimentStatus: null,
            safetyMessage: null,
        };
    }
    if (!isAcceptedProposalForm(input.form)) {
        return {
            proposalStatus: PROPOSAL_STATUS_OPEN,
            createExperiment: false,
            experimentStatus: null,
            safetyMessage: interventionSafetyMessage(input.form, input.safetyContract),
        };
    }
    return {
        proposalStatus: PROPOSAL_STATUS_ACCEPTED,
        createExperiment: true,
        experimentStatus: EXPERIMENT_STATUS_SCAFFOLDED,
        safetyMessage: null,
    };
}

export function interventionStrengthForConfidence(
    confidence: InterventionConfidence,
): InterventionStrength {
    return confidence === "medium" ? "workflow" : "advisory";
}

export function interventionObservationStatus(input: {
    readonly currentRisk: boolean;
    readonly graphRisk: boolean;
}): InterventionObservationStatus {
    return input.currentRisk || input.graphRisk ? "observed" : "needs_more_evidence";
}
