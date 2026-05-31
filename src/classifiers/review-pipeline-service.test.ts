import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    ClassifierReviewPipelineService,
    ClassifierReviewPipelineServiceLive,
    type ClassifierReviewPipelineCommandSource,
} from "./review-pipeline-service.ts";

const runWithService = <A>(effect: Effect.Effect<A, unknown, ClassifierReviewPipelineService>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(ClassifierReviewPipelineServiceLive)));

describe("ClassifierReviewPipelineService", () => {
    test("summarizes a ready review repair command for service execution", async () => {
        const source: ClassifierReviewPipelineCommandSource = {
            review_pipeline_stage: "needs_review_repair",
            review_pipeline_next_action: "Fix review issue rows before applying reviewed coverage facts.",
            review_pipeline_command_status: "ready_to_execute",
            review_pipeline_command_can_execute: true,
            review_pipeline_command_next_action: "Execute the pipeline command and capture its output artifacts.",
            review_pipeline_command_blockers: [],
            review_pipeline_command_blocker_details: [],
            review_pipeline_command_kind: "repair_review_issues",
            review_pipeline_required_inputs: [],
            review_pipeline_input_bindings: [],
            review_pipeline_command_argv: [
                "bun",
                "src/cli/index.ts",
                "classifiers",
                "workflow-candidates",
                "--review-coverage",
            ],
            review_pipeline_command: "bun src/cli/index.ts classifiers workflow-candidates --review-coverage",
            review_pipeline_command_output_artifacts: [{
                kind: "readiness_report",
                path: ".ax/experiments/reviewed-coverage-gaps.json",
                argv_flag: "--out",
                argv_index: 9,
                argv_value_prefix: "--out=",
                required_for_handoff: false,
            }],
            review_pipeline_command_output_artifact_checks: [{
                kind: "readiness_report",
                path: ".ax/experiments/reviewed-coverage-gaps.json",
                argv_index: 9,
                check: "file_exists_after_execution",
                status: "pending_execution",
                required_for_command_success: true,
            }],
            review_pipeline_command_output_check_status: "pending_execution",
            review_pipeline_command_output_check_next_action: "Execute the pipeline command, then verify every required output artifact path exists.",
        };

        const summary = await runWithService(Effect.gen(function* () {
            const pipeline = yield* ClassifierReviewPipelineService;
            return yield* pipeline.commandSummary(source);
        }));

        expect(summary).toEqual({
            schema: "ax.classifier_review_pipeline_command.v1",
            stage: "needs_review_repair",
            pipeline_next_action: "Fix review issue rows before applying reviewed coverage facts.",
            command_status: "ready_to_execute",
            command_can_execute: true,
            command_next_action: "Execute the pipeline command and capture its output artifacts.",
            command_blockers: [],
            command_blocker_details: [],
            command_kind: "repair_review_issues",
            required_inputs: [],
            input_bindings: [],
            command_argv: [
                "bun",
                "src/cli/index.ts",
                "classifiers",
                "workflow-candidates",
                "--review-coverage",
            ],
            command: "bun src/cli/index.ts classifiers workflow-candidates --review-coverage",
            output_artifacts: source.review_pipeline_command_output_artifacts,
            output_artifact_checks: source.review_pipeline_command_output_artifact_checks,
            output_check_status: "pending_execution",
            output_check_next_action: "Execute the pipeline command, then verify every required output artifact path exists.",
        });
    });

    test("summarizes a blocked provenance command with input bindings", async () => {
        const source: ClassifierReviewPipelineCommandSource = {
            review_pipeline_stage: "needs_review_provenance",
            review_pipeline_next_action: "Add reviewer and reviewed-at metadata before applying if audit provenance is required.",
            review_pipeline_command_status: "requires_inputs",
            review_pipeline_command_can_execute: false,
            review_pipeline_command_next_action: "Bind required pipeline inputs before executing the command.",
            review_pipeline_command_blockers: ["missing_pipeline_inputs"],
            review_pipeline_command_blocker_details: [{
                blocker: "missing_pipeline_inputs",
                count: 2,
                remediation: "Bind required pipeline inputs before executing the command.",
            }],
            review_pipeline_command_kind: "stamp_review_provenance",
            review_pipeline_required_inputs: ["reviewer", "reviewed_at"],
            review_pipeline_input_bindings: [{
                input: "reviewer",
                argv_flag: "--review-provenance-reviewer",
                argv_index: 8,
                argv_value_prefix: "--review-provenance-reviewer=",
                placeholder: "<reviewer>",
                value_kind: "nonempty_string",
            }],
            review_pipeline_command_argv: [
                "bun",
                "src/cli/index.ts",
                "classifiers",
                "workflow-candidates",
                "--review-provenance-reviewer=<reviewer>",
            ],
            review_pipeline_command: "bun src/cli/index.ts classifiers workflow-candidates --review-provenance-reviewer=<reviewer>",
            review_pipeline_command_output_artifacts: [],
            review_pipeline_command_output_artifact_checks: [],
            review_pipeline_command_output_check_status: "no_output_artifacts",
            review_pipeline_command_output_check_next_action: "No pipeline output artifacts need verification.",
        };

        const summary = await runWithService(Effect.gen(function* () {
            const pipeline = yield* ClassifierReviewPipelineService;
            return yield* pipeline.commandSummary(source);
        }));

        expect(summary.command_can_execute).toBe(false);
        expect(summary.command_next_action).toBe("Bind required pipeline inputs before executing the command.");
        expect(summary.command_blockers).toEqual(["missing_pipeline_inputs"]);
        expect(summary.required_inputs).toEqual(["reviewer", "reviewed_at"]);
        expect(summary.input_bindings).toEqual(source.review_pipeline_input_bindings);
    });

    test("prepares a blocked provenance command after binding required inputs", async () => {
        const source: ClassifierReviewPipelineCommandSource = provenanceCommandSource();

        const prepared = await runWithService(Effect.gen(function* () {
            const pipeline = yield* ClassifierReviewPipelineService;
            return yield* pipeline.prepareCommand(source, {
                reviewer: "codex",
                reviewed_at: "2026-05-31T10:00:00.000Z",
            });
        }));

        expect(prepared).toEqual({
            schema: "ax.classifier_review_pipeline_prepared_command.v1",
            status: "ready_to_execute",
            can_execute: true,
            next_action: "Execute the prepared argv and capture its output artifacts.",
            missing_inputs: [],
            invalid_inputs: [],
            command_kind: "stamp_review_provenance",
            argv: [
                "bun",
                "src/cli/index.ts",
                "classifiers",
                "workflow-candidates",
                "--review-provenance-reviewer=codex",
                "--review-provenance-reviewed-at=2026-05-31T10:00:00.000Z",
            ],
            output_artifacts: source.review_pipeline_command_output_artifacts,
            output_artifact_checks: source.review_pipeline_command_output_artifact_checks,
            output_check_status: "pending_execution",
            output_check_next_action: "Execute the pipeline command, then verify every required output artifact path exists.",
        });
    });

    test("reports missing and invalid pipeline inputs before command execution", async () => {
        const source = provenanceCommandSource();

        const prepared = await runWithService(Effect.gen(function* () {
            const pipeline = yield* ClassifierReviewPipelineService;
            return yield* pipeline.prepareCommand(source, {
                reviewer: " ",
                reviewed_at: "not-a-date",
            });
        }));

        expect(prepared.can_execute).toBe(false);
        expect(prepared.status).toBe("invalid_inputs");
        expect(prepared.next_action).toBe("Provide valid pipeline input values before executing the command.");
        expect(prepared.missing_inputs).toEqual([]);
        expect(prepared.invalid_inputs).toEqual([
            {
                input: "reviewer",
                value_kind: "nonempty_string",
                reason: "Value must be a non-empty string.",
            },
            {
                input: "reviewed_at",
                value_kind: "iso_datetime",
                reason: "Value must be a parseable ISO datetime string.",
            },
        ]);
        expect(prepared.argv).toBeUndefined();
    });

    test("does not prepare commands when binding indexes do not match argv", async () => {
        const source = provenanceCommandSource();

        const prepared = await runWithService(Effect.gen(function* () {
            const pipeline = yield* ClassifierReviewPipelineService;
            return yield* pipeline.prepareCommand({
                ...source,
                review_pipeline_input_bindings: [{
                    ...source.review_pipeline_input_bindings[0],
                    argv_index: 99,
                }],
            }, {
                reviewer: "codex",
                reviewed_at: "2026-05-31T10:00:00.000Z",
            });
        }));

        expect(prepared.can_execute).toBe(false);
        expect(prepared.status).toBe("missing_command");
        expect(prepared.next_action).toBe("Provide a pipeline command argv before executing the command.");
        expect(prepared.argv).toBeUndefined();
    });
});

const provenanceCommandSource = (): ClassifierReviewPipelineCommandSource => ({
    review_pipeline_stage: "needs_review_provenance",
    review_pipeline_next_action: "Add reviewer and reviewed-at metadata before applying if audit provenance is required.",
    review_pipeline_command_status: "requires_inputs",
    review_pipeline_command_can_execute: false,
    review_pipeline_command_next_action: "Bind required pipeline inputs before executing the command.",
    review_pipeline_command_blockers: ["missing_pipeline_inputs"],
    review_pipeline_command_blocker_details: [{
        blocker: "missing_pipeline_inputs",
        count: 2,
        remediation: "Bind required pipeline inputs before executing the command.",
    }],
    review_pipeline_command_kind: "stamp_review_provenance",
    review_pipeline_required_inputs: ["reviewer", "reviewed_at"],
    review_pipeline_input_bindings: [
        {
            input: "reviewer",
            argv_flag: "--review-provenance-reviewer",
            argv_index: 4,
            argv_value_prefix: "--review-provenance-reviewer=",
            placeholder: "<reviewer>",
            value_kind: "nonempty_string",
        },
        {
            input: "reviewed_at",
            argv_flag: "--review-provenance-reviewed-at",
            argv_index: 5,
            argv_value_prefix: "--review-provenance-reviewed-at=",
            placeholder: "<reviewed-at-iso>",
            value_kind: "iso_datetime",
        },
    ],
    review_pipeline_command_argv: [
        "bun",
        "src/cli/index.ts",
        "classifiers",
        "workflow-candidates",
        "--review-provenance-reviewer=<reviewer>",
        "--review-provenance-reviewed-at=<reviewed-at-iso>",
    ],
    review_pipeline_command: "bun src/cli/index.ts classifiers workflow-candidates --review-provenance-reviewer=<reviewer> --review-provenance-reviewed-at=<reviewed-at-iso>",
    review_pipeline_command_output_artifacts: [{
        kind: "readiness_report",
        path: ".ax/experiments/workflow-candidate-review-coverage-post-apply.json",
        argv_flag: "--out",
        argv_index: 9,
        argv_value_prefix: "--out=",
        required_for_handoff: false,
    }],
    review_pipeline_command_output_artifact_checks: [{
        kind: "readiness_report",
        path: ".ax/experiments/workflow-candidate-review-coverage-post-apply.json",
        argv_index: 9,
        check: "file_exists_after_execution",
        status: "pending_execution",
        required_for_command_success: true,
    }],
    review_pipeline_command_output_check_status: "pending_execution",
    review_pipeline_command_output_check_next_action: "Execute the pipeline command, then verify every required output artifact path exists.",
});
