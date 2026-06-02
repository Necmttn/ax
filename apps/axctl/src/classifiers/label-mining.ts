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
    /** DB-derived intent classification (e.g. 'organic_task' | 'correction' | 'preference'). */
    readonly intentKind?: string | null;
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

const matchWeakLabel = (text: string, intentKind?: string | null): WeakMatch | null => {
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

    // Fallback: broaden organic extraction using the DB-derived `intent_kind`
    // when the high-precision text patterns miss. These remain weak labels
    // (reviewed before any promotion), so a derived-classifier signal is fine.
    switch (intentKind) {
        case "correction":
            return {
                label_family: "correction",
                target: "wrong_output",
                confidence: 0.7,
                sources: ["intent:correction"],
                requiresPreviousAssistant: true,
            };
        case "preference":
            return {
                label_family: "direction",
                target: "stated_preference",
                confidence: 0.7,
                sources: ["intent:preference"],
                requiresPreviousAssistant: false,
            };
        default:
            return null;
    }
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

        const match = matchWeakLabel(text, window.userTurn.intentKind);
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
 * Review queue export.
 *
 * Pure transform from mined candidates into a bounded, diversity-ordered review
 * queue. No DB access, no model calls. The service layer (label-mining-service)
 * reads transcript windows, calls {@link mineTranscriptLabelCandidates}, then
 * hands the candidates here. Every exported row carries the candidate id, at
 * least one evidence path, the previous-assistant excerpt (when the family
 * required it), and pending-review fields so a reviewer can fill them in.
 * ------------------------------------------------------------------------- */

/** Max review rows exported per batch (plan Iteration Rule: <= 80 review rows). */
export const EXPORT_REVIEW_LIMIT = 80;

/**
 * One pending review-queue row. Mirrors {@link TranscriptReviewedLabel} from the
 * plan's Data Model but in its un-reviewed state: `review_status` is always
 * `"pending"`, reviewer/label/target are blank until a human fills them in.
 */
export interface LabelMiningReviewRow {
    readonly candidate_id: string;
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
    readonly review_status: "pending";
    readonly reviewed_label?: string;
    readonly reviewed_target?: string;
    readonly rationale: string;
    readonly reviewer: string;
}

/** Family/confidence summary of an exported review queue. */
export interface LabelMiningReviewDiversity {
    readonly label_family_count: number;
    readonly label_family_counts: Readonly<Record<string, number>>;
    readonly min_weak_confidence: number;
    readonly max_weak_confidence: number;
}

export interface LabelMiningReviewQueue {
    readonly review_rows: readonly LabelMiningReviewRow[];
    readonly diversity: LabelMiningReviewDiversity;
}

const toReviewRow = (candidate: TranscriptLabelCandidate): LabelMiningReviewRow => ({
    candidate_id: candidate.id,
    subject_id: candidate.subject_id,
    session_id: candidate.session_id,
    turn_id: candidate.turn_id,
    ...(candidate.previous_assistant_turn_id !== undefined
        ? { previous_assistant_turn_id: candidate.previous_assistant_turn_id }
        : {}),
    label_family: candidate.label_family,
    target: candidate.target,
    weak_label: candidate.weak_label,
    weak_confidence: candidate.weak_confidence,
    weak_sources: candidate.weak_sources,
    evidence_paths: candidate.evidence_paths,
    excerpt: candidate.excerpt,
    ...(candidate.previous_assistant_excerpt !== undefined
        ? { previous_assistant_excerpt: candidate.previous_assistant_excerpt }
        : {}),
    review_status: "pending",
    rationale: "",
    reviewer: "",
});

/**
 * Build a bounded, diversity-ordered review queue from mined candidates.
 *
 * Ordering is a confidence-ranked round-robin across label families: within
 * each family candidates are sorted by descending weak confidence (ties broken
 * by candidate id for determinism), then families are interleaved one row at a
 * time, families themselves ordered by their top candidate's confidence. This
 * front-loads diversity (every represented family appears before any repeats)
 * while still preferring high-confidence candidates. The result is capped at
 * `min(limit, EXPORT_REVIEW_LIMIT)` rows.
 */
export function buildReviewQueue(input: {
    readonly candidates: readonly TranscriptLabelCandidate[];
    readonly limit?: number;
}): LabelMiningReviewQueue {
    const cap = Math.min(
        input.limit ?? EXPORT_REVIEW_LIMIT,
        EXPORT_REVIEW_LIMIT,
    );

    const byFamily = new Map<LabelFamily, TranscriptLabelCandidate[]>();
    for (const candidate of input.candidates) {
        const bucket = byFamily.get(candidate.label_family);
        if (bucket) bucket.push(candidate);
        else byFamily.set(candidate.label_family, [candidate]);
    }

    const sortDesc = (a: TranscriptLabelCandidate, b: TranscriptLabelCandidate): number =>
        b.weak_confidence - a.weak_confidence || a.id.localeCompare(b.id);

    const families = [...byFamily.entries()].map(([family, candidates]) => ({
        family,
        candidates: [...candidates].sort(sortDesc),
    }));
    // Order families by their strongest candidate so the highest-confidence
    // family leads the round-robin.
    families.sort((a, b) =>
        (b.candidates[0]?.weak_confidence ?? 0) - (a.candidates[0]?.weak_confidence ?? 0)
        || a.family.localeCompare(b.family));

    const ordered: TranscriptLabelCandidate[] = [];
    let round = 0;
    let added = true;
    while (added && ordered.length < cap) {
        added = false;
        for (const entry of families) {
            const candidate = entry.candidates[round];
            if (candidate === undefined) continue;
            ordered.push(candidate);
            added = true;
            if (ordered.length >= cap) break;
        }
        round += 1;
    }

    const review_rows = ordered.map(toReviewRow);

    const family_counts: Record<string, number> = {};
    let min_weak_confidence = review_rows.length > 0 ? Number.POSITIVE_INFINITY : 0;
    let max_weak_confidence = 0;
    for (const row of review_rows) {
        family_counts[row.label_family] = (family_counts[row.label_family] ?? 0) + 1;
        if (row.weak_confidence < min_weak_confidence) min_weak_confidence = row.weak_confidence;
        if (row.weak_confidence > max_weak_confidence) max_weak_confidence = row.weak_confidence;
    }

    return {
        review_rows,
        diversity: {
            label_family_count: Object.keys(family_counts).length,
            label_family_counts: family_counts,
            min_weak_confidence: review_rows.length > 0 ? min_weak_confidence : 0,
            max_weak_confidence,
        },
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

/* ------------------------------------------------------------------------- *
 * Reviewed graph + vector projection.
 *
 * Pure transform from accepted/rejected/deferred reviewed labels into
 * classifier_graph_* rows (node/edge/fact) plus transcript_label_vector and
 * transcript_label_review rows. No DB access. The projection is deterministic:
 * every emitted row carries a stable id derived from the candidate id, so the
 * generated UPSERT statements are idempotent (re-running over the same input
 * yields byte-identical statements and rewrites the same records).
 *
 * Promotion contract (plan Data Model "Graph Fact Contract"):
 *   - Only `review_status === "accepted"` rows become promotion-safe graph
 *     facts (`promotion_safe: true`). Rejected/deferred/revised rows are stored
 *     for provenance with `promotion_safe: false` and emit no graph facts.
 *   - Vector rows are recorded for every supplied vector; their `graph_fact_id`
 *     is set only when the candidate has an accepted reviewed fact to join to.
 * ------------------------------------------------------------------------- */

/** Reviewed label artifact (plan Data Model). Input to the projection. */
export interface TranscriptReviewedLabel {
    readonly candidate_id: string;
    readonly review_status: "accepted" | "rejected" | "revised" | "deferred";
    readonly reviewed_label?: string;
    readonly reviewed_target?: string;
    readonly rationale: string;
    readonly reviewer: string;
    readonly reviewed_at: string;
}

/** Vector row artifact (plan Data Model). Input to the projection. */
export interface TranscriptLabelVectorRow {
    readonly id: string;
    readonly candidate_id: string;
    readonly graph_fact_id?: string;
    readonly embedding_model: string;
    readonly embedding_dim: number;
    readonly embedding_ref: string;
    readonly nearest_reviewed_candidate_ids: readonly string[];
    readonly nearest_scores: readonly number[];
}

/** Projected `classifier_graph_node` row. */
export interface LabelMiningGraphNode {
    readonly graph_id: string;
    readonly kind: string;
    readonly label: string;
    readonly properties_json: string;
    readonly source_kind: string;
}

/** Projected `classifier_graph_edge` row (evidence link). */
export interface LabelMiningGraphEdge {
    readonly graph_id: string;
    readonly kind: string;
    readonly from_id: string;
    readonly to_id: string;
    readonly evidence_path: string;
    readonly properties_json: string;
    readonly source_kind: string;
}

/** Projected `classifier_graph_fact` row. */
export interface LabelMiningGraphFact {
    readonly graph_id: string;
    readonly kind: "transcript_reviewed_label";
    readonly subject: string;
    readonly predicate:
        | "reviewed_label"
        | "reviewed_target"
        | "nearest_reviewed_neighbor"
        | "promotion_safety";
    readonly object?: string;
    readonly value_json?: string;
    readonly evidence_edges_json: string;
    readonly properties_json: string;
    readonly source_kind: "transcript_label_mining_reviewed";
}

/** Persisted reviewed-status row (`transcript_label_review` table). */
export interface LabelMiningReviewedRow {
    readonly candidate_id: string;
    readonly graph_fact_id?: string;
    readonly label_family: LabelFamily;
    readonly review_status: TranscriptReviewedLabel["review_status"];
    readonly promotion_safe: boolean;
    readonly reviewed_label?: string;
    readonly reviewed_target?: string;
    readonly reviewer: string;
    readonly rationale: string;
    readonly reviewed_at: string;
    readonly evidence_paths: readonly string[];
}

/** Persisted vector row (`transcript_label_vector` table) with graph join. */
export interface LabelMiningVectorRow {
    readonly id: string;
    readonly candidate_id: string;
    readonly graph_fact_id?: string;
    readonly embedding_model: string;
    readonly embedding_dim: number;
    readonly embedding_ref: string;
    readonly nearest_reviewed_candidate_ids: readonly string[];
    readonly nearest_scores: readonly number[];
}

export interface LabelMiningGraphProjection {
    readonly nodes: readonly LabelMiningGraphNode[];
    readonly edges: readonly LabelMiningGraphEdge[];
    readonly facts: readonly LabelMiningGraphFact[];
    readonly review_rows: readonly LabelMiningReviewedRow[];
    readonly vector_rows: readonly LabelMiningVectorRow[];
    /** Idempotent UPSERT statements (deterministic order) for all rows above. */
    readonly statements: readonly string[];
    readonly accepted_count: number;
    readonly promotion_safe_fact_count: number;
}

const stableId = (parts: readonly string[]): string =>
    Bun.hash(parts.join("|")).toString(16).slice(0, 16);

const graphNodeId = (candidateId: string): string =>
    `tlmg_node__${safeKeyPart(candidateId)}__${stableId(["node", candidateId])}`;

const graphFactId = (candidateId: string, predicate: string): string =>
    `tlmg_fact__${safeKeyPart(candidateId)}__${safeKeyPart(predicate)}__${stableId([
        "fact",
        candidateId,
        predicate,
    ])}`;

const graphEdgeId = (candidateId: string, idx: number): string =>
    `tlmg_edge__${safeKeyPart(candidateId)}__${idx}__${stableId(["edge", candidateId, String(idx)])}`;

/** Deterministic SurrealQL string literal (escapes `\` and `'`). */
const surqlString = (value: string): string =>
    `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * Build a single idempotent UPSERT keyed by the row's stable string id. Fields
 * are emitted in a fixed order so re-running over identical input is byte-stable.
 */
const upsert = (
    table: string,
    id: string,
    fields: readonly (readonly [string, string])[],
): string => {
    const set = fields.map(([key, expr]) => `${key} = ${expr}`).join(", ");
    return `UPSERT ${table}:${surqlString(id)} SET ${set}`;
};

const PROMOTION_SAFE_STATUS = "accepted" as const;

export function projectReviewedLabelsToGraph(input: {
    readonly candidates: readonly TranscriptLabelCandidate[];
    readonly reviews: readonly TranscriptReviewedLabel[];
    readonly vectors: readonly TranscriptLabelVectorRow[];
}): LabelMiningGraphProjection {
    const candidateById = new Map<string, TranscriptLabelCandidate>();
    for (const candidate of input.candidates) candidateById.set(candidate.id, candidate);

    const nodes: LabelMiningGraphNode[] = [];
    const edges: LabelMiningGraphEdge[] = [];
    const facts: LabelMiningGraphFact[] = [];
    const reviewRows: LabelMiningReviewedRow[] = [];
    const statements: string[] = [];

    // Accepted reviews keyed by candidate id, used to join vector rows back.
    const acceptedFactByCandidate = new Map<string, string>();
    let acceptedCount = 0;
    let promotionSafeFactCount = 0;

    // Deterministic order: reviews sorted by candidate id.
    const sortedReviews = [...input.reviews].sort((a, b) =>
        a.candidate_id.localeCompare(b.candidate_id));

    for (const review of sortedReviews) {
        const candidate = candidateById.get(review.candidate_id);
        const labelFamily: LabelFamily = candidate?.label_family ?? "none";
        const evidencePaths = candidate?.evidence_paths ?? [];
        const isAccepted = review.review_status === PROMOTION_SAFE_STATUS;
        const promotionSafe = isAccepted;

        const reviewRow: LabelMiningReviewedRow = {
            candidate_id: review.candidate_id,
            label_family: labelFamily,
            review_status: review.review_status,
            promotion_safe: promotionSafe,
            ...(review.reviewed_label !== undefined ? { reviewed_label: review.reviewed_label } : {}),
            ...(review.reviewed_target !== undefined ? { reviewed_target: review.reviewed_target } : {}),
            reviewer: review.reviewer,
            rationale: review.rationale,
            reviewed_at: review.reviewed_at,
            evidence_paths: evidencePaths,
        };

        if (!isAccepted) {
            reviewRows.push(reviewRow);
            continue;
        }

        acceptedCount += 1;

        // Graph node for the accepted candidate.
        const nodeId = graphNodeId(review.candidate_id);
        const nodeProps = JSON.stringify({
            candidate_id: review.candidate_id,
            label_family: labelFamily,
            review_status: review.review_status,
            promotion_safe: true,
        });
        nodes.push({
            graph_id: nodeId,
            kind: "transcript_reviewed_label",
            label: review.reviewed_label ?? candidate?.weak_label ?? labelFamily,
            properties_json: nodeProps,
            source_kind: "transcript_label_mining_reviewed",
        });

        // Evidence edges: one per evidence path (deterministic order).
        const edgeIds: string[] = [];
        evidencePaths.forEach((path, idx) => {
            const edgeId = graphEdgeId(review.candidate_id, idx);
            edgeIds.push(edgeId);
            edges.push({
                graph_id: edgeId,
                kind: "reviewed_evidence",
                from_id: nodeId,
                to_id: `evidence:${review.candidate_id}:${idx}`,
                evidence_path: path,
                properties_json: JSON.stringify({ candidate_id: review.candidate_id, kind: "evidence_path" }),
                source_kind: "transcript_label_mining_reviewed",
            });
        });
        const evidenceEdgesJson = JSON.stringify(edgeIds);
        const factProps = JSON.stringify({
            candidate_id: review.candidate_id,
            review_status: review.review_status,
            promotion_safe: true,
            reviewer: review.reviewer,
        });

        // The reviewed_label fact is the canonical promotion-safe fact a vector
        // row joins back to.
        const reviewedLabelFactId = graphFactId(review.candidate_id, "reviewed_label");
        acceptedFactByCandidate.set(review.candidate_id, reviewedLabelFactId);

        const factSpecs: readonly {
            readonly predicate: LabelMiningGraphFact["predicate"];
            readonly object?: string;
            readonly value_json?: string;
        }[] = [
            { predicate: "reviewed_label", object: review.reviewed_label ?? labelFamily },
            ...(review.reviewed_target !== undefined
                ? [{ predicate: "reviewed_target" as const, object: review.reviewed_target }]
                : []),
            { predicate: "promotion_safety", value_json: JSON.stringify({ promotion_safe: true }) },
        ];

        for (const spec of factSpecs) {
            const factId = graphFactId(review.candidate_id, spec.predicate);
            if (spec.predicate === "promotion_safety") promotionSafeFactCount += 1;
            facts.push({
                graph_id: factId,
                kind: "transcript_reviewed_label",
                subject: review.candidate_id,
                predicate: spec.predicate,
                ...(spec.object !== undefined ? { object: spec.object } : {}),
                ...(spec.value_json !== undefined ? { value_json: spec.value_json } : {}),
                evidence_edges_json: evidenceEdgesJson,
                properties_json: factProps,
                source_kind: "transcript_label_mining_reviewed",
            });
        }

        reviewRows.push({ ...reviewRow, graph_fact_id: reviewedLabelFactId });
    }

    // Vector rows: record all supplied vectors, join to accepted fact when present.
    const sortedVectors = [...input.vectors].sort((a, b) =>
        a.candidate_id.localeCompare(b.candidate_id));
    const vectorRows: LabelMiningVectorRow[] = sortedVectors.map((vector) => {
        const graphFact = acceptedFactByCandidate.get(vector.candidate_id);
        return {
            id: vector.id,
            candidate_id: vector.candidate_id,
            ...(graphFact !== undefined ? { graph_fact_id: graphFact } : {}),
            embedding_model: vector.embedding_model,
            embedding_dim: vector.embedding_dim,
            embedding_ref: vector.embedding_ref,
            nearest_reviewed_candidate_ids: vector.nearest_reviewed_candidate_ids,
            nearest_scores: vector.nearest_scores,
        };
    });

    // Emit nearest_reviewed_neighbor facts for accepted candidates with neighbors.
    for (const vector of sortedVectors) {
        if (!acceptedFactByCandidate.has(vector.candidate_id)) continue;
        if (vector.nearest_reviewed_candidate_ids.length === 0) continue;
        const factId = graphFactId(vector.candidate_id, "nearest_reviewed_neighbor");
        facts.push({
            graph_id: factId,
            kind: "transcript_reviewed_label",
            subject: vector.candidate_id,
            predicate: "nearest_reviewed_neighbor",
            value_json: JSON.stringify({
                nearest_reviewed_candidate_ids: vector.nearest_reviewed_candidate_ids,
                nearest_scores: vector.nearest_scores,
            }),
            evidence_edges_json: JSON.stringify([]),
            properties_json: JSON.stringify({
                candidate_id: vector.candidate_id,
                promotion_safe: true,
            }),
            source_kind: "transcript_label_mining_reviewed",
        });
    }

    // Build idempotent UPSERT statements in a fixed, deterministic order.
    for (const node of [...nodes].sort((a, b) => a.graph_id.localeCompare(b.graph_id))) {
        statements.push(upsert("classifier_graph_node", node.graph_id, [
            ["graph_id", surqlString(node.graph_id)],
            ["kind", surqlString(node.kind)],
            ["label", surqlString(node.label)],
            ["properties_json", surqlString(node.properties_json)],
            ["source_kind", surqlString(node.source_kind)],
        ]));
    }
    for (const edge of [...edges].sort((a, b) => a.graph_id.localeCompare(b.graph_id))) {
        statements.push(upsert("classifier_graph_edge", edge.graph_id, [
            ["graph_id", surqlString(edge.graph_id)],
            ["kind", surqlString(edge.kind)],
            ["from_id", surqlString(edge.from_id)],
            ["to_id", surqlString(edge.to_id)],
            ["evidence_path", surqlString(edge.evidence_path)],
            ["properties_json", surqlString(edge.properties_json)],
            ["source_kind", surqlString(edge.source_kind)],
        ]));
    }
    for (const fact of [...facts].sort((a, b) => a.graph_id.localeCompare(b.graph_id))) {
        statements.push(upsert("classifier_graph_fact", fact.graph_id, [
            ["graph_id", surqlString(fact.graph_id)],
            ["kind", surqlString(fact.kind)],
            ["subject", surqlString(fact.subject)],
            ["predicate", surqlString(fact.predicate)],
            ["object", fact.object !== undefined ? surqlString(fact.object) : "NONE"],
            ["value_json", fact.value_json !== undefined ? surqlString(fact.value_json) : "NONE"],
            ["evidence_edges_json", surqlString(fact.evidence_edges_json)],
            ["properties_json", surqlString(fact.properties_json)],
            ["source_kind", surqlString(fact.source_kind)],
        ]));
    }
    for (const row of [...reviewRows].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id))) {
        statements.push(upsert("transcript_label_review", row.candidate_id, [
            ["candidate_id", surqlString(row.candidate_id)],
            ["graph_fact_id", row.graph_fact_id !== undefined ? surqlString(row.graph_fact_id) : "NONE"],
            ["label_family", surqlString(row.label_family)],
            ["review_status", surqlString(row.review_status)],
            ["promotion_safe", row.promotion_safe ? "true" : "false"],
            ["reviewed_label", row.reviewed_label !== undefined ? surqlString(row.reviewed_label) : "NONE"],
            ["reviewed_target", row.reviewed_target !== undefined ? surqlString(row.reviewed_target) : "NONE"],
            ["reviewer", surqlString(row.reviewer)],
            ["rationale", surqlString(row.rationale)],
            ["evidence_paths_json", surqlString(JSON.stringify(row.evidence_paths))],
        ]));
    }
    for (const row of [...vectorRows].sort((a, b) => a.id.localeCompare(b.id))) {
        statements.push(upsert("transcript_label_vector", row.id, [
            ["candidate_id", surqlString(row.candidate_id)],
            ["graph_fact_id", row.graph_fact_id !== undefined ? surqlString(row.graph_fact_id) : "NONE"],
            ["embedding_model", surqlString(row.embedding_model)],
            ["embedding_dim", String(row.embedding_dim)],
            ["embedding_ref", surqlString(row.embedding_ref)],
            ["nearest_reviewed_candidate_ids_json", surqlString(JSON.stringify(row.nearest_reviewed_candidate_ids))],
            ["nearest_scores_json", surqlString(JSON.stringify(row.nearest_scores))],
        ]));
    }

    return {
        nodes,
        edges,
        facts,
        review_rows: reviewRows,
        vector_rows: vectorRows,
        statements,
        accepted_count: acceptedCount,
        promotion_safe_fact_count: promotionSafeFactCount,
    };
}
