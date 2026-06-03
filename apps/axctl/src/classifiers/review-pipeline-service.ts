import { Context, Effect, FileSystem, Layer } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
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

export type ClassifierReviewPipelinePreparedCommandStatus =
    | "ready_to_execute"
    | "missing_command"
    | "missing_inputs"
    | "invalid_inputs";

export type ClassifierReviewPipelineInputValues = Partial<Record<WorkflowCandidateReviewCoveragePipelineRequiredInput, string>>;

export interface ClassifierReviewPipelineInvalidInput {
    readonly input: WorkflowCandidateReviewCoveragePipelineRequiredInput;
    readonly value_kind: WorkflowCandidateReviewCoveragePipelineInputBinding["value_kind"];
    readonly reason: string;
}

export interface ClassifierReviewPipelinePreparedCommand {
    readonly schema: "ax.classifier_review_pipeline_prepared_command.v1";
    readonly status: ClassifierReviewPipelinePreparedCommandStatus;
    readonly can_execute: boolean;
    readonly next_action: string;
    readonly missing_inputs: readonly WorkflowCandidateReviewCoveragePipelineRequiredInput[];
    readonly invalid_inputs: readonly ClassifierReviewPipelineInvalidInput[];
    readonly command_kind?: WorkflowCandidateReviewCoveragePipelineCommandKind;
    readonly argv?: readonly string[];
    readonly output_artifacts: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifact[];
    readonly output_artifact_checks: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckRow[];
    readonly output_check_status: WorkflowCandidateReviewCoveragePipelineCommandOutputCheckStatus;
    readonly output_check_next_action: string;
}

export type ClassifierReviewPipelineOutputVerificationStatus =
    | "verified"
    | "missing_required_outputs"
    | "no_output_artifacts";

export interface ClassifierReviewPipelineOutputArtifactVerificationRow {
    readonly kind: WorkflowCandidateReviewCoveragePipelineCommandOutputArtifact["kind"];
    readonly path: string;
    readonly argv_index: number;
    readonly required_for_command_success: boolean;
    readonly exists: boolean;
}

export interface ClassifierReviewPipelineOutputVerificationReport {
    readonly schema: "ax.classifier_review_pipeline_output_verification.v1";
    readonly status: ClassifierReviewPipelineOutputVerificationStatus;
    readonly can_continue: boolean;
    readonly next_action: string;
    readonly checked_artifacts: readonly ClassifierReviewPipelineOutputArtifactVerificationRow[];
    readonly missing_required_artifacts: readonly string[];
}

export interface ClassifierReviewPipelineOutputVerifier {
    readonly exists: (path: string) => Effect.Effect<boolean, never, FileSystem.FileSystem>;
}

export const nodeFileOutputVerifier: ClassifierReviewPipelineOutputVerifier = {
    exists: (path) =>
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* fs.exists(path).pipe(orAbsent(false));
        }),
};

export type ClassifierReviewPipelineLifecycleStatus =
    | "blocked_before_execution"
    | "ready_to_execute"
    | "verified_after_execution"
    | "missing_required_outputs";

export interface ClassifierReviewPipelineLifecycleInput {
    readonly values?: ClassifierReviewPipelineInputValues;
    readonly verifier?: ClassifierReviewPipelineOutputVerifier;
}

export interface ClassifierReviewPipelineLifecycleReport {
    readonly schema: "ax.classifier_review_pipeline_lifecycle.v1";
    readonly status: ClassifierReviewPipelineLifecycleStatus;
    readonly can_execute: boolean;
    readonly can_continue: boolean;
    readonly next_action: string;
    readonly summary: ClassifierReviewPipelineCommandSummary;
    readonly prepared: ClassifierReviewPipelinePreparedCommand;
    readonly output_verification?: ClassifierReviewPipelineOutputVerificationReport;
}

export interface ClassifierReviewPipelineServiceShape {
    readonly commandSummary: (
        input: ClassifierReviewPipelineCommandSource,
    ) => Effect.Effect<ClassifierReviewPipelineCommandSummary>;
    readonly prepareCommand: (
        input: ClassifierReviewPipelineCommandSource,
        values?: ClassifierReviewPipelineInputValues,
    ) => Effect.Effect<ClassifierReviewPipelinePreparedCommand>;
    readonly verifyOutputArtifacts: (
        input: ClassifierReviewPipelinePreparedCommand,
        verifier: ClassifierReviewPipelineOutputVerifier,
    ) => Effect.Effect<ClassifierReviewPipelineOutputVerificationReport, never, FileSystem.FileSystem>;
    readonly commandLifecycle: (
        input: ClassifierReviewPipelineCommandSource,
        lifecycle?: ClassifierReviewPipelineLifecycleInput,
    ) => Effect.Effect<ClassifierReviewPipelineLifecycleReport, never, FileSystem.FileSystem>;
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

        const prepareCommand = Effect.fn("ClassifierReviewPipelineService.prepareCommand")(function* (
            input: ClassifierReviewPipelineCommandSource,
            values: ClassifierReviewPipelineInputValues = {},
        ) {
            const summary = yield* commandSummary(input);
            const argv = summary.command_argv;
            if (argv === undefined || summary.command_status === "unavailable") {
                return preparedCommand(summary, {
                    status: "missing_command",
                    canExecute: false,
                    nextAction: "Provide a pipeline command argv before executing the command.",
                    missingInputs: [],
                    invalidInputs: [],
                });
            }
            const hasUnboundableInput = summary.input_bindings.some((binding) =>
                binding.argv_index < 0 ||
                binding.argv_index >= argv.length ||
                !argv[binding.argv_index]?.startsWith(binding.argv_value_prefix)
            );
            if (hasUnboundableInput) {
                return preparedCommand(summary, {
                    status: "missing_command",
                    canExecute: false,
                    nextAction: "Provide a pipeline command argv before executing the command.",
                    missingInputs: [],
                    invalidInputs: [],
                });
            }

            const missingInputs = summary.input_bindings
                .filter((binding) => values[binding.input] === undefined)
                .map((binding) => binding.input);
            if (missingInputs.length > 0) {
                return preparedCommand(summary, {
                    status: "missing_inputs",
                    canExecute: false,
                    nextAction: "Provide required pipeline input values before executing the command.",
                    missingInputs,
                    invalidInputs: [],
                });
            }

            const invalidInputs = summary.input_bindings.flatMap((binding) => {
                const value = values[binding.input];
                if (value === undefined) return [];
                const reason = invalidInputReason(binding, value);
                return reason === undefined
                    ? []
                    : [{
                        input: binding.input,
                        value_kind: binding.value_kind,
                        reason,
                    }];
            });
            if (invalidInputs.length > 0) {
                return preparedCommand(summary, {
                    status: "invalid_inputs",
                    canExecute: false,
                    nextAction: "Provide valid pipeline input values before executing the command.",
                    missingInputs: [],
                    invalidInputs,
                });
            }

            const preparedArgv = summary.input_bindings.reduce((nextArgv, binding) => {
                const value = values[binding.input];
                if (value === undefined || binding.argv_index < 0 || binding.argv_index >= nextArgv.length) {
                    return nextArgv;
                }
                const replaced = [...nextArgv];
                replaced[binding.argv_index] = `${binding.argv_value_prefix}${value}`;
                return replaced;
            }, [...argv]);

            return preparedCommand(summary, {
                status: "ready_to_execute",
                canExecute: true,
                nextAction: "Execute the prepared argv and capture its output artifacts.",
                missingInputs: [],
                invalidInputs: [],
                argv: preparedArgv,
            });
        });

        const verifyOutputArtifacts = Effect.fn("ClassifierReviewPipelineService.verifyOutputArtifacts")(function* (
            input: ClassifierReviewPipelinePreparedCommand,
            verifier: ClassifierReviewPipelineOutputVerifier,
        ) {
            const checkedArtifacts = yield* Effect.forEach(input.output_artifact_checks, (check) =>
                Effect.gen(function* () {
                    const exists = yield* verifier.exists(check.path);
                    return {
                        kind: check.kind,
                        path: check.path,
                        argv_index: check.argv_index,
                        required_for_command_success: check.required_for_command_success,
                        exists,
                    } satisfies ClassifierReviewPipelineOutputArtifactVerificationRow;
                }));

            const missingRequiredArtifacts = checkedArtifacts
                .filter((check) => check.required_for_command_success && !check.exists)
                .map((check) => check.path);

            if (checkedArtifacts.length === 0) {
                return outputVerificationReport({
                    status: "no_output_artifacts",
                    canContinue: true,
                    nextAction: "No pipeline output artifacts need verification; continue with the next review pipeline step.",
                    checkedArtifacts,
                    missingRequiredArtifacts,
                });
            }

            if (missingRequiredArtifacts.length > 0) {
                return outputVerificationReport({
                    status: "missing_required_outputs",
                    canContinue: false,
                    nextAction: "Re-run or debug the pipeline command until every required output artifact exists.",
                    checkedArtifacts,
                    missingRequiredArtifacts,
                });
            }

            return outputVerificationReport({
                status: "verified",
                canContinue: true,
                nextAction: "All required pipeline output artifacts exist; continue with the next review pipeline step.",
                checkedArtifacts,
                missingRequiredArtifacts,
            });
        });

        const commandLifecycle = Effect.fn("ClassifierReviewPipelineService.commandLifecycle")(function* (
            input: ClassifierReviewPipelineCommandSource,
            lifecycle: ClassifierReviewPipelineLifecycleInput = {},
        ) {
            const summary = yield* commandSummary(input);
            const prepared = yield* prepareCommand(input, lifecycle.values);

            if (!prepared.can_execute) {
                return lifecycleReport({
                    status: "blocked_before_execution",
                    canExecute: false,
                    canContinue: false,
                    nextAction: prepared.next_action,
                    summary,
                    prepared,
                });
            }

            if (lifecycle.verifier === undefined) {
                return lifecycleReport({
                    status: "ready_to_execute",
                    canExecute: true,
                    canContinue: false,
                    nextAction: "Execute the prepared argv, then verify required output artifacts.",
                    summary,
                    prepared,
                });
            }

            const outputVerification = yield* verifyOutputArtifacts(prepared, lifecycle.verifier);
            return lifecycleReport({
                status: outputVerification.can_continue ? "verified_after_execution" : "missing_required_outputs",
                canExecute: true,
                canContinue: outputVerification.can_continue,
                nextAction: outputVerification.next_action,
                summary,
                prepared,
                outputVerification,
            });
        });

        return ClassifierReviewPipelineService.of({ commandSummary, prepareCommand, verifyOutputArtifacts, commandLifecycle });
    }),
);

const invalidInputReason = (
    binding: WorkflowCandidateReviewCoveragePipelineInputBinding,
    value: string,
): string | undefined => {
    switch (binding.value_kind) {
        case "nonempty_string":
            return value.trim().length === 0 ? "Value must be a non-empty string." : undefined;
        case "iso_datetime":
            return Number.isNaN(Date.parse(value)) ? "Value must be a parseable ISO datetime string." : undefined;
    }
};

const preparedCommand = (
    summary: ClassifierReviewPipelineCommandSummary,
    state: {
        readonly status: ClassifierReviewPipelinePreparedCommandStatus;
        readonly canExecute: boolean;
        readonly nextAction: string;
        readonly missingInputs: readonly WorkflowCandidateReviewCoveragePipelineRequiredInput[];
        readonly invalidInputs: readonly ClassifierReviewPipelineInvalidInput[];
        readonly argv?: readonly string[];
    },
): ClassifierReviewPipelinePreparedCommand => ({
    schema: "ax.classifier_review_pipeline_prepared_command.v1",
    status: state.status,
    can_execute: state.canExecute,
    next_action: state.nextAction,
    missing_inputs: state.missingInputs,
    invalid_inputs: state.invalidInputs,
    ...(summary.command_kind === undefined ? {} : { command_kind: summary.command_kind }),
    ...(state.argv === undefined ? {} : { argv: state.argv }),
    output_artifacts: summary.output_artifacts,
    output_artifact_checks: summary.output_artifact_checks,
    output_check_status: summary.output_check_status,
    output_check_next_action: summary.output_check_next_action,
});

const outputVerificationReport = (input: {
    readonly status: ClassifierReviewPipelineOutputVerificationStatus;
    readonly canContinue: boolean;
    readonly nextAction: string;
    readonly checkedArtifacts: readonly ClassifierReviewPipelineOutputArtifactVerificationRow[];
    readonly missingRequiredArtifacts: readonly string[];
}): ClassifierReviewPipelineOutputVerificationReport => ({
    schema: "ax.classifier_review_pipeline_output_verification.v1",
    status: input.status,
    can_continue: input.canContinue,
    next_action: input.nextAction,
    checked_artifacts: input.checkedArtifacts,
    missing_required_artifacts: input.missingRequiredArtifacts,
});

const lifecycleReport = (input: {
    readonly status: ClassifierReviewPipelineLifecycleStatus;
    readonly canExecute: boolean;
    readonly canContinue: boolean;
    readonly nextAction: string;
    readonly summary: ClassifierReviewPipelineCommandSummary;
    readonly prepared: ClassifierReviewPipelinePreparedCommand;
    readonly outputVerification?: ClassifierReviewPipelineOutputVerificationReport;
}): ClassifierReviewPipelineLifecycleReport => ({
    schema: "ax.classifier_review_pipeline_lifecycle.v1",
    status: input.status,
    can_execute: input.canExecute,
    can_continue: input.canContinue,
    next_action: input.nextAction,
    summary: input.summary,
    prepared: input.prepared,
    ...(input.outputVerification === undefined ? {} : { output_verification: input.outputVerification }),
});
