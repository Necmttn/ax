import { describe, expect, test } from "bun:test";
import { rootCommand } from "./index.ts";
import {
    buildSelfImproveQuery,
    renderSelfImproveText,
    type LabelMiningReviewTableRow,
    type LabelMiningGraphFactRow,
} from "../classifiers/label-mining-service.ts";

/* -------------------------------------------------------------------------- *
 * CLI routing: `ax classifiers label-mining` must be a classifiers subcommand.
 * -------------------------------------------------------------------------- */

describe("classifiers label-mining cli routing", () => {
    test("classifiers group exposes the label-mining subcommand", () => {
        const classifiers = rootCommand.subcommands
            .flatMap((group) => group.commands)
            .find((command) => command.name === "classifiers");
        expect(classifiers).toBeDefined();
        const subNames = classifiers!.subcommands.flatMap((group) =>
            group.commands.map((command) => command.name),
        );
        expect(subNames).toContain("label-mining");
    });
});

/* -------------------------------------------------------------------------- *
 * Self-improve product query: must separate reviewed / advisory / rejected.
 * -------------------------------------------------------------------------- */

const reviewRow = (
    over: Partial<LabelMiningReviewTableRow> & Pick<LabelMiningReviewTableRow, "candidate_id">,
): LabelMiningReviewTableRow => ({
    candidate_id: over.candidate_id,
    graph_fact_id: over.graph_fact_id ?? null,
    label_family: over.label_family ?? "correction",
    review_status: over.review_status ?? "accepted",
    promotion_safe: over.promotion_safe ?? false,
    reviewed_label: over.reviewed_label ?? null,
    reviewed_target: over.reviewed_target ?? null,
    reviewer: over.reviewer ?? "",
    rationale: over.rationale ?? "",
    evidence_paths_json: over.evidence_paths_json ?? "[]",
});

const factRow = (
    over: Partial<LabelMiningGraphFactRow> & Pick<LabelMiningGraphFactRow, "graph_id" | "predicate">,
): LabelMiningGraphFactRow => ({
    graph_id: over.graph_id,
    kind: over.kind ?? "transcript_reviewed_label",
    subject: over.subject ?? "turn:x",
    predicate: over.predicate,
    object: over.object ?? null,
    value_json: over.value_json ?? null,
    properties_json: over.properties_json ?? JSON.stringify({ promotion_safe: true }),
    source_kind: over.source_kind ?? "transcript_label_mining_reviewed",
});

describe("buildSelfImproveQuery", () => {
    test("separates reviewed promotion-safe, weak/advisory, and rejected/deferred", () => {
        const result = buildSelfImproveQuery({
            review_rows: [
                reviewRow({ candidate_id: "turn:a", review_status: "accepted", promotion_safe: true, label_family: "correction", graph_fact_id: "fact-a" }),
                reviewRow({ candidate_id: "turn:b", review_status: "accepted", promotion_safe: true, label_family: "direction", graph_fact_id: "fact-b" }),
                reviewRow({ candidate_id: "turn:c", review_status: "rejected", promotion_safe: false, label_family: "verification" }),
                reviewRow({ candidate_id: "turn:d", review_status: "deferred", promotion_safe: false, label_family: "correction" }),
                reviewRow({ candidate_id: "turn:e", review_status: "pending", promotion_safe: false, label_family: "approval_or_rejection" }),
            ],
            fact_rows: [
                factRow({ graph_id: "fact-a", predicate: "reviewed_label", object: "correction" }),
                factRow({ graph_id: "fact-b", predicate: "reviewed_label", object: "direction" }),
                factRow({ graph_id: "fact-a-nn", predicate: "nearest_reviewed_neighbor", value_json: JSON.stringify({ nearest_reviewed_candidate_ids: ["turn:z"], nearest_scores: [0.91] }) }),
            ],
        });

        expect(result.schema).toBe("ax.transcript_label_mining_self_improve.v1");
        // Reviewed promotion-safe facts = the two reviewed_label facts.
        expect(result.reviewed_promotion_safe_fact_count).toBe(2);
        // Weak/advisory = pending rows (not yet reviewed).
        expect(result.weak_advisory_candidate_count).toBe(1);
        // Rejected + deferred.
        expect(result.rejected_deferred_count).toBe(2);
        // Nearest-neighbor explanation facts.
        expect(result.nearest_neighbor_explanation_count).toBe(1);
    });

    test("surfaces top repeated correction/direction/verification patterns", () => {
        const result = buildSelfImproveQuery({
            review_rows: [
                reviewRow({ candidate_id: "turn:a", review_status: "accepted", promotion_safe: true, label_family: "correction", reviewed_label: "revert-bad-edit", graph_fact_id: "f1" }),
                reviewRow({ candidate_id: "turn:b", review_status: "accepted", promotion_safe: true, label_family: "correction", reviewed_label: "revert-bad-edit", graph_fact_id: "f2" }),
                reviewRow({ candidate_id: "turn:c", review_status: "accepted", promotion_safe: true, label_family: "direction", reviewed_label: "use-uv", graph_fact_id: "f3" }),
            ],
            fact_rows: [
                factRow({ graph_id: "f1", predicate: "reviewed_label", object: "revert-bad-edit", subject: "turn:a" }),
                factRow({ graph_id: "f2", predicate: "reviewed_label", object: "revert-bad-edit", subject: "turn:b" }),
                factRow({ graph_id: "f3", predicate: "reviewed_label", object: "use-uv", subject: "turn:c" }),
            ],
        });

        expect(result.top_patterns.length).toBeGreaterThan(0);
        // Most repeated reviewed pattern is the correction "revert-bad-edit" (count 2).
        expect(result.top_patterns[0]?.pattern).toBe("revert-bad-edit");
        expect(result.top_patterns[0]?.count).toBe(2);
        expect(result.top_patterns[0]?.label_family).toBe("correction");
    });

    test("recommends review export when no reviewed promotion-safe facts exist yet", () => {
        const result = buildSelfImproveQuery({
            review_rows: [
                reviewRow({ candidate_id: "turn:p", review_status: "pending", promotion_safe: false }),
            ],
            fact_rows: [],
        });
        expect(result.reviewed_promotion_safe_fact_count).toBe(0);
        expect(result.recommended_next_action).toContain("review");
    });

    test("never reports weak/advisory candidates as promotion-safe", () => {
        const result = buildSelfImproveQuery({
            review_rows: [
                reviewRow({ candidate_id: "turn:p", review_status: "pending", promotion_safe: false }),
            ],
            // A fact row that is NOT a reviewed_label fact must not inflate the safe count.
            fact_rows: [
                factRow({ graph_id: "nn", predicate: "nearest_reviewed_neighbor" }),
            ],
        });
        expect(result.reviewed_promotion_safe_fact_count).toBe(0);
        expect(result.weak_advisory_candidate_count).toBe(1);
    });
});

describe("renderSelfImproveText", () => {
    test("renders separated counts and the next action", () => {
        const text = renderSelfImproveText({
            schema: "ax.transcript_label_mining_self_improve.v1",
            reviewed_promotion_safe_fact_count: 2,
            weak_advisory_candidate_count: 3,
            rejected_deferred_count: 1,
            nearest_neighbor_explanation_count: 4,
            top_patterns: [{ pattern: "use-uv", label_family: "direction", count: 2 }],
            recommended_next_action: "apply reviewed graph facts",
        });
        expect(text).toContain("promotion-safe");
        expect(text).toContain("2");
        expect(text).toContain("use-uv");
        expect(text).toContain("apply reviewed graph facts");
    });
});
