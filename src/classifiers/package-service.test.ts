import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import {
    ClassifierPackageOperationNotFound,
    ClassifierPackageService,
    ClassifierPackageServiceLive,
} from "./package-service.ts";
import {
    buildOperationExecutionPlanReport,
    executeOperationPlanReport,
    writeOperationExecutionReport,
} from "./package-operations.ts";

const sessionSectionManifest = "packages/ax-classifier-session-sections/ax.classifier.json";

const runWithService = <A>(effect: Effect.Effect<A, unknown, ClassifierPackageService>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(ClassifierPackageServiceLive)));

const runWithServiceAndDb = <A>(
    effect: Effect.Effect<A, unknown, ClassifierPackageService | SurrealClient>,
    db: SurrealClientShape,
): Promise<A> =>
    Effect.runPromise(effect.pipe(
        Effect.provide(ClassifierPackageServiceLive),
        Effect.provideService(SurrealClient, db),
    ));

function writeTempManifest(command: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "ax-package-manifest-")), "ax.classifier.json");
    writeFileSync(path, `${JSON.stringify({
        schema: "ax.classifier.v1",
        key: "exec-demo",
        version: "0.1.0",
        package: "@ax-classifier/exec-demo",
        entrypoint: "./predict.py",
        kind: "local_model",
        input: "event_window",
        description: "Execution test classifier package.",
        labels: ["none"],
        targets: ["section_candidate"],
        operations: [{
            id: "print-demo",
            kind: "debug",
            description: "Print a deterministic execution marker.",
            command,
        }],
    }, null, 2)}\n`);
    return path;
}

async function writeTempExecutionReportRoot(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "ax-package-service-executions-"));
    const artifactPath = join(root, "artifact.txt");
    const manifestPath = writeTempManifest(`node -e "require('fs').writeFileSync('${artifactPath}', 'artifact')"`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const plan = buildOperationExecutionPlanReport(manifest, manifestPath, "print-demo", {
        allowExecute: true,
        allowExpensive: false,
    });
    const execution = await executeOperationPlanReport(plan);
    writeOperationExecutionReport(join(root, "classifier-package-execution-demo.json"), execution);
    return root;
}

describe("ClassifierPackageService", () => {
    test("lists classifier package operations through the service layer", async () => {
        const operations = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.listOperations(sessionSectionManifest);
        }));

        expect(operations.map((operation) => operation.id)).toEqual([
            "setfit-train-eval",
            "setfit-fixture-eval",
            "frozen-embedding-helper-svm",
            "embedding-helper-review",
            "embedding-helper-review-batch",
            "embedding-helper-review-progress",
            "embedding-helper-review-status",
            "embedding-helper-export",
            "embedding-helper-fixture-append",
            "embedding-helper-fixture-metadata",
            "embedding-helper-fixture-split-audit",
            "embedding-helper-fixture-setfit-robustness",
            "embedding-helper-fixture-failure-analysis",
            "embedding-helper-boundary-miss-review",
            "embedding-helper-boundary-miss-review-sync",
            "embedding-helper-export-preview",
            "embedding-helper-graph-projection",
            "embedding-helper-graph-apply",
            "embedding-helper-graph-health",
            "embedding-helper-usefulness-transcript-report",
            "embedding-helper-usefulness-hybrid-report",
            "embedding-helper-graph-usefulness",
            "hybrid-gate-eval",
            "hybrid-window-candidate-projection",
            "hybrid-window-candidate-apply",
            "hybrid-window-workflow-candidate-report",
            "workflow-candidate-source-compare",
            "workflow-candidate-combined-report",
            "workflow-candidate-proposal-pack",
            "workflow-candidate-proposal-review",
            "workflow-candidate-proposal-promote-drafts",
            "workflow-candidate-proposal-ready-smoke",
            "predict-windows",
            "blind-review-refresh",
            "blind-workflow-status",
            "focused-batch-eval",
            "focused-batch-suggestion-draft",
            "focused-batch-promote-draft",
            "graph-health-summary",
            "graph-health-guarded",
            "graph-health-changed-artifacts",
            "candidate-graph-projection",
            "transcript-candidate-graph-projection",
            "workflow-candidate-report",
            "workflow-fixture-review",
            "workflow-fixture-review-sync",
            "workflow-fixture-append",
            "workflow-fixture-metadata",
            "workflow-fixture-split-audit",
            "workflow-fixture-setfit-robustness",
            "workflow-fixture-failure-analysis",
            "workflow-fixture-none-safety-pregate",
            "workflow-fixture-none-safety-window-replay",
            "workflow-fixture-hybrid-robustness",
            "workflow-fixture-hybrid-graph-usefulness",
            "classifier-lifecycle-status",
            "blind-post-review",
        ]);
        expect(operations.map((operation) => operation.kind)).toEqual([
            "train",
            "eval",
            "eval",
            "review",
            "review",
            "status",
            "review",
            "publish",
            "publish",
            "status",
            "eval",
            "eval",
            "status",
            "review",
            "review",
            "review",
            "status",
            "publish",
            "status",
            "status",
            "status",
            "status",
            "eval",
            "status",
            "publish",
            "status",
            "status",
            "status",
            "review",
            "review",
            "review",
            "review",
            "debug",
            "review",
            "status",
            "review",
            "review",
            "review",
            "status",
            "status",
            "status",
            "status",
            "status",
            "status",
            "review",
            "review",
            "review",
            "status",
            "eval",
            "eval",
            "status",
            "status",
            "status",
            "eval",
            "eval",
            "status",
            "review",
        ]);
    });

    test("loads one operation for debugger-style callers", async () => {
        const operation = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.getOperation({
                manifestPath: sessionSectionManifest,
                operationId: "blind-review-refresh",
            });
        }));

        expect(operation.command).toBe("bun run classifiers:blind-review-refresh");
        expect(operation.outputs).toContain(".ax/experiments/blind-workflow-status-current.json");
    });

    test("reports missing operations as typed service errors", async () => {
        const error = await Effect.runPromise(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.getOperation({
                manifestPath: sessionSectionManifest,
                operationId: "missing",
            });
        }).pipe(
            Effect.provide(ClassifierPackageServiceLive),
            Effect.flip,
        ));

        expect(error).toBeInstanceOf(ClassifierPackageOperationNotFound);
        expect(error).toMatchObject({
            packageKey: "session-section-chunks",
            operationId: "missing",
        });
    });

    test("builds persisted operation reports through the service", async () => {
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.operationsReport({
                manifestPath: sessionSectionManifest,
                operationId: "blind-workflow-status",
            });
        }));

        expect(report.decision).toBe("operation_found");
        expect(report.operations[0]?.id).toBe("blind-workflow-status");
        expect(report.failures).toEqual([]);
    });

    test("writes operation reports through the service layer", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "ax-package-service-")), "report.json");

        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.writeOperationsReport({
                manifestPath: sessionSectionManifest,
                operationId: "blind-review-refresh",
                out: path,
            });
        }));

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(report.decision).toBe("operation_found");
        expect(written.operations[0].id).toBe("blind-review-refresh");
    });

    test("preflights operation inputs through the service layer", async () => {
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.operationPreflightReport({
                manifestPath: sessionSectionManifest,
                operationId: "setfit-train-eval",
            });
        }));

        expect(report.decision).toBe("ready");
        expect(report.operation?.kind).toBe("train");
        expect(report.missing_inputs).toEqual([]);
    });

    test("writes ready preflight reports through the service layer", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "ax-package-preflight-")), "report.json");

        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.writeOperationPreflightReport({
                manifestPath: sessionSectionManifest,
                operationId: "setfit-train-eval",
                out: path,
            });
        }));

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(report.decision).toBe("ready");
        expect(written.operation.id).toBe("setfit-train-eval");
    });

    test("builds dry-run reports through the service layer", async () => {
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.operationDryRunReport({
                manifestPath: sessionSectionManifest,
                operationId: "setfit-train-eval",
            });
        }));

        expect(report.decision).toBe("ready_to_run");
        expect(report.would_execute).toBe(false);
        expect(report.command).toContain("bun run classifiers:setfit-eval");
    });

    test("writes dry-run reports through the service layer", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "ax-package-dry-run-")), "report.json");

        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.writeOperationDryRunReport({
                manifestPath: sessionSectionManifest,
                operationId: "setfit-train-eval",
                out: path,
            });
        }));

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(report.decision).toBe("ready_to_run");
        expect(written.would_execute).toBe(false);
    });

    test("builds guarded execution plans through the service layer", async () => {
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.operationExecutionPlanReport({
                manifestPath: sessionSectionManifest,
                operationId: "setfit-train-eval",
                allowExecute: true,
                allowExpensive: false,
            });
        }));

        expect(report.decision).toBe("denied_expensive");
        expect(report.would_execute).toBe(false);
        expect(report.expensive).toBe(true);
    });

    test("writes execution plans through the service layer", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "ax-package-execution-plan-")), "report.json");

        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.writeOperationExecutionPlanReport({
                manifestPath: sessionSectionManifest,
                operationId: "setfit-train-eval",
                allowExecute: false,
                allowExpensive: false,
                out: path,
            });
        }));

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(report.decision).toBe("denied_requires_execute");
        expect(written.would_execute).toBe(false);
    });

    test("executes operations through the service layer", async () => {
        const manifestPath = writeTempManifest("node -e \"process.stdout.write('service-exec-ok')\"");

        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.executeOperation({
                manifestPath,
                operationId: "print-demo",
                allowExecute: true,
                allowExpensive: false,
            });
        }));

        expect(report.decision).toBe("executed");
        expect(report.executed).toBe(true);
        expect(report.stdout).toBe("service-exec-ok");
    });

    test("writes execution reports through the service layer", async () => {
        const manifestPath = writeTempManifest("node -e \"process.stdout.write('service-exec-write-ok')\"");
        const path = join(mkdtempSync(join(tmpdir(), "ax-package-execution-")), "report.json");

        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.writeOperationExecutionReport({
                manifestPath,
                operationId: "print-demo",
                allowExecute: true,
                allowExpensive: false,
                out: path,
            });
        }));

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(report.decision).toBe("executed");
        expect(written.stdout).toBe("service-exec-write-ok");
    });

    test("discovers package operation summaries through the service", async () => {
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.packagesOperationsReport({ root: "packages" });
        }));

        expect(report.totals.package_count).toBeGreaterThanOrEqual(3);
        expect(report.totals.operation_count).toBeGreaterThanOrEqual(3);
        expect(report.totals.local_model_ready_count).toBe(1);
        expect(report.totals.local_model_incomplete_count).toBe(0);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.lifecycle_readiness.status).toBe("ready");
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.operations.map((operation) => operation.id)).toContain("blind-post-review");
    });

    test("writes package operation summaries through the service", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "ax-package-service-all-")), "report.json");

        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.writePackagesOperationsReport({
                root: "packages",
                out: path,
            });
        }));

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(report.schema).toBe("ax.classifier_packages_operations_report.v1");
        expect(written.totals.package_count).toBe(report.totals.package_count);
    });

    test("builds execution history through the service layer", async () => {
        const root = await writeTempExecutionReportRoot();
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.executionHistoryReport({ root });
        }));

        expect(report.schema).toBe("ax.classifier_package_execution_history_report.v1");
        expect(report.totals.report_count).toBe(1);
    });

    test("builds execution fact projections through the service layer", async () => {
        const root = await writeTempExecutionReportRoot();
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.executionFactProjectionReport({ root });
        }));

        expect(report.schema).toBe("ax.classifier_package_execution_fact_projection.v1");
        expect(report.totals.source_report_count).toBe(1);
        expect(report.totals.fact_count).toBeGreaterThanOrEqual(report.totals.source_report_count);
    });

    test("builds Surreal write plans through the service layer", async () => {
        const root = await writeTempExecutionReportRoot();
        const report = await runWithService(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.executionSurrealWritePlanReport({ root });
        }));

        expect(report.schema).toBe("ax.classifier_package_execution_surreal_write_plan.v1");
        expect(report.totals.statement_count).toBeGreaterThanOrEqual(1);
        expect(report.statements[0]).toStartWith("UPSERT classifier_graph_node:");
    });

    test("applies Surreal write plans through the service layer", async () => {
        const statements: string[] = [];
        const db = {
            query: (sql: string) => Effect.sync(() => {
                statements.push(sql);
                return [];
            }),
        } as unknown as SurrealClientShape;

        const report = await runWithServiceAndDb(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.applyExecutionSurrealWritePlanReport({ root: ".ax/experiments" });
        }), db);

        expect(report.schema).toBe("ax.classifier_package_execution_surreal_apply_report.v1");
        expect(report.decision).toBe("applied");
        expect(report.applied_statement_count).toBe(statements.length);
        expect(statements.length).toBeGreaterThanOrEqual(1);
    });

    test("queries classifier graph health through the service layer", async () => {
        const db = {
            query: (sql: string) => Effect.sync(() => {
                expect(sql).toContain("FROM classifier_graph_node");
                return [
                    [
                        {
                            graph_id: "classifier_operation:demo/refresh",
                            kind: "classifier_operation",
                            label: "refresh",
                            properties_json: JSON.stringify({ package_key: "demo", operation_kind: "review", expensive: false }),
                        },
                    ],
                    [
                        {
                            graph_id: "edge:run",
                            kind: "ran_operation",
                            from_id: "classifier_execution:.ax/experiments/run.json",
                            to_id: "classifier_operation:demo/refresh",
                            evidence_path: ".ax/experiments/run.json",
                            properties_json: "{}",
                        },
                    ],
                    [
                        {
                            graph_id: "fact:run",
                            kind: "classifier_operation_execution",
                            subject: "classifier_execution:.ax/experiments/run.json",
                            predicate: "completed_with_decision",
                            value_json: "\"executed\"",
                            evidence_edges_json: JSON.stringify(["edge:run"]),
                            properties_json: "{}",
                        },
                    ],
                ];
            }),
        } as unknown as SurrealClientShape;

        const report = await runWithServiceAndDb(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.executionGraphHealthReport();
        }), db);

        expect(report.schema).toBe("ax.classifier_package_execution_graph_health_report.v1");
        expect(report.decision).toBe("healthy");
        expect(report.operations[0]?.package_key).toBe("demo");
        expect(report.totals.edge_count).toBe(1);
    });

    test("summarizes graph query suggestion repair routing through the service layer", async () => {
        const db = {
            query: (sql: string) => Effect.sync(() => {
                expect(sql).toContain("FROM classifier_graph_node");
                return [
                    [],
                    [
                        {
                            graph_id: "edge:review",
                            kind: "has_lifecycle_fact",
                            from_id: "classifier_lifecycle:workflow_candidate_proposal",
                            to_id: "classifier_lifecycle_fact:workflow_candidate_proposal/review_pipeline_recommended_action_execution_phase",
                            evidence_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                            properties_json: "{}",
                        },
                    ],
                    [
                        {
                            graph_id: "classifier_lifecycle_fact:workflow_candidate_proposal/review_pipeline_recommended_action_execution_phase",
                            kind: "classifier_lifecycle_status",
                            subject: "classifier_lifecycle:workflow_candidate_proposal",
                            predicate: "review_pipeline_recommended_action_execution_phase",
                            value_json: "\"bind_inputs\"",
                            evidence_edges_json: "[\"edge:review\"]",
                            properties_json: "{\"source_kind\":\"review_pipeline_lifecycle\"}",
                        },
                    ],
                ];
            }),
        } as unknown as SurrealClientShape;

        const summary = await runWithServiceAndDb(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.executionGraphQuerySuggestionRoutingSummary({
                query: {
                    mode: "lifecycle",
                    predicate: "review_pipeline_recommended_action_execution_phase",
                    value_equals: "execute",
                },
            });
        }), db);

        expect(summary.has_suggestion).toBe(true);
        expect(summary.query_match_status).toBe("no_match");
        expect(summary.suggestion?.value_equals).toBe("bind_inputs");
        expect(summary.suggestion?.repair.can_execute).toBe(true);
        expect(summary.suggestion?.repair.execution_status).toBe("ready_to_execute");
        expect(summary.suggestion?.repair.command_kind).toBe("classifier_graph_query_repair");
        expect(summary.suggestion?.repair.query?.value_equals).toBe("bind_inputs");
        expect(summary.suggestion?.repair.outcome_status).toBe("expected_matches");
        expect(summary.suggestion?.verification.can_execute).toBe(true);
        expect(summary.suggestion?.verification.execution_status).toBe("ready_to_execute");
        expect(summary.suggestion?.verification.command_kind).toBe("classifier_graph_query_repair_verification");
        expect(summary.suggestion?.verification.query?.value_equals).toBe("bind_inputs");
        expect(summary.suggestion?.verification.expected_result_count).toBe(1);
        expect(summary.suggestion?.verification.outcome_status).toBe("expected_matches");
    });

    test("writes graph query suggestion routing summaries through the service layer", async () => {
        const out = join(mkdtempSync(join(tmpdir(), "ax-query-routing-summary-")), "nested", "summary.json");
        const db = {
            query: (sql: string) => Effect.sync(() => {
                expect(sql).toContain("FROM classifier_graph_node");
                return [
                    [],
                    [
                        {
                            graph_id: "edge:review",
                            kind: "has_lifecycle_fact",
                            from_id: "classifier_lifecycle:workflow_candidate_proposal",
                            to_id: "classifier_lifecycle_fact:workflow_candidate_proposal/review_pipeline_recommended_action_execution_phase",
                            evidence_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                            properties_json: "{}",
                        },
                    ],
                    [
                        {
                            graph_id: "classifier_lifecycle_fact:workflow_candidate_proposal/review_pipeline_recommended_action_execution_phase",
                            kind: "classifier_lifecycle_status",
                            subject: "classifier_lifecycle:workflow_candidate_proposal",
                            predicate: "review_pipeline_recommended_action_execution_phase",
                            value_json: "\"bind_inputs\"",
                            evidence_edges_json: "[\"edge:review\"]",
                            properties_json: "{\"source_kind\":\"review_pipeline_lifecycle\"}",
                        },
                    ],
                ];
            }),
        } as unknown as SurrealClientShape;

        const summary = await runWithServiceAndDb(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.writeExecutionGraphQuerySuggestionRoutingSummaryReport({
                out,
                query: {
                    mode: "lifecycle",
                    predicate: "review_pipeline_recommended_action_execution_phase",
                    value_equals: "execute",
                },
            });
        }), db);
        const saved = await Bun.file(out).json();

        expect(summary.suggestion?.repair.execution_status).toBe("ready_to_execute");
        expect(saved.has_suggestion).toBe(true);
        expect(saved.suggestion.repair.command_kind).toBe("classifier_graph_query_repair");
        expect(saved.suggestion.verification.command_kind).toBe("classifier_graph_query_repair_verification");
    });

    test("builds lifecycle insights through the service layer", async () => {
        const statusDir = mkdtempSync(join(tmpdir(), "ax-lifecycle-status-"));
        const statusPath = join(statusDir, "status.json");
        writeFileSync(statusPath, `${JSON.stringify({
            schema: "ax.blind_workflow_status.v1",
            decision: "needs_human_review",
            next_actions: ["review focused batch"],
            stages: {
                blind_labels: { pending: 3 },
                hard_negative_review: { pending: 2, accepted: 1 },
                review_batch: {
                    details: {
                        selected_ordinals: [1, 2],
                        context_enriched_sections: 2,
                        vocabulary_included: true,
                        allowed_label_count: 5,
                        allowed_target_count: 10,
                        allowed_hard_negative_status_count: 3,
                    },
                },
                review_batch_eval: {
                    details: {
                        review_pending: 2,
                        hard_negative_pending: 1,
                        missing_field_total: 4,
                        invalid_field_total: 1,
                        blocking_field_total: 5,
                        completed_field_total: 3,
                        review_field_total: 8,
                        field_completion_percent: 37.5,
                        row_completion_percent: 25,
                        missing_field_counts: { review_label: 2, review_target: 2 },
                        invalid_field_counts: { review_notes: 1 },
                        incomplete_refs: [{
                            ordinal: 1,
                            id: "blind-row-1",
                            missing: ["review_label"],
                            invalid: ["review_notes"],
                        }],
                        invalid_refs: [{
                            ordinal: 1,
                            id: "blind-row-1",
                            invalid: ["review_notes"],
                        }],
                    },
                },
            },
        })}\n`);
        writeFileSync(join(statusDir, "workflow-candidate-proposal-review-current.json"), `${JSON.stringify({
            schema: "ax.workflow_candidate_proposal_review.v1",
            decision: "needs_workflow_candidate_proposal_review",
            totals: {
                proposal_count: 4,
                ready_count: 0,
                pending_count: 4,
                invalid_count: 0,
                missing_field_count: 16,
            },
            failures: ["proposal briefs are not promotion-ready"],
        })}\n`);
        writeFileSync(join(statusDir, "workflow-candidate-proposal-review-current.md"), "# review checklist\n");
        writeFileSync(join(statusDir, "workflow-candidate-proposal-promotion-current.json"), `${JSON.stringify({
            schema: "ax.workflow_candidate_proposal_promotion.v1",
            decision: "needs_workflow_candidate_proposal_review",
            proposal_count: 4,
            emitted_draft_count: 0,
            skipped_proposal_count: 4,
            failures: ["proposal review report is not ready"],
        })}\n`);
        writeFileSync(join(statusDir, "workflow-candidate-proposal-ready-smoke-promotion-current.json"), `${JSON.stringify({
            schema: "ax.workflow_candidate_proposal_promotion.v1",
            decision: "workflow_candidate_proposal_promotion_ready",
            proposal_count: 3,
            emitted_draft_count: 2,
            skipped_proposal_count: 1,
            failures: [],
        })}\n`);
        const db = {
            query: () => Effect.sync(() => [
                [
                    {
                        graph_id: "classifier_operation:session-section-chunks/blind-review-refresh",
                        kind: "classifier_operation",
                        label: "blind-review-refresh",
                        properties_json: JSON.stringify({ package_key: "session-section-chunks", operation_kind: "review", expensive: false }),
                    },
                    {
                        graph_id: "classifier_lifecycle:workflow_candidate_review_pipeline",
                        kind: "classifier_lifecycle",
                        label: "workflow candidate review pipeline lifecycle",
                        properties_json: "{}",
                    },
                ],
                [
                    {
                        graph_id: "edge:run",
                        kind: "ran_operation",
                        from_id: "classifier_execution:.ax/experiments/run.json",
                        to_id: "classifier_operation:session-section-chunks/blind-review-refresh",
                        evidence_path: ".ax/experiments/run.json",
                        properties_json: "{}",
                    },
                    {
                        graph_id: "edge:lifecycle",
                        kind: "has_evidence",
                        from_id: "classifier_lifecycle:workflow_candidate_review_pipeline",
                        to_id: "artifact:.ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
                        evidence_path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
                        properties_json: JSON.stringify({ lifecycle_key: "review_pipeline_lifecycle" }),
                    },
                ],
                [
                    {
                        graph_id: "fact:phase",
                        kind: "classifier_lifecycle_status",
                        subject: "classifier_lifecycle:workflow_candidate_review_pipeline",
                        predicate: "review_pipeline_recommended_action_execution_phase",
                        value_json: "\"bind_inputs\"",
                        evidence_edges_json: JSON.stringify(["edge:lifecycle"]),
                        properties_json: JSON.stringify({
                            lifecycle_key: "review_pipeline_lifecycle",
                            artifact_path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
                        }),
                    },
                ],
            ]),
        } as unknown as SurrealClientShape;

        const report = await runWithServiceAndDb(Effect.gen(function* () {
            const packages = yield* ClassifierPackageService;
            return yield* packages.lifecycleInsightReport({
                workflowStatusPath: statusPath,
                graphQuery: {
                    mode: "lifecycle",
                    predicate: "review_pipeline_recommended_action_execution_phase",
                    value_equals: "execute",
                },
            });
        }), db);

        expect(report.schema).toBe("ax.classifier_lifecycle_insight_report.v1");
        expect(report.decision).toBe("needs_human_review");
        expect(report.totals.pending_blind_labels).toBe(3);
        expect(report.totals.pending_hard_negatives).toBe(2);
        expect(report.workflow_status.focused_batch?.selected_ordinals).toEqual([1, 2]);
        expect(report.workflow_status.focused_batch?.context_enriched_sections).toBe(2);
        expect(report.workflow_status.focused_batch?.vocabulary_included).toBe(true);
        expect(report.workflow_status.focused_batch?.allowed_label_count).toBe(5);
        expect(report.workflow_status.focused_batch?.blocking_field_total).toBe(5);
        expect(report.workflow_status.focused_batch?.completed_field_total).toBe(3);
        expect(report.workflow_status.focused_batch?.review_field_total).toBe(8);
        expect(report.workflow_status.focused_batch?.field_completion_percent).toBe(37.5);
        expect(report.workflow_status.focused_batch?.row_completion_percent).toBe(25);
        expect(report.workflow_status.focused_batch?.missing_field_total).toBe(4);
        expect(report.workflow_status.focused_batch?.invalid_field_total).toBe(1);
        expect(report.workflow_status.focused_batch?.missing_field_counts?.review_label).toBe(2);
        expect(report.workflow_status.focused_batch?.invalid_field_counts?.review_notes).toBe(1);
        expect(report.workflow_status.focused_batch?.incomplete_refs[0]?.id).toBe("blind-row-1");
        expect(report.workflow_status.focused_batch?.incomplete_refs[0]?.invalid).toEqual(["review_notes"]);
        expect(report.workflow_status.focused_batch?.invalid_refs[0]?.invalid).toEqual(["review_notes"]);
        expect(report.workflow_status.proposal_review?.decision).toBe("needs_workflow_candidate_proposal_review");
        expect(report.workflow_status.proposal_review?.summary_path).toBe(join(statusDir, "workflow-candidate-proposal-review-current.md"));
        expect(report.workflow_status.proposal_review?.missing_field_count).toBe(16);
        expect(report.workflow_status.proposal_promotion?.skipped_proposal_count).toBe(4);
        expect(report.workflow_status.proposal_ready_smoke?.promotion_decision).toBe("workflow_candidate_proposal_promotion_ready");
        expect(report.workflow_status.next_actions[0]).toContain("workflow-candidate-proposal-review-current.md");
        expect(report.blocking_items).toContain("workflow candidate proposal review pending 4 proposal(s)");
        expect(report.blocking_items).toContain("graph query repair available: review_pipeline_recommended_action_execution_phase value execute -> bind_inputs");
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.graph_operation_count).toBe(1);
        expect(report.graph_query_suggestion?.suggestion?.repair.outcome_status).toBe("expected_matches");
    });
});
