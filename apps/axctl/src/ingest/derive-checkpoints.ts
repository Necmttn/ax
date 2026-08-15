/**
 * Derive-Checkpoints Stage (Phase C6).
 *
 * For each active experiment, at the +3 / +10 / +30 session marks measured
 * by count of sessions created after experiment.created_at, emit one
 * `checkpoint` row carrying:
 *  - measured  : { opportunities, addressed, ratio, built }
 *  - suggested : adopted | ignored | regressed | no_longer_needed | partial
 *  - user_verdict : NULL - the human confirms via `axctl improve verdict`.
 *
 * Windows are session-count, not calendar days, because an AI-coding agent
 * may ship eight sessions in a day or none in a weekend. The verdict should
 * ride exposure to the pattern, not the wall clock. See issue #83.
 *
 * v1 exposure definition: count of sessions whose `created_at` is after
 * `experiment.created_at`. (Refinements to narrow this to "sessions that
 * touched the artifact file" or "sessions that fired the trigger pattern"
 * are tracked in follow-ups.)
 *
 * Verdict math (suggested only - the human still confirms):
 *   if opportunities == 0:
 *       if currentFrequency > baselineFrequency  -> ignored (pattern still
 *           firing post-accept, artifact not preventing the trigger)
 *       else                                     -> no_longer_needed
 *   if ratio > 0.6                 -> adopted
 *   if ratio < 0.1                 -> ignored
 *   otherwise                      -> partial
 *
 * Idempotency: a (experiment, kind) checkpoint is only inserted once.
 * Re-derive passes that hit the same window skip. If the underlying
 * opportunity count changes the suggested verdict, the user can re-run
 * `axctl improve checkpoint --force` (Phase C7) to refresh - that path
 * deletes the existing checkpoint and re-inserts.
 *
 * Legacy `t+7` / `t+30` / `t+90` checkpoint rows from the calendar-day era
 * remain valid in the DB (kind is a free-form string). New experiments
 * emit the session-based kinds. The two are non-conflicting because the
 * (experiment, kind) unique index keys on the kind string.
 */

import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import { safeJsonParse } from "@ax/lib/shared/safe-json";

export type CheckpointKind = "+3s" | "+10s" | "+30s";
export type CheckpointVerdict =
    | "adopted"
    | "ignored"
    | "regressed"
    | "no_longer_needed"
    | "partial";

export interface DeriveCheckpointsStats {
    readonly experimentsScanned: number;
    readonly checkpointsInserted: number;
    readonly checkpointsSkipped: number;
}

export interface DeriveCheckpointsOpts {
    readonly now?: Date;
    readonly force?: boolean;
}

interface CheckpointExperimentRow {
    readonly id: string;
    readonly created_at: Date;
    readonly opportunities: number;
    readonly addressed: number;
    readonly artifact_path: string | null;
    readonly existing_kinds: string | null;
    readonly current_frequency?: number | null;
    readonly baseline_json?: string | null;
    /** Sessions created after this experiment's accept time. Drives window cadence. */
    readonly sessions_since_created: number;
}

export interface CheckpointMeasured {
    readonly opportunities: number;
    readonly addressed: number;
    readonly ratio: number;
    readonly built: boolean;
    /** proposal.frequency as of this checkpoint pass (live counter). */
    readonly currentFrequency?: number;
    /**
     * proposal.baseline.frequency at proposal-creation time (snapshot).
     * Used to disambiguate `no_longer_needed` (pattern resolved) from
     * `ignored` (artifact exists but doesn't fire).
     */
    readonly baselineFrequency?: number;
}

export const CHECKPOINT_WINDOWS_SESSIONS: ReadonlyArray<readonly [CheckpointKind, number]> = [
    ["+3s", 3],
    ["+10s", 10],
    ["+30s", 30],
];

export const computeSuggestedVerdict = (measured: CheckpointMeasured): CheckpointVerdict => {
    if (measured.opportunities === 0) {
        // Disambiguate via frequency delta. If the cluster has kept growing
        // post-accept, the trigger pattern is still firing and the artifact
        // is being ignored. Otherwise, the underlying pattern self-resolved.
        const base = measured.baselineFrequency ?? 0;
        const curr = measured.currentFrequency ?? 0;
        if (curr > base) return "ignored";
        return "no_longer_needed";
    }
    const ratio = measured.ratio;
    if (ratio > 0.6) return "adopted";
    if (ratio < 0.1) return "ignored";
    return "partial";
};

export const dueCheckpointKinds = (
    sessionsSinceCreated: number,
    existing: ReadonlySet<string>,
): CheckpointKind[] => {
    const threshold = (kind: CheckpointKind) =>
        CHECKPOINT_WINDOWS_SESSIONS.find(([k]) => k === kind)?.[1] ?? 0;
    return CHECKPOINT_WINDOWS_SESSIONS
        .map(([k]) => k)
        .filter((k) => sessionsSinceCreated >= threshold(k) && !existing.has(k));
};

export const checkpointKey = (experimentKey: string, kind: CheckpointKind): string =>
    stableId("checkpoint", [experimentKey, kind]);

export const buildCheckpointRow = (params: {
    readonly experimentKey: string;
    readonly kind: CheckpointKind;
    readonly measured: CheckpointMeasured;
    readonly suggested: CheckpointVerdict;
    readonly observedAt: Date;
}) => {
    const key = checkpointKey(params.experimentKey, params.kind);
    // Map camelCase TS fields to the snake_case schema fields. Optional
    // current/baseline frequency are emitted only when defined so the
    // option<int> columns stay NONE for older rows.
    const m = params.measured;
    const measuredJson: Record<string, number | boolean> = {
        opportunities: m.opportunities,
        addressed: m.addressed,
        ratio: m.ratio,
        built: m.built,
    };
    if (typeof m.currentFrequency === "number") {
        measuredJson.current_frequency = m.currentFrequency;
    }
    if (typeof m.baselineFrequency === "number") {
        measuredJson.baseline_frequency = m.baselineFrequency;
    }
    return cacheRow({
        id: key,
        experiment: params.experimentKey,
        kind: params.kind,
        measured: jsonParam(measuredJson),
        suggested: params.suggested,
        user_verdict: null,
        observed_at: tsParam(params.observedAt),
    });
};

const CheckpointExperimentDbRow = Schema.Struct({
    id: Schema.String,
    created_at: TimestampColumn,
    opportunities: NumberFromBigIntColumn,
    addressed: NumberFromBigIntColumn,
    artifact_path: Schema.NullOr(Schema.String),
    existing_kinds: Schema.NullOr(Schema.String),
    current_frequency: Schema.NullOr(NumberFromBigIntColumn),
    baseline_json: Schema.NullOr(Schema.String),
    sessions_since_created: NumberFromBigIntColumn,
});

export const deriveCheckpoints = (
    write: CacheWriteService,
    opts: DeriveCheckpointsOpts = {},
): Effect.Effect<DeriveCheckpointsStats, CacheWriteError> =>
    Effect.gen(function* () {
        const now = opts.now ?? new Date();

        const experiments: readonly CheckpointExperimentRow[] = yield* write.rows(CheckpointExperimentDbRow, `
            SELECT
                e.id, e.created_at, e.artifact_path,
                (SELECT count(*) FROM opportunity o WHERE o.in_id = e.id) AS opportunities,
                (SELECT count(*) FROM opportunity o WHERE o.in_id = e.id AND o.was_addressed) AS addressed,
                (SELECT string_agg(c.kind, ',') FROM checkpoint c WHERE c.experiment = e.id) AS existing_kinds,
                p.frequency AS current_frequency,
                p.baseline AS baseline_json,
                (SELECT count(*) FROM session s WHERE s.created_at > e.created_at) AS sessions_since_created
            FROM experiment e
            LEFT JOIN proposal p ON p.id = e.proposal
            WHERE e.locked_verdict IS NULL
        `);

        let inserted = 0;
        let skipped = 0;
        const rows = [];
        for (const exp of experiments) {
            const experimentKey = exp.id;
            const actualExisting = new Set(exp.existing_kinds?.split(",").filter(Boolean) ?? []);
            const existing = new Set(opts.force ? [] : actualExisting);
            const sessionsSince = Number(exp.sessions_since_created ?? 0);
            const due = dueCheckpointKinds(sessionsSince, existing);
            if (due.length === 0) continue;

            const opportunities = Number(exp.opportunities ?? 0);
            const addressed = Number(exp.addressed ?? 0);
            const ratio = opportunities === 0 ? 0 : addressed / opportunities;

            // proposal.baseline is stored as a JSON string (schema rule:
            // SCHEMAFULL v3 has no flexible<object>). Parse defensively -
            // older proposals predating the frequency snapshot won't have
            // baseline.frequency and we just leave it undefined.
            let baselineFrequency: number | undefined;
            const rawBaseline = exp.baseline_json;
            if (typeof rawBaseline === "string" && rawBaseline.length > 0) {
                const parsed = safeJsonParse<{ frequency?: number }>(rawBaseline);
                if (parsed && typeof parsed.frequency === "number") baselineFrequency = parsed.frequency;
                // non-JSON baseline (legacy) - null parse is ignored.
            }
            const rawCurrent = exp.current_frequency;
            const currentFrequency =
                typeof rawCurrent === "number" && Number.isFinite(rawCurrent)
                    ? rawCurrent
                    : undefined;

            const measured: CheckpointMeasured = {
                opportunities,
                addressed,
                ratio,
                built: exp.artifact_path !== null,
                ...(currentFrequency !== undefined ? { currentFrequency } : {}),
                ...(baselineFrequency !== undefined ? { baselineFrequency } : {}),
            };
            const suggested = computeSuggestedVerdict(measured);

            for (const kind of due) {
                if (opts.force && actualExisting.has(kind)) {
                    yield* write.exec("DELETE FROM checkpoint WHERE id = ?", [checkpointKey(experimentKey, kind)]);
                }
                rows.push(buildCheckpointRow({
                    experimentKey,
                    kind,
                    measured,
                    suggested,
                    observedAt: now,
                }));
                inserted += 1;
            }
            skipped += (CHECKPOINT_WINDOWS_SESSIONS.length - due.length);
        }

        yield* write.putMany("checkpoint", rows);
        return {
            experimentsScanned: experiments.length,
            checkpointsInserted: inserted,
            checkpointsSkipped: skipped,
        };
    });
