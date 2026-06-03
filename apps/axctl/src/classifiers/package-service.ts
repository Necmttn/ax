import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { prettyPrint } from "@ax/lib/json";
import { SurrealClient } from "@ax/lib/db";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import {
    applyExecutionSurrealWritePlanReport,
    buildClassifierLifecycleInsightReport,
    buildExecutionGraphHealthReport,
    buildOperationExecutionPlanReport,
    buildOperationDryRunReport,
    buildOperationPreflightReport,
    buildPackagesOperationsReport,
    buildExecutionHistoryReport,
    buildExecutionFactProjectionReport,
    buildExecutionSurrealWritePlanReport,
    buildOperationsReport,
    classifierGraphHealthSql,
    discoverClassifierPackageManifestPaths,
    discoverClassifierPackageExecutionReportPaths,
    executeOperationPlanReport,
    loadClassifierPackageExecutionReport,
    loadClassifierLifecycleReviewStatus,
    summarizeClassifierGraphQuerySuggestionRouting,
    summarizeClassifierLifecycleRouting,
    summarizeClassifierPackageOperations,
    writeExecutionHistoryReport,
    writeExecutionFactProjectionReport,
    writeExecutionSurrealWritePlanReport,
    writeExecutionSurrealApplyReport,
    writeExecutionGraphHealthReport,
    writeClassifierGraphQuerySuggestionRoutingSummary,
    writeClassifierLifecycleInsightReport,
    writeClassifierLifecycleRoutingSummaryReport,
    writePackagesOperationsReport,
    writeOperationPreflightReport,
    writeOperationDryRunReport,
    writeOperationExecutionReport,
    writeOperationExecutionPlanReport,
    writeOperationsReport,
    type ClassifierPackagesOperationsReport,
    type ClassifierPackageExecutionHistoryReport,
    type ClassifierPackageExecutionFactProjectionReport,
    type ClassifierPackageExecutionSurrealWritePlanReport,
    type ClassifierPackageExecutionSurrealApplyReport,
    type ClassifierPackageExecutionGraphHealthReport,
    type ClassifierGraphBoundaryReplaySummary,
    type ClassifierGraphQuerySuggestionRoutingSummary,
    type ClassifierLifecycleInsightReport,
    type ClassifierLifecycleRoutingSummaryReport,
    type ClassifierGraphHealthQuery,
    type ClassifierGraphEdgeRow,
    type ClassifierGraphFactRow,
    type ClassifierGraphNodeRow,
    type ClassifierPackageOperationPreflightReport,
    type ClassifierPackageOperationDryRunReport,
    type ClassifierPackageOperationExecutionReport,
    type ClassifierPackageOperationExecutionPlanReport,
    type ClassifierPackageOperationsReport,
    type ClassifierPackageOperationsSummary,
} from "./package-operations.ts";
import {
    loadWorkflowCandidateGuidancePendingReviewTaskListReport,
    type WorkflowCandidateGuidancePendingReviewTaskListFilters,
    type WorkflowCandidateGuidancePendingReviewTaskListReport,
} from "../cli/classifiers-workflow-candidates.ts";
import {
    findClassifierPackageOperation,
    listClassifierPackageOperations,
    loadClassifierPackageManifest,
    type ClassifierPackageManifest,
    type ClassifierPackageOperation,
} from "./package-manifest.ts";

export class ClassifierPackageLoadError extends Schema.TaggedErrorClass<ClassifierPackageLoadError>(
    "ClassifierPackageLoadError",
)("ClassifierPackageLoadError", {
    path: Schema.String,
    message: Schema.String,
}) {}

export class ClassifierPackageOperationNotFound extends Schema.TaggedErrorClass<ClassifierPackageOperationNotFound>(
    "ClassifierPackageOperationNotFound",
)("ClassifierPackageOperationNotFound", {
    packageKey: Schema.String,
    operationId: Schema.String,
}) {}

export class ClassifierPackageReportWriteError extends Schema.TaggedErrorClass<ClassifierPackageReportWriteError>(
    "ClassifierPackageReportWriteError",
)("ClassifierPackageReportWriteError", {
    path: Schema.String,
    message: Schema.String,
}) {}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export interface ClassifierPackageOperationReportInput {
    readonly manifestPath: string;
    readonly operationId?: string;
}

export interface ClassifierPackageOperationWriteInput extends ClassifierPackageOperationReportInput {
    readonly out: string;
}

export interface ClassifierPackageOperationPreflightInput {
    readonly manifestPath: string;
    readonly operationId: string;
}

export interface ClassifierPackageOperationPreflightWriteInput extends ClassifierPackageOperationPreflightInput {
    readonly out: string;
}

export interface ClassifierPackageOperationDryRunInput {
    readonly manifestPath: string;
    readonly operationId: string;
}

export interface ClassifierPackageOperationDryRunWriteInput extends ClassifierPackageOperationDryRunInput {
    readonly out: string;
}

export interface ClassifierPackageOperationExecutionPlanInput {
    readonly manifestPath: string;
    readonly operationId: string;
    readonly allowExecute: boolean;
    readonly allowExpensive: boolean;
}

export interface ClassifierPackageOperationExecutionPlanWriteInput extends ClassifierPackageOperationExecutionPlanInput {
    readonly out: string;
}

export interface ClassifierPackageOperationExecutionInput extends ClassifierPackageOperationExecutionPlanInput {}

export interface ClassifierPackageOperationExecutionWriteInput extends ClassifierPackageOperationExecutionInput {
    readonly out: string;
}

export interface ClassifierPackagesOperationsReportInput {
    readonly root?: string;
}

export interface ClassifierPackagesOperationsWriteInput extends ClassifierPackagesOperationsReportInput {
    readonly out: string;
}

export interface ClassifierPackageExecutionHistoryInput {
    readonly root?: string;
}

export interface ClassifierPackageExecutionHistoryWriteInput extends ClassifierPackageExecutionHistoryInput {
    readonly out: string;
}

export interface ClassifierPackageExecutionFactProjectionInput {
    readonly root?: string;
    readonly workflowStatusPath?: string;
}

export interface ClassifierPackageExecutionFactProjectionWriteInput extends ClassifierPackageExecutionFactProjectionInput {
    readonly out: string;
}

export interface ClassifierPackageExecutionSurrealWritePlanInput {
    readonly root?: string;
    readonly workflowStatusPath?: string;
}

export interface ClassifierPackageExecutionSurrealWritePlanWriteInput extends ClassifierPackageExecutionSurrealWritePlanInput {
    readonly out: string;
}

export interface ClassifierPackageExecutionSurrealApplyInput {
    readonly root?: string;
    readonly workflowStatusPath?: string;
}

export interface ClassifierPackageExecutionSurrealApplyWriteInput extends ClassifierPackageExecutionSurrealApplyInput {
    readonly out: string;
}

export interface ClassifierPackageExecutionGraphHealthInput {
    readonly query?: Partial<ClassifierGraphHealthQuery>;
}

export interface ClassifierPackageExecutionGraphHealthWriteInput extends ClassifierPackageExecutionGraphHealthInput {
    readonly out: string;
}

export interface ClassifierGraphQuerySuggestionRoutingSummaryWriteInput extends ClassifierPackageExecutionGraphHealthInput {
    readonly out: string;
}

export interface ClassifierBoundaryReplaySummaryInput {
    readonly query?: Partial<ClassifierGraphHealthQuery>;
}

export interface ClassifierBoundaryReplaySummaryWriteInput extends ClassifierBoundaryReplaySummaryInput {
    readonly out: string;
}

export interface ClassifierLifecycleInsightInput {
    readonly root?: string;
    readonly workflowStatusPath?: string;
    readonly graphQuery?: Partial<ClassifierGraphHealthQuery>;
}

export interface ClassifierLifecycleInsightWriteInput extends ClassifierLifecycleInsightInput {
    readonly out: string;
}

export interface ClassifierLifecycleRoutingSummaryWriteInput extends ClassifierLifecycleInsightInput {
    readonly out: string;
}

export interface ClassifierPendingReviewTaskListInput {
    readonly taskDir: string;
    readonly filters?: WorkflowCandidateGuidancePendingReviewTaskListFilters;
}

export interface ClassifierPendingReviewTaskListWriteInput extends ClassifierPendingReviewTaskListInput {
    readonly out: string;
}

export type ClassifierQualityRecommendedUse = "candidate_mining" | "model_quality_work";

export interface ClassifierQualityStatusInput {
    readonly sourceReportPath: string;
}

export interface ClassifierQualityStatusWriteInput extends ClassifierQualityStatusInput {
    readonly out: string;
}

export interface ClassifierQualityStatusMetrics {
    readonly accuracy_min?: number;
    readonly accuracy_max?: number;
    readonly macro_f1_min?: number;
    readonly macro_f1_max?: number;
    readonly none_false_positive_rate_max?: number;
    readonly repeated_miss_count: number;
    readonly unique_none_false_positive_count: number;
}

export interface ClassifierQualityStatusReport {
    readonly schema: "ax.classifier_quality_status.v1";
    readonly source_report_path: string;
    readonly source_schema?: string;
    readonly source_decision?: string;
    readonly quality_gate_passed: boolean;
    readonly promotion_quality: false;
    readonly recommended_use: ClassifierQualityRecommendedUse;
    readonly metrics: ClassifierQualityStatusMetrics;
    readonly blockers: readonly string[];
    readonly next_action: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const numberValue = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

const minNumber = (values: readonly (number | undefined)[]): number | undefined => {
    const numbers = values.filter((value): value is number => value !== undefined);
    return numbers.length > 0 ? Math.min(...numbers) : undefined;
};

const maxNumber = (values: readonly (number | undefined)[]): number | undefined => {
    const numbers = values.filter((value): value is number => value !== undefined);
    return numbers.length > 0 ? Math.max(...numbers) : undefined;
};

const boundaryReplaySummaryQuery = (query?: Partial<ClassifierGraphHealthQuery>): Partial<ClassifierGraphHealthQuery> => ({
    mode: "boundary-replay",
    source_kind: "boundary_replay_deterministic_projection",
    fact_kind: "classifier_boundary_replay",
    predicate: "covered_by_deterministic",
    value_equals: "true",
    ...query,
});

const fallbackBoundaryReplaySummary = (): ClassifierGraphBoundaryReplaySummary => ({
    status: "no_reviewed_deterministic_facts",
    production_posture: "not_applicable",
    next_action: "project_or_apply_boundary_replay_facts",
    remediation: "Project and apply boundary replay facts before routing product behavior from reviewed deterministic evidence.",
    covered_subject_count: 0,
    deterministic_label_subject_count: 0,
    evidence_path_count: 0,
    classifier_keys: [],
    targets: [],
    subjects: [],
});

export const buildClassifierQualityStatusReport = (
    sourceReportPath: string,
    source: unknown,
): ClassifierQualityStatusReport => {
    const report = isRecord(source) ? source : {};
    const gate = isRecord(report.gate) ? report.gate : {};
    const gateObserved = isRecord(gate.observed) ? gate.observed : {};
    const runs = Array.isArray(report.runs) ? report.runs.filter(isRecord) : [];
    const sourceSchema = stringValue(report.schema);
    const sourceDecision = stringValue(report.decision);
    const repeatedMissCount = Array.isArray(report.all_seed_repeated_misses)
        ? report.all_seed_repeated_misses.length
        : 0;
    const uniqueNoneFalsePositiveCount = numberValue(report.all_seed_unique_none_false_positive_count) ?? 0;
    const qualityGatePassed = gate.passed === true;
    const accuracyMin = minNumber(runs.map((run) => numberValue(run.accuracy)));
    const accuracyMax = maxNumber(runs.map((run) => numberValue(run.accuracy)));
    const macroF1Min = numberValue(gateObserved.macro_f1_min) ?? minNumber(runs.map((run) => numberValue(run.macro_f1)));
    const macroF1Max = maxNumber(runs.map((run) => numberValue(run.macro_f1)));
    const noneFalsePositiveRateMax =
        numberValue(gateObserved.none_false_positive_rate_max) ??
        maxNumber(runs.map((run) => numberValue(run.none_false_positive_rate)));
    const blockers = [
        qualityGatePassed ? null : "model_quality_gate_not_passed",
        repeatedMissCount > 0 ? "residual_repeated_misses" : null,
        uniqueNoneFalsePositiveCount > 0 ? "residual_none_false_positives" : null,
        "missing_human_promotion_review",
    ].filter((blocker): blocker is string => blocker !== null);
    const metrics = {
        ...(accuracyMin === undefined ? {} : { accuracy_min: accuracyMin }),
        ...(accuracyMax === undefined ? {} : { accuracy_max: accuracyMax }),
        ...(macroF1Min === undefined ? {} : { macro_f1_min: macroF1Min }),
        ...(macroF1Max === undefined ? {} : { macro_f1_max: macroF1Max }),
        ...(noneFalsePositiveRateMax === undefined ? {} : { none_false_positive_rate_max: noneFalsePositiveRateMax }),
        repeated_miss_count: repeatedMissCount,
        unique_none_false_positive_count: uniqueNoneFalsePositiveCount,
    } satisfies ClassifierQualityStatusMetrics;

    return {
        schema: "ax.classifier_quality_status.v1",
        source_report_path: sourceReportPath,
        ...(sourceSchema === undefined ? {} : { source_schema: sourceSchema }),
        ...(sourceDecision === undefined ? {} : { source_decision: sourceDecision }),
        quality_gate_passed: qualityGatePassed,
        promotion_quality: false,
        recommended_use: qualityGatePassed ? "candidate_mining" : "model_quality_work",
        metrics,
        blockers,
        next_action: qualityGatePassed
            ? "Use this classifier for candidate mining and route promotion-quality facts through human review."
            : "Keep this classifier in model-quality work until robustness gates pass.",
    };
};

export interface ClassifierPackageServiceShape {
    readonly loadManifest: (path: string) => Effect.Effect<ClassifierPackageManifest, ClassifierPackageLoadError>;
    readonly listOperations: (manifestPath: string) => Effect.Effect<readonly ClassifierPackageOperation[], ClassifierPackageLoadError>;
    readonly getOperation: (input: {
        readonly manifestPath: string;
        readonly operationId: string;
    }) => Effect.Effect<ClassifierPackageOperation, ClassifierPackageLoadError | ClassifierPackageOperationNotFound>;
    readonly operationsReport: (
        input: ClassifierPackageOperationReportInput,
    ) => Effect.Effect<ClassifierPackageOperationsReport, ClassifierPackageLoadError>;
    readonly writeOperationsReport: (
        input: ClassifierPackageOperationWriteInput,
    ) => Effect.Effect<ClassifierPackageOperationsReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly operationPreflightReport: (
        input: ClassifierPackageOperationPreflightInput,
    ) => Effect.Effect<ClassifierPackageOperationPreflightReport, ClassifierPackageLoadError>;
    readonly writeOperationPreflightReport: (
        input: ClassifierPackageOperationPreflightWriteInput,
    ) => Effect.Effect<ClassifierPackageOperationPreflightReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly operationDryRunReport: (
        input: ClassifierPackageOperationDryRunInput,
    ) => Effect.Effect<ClassifierPackageOperationDryRunReport, ClassifierPackageLoadError>;
    readonly writeOperationDryRunReport: (
        input: ClassifierPackageOperationDryRunWriteInput,
    ) => Effect.Effect<ClassifierPackageOperationDryRunReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly operationExecutionPlanReport: (
        input: ClassifierPackageOperationExecutionPlanInput,
    ) => Effect.Effect<ClassifierPackageOperationExecutionPlanReport, ClassifierPackageLoadError>;
    readonly writeOperationExecutionPlanReport: (
        input: ClassifierPackageOperationExecutionPlanWriteInput,
    ) => Effect.Effect<ClassifierPackageOperationExecutionPlanReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly executeOperation: (
        input: ClassifierPackageOperationExecutionInput,
    ) => Effect.Effect<ClassifierPackageOperationExecutionReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly writeOperationExecutionReport: (
        input: ClassifierPackageOperationExecutionWriteInput,
    ) => Effect.Effect<ClassifierPackageOperationExecutionReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly discoverManifestPaths: (root?: string) => Effect.Effect<readonly string[], ClassifierPackageLoadError>;
    readonly packageSummaries: (root?: string) => Effect.Effect<readonly ClassifierPackageOperationsSummary[], ClassifierPackageLoadError>;
    readonly packagesOperationsReport: (
        input?: ClassifierPackagesOperationsReportInput,
    ) => Effect.Effect<ClassifierPackagesOperationsReport, ClassifierPackageLoadError>;
    readonly writePackagesOperationsReport: (
        input: ClassifierPackagesOperationsWriteInput,
    ) => Effect.Effect<ClassifierPackagesOperationsReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly executionHistoryReport: (
        input?: ClassifierPackageExecutionHistoryInput,
    ) => Effect.Effect<ClassifierPackageExecutionHistoryReport, ClassifierPackageLoadError>;
    readonly writeExecutionHistoryReport: (
        input: ClassifierPackageExecutionHistoryWriteInput,
    ) => Effect.Effect<ClassifierPackageExecutionHistoryReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly executionFactProjectionReport: (
        input?: ClassifierPackageExecutionFactProjectionInput,
    ) => Effect.Effect<ClassifierPackageExecutionFactProjectionReport, ClassifierPackageLoadError>;
    readonly writeExecutionFactProjectionReport: (
        input: ClassifierPackageExecutionFactProjectionWriteInput,
    ) => Effect.Effect<ClassifierPackageExecutionFactProjectionReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly executionSurrealWritePlanReport: (
        input?: ClassifierPackageExecutionSurrealWritePlanInput,
    ) => Effect.Effect<ClassifierPackageExecutionSurrealWritePlanReport, ClassifierPackageLoadError>;
    readonly writeExecutionSurrealWritePlanReport: (
        input: ClassifierPackageExecutionSurrealWritePlanWriteInput,
    ) => Effect.Effect<ClassifierPackageExecutionSurrealWritePlanReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
    readonly applyExecutionSurrealWritePlanReport: (
        input?: ClassifierPackageExecutionSurrealApplyInput,
    ) => Effect.Effect<ClassifierPackageExecutionSurrealApplyReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError, SurrealClient>;
    readonly writeExecutionSurrealApplyReport: (
        input: ClassifierPackageExecutionSurrealApplyWriteInput,
    ) => Effect.Effect<ClassifierPackageExecutionSurrealApplyReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError, SurrealClient>;
    readonly executionGraphHealthReport: (
        input?: ClassifierPackageExecutionGraphHealthInput,
    ) => Effect.Effect<ClassifierPackageExecutionGraphHealthReport, ClassifierPackageReportWriteError, SurrealClient>;
    readonly executionGraphQuerySuggestionRoutingSummary: (
        input?: ClassifierPackageExecutionGraphHealthInput,
    ) => Effect.Effect<ClassifierGraphQuerySuggestionRoutingSummary, ClassifierPackageReportWriteError, SurrealClient>;
    readonly writeExecutionGraphQuerySuggestionRoutingSummaryReport: (
        input: ClassifierGraphQuerySuggestionRoutingSummaryWriteInput,
    ) => Effect.Effect<ClassifierGraphQuerySuggestionRoutingSummary, ClassifierPackageReportWriteError, SurrealClient>;
    readonly boundaryReplaySummaryReport: (
        input?: ClassifierBoundaryReplaySummaryInput,
    ) => Effect.Effect<ClassifierGraphBoundaryReplaySummary, ClassifierPackageReportWriteError, SurrealClient>;
    readonly writeBoundaryReplaySummaryReport: (
        input: ClassifierBoundaryReplaySummaryWriteInput,
    ) => Effect.Effect<ClassifierGraphBoundaryReplaySummary, ClassifierPackageReportWriteError, SurrealClient>;
    readonly writeExecutionGraphHealthReport: (
        input: ClassifierPackageExecutionGraphHealthWriteInput,
    ) => Effect.Effect<ClassifierPackageExecutionGraphHealthReport, ClassifierPackageReportWriteError, SurrealClient>;
    readonly lifecycleInsightReport: (
        input?: ClassifierLifecycleInsightInput,
    ) => Effect.Effect<ClassifierLifecycleInsightReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError, SurrealClient>;
    readonly writeLifecycleInsightReport: (
        input: ClassifierLifecycleInsightWriteInput,
    ) => Effect.Effect<ClassifierLifecycleInsightReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError, SurrealClient>;
    readonly lifecycleRoutingSummaryReport: (
        input?: ClassifierLifecycleInsightInput,
    ) => Effect.Effect<ClassifierLifecycleRoutingSummaryReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError, SurrealClient>;
    readonly writeLifecycleRoutingSummaryReport: (
        input: ClassifierLifecycleRoutingSummaryWriteInput,
    ) => Effect.Effect<ClassifierLifecycleRoutingSummaryReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError, SurrealClient>;
    readonly pendingReviewTaskListReport: (
        input: ClassifierPendingReviewTaskListInput,
    ) => Effect.Effect<WorkflowCandidateGuidancePendingReviewTaskListReport, ClassifierPackageLoadError, FileSystem.FileSystem | Path.Path>;
    readonly writePendingReviewTaskListReport: (
        input: ClassifierPendingReviewTaskListWriteInput,
    ) => Effect.Effect<WorkflowCandidateGuidancePendingReviewTaskListReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError, FileSystem.FileSystem | Path.Path>;
    readonly classifierQualityStatusReport: (
        input: ClassifierQualityStatusInput,
    ) => Effect.Effect<ClassifierQualityStatusReport, ClassifierPackageLoadError>;
    readonly writeClassifierQualityStatusReport: (
        input: ClassifierQualityStatusWriteInput,
    ) => Effect.Effect<ClassifierQualityStatusReport, ClassifierPackageLoadError | ClassifierPackageReportWriteError>;
}

export class ClassifierPackageService extends Context.Service<ClassifierPackageService, ClassifierPackageServiceShape>()(
    "ax/ClassifierPackageService",
) {}

export const ClassifierPackageServiceLive: Layer.Layer<ClassifierPackageService> = Layer.effect(
    ClassifierPackageService,
    Effect.gen(function* () {
        const loadManifest = Effect.fn("ClassifierPackageService.loadManifest")(function* (path: string) {
            return yield* Effect.try({
                try: () => loadClassifierPackageManifest(path),
                catch: (error) => ClassifierPackageLoadError.make({ path, message: errorMessage(error) }),
            });
        });

        const listOperations = Effect.fn("ClassifierPackageService.listOperations")(function* (manifestPath: string) {
            const manifest = yield* loadManifest(manifestPath);
            return listClassifierPackageOperations(manifest);
        });

        const getOperation = Effect.fn("ClassifierPackageService.getOperation")(function* (input: {
            readonly manifestPath: string;
            readonly operationId: string;
        }) {
            const manifest = yield* loadManifest(input.manifestPath);
            const operation = findClassifierPackageOperation(manifest, input.operationId);
            if (!operation) {
                return yield* ClassifierPackageOperationNotFound.make({
                    packageKey: manifest.key,
                    operationId: input.operationId,
                });
            }
            return operation;
        });

        const operationsReport = Effect.fn("ClassifierPackageService.operationsReport")(function* (
            input: ClassifierPackageOperationReportInput,
        ) {
            const manifest = yield* loadManifest(input.manifestPath);
            return buildOperationsReport(manifest, input.manifestPath, input.operationId);
        });

        const writeReport = Effect.fn("ClassifierPackageService.writeOperationsReport")(function* (
            input: ClassifierPackageOperationWriteInput,
        ) {
            const report = yield* operationsReport(input);
            yield* Effect.try({
                try: () => writeOperationsReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const operationPreflightReport = Effect.fn("ClassifierPackageService.operationPreflightReport")(function* (
            input: ClassifierPackageOperationPreflightInput,
        ) {
            const manifest = yield* loadManifest(input.manifestPath);
            return buildOperationPreflightReport(manifest, input.manifestPath, input.operationId);
        });

        const writePreflightReport = Effect.fn("ClassifierPackageService.writeOperationPreflightReport")(function* (
            input: ClassifierPackageOperationPreflightWriteInput,
        ) {
            const report = yield* operationPreflightReport(input);
            yield* Effect.try({
                try: () => writeOperationPreflightReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const operationDryRunReport = Effect.fn("ClassifierPackageService.operationDryRunReport")(function* (
            input: ClassifierPackageOperationDryRunInput,
        ) {
            const manifest = yield* loadManifest(input.manifestPath);
            return buildOperationDryRunReport(manifest, input.manifestPath, input.operationId);
        });

        const writeDryRunReport = Effect.fn("ClassifierPackageService.writeOperationDryRunReport")(function* (
            input: ClassifierPackageOperationDryRunWriteInput,
        ) {
            const report = yield* operationDryRunReport(input);
            yield* Effect.try({
                try: () => writeOperationDryRunReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const operationExecutionPlanReport = Effect.fn("ClassifierPackageService.operationExecutionPlanReport")(function* (
            input: ClassifierPackageOperationExecutionPlanInput,
        ) {
            const manifest = yield* loadManifest(input.manifestPath);
            return buildOperationExecutionPlanReport(manifest, input.manifestPath, input.operationId, {
                allowExecute: input.allowExecute,
                allowExpensive: input.allowExpensive,
            });
        });

        const writeExecutionPlanReport = Effect.fn("ClassifierPackageService.writeOperationExecutionPlanReport")(function* (
            input: ClassifierPackageOperationExecutionPlanWriteInput,
        ) {
            const report = yield* operationExecutionPlanReport(input);
            yield* Effect.try({
                try: () => writeOperationExecutionPlanReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const executeOperation = Effect.fn("ClassifierPackageService.executeOperation")(function* (
            input: ClassifierPackageOperationExecutionInput,
        ) {
            const plan = yield* operationExecutionPlanReport(input);
            return yield* Effect.tryPromise({
                try: () => executeOperationPlanReport(plan),
                catch: (error) => ClassifierPackageReportWriteError.make({
                    path: input.manifestPath,
                    message: errorMessage(error),
                }),
            });
        });

        const writeExecutionReport = Effect.fn("ClassifierPackageService.writeOperationExecutionReport")(function* (
            input: ClassifierPackageOperationExecutionWriteInput,
        ) {
            const report = yield* executeOperation(input);
            yield* Effect.try({
                try: () => writeOperationExecutionReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const discoverManifestPaths = Effect.fn("ClassifierPackageService.discoverManifestPaths")(function* (root = "packages") {
            return yield* Effect.try({
                try: () => discoverClassifierPackageManifestPaths(root),
                catch: (error) => ClassifierPackageLoadError.make({ path: root, message: errorMessage(error) }),
            });
        });

        const packageSummaries = Effect.fn("ClassifierPackageService.packageSummaries")(function* (root = "packages") {
            const paths = yield* discoverManifestPaths(root);
            return yield* Effect.forEach(paths, (path) =>
                Effect.gen(function* () {
                    const manifest = yield* loadManifest(path);
                    return summarizeClassifierPackageOperations(manifest, path);
                }));
        });

        const packagesOperationsReport = Effect.fn("ClassifierPackageService.packagesOperationsReport")(function* (
            input?: ClassifierPackagesOperationsReportInput,
        ) {
            const root = input?.root ?? "packages";
            const summaries = yield* packageSummaries(root);
            return buildPackagesOperationsReport(root, summaries);
        });

        const writePackagesReport = Effect.fn("ClassifierPackageService.writePackagesOperationsReport")(function* (
            input: ClassifierPackagesOperationsWriteInput,
        ) {
            const report = yield* packagesOperationsReport(input);
            yield* Effect.try({
                try: () => writePackagesOperationsReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const executionHistoryReport = Effect.fn("ClassifierPackageService.executionHistoryReport")(function* (
            input?: ClassifierPackageExecutionHistoryInput,
        ) {
            const root = input?.root ?? ".ax/experiments";
            const paths = yield* Effect.try({
                try: () => discoverClassifierPackageExecutionReportPaths(root),
                catch: (error) => ClassifierPackageLoadError.make({ path: root, message: errorMessage(error) }),
            });
            const entries = yield* Effect.forEach(paths, (path) =>
                Effect.try({
                    try: () => ({ path, report: loadClassifierPackageExecutionReport(path) }),
                    catch: (error) => ClassifierPackageLoadError.make({ path, message: errorMessage(error) }),
                }));
            return buildExecutionHistoryReport(root, entries);
        });

        const writeExecutionHistory = Effect.fn("ClassifierPackageService.writeExecutionHistoryReport")(function* (
            input: ClassifierPackageExecutionHistoryWriteInput,
        ) {
            const report = yield* executionHistoryReport(input);
            yield* Effect.try({
                try: () => writeExecutionHistoryReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const executionFactProjectionReport = Effect.fn("ClassifierPackageService.executionFactProjectionReport")(function* (
            input?: ClassifierPackageExecutionFactProjectionInput,
        ) {
            const root = input?.root ?? ".ax/experiments";
            const paths = yield* Effect.try({
                try: () => discoverClassifierPackageExecutionReportPaths(root),
                catch: (error) => ClassifierPackageLoadError.make({ path: root, message: errorMessage(error) }),
            });
            const entries = yield* Effect.forEach(paths, (path) =>
                Effect.try({
                    try: () => ({ path, report: loadClassifierPackageExecutionReport(path) }),
                    catch: (error) => ClassifierPackageLoadError.make({ path, message: errorMessage(error) }),
                }));
            const workflowStatusPath = input?.workflowStatusPath ?? ".ax/experiments/blind-workflow-status-current.json";
            const workflowStatus = yield* Effect.try({
                try: () => loadClassifierLifecycleReviewStatus(workflowStatusPath),
                catch: (error) => ClassifierPackageLoadError.make({ path: workflowStatusPath, message: errorMessage(error) }),
            });
            return buildExecutionFactProjectionReport(root, entries, workflowStatus);
        });

        const writeExecutionFactProjection = Effect.fn("ClassifierPackageService.writeExecutionFactProjectionReport")(function* (
            input: ClassifierPackageExecutionFactProjectionWriteInput,
        ) {
            const report = yield* executionFactProjectionReport(input);
            yield* Effect.try({
                try: () => writeExecutionFactProjectionReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const executionSurrealWritePlanReport = Effect.fn("ClassifierPackageService.executionSurrealWritePlanReport")(function* (
            input?: ClassifierPackageExecutionSurrealWritePlanInput,
        ) {
            const projection = yield* executionFactProjectionReport(input);
            return buildExecutionSurrealWritePlanReport(projection);
        });

        const writeExecutionSurrealWritePlan = Effect.fn("ClassifierPackageService.writeExecutionSurrealWritePlanReport")(function* (
            input: ClassifierPackageExecutionSurrealWritePlanWriteInput,
        ) {
            const report = yield* executionSurrealWritePlanReport(input);
            yield* Effect.try({
                try: () => writeExecutionSurrealWritePlanReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const applyExecutionSurrealWritePlan = Effect.fn("ClassifierPackageService.applyExecutionSurrealWritePlanReport")(function* (
            input?: ClassifierPackageExecutionSurrealApplyInput,
        ) {
            const db = yield* SurrealClient;
            const writePlan = yield* executionSurrealWritePlanReport(input);
            return yield* Effect.tryPromise({
                try: () => applyExecutionSurrealWritePlanReport(writePlan, async (statement) => {
                    await Effect.runPromise(db.query(statement));
                }),
                catch: (error) => ClassifierPackageReportWriteError.make({
                    path: input?.root ?? ".ax/experiments",
                    message: errorMessage(error),
                }),
            });
        });

        const writeExecutionSurrealApply = Effect.fn("ClassifierPackageService.writeExecutionSurrealApplyReport")(function* (
            input: ClassifierPackageExecutionSurrealApplyWriteInput,
        ) {
            const report = yield* applyExecutionSurrealWritePlan(input);
            yield* Effect.try({
                try: () => writeExecutionSurrealApplyReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const executionGraphHealth = Effect.fn("ClassifierPackageService.executionGraphHealthReport")(function* (
            input?: ClassifierPackageExecutionGraphHealthInput,
        ) {
            const db = yield* SurrealClient;
            const result = yield* db.query<[ClassifierGraphNodeRow[], ClassifierGraphEdgeRow[], ClassifierGraphFactRow[]]>(classifierGraphHealthSql()).pipe(
                Effect.mapError((error) => ClassifierPackageReportWriteError.make({
                    path: "classifier_graph_*",
                    message: errorMessage(error),
                })),
            );
            return buildExecutionGraphHealthReport({
                nodes: result[0] ?? [],
                edges: result[1] ?? [],
                facts: result[2] ?? [],
                ...(input?.query === undefined ? {} : { query: input.query }),
            });
        });

        const writeExecutionGraphHealth = Effect.fn("ClassifierPackageService.writeExecutionGraphHealthReport")(function* (
            input: ClassifierPackageExecutionGraphHealthWriteInput,
        ) {
            const report = yield* executionGraphHealth(input);
            yield* Effect.try({
                try: () => writeExecutionGraphHealthReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const executionGraphQuerySuggestionRoutingSummary = Effect.fn("ClassifierPackageService.executionGraphQuerySuggestionRoutingSummary")(function* (
            input?: ClassifierPackageExecutionGraphHealthInput,
        ) {
            const report = yield* executionGraphHealth(input);
            return summarizeClassifierGraphQuerySuggestionRouting(report);
        });

        const writeExecutionGraphQuerySuggestionRoutingSummary = Effect.fn("ClassifierPackageService.writeExecutionGraphQuerySuggestionRoutingSummaryReport")(function* (
            input: ClassifierGraphQuerySuggestionRoutingSummaryWriteInput,
        ) {
            const report = yield* executionGraphQuerySuggestionRoutingSummary(input);
            yield* Effect.try({
                try: () => writeClassifierGraphQuerySuggestionRoutingSummary(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const boundaryReplaySummary = Effect.fn("ClassifierPackageService.boundaryReplaySummaryReport")(function* (
            input?: ClassifierBoundaryReplaySummaryInput,
        ) {
            const report = yield* executionGraphHealth({
                query: boundaryReplaySummaryQuery(input?.query),
            });
            return report.boundary_replay_summary ?? fallbackBoundaryReplaySummary();
        });

        const writeBoundaryReplaySummary = Effect.fn("ClassifierPackageService.writeBoundaryReplaySummaryReport")(function* (
            input: ClassifierBoundaryReplaySummaryWriteInput,
        ) {
            const report = yield* boundaryReplaySummary(input);
            yield* Effect.try({
                try: () => {
                    mkdirSync(dirname(input.out), { recursive: true });
                    writeFileSync(input.out, `${prettyPrint(report)}\n`, "utf8");
                },
                catch: (error) => ClassifierPackageReportWriteError.make({
                    path: input.out,
                    message: errorMessage(error),
                }),
            });
            return report;
        });

        const lifecycleInsight = Effect.fn("ClassifierPackageService.lifecycleInsightReport")(function* (
            input?: ClassifierLifecycleInsightInput,
        ) {
            const packages = yield* packagesOperationsReport({ root: input?.root ?? "packages" });
            const graph = yield* executionGraphHealth({ query: { mode: "summary" } });
            const lifecycleSuccessGraph = yield* executionGraphHealth({
                query: {
                    mode: "lifecycle",
                    subject: "classifier_lifecycle:workflow_candidate_review_pipeline",
                    predicate: "review_pipeline_post_apply_recheck_status",
                    value_equals: "gap_closed",
                },
            });
            const queryGraph = input?.graphQuery === undefined
                ? undefined
                : yield* executionGraphHealth({ query: input.graphQuery });
            const workflowStatusPath = input?.workflowStatusPath ?? ".ax/experiments/blind-workflow-status-current.json";
            const workflowStatus = yield* Effect.try({
                try: () => loadClassifierLifecycleReviewStatus(workflowStatusPath),
                catch: (error) => ClassifierPackageLoadError.make({
                    path: workflowStatusPath,
                    message: errorMessage(error),
                }),
            });
            return buildClassifierLifecycleInsightReport({
                packages,
                graph,
                ...(queryGraph === undefined ? {} : { queryGraph }),
                lifecycleSuccessGraph,
                workflowStatus,
            });
        });

        const writeLifecycleInsight = Effect.fn("ClassifierPackageService.writeLifecycleInsightReport")(function* (
            input: ClassifierLifecycleInsightWriteInput,
        ) {
            const report = yield* lifecycleInsight(input);
            yield* Effect.try({
                try: () => writeClassifierLifecycleInsightReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const lifecycleRoutingSummary = Effect.fn("ClassifierPackageService.lifecycleRoutingSummaryReport")(function* (
            input?: ClassifierLifecycleInsightInput,
        ) {
            const report = yield* lifecycleInsight(input);
            return summarizeClassifierLifecycleRouting(report);
        });

        const writeLifecycleRoutingSummary = Effect.fn("ClassifierPackageService.writeLifecycleRoutingSummaryReport")(function* (
            input: ClassifierLifecycleRoutingSummaryWriteInput,
        ) {
            const report = yield* lifecycleRoutingSummary(input);
            yield* Effect.try({
                try: () => writeClassifierLifecycleRoutingSummaryReport(input.out, report),
                catch: (error) => ClassifierPackageReportWriteError.make({ path: input.out, message: errorMessage(error) }),
            });
            return report;
        });

        const pendingReviewTaskList = Effect.fn("ClassifierPackageService.pendingReviewTaskListReport")(function* (
            input: ClassifierPendingReviewTaskListInput,
        ) {
            return yield* loadWorkflowCandidateGuidancePendingReviewTaskListReport(input.taskDir, input.filters).pipe(
                Effect.catchTag("PlatformError", (error) =>
                    Effect.fail(ClassifierPackageLoadError.make({
                        path: input.taskDir,
                        message: errorMessage(error),
                    })),
                ),
            );
        });

        const writePendingReviewTaskList = Effect.fn("ClassifierPackageService.writePendingReviewTaskListReport")(function* (
            input: ClassifierPendingReviewTaskListWriteInput,
        ) {
            const report = yield* pendingReviewTaskList(input);
            yield* Effect.try({
                try: () => writeFileSync(input.out, `${prettyPrint(report)}\n`, "utf8"),
                catch: (error) => ClassifierPackageReportWriteError.make({
                    path: input.out,
                    message: errorMessage(error),
                }),
            });
            return report;
        });

        const classifierQualityStatus = Effect.fn("ClassifierPackageService.classifierQualityStatusReport")(function* (
            input: ClassifierQualityStatusInput,
        ) {
            return yield* Effect.try({
                try: () => {
                    const parsed = safeJsonParse<unknown>(readFileSync(input.sourceReportPath, "utf8"));
                    if (parsed === null) {
                        throw new Error("Invalid classifier quality source JSON");
                    }
                    return buildClassifierQualityStatusReport(input.sourceReportPath, parsed);
                },
                catch: (error) => ClassifierPackageLoadError.make({
                    path: input.sourceReportPath,
                    message: errorMessage(error),
                }),
            });
        });

        const writeClassifierQualityStatus = Effect.fn("ClassifierPackageService.writeClassifierQualityStatusReport")(function* (
            input: ClassifierQualityStatusWriteInput,
        ) {
            const report = yield* classifierQualityStatus(input);
            yield* Effect.try({
                try: () => writeFileSync(input.out, `${prettyPrint(report)}\n`, "utf8"),
                catch: (error) => ClassifierPackageReportWriteError.make({
                    path: input.out,
                    message: errorMessage(error),
                }),
            });
            return report;
        });

        return ClassifierPackageService.of({
            loadManifest,
            listOperations,
            getOperation,
            operationsReport,
            writeOperationsReport: writeReport,
            operationPreflightReport,
            writeOperationPreflightReport: writePreflightReport,
            operationDryRunReport,
            writeOperationDryRunReport: writeDryRunReport,
            operationExecutionPlanReport,
            writeOperationExecutionPlanReport: writeExecutionPlanReport,
            executeOperation,
            writeOperationExecutionReport: writeExecutionReport,
            discoverManifestPaths,
            packageSummaries,
            packagesOperationsReport,
            writePackagesOperationsReport: writePackagesReport,
            executionHistoryReport,
            writeExecutionHistoryReport: writeExecutionHistory,
            executionFactProjectionReport,
            writeExecutionFactProjectionReport: writeExecutionFactProjection,
            executionSurrealWritePlanReport,
            writeExecutionSurrealWritePlanReport: writeExecutionSurrealWritePlan,
            applyExecutionSurrealWritePlanReport: applyExecutionSurrealWritePlan,
            writeExecutionSurrealApplyReport: writeExecutionSurrealApply,
            executionGraphHealthReport: executionGraphHealth,
            executionGraphQuerySuggestionRoutingSummary,
            writeExecutionGraphQuerySuggestionRoutingSummaryReport: writeExecutionGraphQuerySuggestionRoutingSummary,
            boundaryReplaySummaryReport: boundaryReplaySummary,
            writeBoundaryReplaySummaryReport: writeBoundaryReplaySummary,
            writeExecutionGraphHealthReport: writeExecutionGraphHealth,
            lifecycleInsightReport: lifecycleInsight,
            writeLifecycleInsightReport: writeLifecycleInsight,
            lifecycleRoutingSummaryReport: lifecycleRoutingSummary,
            writeLifecycleRoutingSummaryReport: writeLifecycleRoutingSummary,
            pendingReviewTaskListReport: pendingReviewTaskList,
            writePendingReviewTaskListReport: writePendingReviewTaskList,
            classifierQualityStatusReport: classifierQualityStatus,
            writeClassifierQualityStatusReport: writeClassifierQualityStatus,
        });
    }),
);
