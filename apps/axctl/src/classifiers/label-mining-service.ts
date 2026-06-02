import { Context, Effect, Layer, Schema } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { prettyPrint } from "@ax/lib/json";
import {
    buildReviewQueue,
    mineTranscriptLabelCandidates,
    EXPORT_REVIEW_LIMIT,
    type EventWindowLike,
    type LabelMiningReviewDiversity,
    type LabelMiningReviewRow,
    type TranscriptLabelCandidate,
} from "./label-mining.ts";

export { EXPORT_REVIEW_LIMIT };

/**
 * Effect service that runs the transcript label-mining experiment over
 * persisted transcripts. It reads candidate windows straight from the `turn`
 * table, runs the pure mining + review-queue helpers, and (optionally) writes
 * the bounded review queue report to disk.
 *
 * No model helpers are called here - the service is the deterministic read/write
 * path. Prioritization (embeddings/SVM) lives in a later task.
 */

const REPORT_SCHEMA = "ax.transcript_label_mining_report.v1" as const;

/** Failure surface for the service: DB read errors or report write failures. */
export class LabelMiningReportWriteError extends Schema.TaggedErrorClass<LabelMiningReportWriteError>(
    "LabelMiningReportWriteError",
)("LabelMiningReportWriteError", {
    path: Schema.String,
    message: Schema.String,
}) {}

export type LabelMiningError = DbError | LabelMiningReportWriteError;

export interface LabelMiningReportInput {
    /** Lookback window in days for transcript turns. */
    readonly sinceDays: number;
    /** Max mined candidate rows (plan Iteration Rule: <= 500). */
    readonly limit: number;
    /** Max exported review rows; clamped to {@link EXPORT_REVIEW_LIMIT}. */
    readonly reviewLimit: number;
}

export interface LabelMiningWriteInput extends LabelMiningReportInput {
    readonly out: string;
}

export interface LabelMiningReport {
    readonly schema: typeof REPORT_SCHEMA;
    readonly since_days: number;
    readonly limit: number;
    readonly review_limit: number;
    readonly candidate_count: number;
    readonly review_rows: readonly LabelMiningReviewRow[];
    readonly review_diversity: LabelMiningReviewDiversity;
    readonly out_path?: string;
}

/** Projection row returned by the turn read query (one user turn + prior turn). */
interface TranscriptWindowRow {
    readonly window_key?: string | null;
    readonly subject_id?: string | null;
    readonly session_id?: string | null;
    readonly user_turn_id?: string | null;
    readonly user_seq?: number | null;
    readonly user_role?: string | null;
    readonly user_message_kind?: string | null;
    readonly user_text?: string | null;
    readonly user_evidence_path?: string | null;
    readonly prev_turn_id?: string | null;
    readonly prev_text?: string | null;
    readonly prev_evidence_path?: string | null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));

/**
 * Read recent user turns (with the immediately-preceding turn) from the `turn`
 * table as candidate windows. Only `role = 'user'` turns are eligible subjects;
 * the previous turn is joined via `session` + `seq - 1` so correction/direction
 * candidates can carry the assistant action they reacted to.
 */
const transcriptWindowSql = (sinceDays: number, limit: number): string => `
SELECT
    type::string(id) AS window_key,
    type::string(id) AS subject_id,
    type::string(session) AS session_id,
    type::string(id) AS user_turn_id,
    seq AS user_seq,
    role AS user_role,
    message_kind AS user_message_kind,
    text AS user_text,
    type::string(id) AS user_evidence_path,
    (SELECT VALUE type::string(id) FROM turn WHERE session = $parent.session AND seq = $parent.seq - 1 LIMIT 1)[0] AS prev_turn_id,
    (SELECT VALUE text FROM turn WHERE session = $parent.session AND seq = $parent.seq - 1 LIMIT 1)[0] AS prev_text,
    (SELECT VALUE type::string(id) FROM turn WHERE session = $parent.session AND seq = $parent.seq - 1 LIMIT 1)[0] AS prev_evidence_path
FROM turn
WHERE role = 'user'
    AND text IS NOT NONE
    AND ts >= time::now() - ${Math.max(0, Math.trunc(sinceDays))}d
ORDER BY ts DESC
LIMIT ${Math.max(1, Math.trunc(limit))};`.trim();

const rowToWindow = (row: TranscriptWindowRow): EventWindowLike | null => {
    const userTurnId = str(row.user_turn_id ?? row.subject_id);
    if (userTurnId.length === 0) return null;
    const evidencePaths: string[] = [];
    const userEvidence = str(row.user_evidence_path ?? userTurnId);
    if (userEvidence.length > 0) evidencePaths.push(userEvidence);

    const prevTurnId = row.prev_turn_id;
    const prevText = row.prev_text;
    const prevEvidence = row.prev_evidence_path;

    const window: EventWindowLike = {
        ...(row.window_key ? { key: str(row.window_key) } : {}),
        subjectType: "event_window",
        subjectId: str(row.subject_id ?? userTurnId),
        sessionId: row.session_id != null ? str(row.session_id) : null,
        userTurn: {
            id: userTurnId,
            ...(row.user_seq != null ? { seq: row.user_seq } : {}),
            ...(row.user_role != null ? { role: str(row.user_role) } : {}),
            ...(row.user_message_kind != null
                ? { messageKind: str(row.user_message_kind) }
                : {}),
            text: str(row.user_text),
            evidencePath: userEvidence,
        },
        ...(prevTurnId && str(prevText).trim().length > 0
            ? {
                  previousAssistantTurn: {
                      id: str(prevTurnId),
                      text: str(prevText),
                      evidencePath: prevEvidence != null ? str(prevEvidence) : null,
                  },
              }
            : {}),
        evidencePaths,
    };
    return window;
};

const buildReport = (input: {
    readonly since_days: number;
    readonly limit: number;
    readonly review_limit: number;
    readonly candidates: readonly TranscriptLabelCandidate[];
}): LabelMiningReport => {
    const queue = buildReviewQueue({
        candidates: input.candidates,
        limit: input.review_limit,
    });
    return {
        schema: REPORT_SCHEMA,
        since_days: input.since_days,
        limit: input.limit,
        review_limit: input.review_limit,
        candidate_count: input.candidates.length,
        review_rows: queue.review_rows,
        review_diversity: queue.diversity,
    };
};

export interface LabelMiningServiceShape {
    readonly miningReport: (
        input: LabelMiningReportInput,
    ) => Effect.Effect<LabelMiningReport, LabelMiningError, SurrealClient>;
    readonly writeMiningReport: (
        input: LabelMiningWriteInput,
    ) => Effect.Effect<LabelMiningReport, LabelMiningError, SurrealClient>;
}

export class LabelMiningService extends Context.Service<LabelMiningService, LabelMiningServiceShape>()(
    "ax/LabelMiningService",
) {}

export const LabelMiningServiceLive: Layer.Layer<LabelMiningService, never, SurrealClient> =
    Layer.effect(
        LabelMiningService,
        Effect.gen(function* () {
            const db = yield* SurrealClient;

            const miningReport = Effect.fn("LabelMiningService.miningReport")(function* (
                input: LabelMiningReportInput,
            ) {
                const reviewLimit = Math.min(input.reviewLimit, EXPORT_REVIEW_LIMIT);
                const sql = transcriptWindowSql(input.sinceDays, input.limit);
                const [rows] = yield* db.query<[TranscriptWindowRow[]]>(sql);
                const windows: EventWindowLike[] = [];
                for (const row of rows ?? []) {
                    const window = rowToWindow(row);
                    if (window) windows.push(window);
                }
                const candidates = mineTranscriptLabelCandidates({
                    windows,
                    limit: input.limit,
                });
                return buildReport({
                    since_days: input.sinceDays,
                    limit: input.limit,
                    review_limit: reviewLimit,
                    candidates,
                });
            });

            const writeMiningReport = Effect.fn("LabelMiningService.writeMiningReport")(function* (
                input: LabelMiningWriteInput,
            ) {
                const report = yield* miningReport(input);
                const withPath: LabelMiningReport = { ...report, out_path: input.out };
                yield* Effect.try({
                    try: () => {
                        mkdirSync(dirname(input.out), { recursive: true });
                        writeFileSync(input.out, `${prettyPrint(withPath)}\n`);
                    },
                    catch: (err) =>
                        new LabelMiningReportWriteError({
                            path: input.out,
                            message: err instanceof Error ? err.message : String(err),
                        }),
                });
                return withPath;
            });

            return LabelMiningService.of({ miningReport, writeMiningReport });
        }),
    );
