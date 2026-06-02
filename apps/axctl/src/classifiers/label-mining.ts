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

export function auditWeakCandidateBatch(candidates: readonly TranscriptLabelCandidate[]): {
    readonly candidate_count: number;
    readonly label_family_counts: Readonly<Record<string, number>>;
    readonly wrapper_like_count: number;
    readonly evidence_missing_count: number;
    readonly decision: "candidate_batch_ready" | "candidate_batch_failed";
    readonly failures: readonly string[];
} {
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
