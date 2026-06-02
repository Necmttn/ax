import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import { isControlOrContextText } from "./control-text.ts";

/**
 * Pure candidate-mining for the transcript label-mining experiment.
 *
 * No DB access, no model calls. Deterministic weak-label extraction from
 * structurally-compatible event windows. Every emitted candidate must carry
 * evidence paths, and every excerpt field is capped at {@link EXCERPT_CAP}.
 */

export const EXCERPT_CAP = 600;

export type LabelFamily =
    | "correction"
    | "direction"
    | "verification"
    | "approval_or_rejection"
    | "workflow_state"
    | "none";

export interface TranscriptLabelCandidate {
    readonly id: string;
    readonly source_kind: "transcript_label_mining";
    readonly subject_type: "event_window";
    readonly subject_id: string;
    readonly session_id: string;
    readonly turn_id: string;
    readonly previous_assistant_turn_id?: string;
    readonly label_family: LabelFamily;
    readonly target: string;
    readonly weak_label: string;
    readonly weak_confidence: number;
    readonly weak_sources: readonly string[];
    readonly evidence_paths: readonly string[];
    readonly excerpt: string;
    readonly previous_assistant_excerpt?: string;
}

/**
 * Minimal structural shape this module consumes. Real `EventWindow`s from
 * `event-window.ts` are adapted into this shape upstream; tests build it
 * directly. Kept intentionally narrow so mining stays a pure transform.
 */
export interface EventWindowTurnLike {
    readonly id: string;
    readonly seq?: number;
    readonly role?: string;
    readonly messageKind?: string | null;
    readonly text: string;
    readonly ts?: Date | string;
    readonly evidencePath?: string | null;
}

export interface EventWindowLike {
    readonly key?: string;
    readonly subjectType?: string;
    readonly subjectId: string;
    readonly sessionId: string | null;
    readonly userTurn: EventWindowTurnLike;
    readonly previousAssistantTurn?: EventWindowTurnLike | null;
    readonly evidencePaths?: readonly string[];
}

const capExcerpt = (text: string): string => text.trim().slice(0, EXCERPT_CAP);

const collectEvidencePaths = (window: EventWindowLike): readonly string[] => {
    const paths = new Set<string>();
    for (const path of window.evidencePaths ?? []) {
        if (typeof path === "string" && path.trim().length > 0) paths.add(path.trim());
    }
    const userPath = window.userTurn.evidencePath;
    if (typeof userPath === "string" && userPath.trim().length > 0) paths.add(userPath.trim());
    return [...paths];
};

interface WeakMatch {
    readonly label_family: LabelFamily;
    readonly target: string;
    readonly confidence: number;
    readonly sources: readonly string[];
    readonly requiresPreviousAssistant: boolean;
}

const matchWeakLabel = (text: string): WeakMatch | null => {
    const lower = text.toLowerCase();

    // Verification demands first: questions about checks/tests/results.
    if (/\b(did you (run|test|check)|have you (run|tested|checked)|are the tests passing|run the tests|does it (build|pass)|verify)\b/i.test(lower)) {
        return {
            label_family: "verification",
            target: "verification_demand",
            confidence: 0.84,
            sources: ["verification:demand"],
            requiresPreviousAssistant: false,
        };
    }

    // Direction / tooling preference.
    if (/\buv\b|\b(use bun|use pnpm|use nix|don'?t use npm|don'?t use pip|don'?t use yarn)\b/i.test(lower)) {
        return {
            label_family: "direction",
            target: "tooling_preference",
            confidence: 0.82,
            sources: ["direction:tooling_preference"],
            requiresPreviousAssistant: true,
        };
    }

    // Approval / rejection.
    if (/^(lgtm|ship it|approved|looks good)\b|\b(lgtm|ship it|merge it|looks good to me)\b/i.test(lower)) {
        return {
            label_family: "approval_or_rejection",
            target: "approval",
            confidence: 0.78,
            sources: ["approval_or_rejection:approval"],
            requiresPreviousAssistant: false,
        };
    }

    // Correction caused by previous assistant action.
    if (/^(no|nope|nah)\b|\b(wrong|not what i asked|not that|that'?s wrong|incorrect|revert)\b/i.test(lower)) {
        return {
            label_family: "correction",
            target: "wrong_output",
            confidence: 0.74,
            sources: ["correction:wrong_output"],
            requiresPreviousAssistant: true,
        };
    }

    return null;
};

const candidateId = (input: {
    readonly subjectId: string;
    readonly labelFamily: LabelFamily;
    readonly target: string;
}): string => {
    const stable = [input.subjectId, input.labelFamily, input.target].join("|");
    return [
        "tlm",
        safeKeyPart(input.labelFamily),
        Bun.hash(stable).toString(16).slice(0, 16),
    ].join("__");
};

const isWrapperLike = (window: EventWindowLike, text: string): boolean => {
    if (text.length === 0) return true;
    if (isControlOrContextText(text)) return true;
    const kind = window.userTurn.messageKind;
    if (kind === "system_or_developer" || kind === "system" || kind === "developer") return true;
    const role = window.userTurn.role;
    if (role !== undefined && role !== "user") return true;
    if (/^(system reminder|<system-reminder>|<subagent_notification>)/i.test(text)) return true;
    return false;
};

export function mineTranscriptLabelCandidates(input: {
    readonly windows: readonly EventWindowLike[];
    readonly limit: number;
}): readonly TranscriptLabelCandidate[] {
    const out: TranscriptLabelCandidate[] = [];
    const seen = new Set<string>();

    for (const window of input.windows) {
        if (out.length >= input.limit) break;
        const text = window.userTurn.text.trim();
        if (isWrapperLike(window, text)) continue;

        const match = matchWeakLabel(text);
        if (!match) continue;

        const hasPreviousAssistant = !!window.previousAssistantTurn
            && window.previousAssistantTurn.text.trim().length > 0;
        if (match.requiresPreviousAssistant && !hasPreviousAssistant) continue;

        const evidencePaths = collectEvidencePaths(window);
        if (evidencePaths.length === 0) continue;

        const id = candidateId({
            subjectId: window.subjectId,
            labelFamily: match.label_family,
            target: match.target,
        });
        if (seen.has(id)) continue;
        seen.add(id);

        const candidate: TranscriptLabelCandidate = {
            id,
            source_kind: "transcript_label_mining",
            subject_type: "event_window",
            subject_id: window.subjectId,
            session_id: window.sessionId ?? "unknown",
            turn_id: window.userTurn.id,
            ...(window.previousAssistantTurn
                ? { previous_assistant_turn_id: window.previousAssistantTurn.id }
                : {}),
            label_family: match.label_family,
            target: match.target,
            weak_label: match.label_family,
            weak_confidence: match.confidence,
            weak_sources: match.sources,
            evidence_paths: evidencePaths,
            excerpt: capExcerpt(text),
            ...(hasPreviousAssistant && window.previousAssistantTurn
                ? { previous_assistant_excerpt: capExcerpt(window.previousAssistantTurn.text) }
                : {}),
        };
        out.push(candidate);
    }

    return out;
}

const WRAPPER_FAMILIES = new Set<LabelFamily>(["none"]);
const MIN_FAMILY_DIVERSITY = 4;

/**
 * Output of {@link auditWeakCandidateBatch}. Also the candidate-side input to
 * {@link evaluateLabelMiningIteration}: `failures` carries any
 * `failed_missing_evidence` / `failed_empty_batch` /
 * `failed_insufficient_family_diversity` tokens forward into iteration gating.
 */
export interface LabelMiningCandidateAudit {
    readonly candidate_count: number;
    readonly label_family_counts: Readonly<Record<string, number>>;
    readonly wrapper_like_count: number;
    readonly evidence_missing_count: number;
    readonly decision: "candidate_batch_ready" | "candidate_batch_failed";
    readonly failures: readonly string[];
}

export function auditWeakCandidateBatch(
    candidates: readonly TranscriptLabelCandidate[],
): LabelMiningCandidateAudit {
    const family_counts: Record<string, number> = {};
    let wrapper_like_count = 0;
    let evidence_missing_count = 0;

    for (const candidate of candidates) {
        family_counts[candidate.label_family] = (family_counts[candidate.label_family] ?? 0) + 1;
        if (WRAPPER_FAMILIES.has(candidate.label_family)) wrapper_like_count += 1;
        if (candidate.evidence_paths.length === 0) evidence_missing_count += 1;
    }

    const failures: string[] = [];
    if (candidates.length === 0) failures.push("failed_empty_batch");
    if (evidence_missing_count > 0) failures.push("failed_missing_evidence");

    const meaningfulFamilies = Object.keys(family_counts).filter(
        (family) => !WRAPPER_FAMILIES.has(family as LabelFamily),
    );
    if (meaningfulFamilies.length < MIN_FAMILY_DIVERSITY) {
        failures.push("failed_insufficient_family_diversity");
    }

    return {
        candidate_count: candidates.length,
        label_family_counts: family_counts,
        wrapper_like_count,
        evidence_missing_count,
        decision: failures.length === 0 ? "candidate_batch_ready" : "candidate_batch_failed",
        failures,
    };
}

/* ------------------------------------------------------------------------- *
 * Bounded experiment gates.
 *
 * Pure evaluator over per-iteration metrics + audits. Enforces the plan's
 * Iteration Rules (stop conditions) and Failure Cases (hard fails) for the
 * transcript label-mining experiment. No DB access, no model calls.
 * ------------------------------------------------------------------------- */

/** Max implementation iterations before {@link STOP_FOR_ITERATION_LIMIT}. */
export const MAX_LABEL_MINING_ITERATIONS = 8;
/** Hard floor: candidate precision on reviewed rows below this is a failure. */
export const MIN_CANDIDATE_PRECISION = 0.65;
/** Consecutive no-improvement iterations that trigger no-progress stop. */
export const NO_PROGRESS_ITERATIONS = 2;

/**
 * Per-iteration usefulness metrics. Stop-for-no-progress fires only when none
 * of these improve across {@link NO_PROGRESS_ITERATIONS} consecutive iterations.
 */
export interface LabelMiningMetrics {
    readonly review_precision: number;
    readonly accepted_label_count: number;
    readonly neighbor_recall: number;
    readonly graph_fact_count: number;
    readonly product_query_result_count: number;
}

/**
 * Promotion-side audit. `unsafe_promoted_count > 0` means weak/model-only rows
 * reached promotion without review (a hard failure); `candidate_precision` is
 * measured on the reviewed sample.
 */
export interface LabelMiningPromotionAudit {
    readonly promoted_count: number;
    readonly reviewed_promoted_count: number;
    readonly unsafe_promoted_count: number;
    readonly candidate_precision: number;
}

export type LabelMiningStopReason =
    | "stop_for_no_progress"
    | "stop_for_iteration_limit";

export type LabelMiningFailure =
    | "failed_candidate_precision"
    | "failed_missing_evidence"
    | "failed_unsafe_promotion";

export interface LabelMiningIterationDecision {
    readonly decision: "continue" | "stop" | "fail";
    readonly can_continue: boolean;
    readonly stop_reason: LabelMiningStopReason | null;
    readonly failures: readonly LabelMiningFailure[];
    readonly next_action: string;
}

const METRIC_KEYS = [
    "review_precision",
    "accepted_label_count",
    "neighbor_recall",
    "graph_fact_count",
    "product_query_result_count",
] as const satisfies readonly (keyof LabelMiningMetrics)[];

const improvesAny = (
    current: LabelMiningMetrics,
    previous: LabelMiningMetrics,
): boolean => METRIC_KEYS.some((key) => current[key] > previous[key]);

/**
 * Evaluate one bounded experiment iteration.
 *
 * Priority: hard failures first (a failing iteration must not be reported as a
 * benign stop), then stop conditions, then continue. Failures are collected
 * from both the candidate audit (evidence) and the promotion audit (precision,
 * unsafe promotion).
 */
export function evaluateLabelMiningIteration(input: {
    readonly iteration: number;
    readonly expensive_model_runs: number;
    readonly previous_metrics: readonly LabelMiningMetrics[];
    readonly current_metrics: LabelMiningMetrics;
    readonly candidate_audit: LabelMiningCandidateAudit;
    readonly promotion_audit: LabelMiningPromotionAudit;
}): LabelMiningIterationDecision {
    const failures: LabelMiningFailure[] = [];

    if (input.promotion_audit.candidate_precision < MIN_CANDIDATE_PRECISION) {
        failures.push("failed_candidate_precision");
    }
    if (
        input.candidate_audit.evidence_missing_count > 0
        || input.candidate_audit.failures.includes("failed_missing_evidence")
    ) {
        failures.push("failed_missing_evidence");
    }
    if (input.promotion_audit.unsafe_promoted_count > 0) {
        failures.push("failed_unsafe_promotion");
    }

    if (failures.length > 0) {
        return {
            decision: "fail",
            can_continue: false,
            stop_reason: null,
            failures,
            next_action: `stop and treat as experiment failure: ${failures.join(", ")}`,
        };
    }

    if (input.iteration > MAX_LABEL_MINING_ITERATIONS) {
        return {
            decision: "stop",
            can_continue: false,
            stop_reason: "stop_for_iteration_limit",
            failures: [],
            next_action: `iteration limit (${MAX_LABEL_MINING_ITERATIONS}) reached; finalize results`,
        };
    }

    const recent = input.previous_metrics.slice(-NO_PROGRESS_ITERATIONS);
    if (recent.length >= NO_PROGRESS_ITERATIONS) {
        const chain = [...recent, input.current_metrics];
        let stalled = true;
        for (let i = 1; i < chain.length; i += 1) {
            if (improvesAny(chain[i]!, chain[i - 1]!)) {
                stalled = false;
                break;
            }
        }
        if (stalled) {
            return {
                decision: "stop",
                can_continue: false,
                stop_reason: "stop_for_no_progress",
                failures: [],
                next_action: "no metric improved across consecutive iterations; stop tuning",
            };
        }
    }

    return {
        decision: "continue",
        can_continue: true,
        stop_reason: null,
        failures: [],
        next_action: "run next bounded iteration",
    };
}
