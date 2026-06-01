#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Report {
    readonly [key: string]: unknown;
}

export interface WorkflowQualityConclusionReport {
    readonly schema: "ax.workflow_classifier_quality_conclusion.v1";
    readonly inputs: {
        readonly quality_status: string;
        readonly hybrid_robustness: string;
        readonly boundary_replay: string;
        readonly graph_query: string;
    };
    readonly setfit: {
        readonly quality_gate_passed: boolean;
        readonly promotion_quality: boolean;
        readonly recommended_use?: string;
        readonly macro_f1_min?: number;
        readonly repeated_miss_count?: number;
        readonly blockers: readonly string[];
    };
    readonly hybrid: {
        readonly decision?: string;
        readonly macro_f1_min?: number;
        readonly none_false_positive_rate_max?: number;
        readonly harmful_override_count_total?: number;
        readonly fixed_none_false_positive_count_total?: number;
    };
    readonly boundary_replay: {
        readonly decision?: string;
        readonly coverage_rate?: number;
        readonly covered_by_deterministic?: number;
        readonly uncovered?: number;
    };
    readonly graph: {
        readonly query_match_status?: string;
        readonly boundary_replay_fact_count?: number;
        readonly result_boundary_replay_fact_count?: number;
    };
    readonly conclusion: "continue_hybrid_not_raw_setfit" | "continue_model_quality_work" | "bail_on_classifier_path";
    readonly production_posture: "deterministic_and_reviewed_graph_facts_only" | "model_quality_work_only";
    readonly next_action: string;
    readonly reasons: readonly string[];
}

const loadJson = (path: string): Report =>
    JSON.parse(readFileSync(path, "utf8")) as Report;

const record = (value: unknown): Report =>
    typeof value === "object" && value !== null ? value as Report : {};

const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const booleanValue = (value: unknown): boolean =>
    value === true;

const stringArray = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function buildWorkflowQualityConclusion(input: {
    readonly qualityStatusPath: string;
    readonly hybridRobustnessPath: string;
    readonly boundaryReplayPath: string;
    readonly graphQueryPath: string;
    readonly qualityStatus: Report;
    readonly hybridRobustness: Report;
    readonly boundaryReplay: Report;
    readonly graphQuery: Report;
}): WorkflowQualityConclusionReport {
    const qualityMetrics = record(input.qualityStatus.metrics);
    const hybridSummary = record(input.hybridRobustness.summary);
    const graphTotals = record(input.graphQuery.totals);
    const graphResultTotals = record(input.graphQuery.result_totals);
    const setfitGatePassed = booleanValue(input.qualityStatus.quality_gate_passed);
    const promotionQuality = booleanValue(input.qualityStatus.promotion_quality);
    const hybridRobust = stringValue(input.hybridRobustness.decision) === "hybrid_robust_enough";
    const graphMatched = stringValue(input.graphQuery.query_match_status) === "matched";
    const boundaryCoverage = numberValue(input.boundaryReplay.coverage_rate) ?? 0;
    const boundaryCovered = numberValue(input.boundaryReplay.covered_by_deterministic) ?? 0;
    const boundaryUncovered = numberValue(input.boundaryReplay.uncovered) ?? 0;

    const reasons = [
        setfitGatePassed
            ? "SetFit quality gate passed, but promotion remains human/review gated."
            : "Raw SetFit is not promotion quality because the quality gate failed.",
        promotionQuality
            ? "The quality status allows promotion-quality model use."
            : "The quality status explicitly blocks promotion-quality model use.",
        hybridRobust
            ? "Hybrid robustness passes and removes none false positives in the current run."
            : "Hybrid robustness is not yet a passing fallback.",
        boundaryCoverage > 0 && boundaryUncovered === 0
            ? "The repeated workflow-candidate miss is covered by deterministic replay."
            : "Boundary replay still has uncovered misses.",
        graphMatched && boundaryCovered > 0
            ? "Boundary replay coverage is queryable from the graph."
            : "Boundary replay coverage is not yet queryable from the graph.",
    ];

    const conclusion = !setfitGatePassed && hybridRobust && boundaryCoverage > 0 && graphMatched
        ? "continue_hybrid_not_raw_setfit"
        : !setfitGatePassed
            ? "continue_model_quality_work"
            : promotionQuality
                ? "continue_hybrid_not_raw_setfit"
                : "bail_on_classifier_path";

    return {
        schema: "ax.workflow_classifier_quality_conclusion.v1",
        inputs: {
            quality_status: input.qualityStatusPath,
            hybrid_robustness: input.hybridRobustnessPath,
            boundary_replay: input.boundaryReplayPath,
            graph_query: input.graphQueryPath,
        },
        setfit: {
            quality_gate_passed: setfitGatePassed,
            promotion_quality: promotionQuality,
            ...(stringValue(input.qualityStatus.recommended_use) === undefined ? {} : { recommended_use: stringValue(input.qualityStatus.recommended_use) }),
            ...(numberValue(qualityMetrics.macro_f1_min) === undefined ? {} : { macro_f1_min: numberValue(qualityMetrics.macro_f1_min) }),
            ...(numberValue(qualityMetrics.repeated_miss_count) === undefined ? {} : { repeated_miss_count: numberValue(qualityMetrics.repeated_miss_count) }),
            blockers: stringArray(input.qualityStatus.blockers),
        },
        hybrid: {
            ...(stringValue(input.hybridRobustness.decision) === undefined ? {} : { decision: stringValue(input.hybridRobustness.decision) }),
            ...(numberValue(hybridSummary.macro_f1_min) === undefined ? {} : { macro_f1_min: numberValue(hybridSummary.macro_f1_min) }),
            ...(numberValue(hybridSummary.none_false_positive_rate_max) === undefined ? {} : { none_false_positive_rate_max: numberValue(hybridSummary.none_false_positive_rate_max) }),
            ...(numberValue(input.hybridRobustness.harmful_override_count_total) === undefined ? {} : { harmful_override_count_total: numberValue(input.hybridRobustness.harmful_override_count_total) }),
            ...(numberValue(input.hybridRobustness.fixed_none_false_positive_count_total) === undefined ? {} : { fixed_none_false_positive_count_total: numberValue(input.hybridRobustness.fixed_none_false_positive_count_total) }),
        },
        boundary_replay: {
            ...(stringValue(input.boundaryReplay.decision) === undefined ? {} : { decision: stringValue(input.boundaryReplay.decision) }),
            ...(numberValue(input.boundaryReplay.coverage_rate) === undefined ? {} : { coverage_rate: numberValue(input.boundaryReplay.coverage_rate) }),
            ...(numberValue(input.boundaryReplay.covered_by_deterministic) === undefined ? {} : { covered_by_deterministic: numberValue(input.boundaryReplay.covered_by_deterministic) }),
            ...(numberValue(input.boundaryReplay.uncovered) === undefined ? {} : { uncovered: numberValue(input.boundaryReplay.uncovered) }),
        },
        graph: {
            ...(stringValue(input.graphQuery.query_match_status) === undefined ? {} : { query_match_status: stringValue(input.graphQuery.query_match_status) }),
            ...(numberValue(graphTotals.boundary_replay_fact_count) === undefined ? {} : { boundary_replay_fact_count: numberValue(graphTotals.boundary_replay_fact_count) }),
            ...(numberValue(graphResultTotals.boundary_replay_fact_count) === undefined ? {} : { result_boundary_replay_fact_count: numberValue(graphResultTotals.boundary_replay_fact_count) }),
        },
        conclusion,
        production_posture: conclusion === "continue_hybrid_not_raw_setfit"
            ? "deterministic_and_reviewed_graph_facts_only"
            : "model_quality_work_only",
        next_action: conclusion === "continue_hybrid_not_raw_setfit"
            ? "Do not promote raw SetFit output; continue with deterministic gates, reviewed boundary fixtures, and graph-queryable evidence."
            : "Keep classifier work in model-quality experiments until gates, replay coverage, and graph evidence pass together.",
        reasons,
    };
}

const main = (): number => {
    const args = parseArgs({
        options: {
            quality: { type: "string" },
            hybrid: { type: "string" },
            replay: { type: "string" },
            graph: { type: "string" },
            out: { type: "string" },
            json: { type: "boolean", default: false },
        },
    });
    const qualityStatusPath = args.values.quality ?? ".ax/experiments/classifier-quality-status-workflow-fixtures-e489.json";
    const hybridRobustnessPath = args.values.hybrid ?? ".ax/experiments/hybrid-robustness-workflow-fixtures-current.json";
    const boundaryReplayPath = args.values.replay ?? ".ax/experiments/boundary-review-deterministic-replay-workflow-candidate-current.json";
    const graphQueryPath = args.values.graph ?? ".ax/experiments/boundary-replay-graph-query-e497.json";
    const out = args.values.out ?? ".ax/experiments/workflow-classifier-quality-conclusion-current.json";
    const report = buildWorkflowQualityConclusion({
        qualityStatusPath,
        hybridRobustnessPath,
        boundaryReplayPath,
        graphQueryPath,
        qualityStatus: loadJson(qualityStatusPath),
        hybridRobustness: loadJson(hybridRobustnessPath),
        boundaryReplay: loadJson(boundaryReplayPath),
        graphQuery: loadJson(graphQueryPath),
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    if (args.values.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log("workflow classifier quality conclusion");
        console.log(`conclusion: ${report.conclusion}`);
        console.log(`production posture: ${report.production_posture}`);
        console.log(`next action: ${report.next_action}`);
    }
    return report.conclusion === "bail_on_classifier_path" ? 1 : 0;
};

if (import.meta.main) {
    process.exit(main());
}
