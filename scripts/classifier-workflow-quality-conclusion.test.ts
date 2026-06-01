import { describe, expect, test } from "bun:test";
import { buildWorkflowQualityConclusion } from "./classifier-workflow-quality-conclusion.ts";

describe("classifier workflow quality conclusion", () => {
    test("continues hybrid path when raw SetFit fails but replay graph evidence is available", () => {
        const report = buildWorkflowQualityConclusion({
            qualityStatusPath: "quality.json",
            hybridRobustnessPath: "hybrid.json",
            boundaryReplayPath: "replay.json",
            graphQueryPath: "graph.json",
            qualityStatus: {
                quality_gate_passed: false,
                promotion_quality: false,
                recommended_use: "model_quality_work",
                metrics: {
                    macro_f1_min: 0.7364,
                    repeated_miss_count: 7,
                },
                blockers: [
                    "model_quality_gate_not_passed",
                    "residual_repeated_misses",
                ],
            },
            hybridRobustness: {
                decision: "hybrid_robust_enough",
                summary: {
                    macro_f1_min: 0.7364,
                    none_false_positive_rate_max: 0,
                },
                harmful_override_count_total: 0,
                fixed_none_false_positive_count_total: 1,
            },
            boundaryReplay: {
                decision: "deterministic_boundary_replay_complete",
                coverage_rate: 1,
                covered_by_deterministic: 1,
                uncovered: 0,
            },
            graphQuery: {
                query_match_status: "matched",
                totals: {
                    boundary_replay_fact_count: 2,
                },
                result_totals: {
                    boundary_replay_fact_count: 1,
                },
            },
        });

        expect(report).toMatchObject({
            schema: "ax.workflow_classifier_quality_conclusion.v1",
            conclusion: "continue_hybrid_not_raw_setfit",
            production_posture: "deterministic_and_reviewed_graph_facts_only",
            setfit: {
                quality_gate_passed: false,
                promotion_quality: false,
                macro_f1_min: 0.7364,
                repeated_miss_count: 7,
            },
            hybrid: {
                decision: "hybrid_robust_enough",
                none_false_positive_rate_max: 0,
            },
            boundary_replay: {
                coverage_rate: 1,
                covered_by_deterministic: 1,
                uncovered: 0,
            },
            graph: {
                query_match_status: "matched",
                boundary_replay_fact_count: 2,
                result_boundary_replay_fact_count: 1,
            },
        });
        expect(report.next_action).toContain("Do not promote raw SetFit output");
    });

    test("keeps the work in model-quality mode when replay graph evidence is missing", () => {
        const report = buildWorkflowQualityConclusion({
            qualityStatusPath: "quality.json",
            hybridRobustnessPath: "hybrid.json",
            boundaryReplayPath: "replay.json",
            graphQueryPath: "graph.json",
            qualityStatus: {
                quality_gate_passed: false,
                promotion_quality: false,
                metrics: {
                    macro_f1_min: 0.71,
                },
            },
            hybridRobustness: {
                decision: "hybrid_robust_enough",
            },
            boundaryReplay: {
                coverage_rate: 0,
                covered_by_deterministic: 0,
                uncovered: 1,
            },
            graphQuery: {
                query_match_status: "no_match",
            },
        });

        expect(report.conclusion).toBe("continue_model_quality_work");
        expect(report.production_posture).toBe("model_quality_work_only");
        expect(report.reasons).toContain("Boundary replay still has uncovered misses.");
    });
});
