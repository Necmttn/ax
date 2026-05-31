import { Context, Effect, Layer, Schema } from "effect";
import { SurrealClient } from "../lib/db.ts";
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

        const lifecycleInsight = Effect.fn("ClassifierPackageService.lifecycleInsightReport")(function* (
            input?: ClassifierLifecycleInsightInput,
        ) {
            const packages = yield* packagesOperationsReport({ root: input?.root ?? "packages" });
            const graph = yield* executionGraphHealth({ query: { mode: "summary" } });
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
            writeExecutionGraphHealthReport: writeExecutionGraphHealth,
            lifecycleInsightReport: lifecycleInsight,
            writeLifecycleInsightReport: writeLifecycleInsight,
            lifecycleRoutingSummaryReport: lifecycleRoutingSummary,
            writeLifecycleRoutingSummaryReport: writeLifecycleRoutingSummary,
        });
    }),
);
