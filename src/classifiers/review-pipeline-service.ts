import { Context, Effect, Layer } from "effect";
import type {
    WorkflowCandidateReviewCoveragePipelineCommandBlocker,
    WorkflowCandidateReviewCoveragePipelineCommandBlockerDetail,
    WorkflowCandidateReviewCoveragePipelineCommandKind,
    WorkflowCandidateReviewCoveragePipelineCommandOutputArtifact,
    WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckRow,
    WorkflowCandidateReviewCoveragePipelineCommandOutputCheckStatus,
    WorkflowCandidateReviewCoveragePipelineCommandStatus,
    WorkflowCandidateReviewCoveragePipelineInputBinding,
    WorkflowCandidateReviewCoveragePipelineRequiredInput,
    WorkflowCandidateReviewCoveragePipelineStage,
} from "../cli/classifiers-workflow-candidates.ts";

export interface ClassifierReviewPipelineCommandSource {
    readonly review_pipeline_stage: WorkflowCandidateReviewCoveragePipelineStage;
    readonly review_pipeline_next_action: string;
    readonly review_pipeline_command_status: WorkflowCandidateReviewCoveragePipelineCommandStatus;
    readonly review_pipeline_command_can_execute: boolean;
    readonly review_pipeline_command_next_action: string;
    readonly review_pipeline_command_blockers: readonly WorkflowCandidateReviewCoveragePipelineCommandBlocker[];
    readonly review_pipeline_command_blocker_details: readonly WorkflowCandidateReviewCoveragePipelineCommandBlockerDetail[];
    readonly review_pipeline_command_kind?: WorkflowCandidateReviewCoveragePipelineCommandKind;
    readonly review_pipeline_required_inputs: readonly WorkflowCandidateReviewCoveragePipelineRequiredInput[];
    readonly review_pipeline_input_bindings: readonly WorkflowCandidateReviewCoveragePipelineInputBinding[];
    readonly review_pipeline_command_argv?: readonly string[];
    readonly review_pipeline_command?: string;
    readonly review_pipeline_command_output_artifacts: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifact[];
    readonly review_pipeline_command_output_artifact_checks: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckRow[];
    readonly review_pipeline_command_output_check_status: WorkflowCandidateReviewCoveragePipelineCommandOutputCheckStatus;
    readonly review_pipeline_command_output_check_next_action: string;
}

export interface ClassifierReviewPipelineCommandSummary {
    readonly schema: "ax.classifier_review_pipeline_command.v1";
    readonly stage: WorkflowCandidateReviewCoveragePipelineStage;
    readonly pipeline_next_action: string;
    readonly command_status: WorkflowCandidateReviewCoveragePipelineCommandStatus;
    readonly command_can_execute: boolean;
    readonly command_next_action: string;
    readonly command_blockers: readonly WorkflowCandidateReviewCoveragePipelineCommandBlocker[];
    readonly command_blocker_details: readonly WorkflowCandidateReviewCoveragePipelineCommandBlockerDetail[];
    readonly command_kind?: WorkflowCandidateReviewCoveragePipelineCommandKind;
    readonly required_inputs: readonly WorkflowCandidateReviewCoveragePipelineRequiredInput[];
    readonly input_bindings: readonly WorkflowCandidateReviewCoveragePipelineInputBinding[];
    readonly command_argv?: readonly string[];
    readonly command?: string;
    readonly output_artifacts: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifact[];
    readonly output_artifact_checks: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckRow[];
    readonly output_check_status: WorkflowCandidateReviewCoveragePipelineCommandOutputCheckStatus;
    readonly output_check_next_action: string;
}

export interface ClassifierReviewPipelineServiceShape {
    readonly commandSummary: (
        input: ClassifierReviewPipelineCommandSource,
    ) => Effect.Effect<ClassifierReviewPipelineCommandSummary>;
}

export class ClassifierReviewPipelineService extends Context.Service<
    ClassifierReviewPipelineService,
    ClassifierReviewPipelineServiceShape
>()("ax/ClassifierReviewPipelineService") {}

export const ClassifierReviewPipelineServiceLive: Layer.Layer<ClassifierReviewPipelineService> = Layer.effect(
    ClassifierReviewPipelineService,
    Effect.gen(function* () {
        const commandSummary = Effect.fn("ClassifierReviewPipelineService.commandSummary")(function* (
            input: ClassifierReviewPipelineCommandSource,
        ) {
            return {
                schema: "ax.classifier_review_pipeline_command.v1",
                stage: input.review_pipeline_stage,
                pipeline_next_action: input.review_pipeline_next_action,
                command_status: input.review_pipeline_command_status,
                command_can_execute: input.review_pipeline_command_can_execute,
                command_next_action: input.review_pipeline_command_next_action,
                command_blockers: input.review_pipeline_command_blockers,
                command_blocker_details: input.review_pipeline_command_blocker_details,
                ...(input.review_pipeline_command_kind === undefined ? {} : { command_kind: input.review_pipeline_command_kind }),
                required_inputs: input.review_pipeline_required_inputs,
                input_bindings: input.review_pipeline_input_bindings,
                ...(input.review_pipeline_command_argv === undefined ? {} : { command_argv: input.review_pipeline_command_argv }),
                ...(input.review_pipeline_command === undefined ? {} : { command: input.review_pipeline_command }),
                output_artifacts: input.review_pipeline_command_output_artifacts,
                output_artifact_checks: input.review_pipeline_command_output_artifact_checks,
                output_check_status: input.review_pipeline_command_output_check_status,
                output_check_next_action: input.review_pipeline_command_output_check_next_action,
            } satisfies ClassifierReviewPipelineCommandSummary;
        });

        return ClassifierReviewPipelineService.of({ commandSummary });
    }),
);
