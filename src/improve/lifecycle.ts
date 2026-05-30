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
