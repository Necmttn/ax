import { describe, expect, test } from "bun:test";
import {
    auditWeakCandidateBatch,
    evaluateLabelMiningIteration,
    mineTranscriptLabelCandidates,
    projectReviewedLabelsToGraph,
    type EventWindowLike,
    type LabelMiningCandidateAudit,
    type LabelMiningMetrics,
    type LabelMiningPromotionAudit,
    type TranscriptLabelCandidate,
    type TranscriptLabelVectorRow,
    type TranscriptReviewedLabel,
} from "./label-mining.ts";

const win = (input: {
    readonly user: string;
    readonly previousAssistant?: string;
    readonly sessionId?: string;
    readonly subjectId?: string;
    readonly turnId?: string;
    readonly userMessageKind?: string;
    readonly evidencePaths?: readonly string[];
}): EventWindowLike => ({
    key: `window:${input.subjectId ?? "u1"}`,
    subjectType: "event_window",
    subjectId: input.subjectId ?? "turn:u1",
    sessionId: input.sessionId ?? "session:s1",
    userTurn: {
        id: input.turnId ?? "turn:u1",
        seq: 3,
        role: "user",
        ...(input.userMessageKind ? { messageKind: input.userMessageKind } : {}),
        text: input.user,
        ts: new Date("2026-05-30T00:00:03Z"),
        evidencePath: (input.evidencePaths ?? ["transcript://session:s1/turn:u1"])[0],
    },
    previousAssistantTurn: input.previousAssistant
        ? {
            id: "turn:a1",
            seq: 1,
            role: "assistant",
            text: input.previousAssistant,
            ts: new Date("2026-05-30T00:00:01Z"),
            evidencePath: "transcript://session:s1/turn:a1",
        }
        : null,
    evidencePaths: input.evidencePaths ?? ["transcript://session:s1/turn:u1"],
});

describe("mineTranscriptLabelCandidates", () => {
    test("mines a correction caused by previous assistant action", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({
                    user: "no, that's wrong, not what I asked for",
                    previousAssistant: "I used pip to install the dependency.",
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        const c = candidates[0]!;
        expect(c.label_family).toBe("correction");
        expect(c.source_kind).toBe("transcript_label_mining");
        expect(c.subject_type).toBe("event_window");
        expect(c.previous_assistant_turn_id).toBe("turn:a1");
        expect(c.previous_assistant_excerpt).toContain("pip");
        expect(c.evidence_paths.length).toBeGreaterThan(0);
        expect(c.weak_confidence).toBeGreaterThan(0);
        expect(c.weak_sources.length).toBeGreaterThan(0);
    });

    test("mines a direction/preference like use UV", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({
                    user: "use uv for python, don't use pip",
                    previousAssistant: "Running pip install ...",
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.label_family).toBe("direction");
    });

    test("mines a verification demand like did you run tests", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "did you run the tests?", previousAssistant: "Done implementing." }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.label_family).toBe("verification");
    });

    test("mines an approval/rejection", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "lgtm, ship it", previousAssistant: "Here is the PR." }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.label_family).toBe("approval_or_rejection");
    });

    test("ignores wrapper/control/system text", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "<goal_context>do the thing</goal_context>" }),
                win({
                    user: "# CLAUDE.md instructions",
                    subjectId: "turn:u2",
                    turnId: "turn:u2",
                }),
                win({
                    user: "system reminder, not a real message",
                    subjectId: "turn:u3",
                    turnId: "turn:u3",
                    userMessageKind: "system_or_developer",
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(0);
    });

    test("requires evidence paths and drops candidates without them", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({
                    user: "no, that's wrong",
                    previousAssistant: "I did X.",
                    evidencePaths: [],
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(0);
    });

    test("caps excerpt fields to 600 characters", () => {
        const longUser = `no, that's wrong. ${"x".repeat(2000)}`;
        const longAssistant = `I used pip. ${"y".repeat(2000)}`;
        const candidates = mineTranscriptLabelCandidates({
            windows: [win({ user: longUser, previousAssistant: longAssistant })],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.excerpt.length).toBeLessThanOrEqual(600);
        expect(candidates[0]!.previous_assistant_excerpt!.length).toBeLessThanOrEqual(600);
    });

    test("respects the limit", () => {
        const windows = Array.from({ length: 10 }, (_v, i) =>
            win({
                user: "no, that's wrong",
                previousAssistant: "I did X.",
                subjectId: `turn:u${i}`,
                turnId: `turn:u${i}`,
                evidencePaths: [`transcript://session:s1/turn:u${i}`],
            }),
        );
        const candidates = mineTranscriptLabelCandidates({ windows, limit: 3 });
        expect(candidates.length).toBe(3);
    });

    test("produces stable deterministic candidate ids", () => {
        const input = {
            windows: [
                win({ user: "no, that's wrong", previousAssistant: "I did X." }),
            ],
            limit: 500,
        };
        const a = mineTranscriptLabelCandidates(input);
        const b = mineTranscriptLabelCandidates(input);
        expect(a[0]!.id).toBe(b[0]!.id);
    });
});

describe("auditWeakCandidateBatch", () => {
    test("reports ready when families are diverse and evidence present", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "no, that's wrong", previousAssistant: "I used pip." }),
                win({
                    user: "use uv, don't use pip",
                    previousAssistant: "Running pip ...",
                    subjectId: "turn:u2",
                    turnId: "turn:u2",
                    evidencePaths: ["transcript://session:s1/turn:u2"],
                }),
                win({
                    user: "did you run the tests?",
                    previousAssistant: "Done.",
                    subjectId: "turn:u3",
                    turnId: "turn:u3",
                    evidencePaths: ["transcript://session:s1/turn:u3"],
                }),
                win({
                    user: "lgtm, ship it",
                    previousAssistant: "Here is the PR.",
                    subjectId: "turn:u4",
                    turnId: "turn:u4",
                    evidencePaths: ["transcript://session:s1/turn:u4"],
                }),
            ],
            limit: 500,
        });
        const audit = auditWeakCandidateBatch(candidates);
        expect(audit.candidate_count).toBe(4);
        expect(audit.evidence_missing_count).toBe(0);
        expect(Object.keys(audit.label_family_counts).length).toBeGreaterThanOrEqual(4);
        expect(audit.decision).toBe("candidate_batch_ready");
        expect(audit.failures.length).toBe(0);
    });

    test("fails when candidates are missing evidence", () => {
        const audit = auditWeakCandidateBatch([
            {
                id: "x",
                source_kind: "transcript_label_mining",
                subject_type: "event_window",
                subject_id: "turn:u1",
                session_id: "session:s1",
                turn_id: "turn:u1",
                label_family: "correction",
                target: "wrong_output",
                weak_label: "correction",
                weak_confidence: 0.7,
                weak_sources: ["correction"],
                evidence_paths: [],
                excerpt: "no, wrong",
            },
        ]);
        expect(audit.evidence_missing_count).toBe(1);
        expect(audit.decision).toBe("candidate_batch_failed");
        expect(audit.failures).toContain("failed_missing_evidence");
    });
});

describe("evaluateLabelMiningIteration", () => {
    const metrics = (input: Partial<LabelMiningMetrics> = {}): LabelMiningMetrics => ({
        review_precision: 0.9,
        accepted_label_count: 50,
        neighbor_recall: 0.6,
        graph_fact_count: 12,
        product_query_result_count: 20,
        ...input,
    });

    const okAudit = (): LabelMiningCandidateAudit => ({
        candidate_count: 4,
        label_family_counts: { correction: 1, direction: 1, verification: 1, approval_or_rejection: 1 },
        wrapper_like_count: 0,
        evidence_missing_count: 0,
        decision: "candidate_batch_ready",
        failures: [],
    });

    const okPromotion = (): LabelMiningPromotionAudit => ({
        promoted_count: 10,
        reviewed_promoted_count: 10,
        unsafe_promoted_count: 0,
        candidate_precision: 0.88,
    });

    test("continues when metrics improve and gates pass", () => {
        const decision = evaluateLabelMiningIteration({
            iteration: 3,
            expensive_model_runs: 1,
            previous_metrics: [metrics({ accepted_label_count: 40 })],
            current_metrics: metrics({ accepted_label_count: 50 }),
            candidate_audit: okAudit(),
            promotion_audit: okPromotion(),
        });
        expect(decision.decision).toBe("continue");
        expect(decision.can_continue).toBe(true);
        expect(decision.stop_reason).toBeNull();
        expect(decision.failures.length).toBe(0);
    });

    test("two no-improvement iterations triggers stop_for_no_progress", () => {
        const flat = metrics();
        const decision = evaluateLabelMiningIteration({
            iteration: 4,
            expensive_model_runs: 1,
            previous_metrics: [flat, flat],
            current_metrics: flat,
            candidate_audit: okAudit(),
            promotion_audit: okPromotion(),
        });
        expect(decision.decision).toBe("stop");
        expect(decision.can_continue).toBe(false);
        expect(decision.stop_reason).toBe("stop_for_no_progress");
    });

    test("more than 8 iterations triggers stop_for_iteration_limit", () => {
        const decision = evaluateLabelMiningIteration({
            iteration: 9,
            expensive_model_runs: 1,
            previous_metrics: [metrics({ accepted_label_count: 1 })],
            current_metrics: metrics({ accepted_label_count: 99 }),
            candidate_audit: okAudit(),
            promotion_audit: okPromotion(),
        });
        expect(decision.decision).toBe("stop");
        expect(decision.can_continue).toBe(false);
        expect(decision.stop_reason).toBe("stop_for_iteration_limit");
    });

    test("precision below 0.65 triggers failed_candidate_precision", () => {
        const decision = evaluateLabelMiningIteration({
            iteration: 2,
            expensive_model_runs: 0,
            previous_metrics: [],
            current_metrics: metrics(),
            candidate_audit: okAudit(),
            promotion_audit: { ...okPromotion(), candidate_precision: 0.6 },
        });
        expect(decision.decision).toBe("fail");
        expect(decision.can_continue).toBe(false);
        expect(decision.failures).toContain("failed_candidate_precision");
    });

    test("missing evidence triggers failed_missing_evidence", () => {
        const decision = evaluateLabelMiningIteration({
            iteration: 2,
            expensive_model_runs: 0,
            previous_metrics: [],
            current_metrics: metrics(),
            candidate_audit: {
                ...okAudit(),
                evidence_missing_count: 2,
                decision: "candidate_batch_failed",
                failures: ["failed_missing_evidence"],
            },
            promotion_audit: okPromotion(),
        });
        expect(decision.decision).toBe("fail");
        expect(decision.can_continue).toBe(false);
        expect(decision.failures).toContain("failed_missing_evidence");
    });

    test("weak/model-only promotion triggers failed_unsafe_promotion", () => {
        const decision = evaluateLabelMiningIteration({
            iteration: 2,
            expensive_model_runs: 0,
            previous_metrics: [],
            current_metrics: metrics(),
            candidate_audit: okAudit(),
            promotion_audit: { ...okPromotion(), unsafe_promoted_count: 3 },
        });
        expect(decision.decision).toBe("fail");
        expect(decision.can_continue).toBe(false);
        expect(decision.failures).toContain("failed_unsafe_promotion");
    });

    test("failures take priority over stop conditions and surface next_action", () => {
        const flat = metrics();
        const decision = evaluateLabelMiningIteration({
            iteration: 9,
            expensive_model_runs: 0,
            previous_metrics: [flat, flat],
            current_metrics: flat,
            candidate_audit: okAudit(),
            promotion_audit: { ...okPromotion(), candidate_precision: 0.5 },
        });
        expect(decision.decision).toBe("fail");
        expect(decision.failures).toContain("failed_candidate_precision");
        expect(typeof decision.next_action).toBe("string");
        expect(decision.next_action.length).toBeGreaterThan(0);
    });
});

describe("projectReviewedLabelsToGraph", () => {
    const candidate = (input: {
        readonly id: string;
        readonly family?: TranscriptLabelCandidate["label_family"];
        readonly evidence?: readonly string[];
    }): TranscriptLabelCandidate => ({
        id: input.id,
        source_kind: "transcript_label_mining",
        subject_type: "event_window",
        subject_id: `subj:${input.id}`,
        session_id: "session:s1",
        turn_id: `turn:${input.id}`,
        label_family: input.family ?? "correction",
        target: "wrong_output",
        weak_label: input.family ?? "correction",
        weak_confidence: 0.74,
        weak_sources: ["correction:wrong_output"],
        evidence_paths: input.evidence ?? [`~/.claude/projects/p/${input.id}.jsonl`],
        excerpt: "no, that is wrong",
    });

    const reviewed = (input: {
        readonly candidate_id: string;
        readonly status: TranscriptReviewedLabel["review_status"];
        readonly reviewed_label?: string;
    }): TranscriptReviewedLabel => ({
        candidate_id: input.candidate_id,
        review_status: input.status,
        ...(input.reviewed_label ? { reviewed_label: input.reviewed_label } : {}),
        rationale: "human checked",
        reviewer: "necmttn",
        reviewed_at: "2026-06-02T00:00:00.000Z",
    });

    const vector = (input: {
        readonly candidate_id: string;
        readonly neighbors?: readonly string[];
    }): TranscriptLabelVectorRow => ({
        id: `vec:${input.candidate_id}`,
        candidate_id: input.candidate_id,
        embedding_model: "sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim: 384,
        embedding_ref: `ref:${input.candidate_id}`,
        nearest_reviewed_candidate_ids: input.neighbors ?? [],
        nearest_scores: (input.neighbors ?? []).map(() => 0.9),
    });

    test("accepted reviewed rows become promotion-safe graph facts with evidence", () => {
        const c = candidate({ id: "c1", family: "correction" });
        const projection = projectReviewedLabelsToGraph({
            candidates: [c],
            reviews: [reviewed({ candidate_id: "c1", status: "accepted", reviewed_label: "correction" })],
            vectors: [vector({ candidate_id: "c1" })],
        });
        expect(projection.promotion_safe_fact_count).toBeGreaterThanOrEqual(1);
        const facts = projection.facts.filter((f) => f.subject === "c1");
        expect(facts.length).toBeGreaterThanOrEqual(1);
        for (const fact of facts) {
            expect(fact.kind).toBe("transcript_reviewed_label");
            expect(fact.source_kind).toBe("transcript_label_mining_reviewed");
            expect(fact.properties_json).toContain("\"review_status\":\"accepted\"");
            expect(fact.properties_json).toContain("\"promotion_safe\":true");
            expect(fact.evidence_edges_json.length).toBeGreaterThan(2);
        }
        // node + at least one evidence edge per accepted row
        expect(projection.nodes.some((n) => n.source_kind === "transcript_label_mining_reviewed")).toBe(true);
        expect(projection.edges.some((e) => e.evidence_path.length > 0)).toBe(true);
    });

    test("rejected and deferred rows are stored but not promotion-safe", () => {
        const projection = projectReviewedLabelsToGraph({
            candidates: [
                candidate({ id: "c2", family: "direction" }),
                candidate({ id: "c3", family: "verification" }),
            ],
            reviews: [
                reviewed({ candidate_id: "c2", status: "rejected" }),
                reviewed({ candidate_id: "c3", status: "deferred" }),
            ],
            vectors: [],
        });
        expect(projection.promotion_safe_fact_count).toBe(0);
        for (const fact of projection.facts) {
            expect(fact.properties_json).toContain("\"promotion_safe\":false");
        }
        expect(projection.review_rows.every((r) => r.promotion_safe === false)).toBe(true);
        expect(projection.review_rows.map((r) => r.review_status).sort()).toEqual(["deferred", "rejected"]);
    });

    test("vector rows join back to candidate and graph fact ids", () => {
        const projection = projectReviewedLabelsToGraph({
            candidates: [candidate({ id: "c4" })],
            reviews: [reviewed({ candidate_id: "c4", status: "accepted", reviewed_label: "correction" })],
            vectors: [vector({ candidate_id: "c4", neighbors: ["c1"] })],
        });
        expect(projection.vector_rows.length).toBe(1);
        const row = projection.vector_rows[0]!;
        expect(row.candidate_id).toBe("c4");
        expect(typeof row.graph_fact_id).toBe("string");
        expect(row.graph_fact_id!.length).toBeGreaterThan(0);
        // the referenced graph fact id exists among projected facts
        expect(projection.facts.some((f) => f.graph_id === row.graph_fact_id)).toBe(true);
        expect(row.nearest_reviewed_candidate_ids).toEqual(["c1"]);
    });

    test("write statements are deterministic and idempotent", () => {
        const input = {
            candidates: [candidate({ id: "c5", family: "correction" })],
            reviews: [reviewed({ candidate_id: "c5", status: "accepted", reviewed_label: "correction" })],
            vectors: [vector({ candidate_id: "c5" })],
        } as const;
        const a = projectReviewedLabelsToGraph(input);
        const b = projectReviewedLabelsToGraph(input);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        // every write statement is an idempotent UPSERT keyed by a stable id
        expect(a.statements.length).toBeGreaterThan(0);
        for (const stmt of a.statements) {
            expect(stmt.startsWith("UPSERT ")).toBe(true);
        }
        expect(a.statements).toEqual(b.statements);
    });

    test("a vector with no matching reviewed candidate yields no graph fact link", () => {
        const projection = projectReviewedLabelsToGraph({
            candidates: [candidate({ id: "c6" })],
            reviews: [],
            vectors: [vector({ candidate_id: "c6" })],
        });
        // no accepted review -> no promotion-safe fact, vector still recorded
        expect(projection.promotion_safe_fact_count).toBe(0);
        expect(projection.vector_rows.length).toBe(1);
        expect(projection.vector_rows[0]!.graph_fact_id).toBeUndefined();
    });
});
