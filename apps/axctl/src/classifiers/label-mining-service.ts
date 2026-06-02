import { Context, Effect, Layer, Schema } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { prettyPrint } from "@ax/lib/json";
import {
    buildReviewQueue,
    mineTranscriptLabelCandidates,
    projectReviewedLabelsToGraph,
    EXPORT_REVIEW_LIMIT,
    type EventWindowLike,
    type LabelFamily,
    type LabelMiningGraphProjection,
    type LabelMiningReviewDiversity,
    type LabelMiningReviewRow,
    type TranscriptLabelCandidate,
    type TranscriptLabelVectorRow,
    type TranscriptReviewedLabel,
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

/* -------------------------------------------------------------------------- *
 * Self-improve product query
 *
 * Reads persisted `transcript_label_review` rows plus the projected
 * `classifier_graph_fact` rows and separates them into the four buckets the
 * self-improve agent must never conflate:
 *   - reviewed promotion-safe facts (accepted -> projected graph facts)
 *   - weak / advisory candidates (still pending review)
 *   - rejected / deferred reviews (stored for provenance, never promotion-safe)
 *   - nearest-neighbor explanations (advisory expansion links)
 * -------------------------------------------------------------------------- */

const SELF_IMPROVE_SCHEMA = "ax.transcript_label_mining_self_improve.v1" as const;
const GRAPH_PROJECTION_SCHEMA = "ax.transcript_label_mining_graph_projection.v1" as const;
const REVIEWED_SOURCE_KIND = "transcript_label_mining_reviewed" as const;

/** A persisted `transcript_label_review` row (as read back from SurrealDB). */
export interface LabelMiningReviewTableRow {
    readonly candidate_id: string;
    readonly graph_fact_id?: string | null;
    readonly label_family: string;
    readonly review_status: string;
    readonly promotion_safe: boolean;
    readonly reviewed_label?: string | null;
    readonly reviewed_target?: string | null;
    readonly reviewer: string;
    readonly rationale: string;
    readonly evidence_paths_json: string;
}

/** A persisted `classifier_graph_fact` row scoped to the reviewed source kind. */
export interface LabelMiningGraphFactRow {
    readonly graph_id: string;
    readonly kind: string;
    readonly subject: string;
    readonly predicate: string;
    readonly object?: string | null;
    readonly value_json?: string | null;
    readonly properties_json: string;
    readonly source_kind: string;
}

export interface LabelMiningSelfImprovePattern {
    readonly pattern: string;
    readonly label_family: string;
    readonly count: number;
}

export interface LabelMiningSelfImproveResult {
    readonly schema: typeof SELF_IMPROVE_SCHEMA;
    readonly reviewed_promotion_safe_fact_count: number;
    readonly weak_advisory_candidate_count: number;
    readonly rejected_deferred_count: number;
    readonly nearest_neighbor_explanation_count: number;
    readonly top_patterns: readonly LabelMiningSelfImprovePattern[];
    readonly recommended_next_action: string;
    readonly out_path?: string;
}

const isPromotionSafeFact = (row: LabelMiningGraphFactRow): boolean => {
    if (row.source_kind !== REVIEWED_SOURCE_KIND) return false;
    if (row.predicate !== "reviewed_label") return false;
    try {
        const props = JSON.parse(row.properties_json) as { readonly promotion_safe?: unknown };
        return props.promotion_safe === true;
    } catch {
        return false;
    }
};

/**
 * Pure product query. Separates reviewed/advisory/rejected buckets and ranks the
 * most-repeated reviewed patterns. Weak/advisory rows are NEVER counted as
 * promotion-safe: only `reviewed_label` graph facts with
 * `properties_json.promotion_safe === true` contribute to the safe count.
 */
export function buildSelfImproveQuery(input: {
    readonly review_rows: readonly LabelMiningReviewTableRow[];
    readonly fact_rows: readonly LabelMiningGraphFactRow[];
}): LabelMiningSelfImproveResult {
    const reviewedPromotionSafeFactCount = input.fact_rows.filter(isPromotionSafeFact).length;
    const nearestNeighborExplanationCount = input.fact_rows.filter(
        (row) =>
            row.source_kind === REVIEWED_SOURCE_KIND &&
            row.predicate === "nearest_reviewed_neighbor",
    ).length;

    let weakAdvisoryCandidateCount = 0;
    let rejectedDeferredCount = 0;
    for (const row of input.review_rows) {
        if (row.review_status === "rejected" || row.review_status === "deferred") {
            rejectedDeferredCount += 1;
        } else if (row.review_status !== "accepted" && row.review_status !== "revised") {
            // pending / unknown -> still weak/advisory, never promotion-safe.
            weakAdvisoryCandidateCount += 1;
        }
    }

    // Rank repeated reviewed patterns from promotion-safe reviewed_label facts.
    const patternCounts = new Map<string, { count: number; label_family: string }>();
    const familyBySubject = new Map<string, string>();
    for (const review of input.review_rows) {
        familyBySubject.set(review.candidate_id, review.label_family);
    }
    for (const fact of input.fact_rows) {
        if (!isPromotionSafeFact(fact)) continue;
        const pattern = (fact.object ?? "").trim();
        if (pattern.length === 0) continue;
        const labelFamily = familyBySubject.get(fact.subject) ?? "none";
        const existing = patternCounts.get(pattern);
        if (existing) existing.count += 1;
        else patternCounts.set(pattern, { count: 1, label_family: labelFamily });
    }
    const topPatterns: LabelMiningSelfImprovePattern[] = [...patternCounts.entries()]
        .map(([pattern, info]) => ({ pattern, label_family: info.label_family, count: info.count }))
        .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
        .slice(0, 10);

    const recommendedNextAction =
        reviewedPromotionSafeFactCount === 0
            ? weakAdvisoryCandidateCount > 0
                ? "export the review queue and review weak candidates before promotion"
                : "mine new transcript label candidates for review"
            : "apply reviewed promotion-safe graph facts to self-improve guidance";

    return {
        schema: SELF_IMPROVE_SCHEMA,
        reviewed_promotion_safe_fact_count: reviewedPromotionSafeFactCount,
        weak_advisory_candidate_count: weakAdvisoryCandidateCount,
        rejected_deferred_count: rejectedDeferredCount,
        nearest_neighbor_explanation_count: nearestNeighborExplanationCount,
        top_patterns: topPatterns,
        recommended_next_action: recommendedNextAction,
    };
}

/** Plain-text rendering of the self-improve query result. */
export function renderSelfImproveText(result: LabelMiningSelfImproveResult): string {
    const lines: string[] = [
        "transcript label mining - self-improve query",
        `  reviewed promotion-safe facts : ${result.reviewed_promotion_safe_fact_count}`,
        `  weak / advisory candidates    : ${result.weak_advisory_candidate_count}`,
        `  rejected / deferred           : ${result.rejected_deferred_count}`,
        `  nearest-neighbor explanations : ${result.nearest_neighbor_explanation_count}`,
    ];
    if (result.top_patterns.length > 0) {
        lines.push("  top reviewed patterns:");
        for (const pattern of result.top_patterns) {
            lines.push(`    - [${pattern.label_family}] ${pattern.pattern} (${pattern.count})`);
        }
    }
    lines.push(`  next action: ${result.recommended_next_action}`);
    return lines.join("\n");
}

/** Graph-projection report (apply reviewed labels -> classifier graph). */
export interface LabelMiningGraphProjectionReport {
    readonly schema: typeof GRAPH_PROJECTION_SCHEMA;
    readonly accepted_count: number;
    readonly promotion_safe_fact_count: number;
    readonly node_count: number;
    readonly edge_count: number;
    readonly fact_count: number;
    readonly review_row_count: number;
    readonly vector_row_count: number;
    readonly statement_count: number;
    readonly applied: boolean;
    readonly out_path?: string;
}

const projectionToReport = (
    projection: LabelMiningGraphProjection,
    applied: boolean,
): LabelMiningGraphProjectionReport => ({
    schema: GRAPH_PROJECTION_SCHEMA,
    accepted_count: projection.accepted_count,
    promotion_safe_fact_count: projection.promotion_safe_fact_count,
    node_count: projection.nodes.length,
    edge_count: projection.edges.length,
    fact_count: projection.facts.length,
    review_row_count: projection.review_rows.length,
    vector_row_count: projection.vector_rows.length,
    statement_count: projection.statements.length,
    applied,
});

/** Plain-text rendering of the graph-projection report. */
export function renderGraphProjectionText(report: LabelMiningGraphProjectionReport): string {
    return [
        "transcript label mining - reviewed graph projection",
        `  accepted reviewed rows    : ${report.accepted_count}`,
        `  promotion-safe facts      : ${report.promotion_safe_fact_count}`,
        `  graph nodes / edges / facts: ${report.node_count} / ${report.edge_count} / ${report.fact_count}`,
        `  review / vector rows      : ${report.review_row_count} / ${report.vector_row_count}`,
        `  upsert statements         : ${report.statement_count}`,
        `  applied to db             : ${report.applied ? "yes" : "no (dry-run)"}`,
    ].join("\n");
}

export interface LabelMiningSelfImproveInput {
    readonly out?: string;
}

export interface LabelMiningProjectInput {
    readonly out?: string;
    /** When false, build statements but do not run them against SurrealDB. */
    readonly apply: boolean;
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
    readonly user_intent_kind?: string | null;
    readonly user_text?: string | null;
    readonly user_evidence_path?: string | null;
    readonly prev_turn_id?: string | null;
    readonly prev_text?: string | null;
    readonly prev_evidence_path?: string | null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));

/**
 * Intent kinds that are NOT organic user instructions and must never seed a
 * label candidate (wrapper/control noise, subagent plumbing, pasted refs).
 */
const EXCLUDED_INTENT_KINDS = [
    "control",
    "wrapper_instruction",
    "subagent_notification",
    "subagent_task",
    "pasted_reference",
] as const;

/**
 * Read recent ORGANIC user turns (with the immediately-preceding turn) from the
 * `turn` table as candidate windows. The read layer filters out the noise that
 * previously dominated mining:
 *   - `message_kind = 'task'`  -> drops tool_result / context / control turns
 *   - `session.source != 'claude-subagent'` -> drops subagent-session turns
 *   - excluded `intent_kind`s  -> drops wrapper/control/subagent-plumbing text
 * Only real `role = 'user'` instructions remain. The previous turn is joined via
 * `session` + `seq - 1` so correction/direction candidates carry the assistant
 * action they reacted to.
 */
const transcriptWindowSql = (sinceDays: number, limit: number): string => `
SELECT
    type::string(id) AS window_key,
    type::string(id) AS subject_id,
    type::string(session) AS session_id,
    type::string(id) AS user_turn_id,
    ts,
    seq AS user_seq,
    role AS user_role,
    message_kind AS user_message_kind,
    intent_kind AS user_intent_kind,
    text AS user_text,
    type::string(id) AS user_evidence_path
FROM turn
WHERE role = 'user'
    AND message_kind = 'task'
    AND session.source != 'claude-subagent'
    AND (intent_kind IS NONE OR intent_kind NOT IN ${JSON.stringify([...EXCLUDED_INTENT_KINDS])})
    AND text IS NOT NONE
    AND ts >= time::now() - ${Math.max(0, Math.trunc(sinceDays))}d
ORDER BY ts DESC
LIMIT ${Math.max(1, Math.trunc(limit))};`.trim();

/**
 * Batch-fetch the immediately-preceding turn for each user-turn window, keyed by
 * `session` + `seq - 1`. A single statement (vs a correlated subquery per row)
 * keeps the previous-assistant join fast on large `turn` tables. The unique
 * index `turn_session_seq` answers each `(session, seq)` membership cheaply.
 */
const prevTurnSql = (sessionIds: readonly string[], prevSeqs: readonly number[]): string => `
SELECT
    type::string(id) AS prev_turn_id,
    type::string(session) AS prev_session_id,
    seq AS prev_seq,
    text AS prev_text
FROM turn
WHERE type::string(session) IN ${JSON.stringify([...new Set(sessionIds)])}
    AND seq IN ${JSON.stringify([...new Set(prevSeqs)])};`.trim();

interface PrevTurnRow {
    readonly prev_turn_id?: string | null;
    readonly prev_session_id?: string | null;
    readonly prev_seq?: number | null;
    readonly prev_text?: string | null;
}

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
            ...(row.user_intent_kind != null
                ? { intentKind: str(row.user_intent_kind) }
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
    /**
     * Product read path: separate reviewed promotion-safe facts, weak/advisory
     * candidates, rejected/deferred reviews, and nearest-neighbor explanations.
     */
    readonly selfImproveQuery: (
        input: LabelMiningSelfImproveInput,
    ) => Effect.Effect<LabelMiningSelfImproveResult, LabelMiningError, SurrealClient>;
    /**
     * Project persisted reviewed rows + vector rows into classifier graph facts.
     * Only `accepted` reviews become promotion-safe. With `apply`, the idempotent
     * UPSERT statements are run against SurrealDB.
     */
    readonly projectReviewed: (
        input: LabelMiningProjectInput,
    ) => Effect.Effect<LabelMiningGraphProjectionReport, LabelMiningError, SurrealClient>;
}

export class LabelMiningService extends Context.Service<LabelMiningService, LabelMiningServiceShape>()(
    "ax/LabelMiningService",
) {}

/** Read all persisted reviewed-status rows. */
const reviewTableSql = `
SELECT
    candidate_id,
    type::string(graph_fact_id) AS graph_fact_id,
    label_family,
    review_status,
    promotion_safe,
    reviewed_label,
    reviewed_target,
    reviewer,
    rationale,
    evidence_paths_json
FROM transcript_label_review;`.trim();

/** Read all reviewed-source classifier graph facts. */
const reviewedFactSql = `
SELECT
    type::string(graph_id) AS graph_id,
    kind,
    subject,
    predicate,
    object,
    value_json,
    properties_json,
    source_kind
FROM classifier_graph_fact
WHERE source_kind = '${REVIEWED_SOURCE_KIND}';`.trim();

/** Read persisted reviewed rows + their candidate evidence for re-projection. */
const reviewProjectionSql = `
SELECT
    candidate_id,
    label_family,
    review_status,
    promotion_safe,
    reviewed_label,
    reviewed_target,
    reviewer,
    rationale,
    evidence_paths_json
FROM transcript_label_review;`.trim();

/** Read persisted vector rows for re-projection. */
const vectorProjectionSql = `
SELECT
    record::id(id) AS id,
    candidate_id,
    embedding_model,
    embedding_dim,
    embedding_ref,
    nearest_reviewed_candidate_ids_json,
    nearest_scores_json
FROM transcript_label_vector;`.trim();

interface VectorTableRow {
    readonly id: string;
    readonly candidate_id: string;
    readonly embedding_model?: string | null;
    readonly embedding_dim?: number | null;
    readonly embedding_ref?: string | null;
    readonly nearest_reviewed_candidate_ids_json?: string | null;
    readonly nearest_scores_json?: string | null;
}

const parseStringArray = (value: string | null | undefined): readonly string[] => {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
        return [];
    }
};

const parseNumberArray = (value: string | null | undefined): readonly number[] => {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((v) => Number(v)) : [];
    } catch {
        return [];
    }
};

/**
 * Reconstruct projection inputs from persisted review + vector rows. The
 * `transcript_label_review` row carries the evidence paths and reviewed label,
 * so a synthetic candidate is enough to re-derive deterministic graph facts.
 */
const reviewRowToReviewedLabel = (row: LabelMiningReviewTableRow): TranscriptReviewedLabel => ({
    candidate_id: row.candidate_id,
    review_status:
        row.review_status === "accepted" ||
        row.review_status === "rejected" ||
        row.review_status === "revised" ||
        row.review_status === "deferred"
            ? row.review_status
            : "deferred",
    ...(row.reviewed_label != null ? { reviewed_label: row.reviewed_label } : {}),
    ...(row.reviewed_target != null ? { reviewed_target: row.reviewed_target } : {}),
    rationale: row.rationale,
    reviewer: row.reviewer,
    reviewed_at: "",
});

const reviewRowToCandidate = (row: LabelMiningReviewTableRow): TranscriptLabelCandidate => ({
    id: row.candidate_id,
    source_kind: "transcript_label_mining",
    subject_type: "event_window",
    subject_id: row.candidate_id,
    session_id: "",
    turn_id: row.candidate_id,
    label_family: (row.label_family as LabelFamily) ?? "none",
    target: row.reviewed_target ?? "",
    weak_label: row.reviewed_label ?? row.label_family,
    weak_confidence: 0,
    weak_sources: [],
    evidence_paths: parseStringArray(row.evidence_paths_json),
    excerpt: "",
});

const vectorRowToVector = (row: VectorTableRow): TranscriptLabelVectorRow => ({
    id: row.id,
    candidate_id: row.candidate_id,
    embedding_model: row.embedding_model ?? "",
    embedding_dim: typeof row.embedding_dim === "number" ? row.embedding_dim : 0,
    embedding_ref: row.embedding_ref ?? "",
    nearest_reviewed_candidate_ids: parseStringArray(row.nearest_reviewed_candidate_ids_json),
    nearest_scores: parseNumberArray(row.nearest_scores_json),
});

const writeReport = (out: string, report: unknown): Effect.Effect<void, LabelMiningReportWriteError> =>
    Effect.try({
        try: () => {
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, `${prettyPrint(report)}\n`);
        },
        catch: (err) =>
            new LabelMiningReportWriteError({
                path: out,
                message: err instanceof Error ? err.message : String(err),
            }),
    });

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
                const windowRows = rows ?? [];

                // Batch-fetch previous turns in ONE statement (correlated subquery
                // per row is O(rows * full-scan) on a large `turn` table).
                const prevKey = (sessionId: string, seq: number): string => `${sessionId}|${seq}`;
                const prevTextById = new Map<string, { id: string; text: string }>();
                const sessionIds: string[] = [];
                const prevSeqs: number[] = [];
                for (const row of windowRows) {
                    // Only batch-fetch prev turns for rows that do not already carry
                    // an inline previous turn (real read query never supplies one).
                    if (
                        row.prev_turn_id == null &&
                        row.session_id != null &&
                        typeof row.user_seq === "number"
                    ) {
                        sessionIds.push(str(row.session_id));
                        prevSeqs.push(row.user_seq - 1);
                    }
                }
                if (sessionIds.length > 0) {
                    const [prevRows] = yield* db.query<[PrevTurnRow[]]>(
                        prevTurnSql(sessionIds, prevSeqs),
                    );
                    for (const prev of prevRows ?? []) {
                        if (
                            prev.prev_session_id != null &&
                            typeof prev.prev_seq === "number" &&
                            prev.prev_turn_id != null
                        ) {
                            prevTextById.set(prevKey(str(prev.prev_session_id), prev.prev_seq), {
                                id: str(prev.prev_turn_id),
                                text: str(prev.prev_text ?? ""),
                            });
                        }
                    }
                }

                const windows: EventWindowLike[] = [];
                for (const row of windowRows) {
                    let merged: TranscriptWindowRow = row;
                    // Prefer the batch-fetched previous turn; fall back to any prev
                    // fields already present on the row (test fixtures supply these
                    // inline; the real read query does not).
                    if (
                        row.prev_turn_id == null &&
                        row.session_id != null &&
                        typeof row.user_seq === "number"
                    ) {
                        const prev = prevTextById.get(
                            prevKey(str(row.session_id), row.user_seq - 1),
                        );
                        if (prev) {
                            merged = {
                                ...row,
                                prev_turn_id: prev.id,
                                prev_text: prev.text,
                                prev_evidence_path: prev.id,
                            };
                        }
                    }
                    const window = rowToWindow(merged);
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

            const selfImproveQuery = Effect.fn("LabelMiningService.selfImproveQuery")(function* (
                input: LabelMiningSelfImproveInput,
            ) {
                const [reviewRows] = yield* db.query<[LabelMiningReviewTableRow[]]>(reviewTableSql);
                const [factRows] = yield* db.query<[LabelMiningGraphFactRow[]]>(reviewedFactSql);
                const result = buildSelfImproveQuery({
                    review_rows: reviewRows ?? [],
                    fact_rows: factRows ?? [],
                });
                if (input.out === undefined) return result;
                const withPath: LabelMiningSelfImproveResult = { ...result, out_path: input.out };
                yield* writeReport(input.out, withPath);
                return withPath;
            });

            const projectReviewed = Effect.fn("LabelMiningService.projectReviewed")(function* (
                input: LabelMiningProjectInput,
            ) {
                const [reviewRows] = yield* db.query<[LabelMiningReviewTableRow[]]>(
                    reviewProjectionSql,
                );
                const [vectorRows] = yield* db.query<[VectorTableRow[]]>(vectorProjectionSql);
                const reviews = (reviewRows ?? []).map(reviewRowToReviewedLabel);
                const candidates = (reviewRows ?? []).map(reviewRowToCandidate);
                const vectors = (vectorRows ?? []).map(vectorRowToVector);
                const projection = projectReviewedLabelsToGraph({ candidates, reviews, vectors });

                if (input.apply) {
                    for (const statement of projection.statements) {
                        yield* db.query(statement);
                    }
                }

                const report = projectionToReport(projection, input.apply);
                if (input.out === undefined) return report;
                const withPath: LabelMiningGraphProjectionReport = { ...report, out_path: input.out };
                yield* writeReport(input.out, withPath);
                return withPath;
            });

            return LabelMiningService.of({
                miningReport,
                writeMiningReport,
                selfImproveQuery,
                projectReviewed,
            });
        }),
    );
