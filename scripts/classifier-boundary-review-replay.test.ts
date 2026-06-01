import { describe, expect, test } from "bun:test";
import { buildBoundaryReplayReport } from "./classifier-boundary-review-replay.ts";

describe("classifier boundary review replay", () => {
    test("reports deterministic coverage for reviewed workflow correction misses", async () => {
        const report = await buildBoundaryReplayReport({
            reviewPath: ".ax/experiments/boundary-miss-review-workflow-candidate-current.json",
            review: {
                schema: "ax.boundary_miss_review.v1",
                source_analysis_decision: "needs_none_safety_review",
                items: [{
                    id: "workflow-candidate-topic/review_coverage/correction_or_rejection_signal/lhseid",
                    actual: "correction_or_rejection_signal",
                    current_label: "correction",
                    target: "workflow_state",
                    text_excerpt: "Persisted review fact accepted workflow candidate correction_or_rejection_signal. add_context_guardrail Accepted as a real workflow-state correction case.",
                }],
            },
        });

        expect(report).toMatchObject({
            schema: "ax.boundary_review_deterministic_replay.v1",
            items: 1,
            covered_by_deterministic: 1,
            uncovered: 0,
            coverage_rate: 1,
            decision: "deterministic_boundary_replay_complete",
        });
        expect(report.rows[0]?.deterministic_results[0]).toMatchObject({
            classifier_key: "correction-event",
            label: "correction",
            target: "workflow_state",
        });
    });

    test("keeps gaps visible when deterministic classifiers do not match", async () => {
        const report = await buildBoundaryReplayReport({
            reviewPath: "review.json",
            review: {
                items: [{
                    id: "gap",
                    actual: "verification_or_recovery_signal",
                    current_label: "verification_request",
                    target: "benchmark_required",
                    text_excerpt: "please define the benchmark",
                }],
            },
        });

        expect(report).toMatchObject({
            items: 1,
            covered_by_deterministic: 0,
            uncovered: 1,
            coverage_rate: 0,
            decision: "deterministic_boundary_replay_has_gaps",
        });
    });
});
