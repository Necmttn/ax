/**
 * Derive-Checkpoints Stage (Phase C6).
 *
 * For each active experiment, at the t+7 / t+30 / t+90 day marks measured
 * from experiment.created_at, emit one `checkpoint` row carrying:
 *  - measured  : { opportunities, addressed, ratio, built }
 *  - suggested : adopted | ignored | regressed | no_longer_needed | partial
 *  - user_verdict : NULL - the human confirms via `axctl improve verdict`.
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
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef, surrealDate, surrealString } from "../lib/shared/surql.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { safeKeyPart, recordKeyPart } from "../lib/shared/derive-keys.ts";
import { safeJsonParse } from "../lib/shared/safe-json.ts";

export type CheckpointKind = "t+7" | "t+30" | "t+90";
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
    readonly id: string | { tb: string; id: string };
    readonly created_at: string;
    readonly opportunities: number;
    readonly addressed: number;
    readonly artifact_path: string | null;
    readonly existing_kinds: ReadonlyArray<string>;
    readonly current_frequency?: number | null;
    readonly baseline_json?: string | null;
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

export const CHECKPOINT_WINDOWS_DAYS: ReadonlyArray<readonly [CheckpointKind, number]> = [
    ["t+7", 7],
    ["t+30", 30],
    ["t+90", 90],
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
    createdAt: Date,
    now: Date,
    existing: ReadonlySet<string>,
): CheckpointKind[] => {
    const dueMs = (kind: CheckpointKind) => {
        const days = CHECKPOINT_WINDOWS_DAYS.find(([k]) => k === kind)?.[1] ?? 0;
        return createdAt.getTime() + days * 24 * 3600 * 1000;
    };
    return CHECKPOINT_WINDOWS_DAYS
        .map(([k]) => k)
        .filter((k) => now.getTime() >= dueMs(k) && !existing.has(k));
};

export const checkpointKey = (experimentKey: string, kind: CheckpointKind): string =>
    `${safeKeyPart(experimentKey).slice(0, 64)}__${kind.replace("+", "_plus_")}`;

export const buildCheckpointStatement = (params: {
    readonly experimentKey: string;
    readonly kind: CheckpointKind;
    readonly measured: CheckpointMeasured;
    readonly suggested: CheckpointVerdict;
    readonly observedAt: Date;
}): string => {
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
    return `UPSERT ${recordRef("checkpoint", key)} CONTENT { experiment: ${recordRef("experiment", params.experimentKey)}, kind: ${surrealString(params.kind)}, measured: ${JSON.stringify(measuredJson)}, suggested: ${surrealString(params.suggested)}, user_verdict: NONE, observed_at: ${surrealDate(params.observedAt)} };`;
};

export const deriveCheckpoints = (
    opts: DeriveCheckpointsOpts = {},
): Effect.Effect<DeriveCheckpointsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const now = opts.now ?? new Date();

        const result = yield* db.query<[CheckpointExperimentRow[]]>(`
            SELECT
                id,
                type::string(created_at) AS created_at,
                artifact_path,
                (SELECT count() FROM opportunity WHERE in = $parent.id GROUP ALL)[0].count ?? 0 AS opportunities,
                (SELECT count() FROM opportunity WHERE in = $parent.id AND was_addressed = true GROUP ALL)[0].count ?? 0 AS addressed,
                (SELECT VALUE kind FROM checkpoint WHERE experiment = $parent.id) AS existing_kinds,
                proposal.frequency AS current_frequency,
                proposal.baseline AS baseline_json
            FROM experiment
            WHERE locked_verdict IS NONE;
        `);
        const experiments = result?.[0] ?? [];

        let inserted = 0;
        let skipped = 0;
        const statements: string[] = [];
        for (const exp of experiments) {
            const experimentKey = recordKeyPart(exp.id, "experiment");
            if (!experimentKey) continue;
            const createdAt = new Date(exp.created_at);
            const existing = new Set(opts.force ? [] : (exp.existing_kinds ?? []));
            const due = dueCheckpointKinds(createdAt, now, existing);
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
                if (opts.force && existing.has(kind)) {
                    statements.push(`DELETE ${recordRef("checkpoint", checkpointKey(experimentKey, kind))};`);
                }
                statements.push(buildCheckpointStatement({
                    experimentKey,
                    kind,
                    measured,
                    suggested,
                    observedAt: now,
                }));
                inserted += 1;
            }
            skipped += (CHECKPOINT_WINDOWS_DAYS.length - due.length);
        }

        yield* executeStatementsWith(db, statements, { chunkSize: 200 });
        return {
            experimentsScanned: experiments.length,
            checkpointsInserted: inserted,
            checkpointsSkipped: skipped,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveCheckpoints().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveCheckpointsStats>,
    );
}
