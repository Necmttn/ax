/**
 * Derive-Checkpoints Stage (Phase C6).
 *
 * For each ELIGIBLE experiment, at the +3 / +10 / +30 session marks measured by
 * count of sessions started after the OBSERVED INSTALL
 * (`experiment.scaffolded_at`), emit one `checkpoint` row carrying:
 *  - measured  : { opportunities, addressed, ratio, built, measurement_status,
 *                  reason?, measurement_version }
 *  - suggested : adopted | ignored | regressed | no_longer_needed | partial
 *                | NULL when the window has no measurement to report
 *  - user_verdict : NULL - the human confirms via `axctl improve verdict`.
 *
 * Windows are session-count, not calendar days, because an AI-coding agent
 * may ship eight sessions in a day or none in a weekend. The verdict should
 * ride exposure to the pattern, not the wall clock. See issue #83.
 *
 * Exposure definition: sessions whose `started_at` is after the install, minus
 * the recognized `*-subagent` sources (a subagent run is not an independent
 * exposure of the user's rig). Acceptance can precede installation by days, and
 * sessions in that gap could not have met the artifact at all.
 *
 * WHAT A CHECKPOINT MAY AND MAY NOT SAY (#1134). Three distinct states used to
 * collapse into one confident verdict:
 *  - measured           : positive opportunities, corrected evidence, a real
 *                         ratio. Reported as OBSERVED USE - the artifact was
 *                         present when the trigger fired - never as proven
 *                         causal improvement.
 *  - insufficient data  : zero opportunities, no detector for this form, or
 *                         opportunity rows that predate the corrected
 *                         derivation. `suggested` is NULL with a `reason`.
 *  - not measurable     : the experiment is not eligible at all (never
 *                         installed, retired, regressed, locked, or lint never
 *                         reconciled an artifact). Nothing is written, and its
 *                         existing rows are left exactly as they are.
 * `no_longer_needed` survives only as a HUMAN verdict: frequency equality never
 * proved a pattern disappeared, so the algorithm no longer suggests it.
 *
 * Verdict math for a supported measurement with positive opportunities:
 *   ratio > 0.6  -> adopted
 *   ratio < 0.1  -> ignored
 *   otherwise    -> partial
 *
 * Refresh: an unreviewed window is recomputed when its last run left no
 * suggestion, when it predates {@link MEASUREMENT_VERSION}, when the snapshot
 * lost its corrected-derivation certificate, or under `--force`. A row a human
 * has answered (`user_verdict`) is never touched, by any path, and no row of a
 * locked experiment is either. Both protections are re-checked INSIDE the write
 * transaction, so a verdict locked while the cache was being read cannot be
 * overwritten by a measurement computed before it.
 *
 * Legacy `t+7` / `t+30` / `t+90` checkpoint rows from the calendar-day era
 * remain valid in the DB (kind is a free-form string) and are left alone.
 */

import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { Judgment, NumberColumn, TextColumn, TimestampColumn, type JudgmentError, type JudgmentTransaction, type SidecarParam } from "@ax/lib/sqlite";
import { stableId } from "@ax/lib/stable-id";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import { listStoredProposals, type StoredCheckpoint } from "../improve/judgment-proposals.ts";
import {
    MEASUREMENT_VERSION,
    detectorSupport,
    installationTime,
    measurementEligibility,
    readMeasurementVersion,
    type MeasurementReason,
} from "../improve/measurement.ts";
import { SUBAGENT_SOURCES_SQL } from "./source-origin.ts";
import {
    OPPORTUNITY_VERSION,
    OPPORTUNITY_VERSION_PATH,
    OPPORTUNITY_VERSION_SOURCE,
} from "./opportunity-cache-version.ts";

export type CheckpointKind = "+3s" | "+10s" | "+30s";
export type CheckpointVerdict =
    | "adopted"
    | "ignored"
    | "regressed"
    | "no_longer_needed"
    | "partial";

export interface DeriveCheckpointsStats {
    /** Eligible experiments this run measured. */
    readonly experimentsScanned: number;
    /** Experiments skipped by the eligibility rules - never measured, never
     *  rewritten. Distinct from a measurement that found nothing. */
    readonly experimentsExcluded: number;
    readonly checkpointsInserted: number;
    /** Existing unreviewed windows recomputed this run. */
    readonly checkpointsRefreshed: number;
    /** Windows of eligible experiments left alone (not due, reviewed, or still
     *  current). */
    readonly checkpointsSkipped: number;
    /** Written windows that carry no suggestion - the absence-of-data count. */
    readonly insufficientData: number;
    /** Eligible experiments whose published snapshot carries no valid
     *  opportunity-derivation certificate. Reported even when nothing is due. */
    readonly cacheRefreshRequired: number;
}

export interface DeriveCheckpointsOpts {
    readonly now?: Date;
    readonly force?: boolean;
    /**
     * TEST SEAM: runs after the cache reads and before the sidecar write
     * transaction. Exists so the concurrent-verdict protection can be exercised
     * at the real boundary it guards; production callers never pass it.
     */
    readonly beforeWrite?: Effect.Effect<void>;
}

export interface CheckpointMeasured {
    readonly opportunities: number;
    readonly addressed: number;
    readonly ratio: number;
    readonly built: boolean;
    /** proposal.frequency as of this checkpoint pass (live counter). */
    readonly currentFrequency?: number;
    /** proposal.baseline.frequency at proposal-creation time (snapshot). */
    readonly baselineFrequency?: number;
}

export const CHECKPOINT_WINDOWS_SESSIONS: ReadonlyArray<readonly [CheckpointKind, number]> = [
    ["+3s", 3],
    ["+10s", 10],
    ["+30s", 30],
];

/**
 * The suggested verdict for a SUPPORTED measurement, or `null` when there is
 * nothing to suggest.
 *
 * Zero opportunities returns null unconditionally. The old code disambiguated
 * it with the proposal's frequency counters - `current > baseline` read as
 * "ignored", anything else as "no_longer_needed" - which turned the absence of
 * evidence into two confident verdicts. Frequency equality does not prove a
 * pattern disappeared; it is just as consistent with a detector that never ran.
 */
export const computeSuggestedVerdict = (measured: CheckpointMeasured): CheckpointVerdict | null => {
    if (measured.opportunities === 0) return null;
    const ratio = measured.ratio;
    if (ratio > 0.6) return "adopted";
    if (ratio < 0.1) return "ignored";
    return "partial";
};

/** Every window whose session threshold this exposure count has reached. */
export const dueCheckpointKinds = (sessionsSinceInstall: number): CheckpointKind[] =>
    CHECKPOINT_WINDOWS_SESSIONS
        .filter(([, threshold]) => sessionsSinceInstall >= threshold)
        .map(([kind]) => kind);

export const checkpointKey = (experimentKey: string, kind: CheckpointKind): string =>
    stableId("checkpoint", [experimentKey, kind]);

/**
 * ONE statement per experiment: both opportunity counts, the exposure count,
 * the resolvable skill candidate, and the derivation-version certificate.
 *
 * They travel together on purpose. Split across statements, a publication
 * landing mid-read could hand this stage counts from the corrected derivation
 * and a certificate from the previous snapshot (or the reverse), and the
 * measurement would describe a cache state that never existed.
 *
 * Both opportunity counts are windowed on the OBSERVED INSTALL, and that
 * predicate is load-bearing rather than belt-and-braces. The certificate says
 * the rows came from the corrected derivation; it does NOT say they came from
 * the CURRENT installation. An experiment reinstalled since the last ingest
 * carries cached rows matched against its previous install, and without this
 * window they would be counted - a positive verdict for an artifact this
 * installation was never present for. The write-transaction guard cannot catch
 * it either: that detects a change DURING the command, and this one happened
 * before it started.
 *
 * The candidate arm RESOLVES the cited row rather than counting the edge. A
 * `cites_evidence` edge whose `skill_candidate` is gone (a rebuilt cache, a
 * retired candidate) leaves the legacy skill detector with no match tokens to
 * derive, so it detects nothing - and the supported `tool=<name>` trigger, when
 * the proposal has one, is what the caller falls back to.
 */
const MEASUREMENT_SQL = `
SELECT
    (SELECT CAST(count(*) AS INTEGER) FROM opportunity
      WHERE in_id = ? AND matched_at > ?) AS opportunities,
    (SELECT CAST(count(*) AS INTEGER) FROM opportunity
      WHERE in_id = ? AND matched_at > ? AND was_addressed = true) AS addressed,
    (SELECT CAST(count(*) AS INTEGER) FROM session
      WHERE started_at > ?
        AND (source IS NULL OR source NOT IN ${SUBAGENT_SOURCES_SQL})) AS sessions,
    (SELECT CAST(count(*) AS INTEGER) FROM cites_evidence AS ce
       JOIN skill_candidate AS sc ON sc.id = ce.out_id
      WHERE ce.in_id = ? AND ce.out_table = 'skill_candidate') AS resolved_candidates,
    (SELECT sha FROM ingest_file_state WHERE source_kind = ? AND path = ? LIMIT 1) AS cache_version
`;

const MeasurementRow = Schema.Struct({
    opportunities: NumberColumn,
    addressed: NumberColumn,
    sessions: NumberColumn,
    resolved_candidates: NumberColumn,
    cache_version: Schema.NullOr(Schema.String),
});

/** The sidecar state a pending write is re-checked against inside the
 *  transaction. */
const GuardRow = Schema.Struct({
    id: TextColumn,
    status: TextColumn,
    locked_verdict: Schema.NullOr(TextColumn),
    artifact_path: Schema.NullOr(TextColumn),
    scaffolded_at: Schema.NullOr(TimestampColumn),
    proposal_status: TextColumn,
});

const ReviewRow = Schema.Struct({
    id: TextColumn,
    user_verdict: Schema.NullOr(TextColumn),
});

interface PendingWrite {
    readonly experimentId: string;
    readonly kind: CheckpointKind;
    /** The install this measurement describes; a changed one voids it. */
    readonly installedAtMs: number;
    readonly artifactPath: string;
    readonly refresh: boolean;
    readonly insufficient: boolean;
    readonly row: Readonly<Record<string, SidecarParam>>;
}

/** The newest stored row for a window, keyed by kind. */
const byKind = (checkpoints: ReadonlyArray<StoredCheckpoint>): Map<string, StoredCheckpoint> => {
    const map = new Map<string, StoredCheckpoint>();
    for (const checkpoint of checkpoints) map.set(checkpoint.kind, checkpoint);
    return map;
};

/**
 * May this run write over an existing window?
 *
 * A reviewed row is never rewritten, whatever else is true - that answer is the
 * judgment the sidecar exists to keep. Everything else is recomputed when the
 * stored result is not a current measurement: no suggestion, an older measured
 * format, or a snapshot that lost its corrected-derivation certificate (an old
 * positive answer must not outlive the evidence it was computed from).
 */
export const shouldRefreshCheckpoint = (input: {
    readonly existing: StoredCheckpoint | undefined;
    readonly force: boolean;
    readonly correctedEvidence: boolean;
}): "insert" | "refresh" | "preserve" => {
    const existing = input.existing;
    if (existing === undefined) return "insert";
    if (existing.user_verdict !== null) return "preserve";
    if (existing.suggested === null) return "refresh";
    if (readMeasurementVersion(existing.measured) !== MEASUREMENT_VERSION) return "refresh";
    if (!input.correctedEvidence) return "refresh";
    return input.force ? "refresh" : "preserve";
};

const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const deriveCheckpoints = (
    opts: DeriveCheckpointsOpts = {},
): Effect.Effect<DeriveCheckpointsStats, CacheReadError | JudgmentError, CacheRead | Judgment> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const judgment = yield* Judgment;
        const now = opts.now ?? new Date();
        const force = opts.force ?? false;
        const proposals = yield* listStoredProposals(100_000);

        let scanned = 0;
        let excluded = 0;
        let cacheRefreshRequired = 0;
        const pending: PendingWrite[] = [];

        for (const proposal of proposals) {
            const exp = proposal.experiment;
            if (exp === null) continue;
            const subject = {
                proposalStatus: proposal.status,
                experimentStatus: exp.status,
                lockedVerdict: exp.locked_verdict,
                artifactPath: exp.artifact_path,
                scaffoldedAt: exp.scaffolded_at,
            };
            const eligibility = measurementEligibility(subject);
            if (!eligibility.eligible) {
                excluded += 1;
                continue;
            }
            scanned += 1;
            const installedAt = installationTime(exp.scaffolded_at)!;
            const artifactPath = exp.artifact_path!;
            const experimentKey = exp.id;

            const rows = yield* cache.rows(MeasurementRow, MEASUREMENT_SQL, [
                experimentKey,
                installedAt,
                experimentKey,
                installedAt,
                installedAt,
                proposal.id,
                OPPORTUNITY_VERSION_SOURCE,
                OPPORTUNITY_VERSION_PATH,
            ]);
            const facts = rows[0];
            if (facts === undefined) continue;

            // Algorithm compatibility, not freshness: the certificate says the
            // published opportunity rows came from the corrected derivation.
            // Missing, null, old or unknown all mean the same thing here.
            const correctedEvidence = facts.cache_version === OPPORTUNITY_VERSION;
            if (!correctedEvidence) cacheRefreshRequired += 1;

            const support = detectorSupport({
                form: proposal.form,
                skillTrigger: proposal.skill_payload?.trigger_pattern ?? null,
                hasSkillCandidate: facts.resolved_candidates > 0,
                hookTargetTool: proposal.hook_payload?.target_tool ?? null,
                hookEventName: proposal.hook_payload?.event_name ?? null,
                dedupeSig: proposal.dedupe_sig,
                artifactPath,
            });

            const opportunities = facts.opportunities;
            const addressed = facts.addressed;
            const ratio = opportunities === 0 ? 0 : addressed / opportunities;

            // proposal.baseline is stored as a JSON string. Parse defensively -
            // older proposals predating the frequency snapshot won't have
            // baseline.frequency. Both counters ride along for compatibility;
            // neither decides a verdict any more.
            const parsedBaseline = typeof proposal.baseline === "string" && proposal.baseline.length > 0
                ? safeJsonParse<{ frequency?: number }>(proposal.baseline)
                : null;
            const baselineFrequency = numberOrUndefined(parsedBaseline?.frequency);
            const currentFrequency = numberOrUndefined(proposal.frequency);

            const measured: CheckpointMeasured = {
                opportunities,
                addressed,
                ratio,
                built: true,
                ...(currentFrequency === undefined ? {} : { currentFrequency }),
                ...(baselineFrequency === undefined ? {} : { baselineFrequency }),
            };

            // Order matters: uncorrected evidence outranks everything, because
            // the counts themselves cannot be trusted yet.
            const reason: MeasurementReason | null = !correctedEvidence
                ? "refresh_required"
                : !support.supported
                    ? support.reason
                    : opportunities === 0
                        ? "no_opportunities"
                        : null;
            const suggested = reason === null ? computeSuggestedVerdict(measured) : null;
            const measuredJson = JSON.stringify({
                opportunities: measured.opportunities,
                addressed: measured.addressed,
                ratio: measured.ratio,
                built: measured.built,
                ...(measured.currentFrequency === undefined ? {} : { current_frequency: measured.currentFrequency }),
                ...(measured.baselineFrequency === undefined ? {} : { baseline_frequency: measured.baselineFrequency }),
                measurement_status: suggested === null ? "insufficient_data" : "measured",
                ...(reason === null ? {} : { reason }),
                measurement_version: MEASUREMENT_VERSION,
            });

            const existingByKind = byKind(exp.checkpoints);
            for (const kind of dueCheckpointKinds(facts.sessions)) {
                const existing = existingByKind.get(kind);
                const action = shouldRefreshCheckpoint({ existing, force, correctedEvidence });
                if (action === "preserve") continue;
                pending.push({
                    experimentId: experimentKey,
                    kind,
                    installedAtMs: installedAt.getTime(),
                    artifactPath,
                    refresh: action === "refresh",
                    insufficient: suggested === null,
                    row: {
                        // A REFRESH updates the row it read, whatever its id.
                        // History predating `checkpointKey` (and any row written
                        // by another producer) is keyed differently, and writing
                        // the canonical id instead would leave the old row in
                        // place as a second, contradicting checkpoint for the
                        // same window - and would send the transaction's
                        // user_verdict re-check at a row nobody reviewed.
                        id: action === "refresh" && existing !== undefined
                            ? existing.id
                            : checkpointKey(experimentKey, kind),
                        experiment: experimentKey,
                        kind,
                        measured: measuredJson,
                        suggested,
                        user_verdict: null,
                        observed_at: now,
                    },
                });
            }
        }

        if (opts.beforeWrite !== undefined) yield* opts.beforeWrite;

        const landed = pending.length === 0
            ? []
            : yield* judgment.transaction((transaction) => commitCheckpoints(transaction, pending));

        return {
            experimentsScanned: scanned,
            experimentsExcluded: excluded,
            checkpointsInserted: landed.filter((write) => !write.refresh).length,
            checkpointsRefreshed: landed.filter((write) => write.refresh).length,
            checkpointsSkipped: scanned * CHECKPOINT_WINDOWS_SESSIONS.length - landed.length,
            insufficientData: landed.filter((write) => write.insufficient).length,
            cacheRefreshRequired,
        };
    });

/**
 * Write the selected windows, re-checking every protection first.
 *
 * The cache read above is not instantaneous, and a human can lock a verdict or
 * retire an experiment while it runs. Re-reading eligibility and `user_verdict`
 * HERE - inside the same transaction as the write - is what stops a measurement
 * computed against the previous state from landing on top of a decision made
 * since. A changed install (or artifact) is treated the same way: the
 * measurement describes an installation that is no longer the current one, so
 * it is dropped rather than published, and the next explicit run measures the
 * new one.
 */
const commitCheckpoints = (
    transaction: JudgmentTransaction,
    pending: ReadonlyArray<PendingWrite>,
): Effect.Effect<ReadonlyArray<PendingWrite>, JudgmentError> =>
    Effect.gen(function* () {
        const experimentIds = [...new Set(pending.map((write) => write.experimentId))];
        const guards = yield* transaction.rows(
            GuardRow,
            `SELECT e.id AS id, e.status AS status, e.locked_verdict AS locked_verdict,
                    e.artifact_path AS artifact_path, e.scaffolded_at AS scaffolded_at,
                    p.status AS proposal_status
             FROM experiment e JOIN proposal p ON p.id = e.proposal
             WHERE e.id IN (${experimentIds.map(() => "?").join(", ")})`,
            experimentIds,
        );
        const guardById = new Map(guards.map((guard) => [guard.id, guard]));

        const checkpointIds = pending.map((write) => String(write.row.id));
        const reviews = yield* transaction.rows(
            ReviewRow,
            `SELECT id, user_verdict FROM checkpoint WHERE id IN (${checkpointIds.map(() => "?").join(", ")})`,
            checkpointIds,
        );
        const reviewedIds = new Set(
            reviews.filter((review) => review.user_verdict !== null).map((review) => review.id),
        );

        const selected = pending.filter((write) => {
            if (reviewedIds.has(String(write.row.id))) return false;
            const guard = guardById.get(write.experimentId);
            if (guard === undefined) return false;
            const eligibility = measurementEligibility({
                proposalStatus: guard.proposal_status,
                experimentStatus: guard.status,
                lockedVerdict: guard.locked_verdict,
                artifactPath: guard.artifact_path,
                scaffoldedAt: guard.scaffolded_at,
            });
            if (!eligibility.eligible) return false;
            if (guard.artifact_path !== write.artifactPath) return false;
            return installationTime(guard.scaffolded_at)?.getTime() === write.installedAtMs;
        });
        if (selected.length > 0) {
            yield* transaction.putMany("checkpoint", selected.map((write) => write.row));
        }
        return selected;
    });
