/**
 * Measurement eligibility - the one place that answers "may this experiment
 * receive a new measurement, and can anything actually detect its artifact?"
 * (#1134).
 *
 * Two readers share it: the opportunities derive stage (which evidence to
 * collect, and from when) and the checkpoint stage (which windows to measure).
 * They used to disagree - opportunities windowed hooks/guidance on the OBSERVED
 * install while checkpoints counted sessions from acceptance, and neither
 * checked the experiment's lifecycle - so a retired or never-installed
 * experiment could still acquire a confident-looking verdict.
 *
 * The distinction this module exists to keep is between a MEASUREMENT and an
 * ABSENCE OF DATA. "No opportunities" is not "the pattern went away", and "no
 * detector for this form" is not "the artifact was ignored". Both are
 * insufficient data, and they are reported as such rather than resolved into
 * one of the five human verdicts.
 *
 * Pure by contract: plain values in, a verdict-shaped record out. It opens no
 * store, reads no filesystem, and introduces no service - the data-dependent
 * part (does a skill proposal cite a resolvable candidate?) is passed IN as a
 * boolean by whichever caller already did that cache lookup.
 */

/** Why an experiment cannot be measured right now - a lifecycle/identity fact,
 *  never a judgment about the artifact. */
export type IneligibleReason =
    | "not_accepted"
    | "not_started"
    | "retired"
    | "regressed"
    | "locked"
    | "artifact_unavailable";

/** Why a due window produced no suggested verdict. Mirrors the optional
 *  `reason` field written into `checkpoint.measured`. */
export type MeasurementReason =
    | "no_opportunities"
    | "detector_unavailable"
    | "artifact_unavailable"
    | "refresh_required";

/** The measured-JSON status flag. `measured` means a real ratio was computed
 *  over positive opportunities; everything else is absence of data. */
export type MeasurementStatus = "measured" | "insufficient_data";

/** The measured-JSON format version this chunk writes. Bumped together with the
 *  fields below; the opportunity DERIVATION version is a separate token
 *  (`opportunity-cache-version.ts`) because it certifies different facts. */
export const MEASUREMENT_VERSION = 2;

/** The additive fields written alongside the existing measured numbers. */
export interface MeasurementFields {
    readonly measurement_status: MeasurementStatus;
    readonly reason?: MeasurementReason;
    readonly measurement_version: number;
}

export interface MeasurementSubject {
    readonly proposalStatus: string;
    readonly experimentStatus: string;
    readonly lockedVerdict: string | null;
    readonly artifactPath: string | null;
    /** When `improve lint` OBSERVED the artifact installed. */
    readonly scaffoldedAt: Date | string | null;
}

export type Eligibility =
    | { readonly eligible: true }
    | { readonly eligible: false; readonly reason: IneligibleReason };

const ELIGIBLE: Eligibility = { eligible: true };

/** The install instant, or `null` when nothing usable was recorded. Accepts the
 *  sidecar's decoded `Date` and the ISO string every projection carries. */
export const installationTime = (value: Date | string | null | undefined): Date | null => {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * May this experiment receive a new measurement?
 *
 * All four conditions hold or none of it counts: the proposal is accepted, the
 * experiment reached `scaffolded` (`task_emitted` never installed anything,
 * `retired`/`regressed` are past their measurement life), no verdict is locked,
 * and lint reconciled BOTH an artifact path and an install time. `locked` is
 * checked first on purpose: a locked experiment is finished, and reporting its
 * lifecycle state as "retired" would invite a caller to rewrite settled history.
 */
export const measurementEligibility = (subject: MeasurementSubject): Eligibility => {
    if (subject.lockedVerdict !== null) return { eligible: false, reason: "locked" };
    if (subject.proposalStatus !== "accepted") return { eligible: false, reason: "not_accepted" };
    switch (subject.experimentStatus) {
        case "scaffolded":
            break;
        case "retired":
            return { eligible: false, reason: "retired" };
        case "regressed":
            return { eligible: false, reason: "regressed" };
        default:
            return { eligible: false, reason: "not_started" };
    }
    if ((subject.artifactPath?.trim() ?? "").length === 0) {
        return { eligible: false, reason: "artifact_unavailable" };
    }
    if (installationTime(subject.scaffoldedAt) === null) {
        return { eligible: false, reason: "artifact_unavailable" };
    }
    return ELIGIBLE;
};

/**
 * Parse a skill_proposal.trigger_pattern of the form `tool=<Name>` and return
 * the tool name. Returns null for any other shape - a prose trigger has no
 * detector, and guessing one from the words would manufacture evidence.
 */
export const parseSkillTriggerTool = (pattern: string): string | null => {
    const m = /^tool=(.+)$/.exec(pattern.trim());
    return m && m[1] ? m[1].trim() : null;
};

export interface DetectorSubject {
    readonly form: string;
    /** skill_proposal.trigger_pattern, when the proposal carries one. */
    readonly skillTrigger: string | null;
    /** Did the caller RESOLVE a cited `skill_candidate` ROW? A dangling
     *  `cites_evidence` edge is not a detector - the legacy skill detector
     *  derives its match tokens from the candidate itself. */
    readonly hasSkillCandidate: boolean;
    readonly hookTargetTool: string | null;
    readonly hookEventName: string | null;
    /** The `ax:<dedupe_sig>` marker identity installed in the hook command. */
    readonly dedupeSig: string;
    readonly artifactPath: string | null;
}

export type DetectorSupport =
    | { readonly supported: true }
    | { readonly supported: false; readonly reason: "detector_unavailable" | "artifact_unavailable" };

const SUPPORTED: DetectorSupport = { supported: true };
const NO_DETECTOR: DetectorSupport = { supported: false, reason: "detector_unavailable" };

/**
 * Can anything in this codebase observe whether this artifact did its job?
 *
 * The answer follows the detectors that EXIST in `derive-opportunities.ts`, not
 * the forms the proposal vocabulary can express. Automation, subagent and
 * harness-check proposals have no detector at all; a skill proposal needs
 * either a cited candidate or the one supported `tool=<name>` trigger; a hook
 * needs the three identity fields its correlation matches on; guidance needs
 * the file lint actually reconciled.
 */
export const detectorSupport = (subject: DetectorSubject): DetectorSupport => {
    switch (subject.form) {
        case "guidance":
            return (subject.artifactPath?.trim() ?? "").length > 0
                ? SUPPORTED
                : { supported: false, reason: "artifact_unavailable" };
        case "hook":
            return (subject.hookTargetTool?.trim() ?? "").length > 0
                && (subject.hookEventName?.trim() ?? "").length > 0
                && subject.dedupeSig.length > 0
                ? SUPPORTED
                : NO_DETECTOR;
        case "skill":
            if (subject.hasSkillCandidate) return SUPPORTED;
            return subject.skillTrigger !== null && parseSkillTriggerTool(subject.skillTrigger) !== null
                ? SUPPORTED
                : NO_DETECTOR;
        default:
            return NO_DETECTOR;
    }
};

/** The stored measured-JSON version, or null when the row predates it (or
 *  carries a non-numeric value a JSON blob can always contain). */
export const readMeasurementVersion = (
    measured: Readonly<Record<string, unknown>> | null | undefined,
): number | null => {
    const raw = measured?.measurement_version;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
};

/** The stored opportunity count, or null when the blob carries no usable one -
 *  absent, non-numeric, non-finite, or negative. A count you cannot read is not
 *  a count of zero, and neither one may authorize a suggestion. */
const readOpportunities = (measured: Readonly<Record<string, unknown>> | null | undefined): number | null => {
    const raw = measured?.opportunities;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
};

const readReason = (
    measured: Readonly<Record<string, unknown>> | null | undefined,
): MeasurementReason | null => {
    const raw = measured?.reason;
    return raw === "no_opportunities" || raw === "detector_unavailable"
        || raw === "artifact_unavailable" || raw === "refresh_required"
        ? raw
        : null;
};

/** The newest checkpoint row, as every projection sees it. */
export interface CheckpointView {
    readonly suggested: string | null;
    readonly user_verdict: string | null;
    readonly measured: Readonly<Record<string, unknown>> | null;
}

export interface CurrentProjection {
    /** The suggestion safe to present as a CURRENT recommendation, or null. */
    readonly suggested: string | null;
    /** Why there is none. Null when `suggested` stands on its own. */
    readonly reason: IneligibleReason | MeasurementReason | "no_checkpoint" | null;
}

/**
 * The CURRENT recommendation for one experiment - a projection over its newest
 * stored row plus today's eligibility, never a search back through history for
 * the last positive answer.
 *
 * Stored checkpoints stay exactly as written (they are the evidence trail).
 * What this suppresses is the claim that an old row still recommends something:
 * a retired experiment, a row measured before the corrected rules, a window
 * that found nothing to measure. A LOCKED experiment is exempt - the human
 * already decided, and that decision is displayed as-is.
 */
export const currentCheckpointProjection = (
    subject: MeasurementSubject,
    latest: CheckpointView | null,
): CurrentProjection => {
    if (subject.lockedVerdict !== null) {
        return { suggested: latest?.suggested ?? null, reason: null };
    }
    const eligibility = measurementEligibility(subject);
    if (!eligibility.eligible) return { suggested: null, reason: eligibility.reason };
    if (latest === null) return { suggested: null, reason: "no_checkpoint" };
    // Every gate below is a POSITIVE requirement, checked against the stored
    // blob rather than inferred from what is missing. A row has to carry the
    // current format version, an explicit `measured` status, and a usable
    // positive count before its suggestion can be presented as advice; absent
    // or unrecognized values ask for an explicit refresh instead of passing.
    if (readMeasurementVersion(latest.measured) !== MEASUREMENT_VERSION) {
        return { suggested: null, reason: "refresh_required" };
    }
    if (latest.suggested === null) {
        return { suggested: null, reason: readReason(latest.measured) ?? "refresh_required" };
    }
    if (latest.measured?.measurement_status !== "measured") {
        return { suggested: null, reason: readReason(latest.measured) ?? "refresh_required" };
    }
    const opportunities = readOpportunities(latest.measured);
    if (opportunities === null) return { suggested: null, reason: "refresh_required" };
    if (opportunities === 0) return { suggested: null, reason: "no_opportunities" };
    return { suggested: latest.suggested, reason: null };
};
