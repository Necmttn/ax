import { describe, expect, test } from "bun:test";
import {
    renderClassifierLifecycleInsightText,
    renderClassifierPackageExecutionFactsText,
    renderClassifierPackageExecutionGraphHealthText,
    renderClassifierPackageExecutionHistoryText,
    renderClassifierPackageExecutionWritePlanText,
    renderClassifierPackageExecutionApplyText,
    renderClassifierPackageOperationDryRunText,
    renderClassifierPackageOperationExecutionText,
    renderClassifierPackageOperationExecutionPlanText,
    renderClassifierPackageOperationPreflightText,
    renderClassifierPackageOperationsText,
    renderClassifierPackagesOperationsText,
} from "./classifiers-package-operations.ts";
import type {
    ClassifierLifecycleInsightReport,
    ClassifierPackageExecutionFactProjectionReport,
    ClassifierPackageExecutionGraphHealthReport,
    ClassifierPackageExecutionHistoryReport,
    ClassifierPackageExecutionSurrealWritePlanReport,
    ClassifierPackageExecutionSurrealApplyReport,
    ClassifierPackageOperationDryRunReport,
    ClassifierPackageOperationExecutionReport,
    ClassifierPackageOperationExecutionPlanReport,
    ClassifierPackageOperationPreflightReport,
    ClassifierPackagesOperationsReport,
    ClassifierPackageOperationsReport,
} from "../classifiers/package-operations.ts";

describe("classifiers package-operations format", () => {
    test("renders operation commands with inputs and outputs", () => {
        const report: ClassifierPackageOperationsReport = {
            schema: "ax.classifier_package_operations_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operations: [{
                id: "refresh",
                kind: "review",
                description: "Refresh demo artifacts.",
                command: "bun run demo:refresh",
                inputs: ["in.json"],
                outputs: ["out.json"],
            }],
            failures: [],
            decision: "operations_listed",
        };

        const output = renderClassifierPackageOperationsText(report);

        expect(output).toContain("classifier package operations: demo");
        expect(output).toContain("- review/refresh: bun run demo:refresh");
        expect(output).toContain("inputs: in.json");
        expect(output).toContain("outputs: out.json");
    });

    test("renders missing-operation failures", () => {
        const report: ClassifierPackageOperationsReport = {
            schema: "ax.classifier_package_operations_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "missing",
            operations: [],
            failures: ["classifier package demo does not declare operation: missing"],
            decision: "operation_missing",
        };

        const output = renderClassifierPackageOperationsText(report);

        expect(output).toContain("decision: operation_missing");
        expect(output).toContain("failure: classifier package demo does not declare operation: missing");
    });

    test("renders preflight input status", () => {
        const report: ClassifierPackageOperationPreflightReport = {
            schema: "ax.classifier_package_operation_preflight_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "eval",
            operation: {
                id: "eval",
                kind: "eval",
                description: "Evaluate demo.",
                command: "bun run demo:eval",
            },
            inputs: [
                { path: "fixtures.jsonl", exists: true },
                { path: "model", exists: false },
            ],
            missing_inputs: ["model"],
            failures: ["missing input: model"],
            decision: "missing_inputs",
        };

        const output = renderClassifierPackageOperationPreflightText(report);

        expect(output).toContain("classifier package operation preflight: demo/eval");
        expect(output).toContain("decision: missing_inputs");
        expect(output).toContain("- ok fixtures.jsonl");
        expect(output).toContain("- missing model");
    });

    test("renders dry-run command without execution", () => {
        const operation = {
            id: "eval",
            kind: "eval" as const,
            description: "Evaluate demo.",
            command: "bun run demo:eval",
        };
        const preflight: ClassifierPackageOperationPreflightReport = {
            schema: "ax.classifier_package_operation_preflight_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "eval",
            operation,
            inputs: [],
            missing_inputs: [],
            failures: [],
            decision: "ready",
        };
        const report: ClassifierPackageOperationDryRunReport = {
            schema: "ax.classifier_package_operation_dry_run_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "eval",
            operation,
            command: "bun run demo:eval",
            would_execute: false,
            preflight,
            failures: [],
            decision: "ready_to_run",
        };

        const output = renderClassifierPackageOperationDryRunText(report);

        expect(output).toContain("classifier package operation dry-run: demo/eval");
        expect(output).toContain("would execute: no");
        expect(output).toContain("command: bun run demo:eval");
        expect(output).toContain("preflight: ready");
    });

    test("renders guarded execution plans", () => {
        const operation = {
            id: "eval",
            kind: "eval" as const,
            description: "Evaluate demo.",
            command: "bun run demo:eval",
        };
        const preflight: ClassifierPackageOperationPreflightReport = {
            schema: "ax.classifier_package_operation_preflight_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "eval",
            operation,
            inputs: [],
            missing_inputs: [],
            failures: [],
            decision: "ready",
        };
        const dryRun: ClassifierPackageOperationDryRunReport = {
            schema: "ax.classifier_package_operation_dry_run_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "eval",
            operation,
            command: "bun run demo:eval",
            would_execute: false,
            preflight,
            failures: [],
            decision: "ready_to_run",
        };
        const report: ClassifierPackageOperationExecutionPlanReport = {
            schema: "ax.classifier_package_operation_execution_plan_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "eval",
            operation,
            command: "bun run demo:eval",
            would_execute: false,
            requested_execute: true,
            allow_expensive: false,
            expensive: true,
            dry_run: dryRun,
            failures: ["operation kind eval requires --allow-expensive"],
            decision: "denied_expensive",
        };

        const output = renderClassifierPackageOperationExecutionPlanText(report);

        expect(output).toContain("classifier package operation execution plan: demo/eval");
        expect(output).toContain("decision: denied_expensive");
        expect(output).toContain("requested execute: yes");
        expect(output).toContain("would execute: no");
        expect(output).toContain("dry-run: ready_to_run");
        expect(output).toContain("preflight: ready");
        expect(output).toContain("failure: operation kind eval requires --allow-expensive");
    });

    test("renders execution reports with captured output", () => {
        const operation = {
            id: "debug",
            kind: "debug" as const,
            description: "Run debug command.",
            command: "node -e \"process.stdout.write('ok')\"",
        };
        const preflight: ClassifierPackageOperationPreflightReport = {
            schema: "ax.classifier_package_operation_preflight_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "debug",
            operation,
            inputs: [],
            missing_inputs: [],
            failures: [],
            decision: "ready",
        };
        const dryRun: ClassifierPackageOperationDryRunReport = {
            schema: "ax.classifier_package_operation_dry_run_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "debug",
            operation,
            command: operation.command,
            would_execute: false,
            preflight,
            failures: [],
            decision: "ready_to_run",
        };
        const plan: ClassifierPackageOperationExecutionPlanReport = {
            schema: "ax.classifier_package_operation_execution_plan_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "debug",
            operation,
            command: operation.command,
            would_execute: true,
            requested_execute: true,
            allow_expensive: false,
            expensive: false,
            dry_run: dryRun,
            failures: [],
            decision: "ready_to_execute",
        };
        const report: ClassifierPackageOperationExecutionReport = {
            schema: "ax.classifier_package_operation_execution_report.v1",
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            operation_id: "debug",
            operation,
            command: operation.command,
            plan,
            executed: true,
            started_at: "2026-05-31T00:00:00.000Z",
            finished_at: "2026-05-31T00:00:00.010Z",
            duration_ms: 10,
            exit_code: 0,
            signal: null,
            stdout: "ok",
            stderr: "",
            outputs: [{ path: "out.json", exists: true }],
            missing_outputs: [],
            outputs_before: [{ path: "out.json", exists: false }],
            output_changes: [{
                path: "out.json",
                before: { path: "out.json", exists: false },
                after: {
                    path: "out.json",
                    exists: true,
                    size_bytes: 2,
                    modified_at: "2026-05-31T00:00:00.010Z",
                },
                changed_during_run: true,
            }],
            failures: [],
            decision: "executed",
        };

        const output = renderClassifierPackageOperationExecutionText(report);

        expect(output).toContain("classifier package operation execution: demo/debug");
        expect(output).toContain("decision: executed");
        expect(output).toContain("executed: yes");
        expect(output).toContain("exit code: 0");
        expect(output).toContain("plan: ready_to_execute");
        expect(output).toContain("- output ok changed out.json");
        expect(output).toContain("stdout:\nok");
    });

    test("renders execution history summaries", () => {
        const report: ClassifierPackageExecutionHistoryReport = {
            schema: "ax.classifier_package_execution_history_report.v1",
            root: ".ax/experiments",
            reports: [{
                path: ".ax/experiments/classifier-package-execution-demo.json",
                package_key: "demo",
                operation_id: "refresh",
                decision: "executed",
                plan_decision: "ready_to_execute",
                executed: true,
                exit_code: 0,
                started_at: "2026-05-31T00:00:00.000Z",
                finished_at: "2026-05-31T00:00:00.010Z",
                duration_ms: 10,
                output_count: 2,
                missing_output_count: 0,
                changed_output_count: 2,
                failures: [],
            }],
            totals: {
                report_count: 1,
                executed_count: 1,
                failed_count: 0,
                not_executed_count: 0,
                output_count: 2,
                missing_output_count: 0,
                changed_output_count: 2,
                failure_count: 0,
            },
        };

        const output = renderClassifierPackageExecutionHistoryText(report);

        expect(output).toContain("classifier package execution history: .ax/experiments");
        expect(output).toContain("executed/failed/not-executed: 1/0/0");
        expect(output).toContain("- executed demo/refresh");
        expect(output).toContain("outputs changed/missing: 2/0");
    });

    test("renders execution fact projections", () => {
        const report: ClassifierPackageExecutionFactProjectionReport = {
            schema: "ax.classifier_package_execution_fact_projection.v1",
            root: ".ax/experiments",
            source_reports: [".ax/experiments/classifier-package-execution-demo.json"],
            nodes: [{
                id: "classifier_execution:.ax/experiments/classifier-package-execution-demo.json",
                kind: "classifier_execution",
                label: "refresh",
                properties: { decision: "executed" },
            }],
            edges: [{
                id: "edge:run",
                kind: "ran_operation",
                from: "classifier_execution:.ax/experiments/classifier-package-execution-demo.json",
                to: "classifier_operation:demo/refresh",
                evidence_path: ".ax/experiments/classifier-package-execution-demo.json",
                properties: { decision: "executed" },
            }],
            facts: [{
                id: "fact:run",
                kind: "classifier_operation_execution",
                subject: "classifier_execution:.ax/experiments/classifier-package-execution-demo.json",
                predicate: "completed_with_decision",
                value: "executed",
                evidence_edges: ["edge:run"],
                properties: { decision: "executed" },
            }],
            totals: {
                source_report_count: 1,
                node_count: 1,
                edge_count: 1,
                fact_count: 1,
                execution_fact_count: 1,
                guard_fact_count: 0,
                artifact_fact_count: 0,
                lifecycle_fact_count: 0,
            },
        };

        const output = renderClassifierPackageExecutionFactsText(report);

        expect(output).toContain("classifier package execution facts: .ax/experiments");
        expect(output).toContain("nodes/edges/facts: 1/1/1");
        expect(output).toContain("- classifier_operation_execution classifier_execution:.ax/experiments/classifier-package-execution-demo.json completed_with_decision");
        expect(output).toContain("evidence_edges: edge:run");
    });

    test("renders execution write plans", () => {
        const report: ClassifierPackageExecutionSurrealWritePlanReport = {
            schema: "ax.classifier_package_execution_surreal_write_plan.v1",
            root: ".ax/experiments",
            source_projection_schema: "ax.classifier_package_execution_fact_projection.v1",
            statements: [
                "UPSERT classifier_graph_node:`n1` CONTENT { graph_id: \"n1\" };",
                "UPSERT classifier_graph_edge:`e1` CONTENT { graph_id: \"e1\" };",
                "UPSERT classifier_graph_fact:`f1` CONTENT { graph_id: \"f1\" };",
            ],
            tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
            totals: {
                statement_count: 3,
                node_statement_count: 1,
                edge_statement_count: 1,
                fact_statement_count: 1,
            },
        };

        const output = renderClassifierPackageExecutionWritePlanText(report);

        expect(output).toContain("classifier package execution write plan: .ax/experiments");
        expect(output).toContain("nodes/edges/facts: 1/1/1");
        expect(output).toContain("tables: classifier_graph_node, classifier_graph_edge, classifier_graph_fact");
        expect(output).toContain("UPSERT classifier_graph_node");
    });

    test("renders execution apply reports", () => {
        const report: ClassifierPackageExecutionSurrealApplyReport = {
            schema: "ax.classifier_package_execution_surreal_apply_report.v1",
            root: ".ax/experiments",
            source_write_plan_schema: "ax.classifier_package_execution_surreal_write_plan.v1",
            applied: false,
            attempted_statement_count: 2,
            applied_statement_count: 1,
            failed_statement_count: 1,
            first_failure: {
                index: 1,
                statement: "UPSERT classifier_graph_fact:`f1` CONTENT {};",
                message: "db rejected statement",
            },
            tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
            decision: "failed",
        };

        const output = renderClassifierPackageExecutionApplyText(report);

        expect(output).toContain("classifier package execution apply: .ax/experiments");
        expect(output).toContain("decision: failed");
        expect(output).toContain("statements attempted/applied/failed: 2/1/1");
        expect(output).toContain("first failure: 1 db rejected statement");
    });

    test("renders execution graph health reports", () => {
        const report: ClassifierPackageExecutionGraphHealthReport = {
            schema: "ax.classifier_package_execution_graph_health_report.v1",
            tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
            query: { mode: "guarded", operation_id: "refresh" },
            operations: [{
                package_key: "demo",
                operation_id: "refresh",
                operation_kind: "review",
                expensive: false,
                run_count: 2,
                executed_count: 1,
                failed_count: 0,
                guarded_count: 1,
                changed_artifact_count: 2,
                evidence_paths: [".ax/experiments/run.json"],
                last_execution: {
                    graph_id: "classifier_execution:.ax/experiments/run.json",
                    decision: "executed",
                    plan_decision: "ready_to_execute",
                    executed: true,
                    started_at: "2026-05-31T00:00:00.000Z",
                    finished_at: "2026-05-31T00:00:01.000Z",
                    duration_ms: 1000,
                    source_path: ".ax/experiments/run.json",
                },
            }],
            guarded_operations: [{
                package_key: "demo",
                operation_id: "refresh",
                operation_kind: "review",
                expensive: false,
                run_count: 2,
                executed_count: 1,
                failed_count: 0,
                guarded_count: 1,
                changed_artifact_count: 2,
                evidence_paths: [".ax/experiments/run.json"],
            }],
            changed_artifacts: [{
                execution_id: "classifier_execution:.ax/experiments/run.json",
                artifact_id: "artifact:.ax/experiments/out.json",
                artifact_path: ".ax/experiments/out.json",
                package_key: "demo",
                operation_id: "refresh",
                evidence_path: ".ax/experiments/run.json",
            }],
            lifecycle_facts: [],
            embedding_helper_facts: [],
            evidence_paths: [".ax/experiments/run.json"],
            totals: {
                node_count: 3,
                edge_count: 2,
                fact_count: 2,
                package_count: 0,
                operation_count: 1,
                execution_count: 1,
                artifact_count: 1,
                execution_fact_count: 1,
                guard_fact_count: 1,
                artifact_fact_count: 1,
                lifecycle_fact_count: 0,
                embedding_helper_fact_count: 0,
                changed_artifact_count: 1,
                evidence_path_count: 1,
            },
            result_totals: {
                operation_count: 1,
                guarded_operation_count: 1,
                changed_artifact_count: 1,
                lifecycle_fact_count: 0,
                embedding_helper_fact_count: 0,
                evidence_path_count: 1,
            },
            decision: "healthy",
        };

        const output = renderClassifierPackageExecutionGraphHealthText(report);

        expect(output).toContain("classifier package execution graph health");
        expect(output).toContain("decision: healthy");
        expect(output).toContain("mode: guarded");
        expect(output).toContain("filter operation: refresh");
        expect(output).toContain("nodes/edges/facts: 3/2/2");
        expect(output).toContain("results operations/guarded/changed/lifecycle/helper/evidence: 1/1/1/0/0/1");
        expect(output).toContain("- demo/refresh");
        expect(output).toContain("runs executed/failed/guarded: 1/0/1");
        expect(output).toContain("changed artifacts:");
        expect(output).toContain(".ax/experiments/out.json");
    });

    test("renders lifecycle graph facts", () => {
        const report: ClassifierPackageExecutionGraphHealthReport = {
            schema: "ax.classifier_package_execution_graph_health_report.v1",
            tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
            query: {
                mode: "lifecycle",
                predicate: "review_pipeline_prepared_argv",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                source_kind: "classifier_package_execution",
                value_contains: "src/cli/index.ts",
                value_equals: "bind_inputs",
            },
            operations: [],
            guarded_operations: [],
            changed_artifacts: [],
            lifecycle_facts: [{
                graph_id: "fact:lifecycle",
                kind: "classifier_lifecycle_status",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                predicate: "review_pipeline_prepared_argv",
                value: ["bun", "src/cli/index.ts"],
                lifecycle_key: "review_pipeline_lifecycle",
                artifact_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                evidence_edges: ["edge:lifecycle"],
                evidence_paths: [".ax/experiments/workflow-candidate-proposal-review-current.json"],
            }],
            lifecycle_value_counts: [{
                predicate: "review_pipeline_prepared_argv",
                value: "[\"bun\",\"src/cli/index.ts\"]",
                count: 1,
            }],
            lifecycle_available_value_counts: [{
                predicate: "review_pipeline_prepared_argv",
                value: "[\"bun\",\"src/cli/index.ts\"]",
                count: 1,
            }],
            embedding_helper_facts: [],
            evidence_paths: [".ax/experiments/workflow-candidate-proposal-review-current.json"],
            query_match_status: "matched",
            query_next_action: "use_query_results",
            query_remediation: "Use the returned graph rows for the requested classifier workflow.",
            query_result_kinds: ["lifecycle_facts"],
            query_result_kind_counts: [{
                kind: "lifecycle_facts",
                count: 1,
            }],
            query_suggested_value_equals: "bind_inputs",
            query_suggested_result_count: 1,
            query_suggested_status: "expected_matches",
            query_suggested_next_action: "run_suggested_query",
            query_suggested_remediation: "Run the suggested graph query to inspect the available classifier lifecycle facts.",
            query_suggestion: {
                value_equals: "bind_inputs",
                result_count: 1,
                changed_filter_count: 0,
                unchanged_filter_count: 1,
                has_changed_filters: false,
                changed_filters: [],
                unchanged_filters: ["value_equals"],
                repair_status: "no_repair_needed",
                repair_next_action: "use_current_query",
                repair_remediation: "Use the current graph query; no filter repair is needed.",
                repair_can_execute: false,
                repair_execution_status: "not_needed",
                repair_command_kind: "none",
                repair_requires_inputs: false,
                repair_required_inputs: [],
                repair_expected_query_match_status: "not_applicable",
                repair_blockers: ["no_repair_needed"],
                repair_blocker_details: [{
                    blocker: "no_repair_needed",
                    remediation: "Use the current graph query; no repair execution is required.",
                }],
                repair_argv: [],
                repair_can_verify: false,
                repair_verification_status: "not_needed",
                repair_verification_next_action: "skip_verification",
                repair_verification_remediation: "Verification is not needed because no repair execution is required.",
                repair_verification_can_execute: false,
                repair_verification_command_kind: "none",
                repair_verification_expected_query_match_status: "not_applicable",
                repair_verification_argv: [],
                status: "expected_matches",
                next_action: "run_suggested_query",
                remediation: "Run the suggested graph query to inspect the available classifier lifecycle facts.",
                source: "lifecycle_available_value_counts",
                reason: "available_value_after_relaxing_value_equals",
                relaxed_filters: ["value_equals"],
                original_query: {
                    mode: "lifecycle",
                    predicate: "review_pipeline_prepared_argv",
                    subject: "classifier_lifecycle:workflow_candidate_proposal",
                    source_kind: "classifier_package_execution",
                    value_contains: "src/cli/index.ts",
                    value_equals: "bind_inputs",
                },
                query: {
                    mode: "lifecycle",
                    predicate: "review_pipeline_prepared_argv",
                    subject: "classifier_lifecycle:workflow_candidate_proposal",
                    source_kind: "classifier_package_execution",
                    value_contains: "src/cli/index.ts",
                    value_equals: "bind_inputs",
                },
                filter_changes: [{
                    filter: "value_equals",
                    from: "bind_inputs",
                    to: "bind_inputs",
                    status: "unchanged",
                }],
                argv: [
                    "bun",
                    "src/cli/index.ts",
                    "classifiers",
                    "graph",
                    "--mode",
                    "lifecycle",
                    "--predicate",
                    "review_pipeline_prepared_argv",
                    "--subject",
                    "classifier_lifecycle:workflow_candidate_proposal",
                    "--source-kind",
                    "classifier_package_execution",
                    "--value-contains",
                    "src/cli/index.ts",
                    "--value",
                    "bind_inputs",
                ],
            },
            query_suggested_argv: [
                "bun",
                "src/cli/index.ts",
                "classifiers",
                "graph",
                "--mode",
                "lifecycle",
                "--predicate",
                "review_pipeline_prepared_argv",
                "--subject",
                "classifier_lifecycle:workflow_candidate_proposal",
                "--source-kind",
                "classifier_package_execution",
                "--value-contains",
                "src/cli/index.ts",
                "--value",
                "bind_inputs",
            ],
            query_suggested_query: {
                mode: "lifecycle",
                predicate: "review_pipeline_prepared_argv",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                source_kind: "classifier_package_execution",
                value_contains: "src/cli/index.ts",
                value_equals: "bind_inputs",
            },
            totals: {
                node_count: 2,
                edge_count: 1,
                fact_count: 1,
                package_count: 0,
                operation_count: 0,
                execution_count: 0,
                artifact_count: 1,
                execution_fact_count: 0,
                guard_fact_count: 0,
                artifact_fact_count: 0,
                lifecycle_fact_count: 1,
                embedding_helper_fact_count: 0,
                changed_artifact_count: 0,
                evidence_path_count: 1,
            },
            result_totals: {
                operation_count: 0,
                guarded_operation_count: 0,
                changed_artifact_count: 0,
                lifecycle_fact_count: 1,
                embedding_helper_fact_count: 0,
                evidence_path_count: 1,
            },
            decision: "healthy",
        };

        const output = renderClassifierPackageExecutionGraphHealthText(report);

        expect(output).toContain("mode: lifecycle");
        expect(output).toContain("filter subject: classifier_lifecycle:workflow_candidate_proposal");
        expect(output).toContain("filter predicate: review_pipeline_prepared_argv");
        expect(output).toContain("filter source kind: classifier_package_execution");
        expect(output).toContain("filter value contains: src/cli/index.ts");
        expect(output).toContain("filter value equals: bind_inputs");
        expect(output).toContain("query match: matched");
        expect(output).toContain("query next action: use_query_results");
        expect(output).toContain("query remediation: Use the returned graph rows for the requested classifier workflow.");
        expect(output).toContain("query result kinds: lifecycle_facts");
        expect(output).toContain("query result kind counts: lifecycle_facts=1");
        expect(output).toContain("query suggested value equals: bind_inputs");
        expect(output).toContain("query suggested result count: 1");
        expect(output).toContain("query suggested status: expected_matches");
        expect(output).toContain("query suggested next action: run_suggested_query");
        expect(output).toContain("query suggested remediation: Run the suggested graph query to inspect the available classifier lifecycle facts.");
        expect(output).toContain("query suggestion: status=expected_matches next_action=run_suggested_query result_count=1 value_equals=bind_inputs");
        expect(output).toContain("query suggestion filter counts: changed=0 unchanged=1");
        expect(output).toContain("query suggestion has changed filters: false");
        expect(output).toContain("query suggestion changed filters: none");
        expect(output).toContain("query suggestion unchanged filters: value_equals");
        expect(output).toContain("query suggestion repair status: no_repair_needed");
        expect(output).toContain("query suggestion repair next action: use_current_query");
        expect(output).toContain("query suggestion repair remediation: Use the current graph query; no filter repair is needed.");
        expect(output).toContain("query suggestion repair can execute: false");
        expect(output).toContain("query suggestion repair execution status: not_needed");
        expect(output).toContain("query suggestion repair command kind: none");
        expect(output).toContain("query suggestion repair requires inputs: false");
        expect(output).toContain("query suggestion repair required inputs: none");
        expect(output).toContain("query suggestion repair expected query match: not_applicable");
        expect(output).toContain("query suggestion repair expected result count: none");
        expect(output).toContain("query suggestion repair blockers: no_repair_needed");
        expect(output).toContain("query suggestion repair blocker details: no_repair_needed: Use the current graph query; no repair execution is required.");
        expect(output).toContain("query suggestion repair argv: none");
        expect(output).toContain("query suggestion repair can verify: false");
        expect(output).toContain("query suggestion repair verification status: not_needed");
        expect(output).toContain("query suggestion repair verification next action: skip_verification");
        expect(output).toContain("query suggestion repair verification remediation: Verification is not needed because no repair execution is required.");
        expect(output).toContain("query suggestion repair verification can execute: false");
        expect(output).toContain("query suggestion repair verification command kind: none");
        expect(output).toContain("query suggestion repair verification expected query match: not_applicable");
        expect(output).toContain("query suggestion repair verification expected result count: none");
        expect(output).toContain("query suggestion repair verification argv: none");
        expect(output).toContain("query suggestion repair verification query: none");
        expect(output).toContain("query suggestion repair query: none");
        expect(output).toContain("query suggestion provenance: source=lifecycle_available_value_counts reason=available_value_after_relaxing_value_equals");
        expect(output).toContain("query suggestion relaxed filters: value_equals");
        expect(output).toContain("query suggestion original query: mode=lifecycle predicate=review_pipeline_prepared_argv subject=classifier_lifecycle:workflow_candidate_proposal source_kind=classifier_package_execution value_contains=src/cli/index.ts value_equals=bind_inputs");
        expect(output).toContain("query suggestion filter changes: value_equals:bind_inputs->bind_inputs (unchanged)");
        expect(output).toContain("query suggested argv: bun src/cli/index.ts classifiers graph --mode lifecycle --predicate review_pipeline_prepared_argv --subject classifier_lifecycle:workflow_candidate_proposal --source-kind classifier_package_execution --value-contains src/cli/index.ts --value bind_inputs");
        expect(output).toContain("query suggested query: mode=lifecycle predicate=review_pipeline_prepared_argv subject=classifier_lifecycle:workflow_candidate_proposal source_kind=classifier_package_execution value_contains=src/cli/index.ts value_equals=bind_inputs");
        expect(output).toContain("execution/guard/artifact/lifecycle/helper facts: 0/0/0/1/0");
        expect(output).toContain("lifecycle facts:");
        expect(output).toContain("- review_pipeline_prepared_argv: [\"bun\",\"src/cli/index.ts\"]");
        expect(output).toContain("source: review_pipeline_lifecycle .ax/experiments/workflow-candidate-proposal-review-current.json");
        expect(output).toContain("lifecycle value counts:");
        expect(output).toContain("- review_pipeline_prepared_argv=[\"bun\",\"src/cli/index.ts\"] count=1");
        expect(output).toContain("lifecycle available value counts:");
        expect(output).toContain("- review_pipeline_prepared_argv=[\"bun\",\"src/cli/index.ts\"] count=1");
    });

    test("renders embedding helper graph facts", () => {
        const report: ClassifierPackageExecutionGraphHealthReport = {
            schema: "ax.classifier_package_execution_graph_health_report.v1",
            tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_hard_negative_candidate",
                status: "accepted",
                source_fixture_id: "session-section-chunks/none-start-building",
                proposed_label: "none",
                threshold: "none",
                min_seed_count: 2,
                min_positive_recall: 0.9,
                min_call_reduction: 0.25,
                min_nearest_similarity: 0.85,
                nearest_fixture_id: "session-section-chunks/approval-alright-go",
            },
            operations: [],
            guarded_operations: [],
            changed_artifacts: [],
            lifecycle_facts: [],
            embedding_helper_facts: [{
                graph_id: "fact:routing",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value: { threshold: "none" },
                threshold: "none",
                setfit_call_reduction_rate_mean: 0.1778,
                positive_recall_after_routing_mean: 0.9028,
                evidence_edges: ["edge:routing"],
                evidence_paths: [".ax/experiments/embedding-helper-review-e210.json"],
            }, {
                graph_id: "fact:hard-negative",
                kind: "embedding_helper_hard_negative_candidate",
                subject: "embedding_helper_hard_negative:session-section-chunks/none-start-building",
                predicate: "promoted_hard_negative_fixture",
                value: true,
                status: "accepted",
                source_fixture_id: "session-section-chunks/none-start-building",
                promoted_fixture_id: "session-section-chunks/embedding-helper-hard-negative-none-start-building",
                proposed_label: "none",
                seed_count: 2,
                max_nearest_positive_similarity: 0.8743,
                nearest_neighbors: [{ fixture_id: "session-section-chunks/approval-alright-go", similarity: 0.8565 }],
                evidence_edges: ["edge:hn"],
                evidence_paths: [".ax/experiments/embedding-helper-review-e210.json"],
            }],
            routing_policy_summary: {
                status: "meets_requested_floors",
                next_action: "choose_reviewed_routing_threshold",
                remediation: "Use the selected reviewed threshold as an advisory routing policy.",
                requested_min_positive_recall: 0.9,
                requested_min_call_reduction: 0.25,
                evaluated_policy_count: 1,
                candidate_count: 1,
                best_threshold_by_call_reduction: "none",
                best_positive_recall: 0.9028,
                best_call_reduction: 0.1778,
                best_available_threshold_by_recall: "none",
                best_available_positive_recall: 0.9028,
                best_available_call_reduction: 0.1778,
                positive_recall_gap_to_request: 0,
                call_reduction_gap_to_request: 0.0722,
                blocking_floor_fields: ["call_reduction"],
                largest_gap_floor: "call_reduction",
                recommended_floor_adjustments: [{
                    floor: "call_reduction",
                    requested: 0.25,
                    recommended: 0.1778,
                    gap: 0.0722,
                    source_threshold: "none",
                }],
                recommended_floor_query: {
                    mode: "embedding-helper",
                    fact_kind: "embedding_helper_hard_negative_candidate",
                    status: "accepted",
                    source_fixture_id: "session-section-chunks/none-start-building",
                    proposed_label: "none",
                    threshold: "none",
                    min_seed_count: 2,
                    min_positive_recall: 0.9,
                    min_call_reduction: 0.1778,
                    min_nearest_similarity: 0.85,
                    nearest_fixture_id: "session-section-chunks/approval-alright-go",
                },
                recommended_floor_argv: [
                    "bun",
                    "src/cli/index.ts",
                    "classifiers",
                    "graph",
                    "--mode",
                    "embedding-helper",
                    "--fact-kind",
                    "embedding_helper_hard_negative_candidate",
                    "--status",
                    "accepted",
                    "--source-fixture",
                    "session-section-chunks/none-start-building",
                    "--proposed-label",
                    "none",
                    "--threshold",
                    "none",
                    "--min-seed-count",
                    "2",
                    "--min-positive-recall",
                    "0.9",
                    "--min-call-reduction",
                    "0.1778",
                    "--min-nearest-similarity",
                    "0.85",
                    "--nearest-fixture",
                    "session-section-chunks/approval-alright-go",
                ],
                recommended_floor_status: "expected_matches",
                recommended_floor_candidate_count: 1,
                recommended_floor_best_threshold_by_call_reduction: "none",
                recommended_floor_best_positive_recall: 0.9028,
                recommended_floor_best_call_reduction: 0.1778,
                recommended_floor_next_action: "choose_recommended_routing_threshold",
            },
            evidence_paths: [".ax/experiments/embedding-helper-review-e210.json"],
            totals: {
                node_count: 75,
                edge_count: 110,
                fact_count: 17,
                package_count: 1,
                operation_count: 0,
                execution_count: 0,
                artifact_count: 1,
                execution_fact_count: 0,
                guard_fact_count: 0,
                artifact_fact_count: 0,
                lifecycle_fact_count: 0,
                embedding_helper_fact_count: 17,
                changed_artifact_count: 0,
                evidence_path_count: 1,
            },
            result_totals: {
                operation_count: 0,
                guarded_operation_count: 0,
                changed_artifact_count: 0,
                lifecycle_fact_count: 0,
                embedding_helper_fact_count: 2,
                evidence_path_count: 1,
            },
            decision: "healthy",
        };

        const output = renderClassifierPackageExecutionGraphHealthText(report);

        expect(output).toContain("mode: embedding-helper");
        expect(output).toContain("filter fact kind: embedding_helper_hard_negative_candidate");
        expect(output).toContain("filter status: accepted");
        expect(output).toContain("filter source fixture: session-section-chunks/none-start-building");
        expect(output).toContain("filter proposed label: none");
        expect(output).toContain("filter threshold: none");
        expect(output).toContain("filter min seed count: 2");
        expect(output).toContain("filter min positive recall: 0.9");
        expect(output).toContain("filter min call reduction: 0.25");
        expect(output).toContain("filter min nearest similarity: 0.85");
        expect(output).toContain("filter nearest fixture: session-section-chunks/approval-alright-go");
        expect(output).toContain("routing policy status: meets_requested_floors");
        expect(output).toContain("routing policy candidates: 1");
        expect(output).toContain("routing policy evaluated: 1");
        expect(output).toContain("routing policy best threshold: none");
        expect(output).toContain("routing policy best positive recall: 0.9028");
        expect(output).toContain("routing policy best call reduction: 0.1778");
        expect(output).toContain("routing policy best available threshold: none");
        expect(output).toContain("routing policy best available positive recall: 0.9028");
        expect(output).toContain("routing policy best available call reduction: 0.1778");
        expect(output).toContain("routing policy positive recall gap: 0");
        expect(output).toContain("routing policy call reduction gap: 0.0722");
        expect(output).toContain("routing policy blocking floors: call_reduction");
        expect(output).toContain("routing policy largest gap: call_reduction");
        expect(output).toContain("routing policy recommended floor adjustments: call_reduction<=0.1778 (requested 0.25, gap 0.0722, threshold none)");
        expect(output).toContain("routing policy recommended floor query: mode=embedding-helper fact_kind=embedding_helper_hard_negative_candidate status=accepted source_fixture_id=session-section-chunks/none-start-building proposed_label=none threshold=none min_seed_count=2 min_positive_recall=0.9 min_call_reduction=0.1778 min_nearest_similarity=0.85 nearest_fixture_id=session-section-chunks/approval-alright-go");
        expect(output).toContain("routing policy recommended floor argv: bun src/cli/index.ts classifiers graph --mode embedding-helper --fact-kind embedding_helper_hard_negative_candidate --status accepted --source-fixture session-section-chunks/none-start-building --proposed-label none --threshold none --min-seed-count 2 --min-positive-recall 0.9 --min-call-reduction 0.1778 --min-nearest-similarity 0.85 --nearest-fixture session-section-chunks/approval-alright-go");
        expect(output).toContain("routing policy recommended floor status: expected_matches");
        expect(output).toContain("routing policy recommended floor candidates: 1");
        expect(output).toContain("routing policy recommended floor best threshold: none");
        expect(output).toContain("routing policy recommended floor best positive recall: 0.9028");
        expect(output).toContain("routing policy recommended floor best call reduction: 0.1778");
        expect(output).toContain("routing policy recommended floor next action: choose_recommended_routing_threshold");
        expect(output).toContain("routing policy next action: choose_reviewed_routing_threshold");
        expect(output).toContain("routing policy remediation: Use the selected reviewed threshold as an advisory routing policy.");
        expect(output).toContain("embedding helper facts:");
        expect(output).toContain("- routing recommended_threshold: threshold=none positive_recall=0.9028 call_reduction=0.1778");
        expect(output).toContain("- hard-negative session-section-chunks/none-start-building: promoted_hard_negative_fixture status=accepted proposed=none seeds=2 nearest=0.8743 promoted=session-section-chunks/embedding-helper-hard-negative-none-start-building");
        expect(output).toContain("nearest: session-section-chunks/approval-alright-go sim=0.8565");
    });

    test("renders classifier lifecycle insight reports", () => {
        const report: ClassifierLifecycleInsightReport = {
            schema: "ax.classifier_lifecycle_insight_report.v1",
            packages_root: "packages",
            graph_tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
            workflow_status: {
                path: ".ax/experiments/blind-workflow-status-current.json",
                exists: true,
                decision: "needs_human_review",
                pending_blind_labels: 40,
                pending_hard_negatives: 20,
                accepted_hard_negatives: 0,
                review_pipeline_lifecycle: {
                    report_path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
                    lifecycle_status: "verified_after_execution",
                    command_kind: "stamp_review_provenance",
                    prepared_status: "ready_to_execute",
                    output_verification_status: "verified",
                    can_execute: true,
                    can_continue: true,
                    missing_required_artifact_count: 0,
                    checked_artifact_count: 2,
                    prepared_argv: ["bun", "src/cli/index.ts", "classifiers", "workflow-candidates"],
                    output_artifacts: [{
                        kind: "review_brief",
                        path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md",
                        required_for_handoff: true,
                    }],
                    checked_artifacts: [{
                        kind: "review_brief",
                        path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md",
                        exists: true,
                    }],
                    failures: [],
                },
                    focused_batch: {
                        batch_path: ".ax/experiments/blind-review-batch-current.md",
                        batch_source: "existing_reviewed_batch",
                        selected_ordinals: [1, 2, 3, 4, 5],
                    context_enriched_sections: 5,
                    vocabulary_included: true,
                    allowed_label_count: 5,
                    allowed_target_count: 10,
                    allowed_hard_negative_status_count: 3,
                    review_pending: 5,
                    hard_negative_pending: 3,
                    missing_field_total: 15,
                    invalid_field_total: 1,
                    blocking_field_total: 16,
                    completed_field_total: 5,
                    review_field_total: 21,
                    field_completion_percent: 23.8,
                    row_completion_percent: 12.5,
                    missing_field_counts: { review_label: 5, review_target: 5, review_notes: 5 },
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
                    review_task_total: 1,
                    review_tasks: [{
                        ordinal: 1,
                        id: "blind-row-1",
                        missing: ["review_label"],
                        invalid: ["review_notes"],
                        blocking_field_count: 2,
                        suggested_label: "environment_or_preference_signal",
                        suggested_target: "workflow_state",
                        confidence_bucket: "medium",
                        risk_reasons: ["possible_none_control_turn"],
                        hard_negative_candidate_id: "pending-hard-negative/blind-row-1",
                        hard_negative_proposed_label: "none",
                        hard_negative_proposed_target: "none",
                        hard_negative_review_instruction: "Accept only if ordinary control.",
                        source_turn: "turn:1",
                        source_session: "session:1",
                        source_seq: "7",
                        evidence_refs: ["turn:0", "tool_call:1"],
                    }],
                    suggestion_draft: {
                        path: ".ax/experiments/blind-review-batch-current-suggestion-draft.md",
                        report_path: ".ax/experiments/blind-review-batch-current-suggestion-draft-report.json",
                        eval_report_path: ".ax/experiments/blind-review-batch-current-suggestion-draft-eval-report.json",
                        decision: "draft_ready_for_human_notes",
                        after_decision: "needs_batch_review",
                        prefilled_review_label: 5,
                        prefilled_review_target: 5,
                        prefilled_hard_negative_status: 3,
                        review_note_prompts: 5,
                        hard_negative_note_prompts: 3,
                        before_blocking_field_total: 21,
                        after_blocking_field_total: 8,
                        before_field_completion_percent: 0,
                        after_field_completion_percent: 61.9,
                        after_missing_field_counts: { review_notes: 5, hard_negative_notes: 3 },
                        eval_decision: "needs_batch_review",
                        eval_blocking_field_total: 8,
                    },
                    draft_promotion: {
                        report_path: ".ax/experiments/blind-review-batch-current-promotion-report.json",
                        decision: "needs_human_notes",
                        draft_eval_decision: "needs_batch_review",
                        blocking_field_total: 8,
                        missing_field_counts: { review_notes: 5, hard_negative_notes: 3 },
                        invalid_field_counts: {},
                        failures: ["draft batch review is incomplete"],
                    },
                },
                next_actions: [
                    "edit suggestion draft notes in .ax/experiments/blind-review-batch-current-suggestion-draft.md then run bun run classifiers:blind-review-batch -- --mode=promote-draft --batch=.ax/experiments/blind-review-batch-current-suggestion-draft.md --out=.ax/experiments/blind-review-batch-current.md --summary=.ax/experiments/blind-review-batch-current-promotion-report.json --json",
                    "edit E63 consolidated review workspace",
                ],
            },
            packages: [{
                package_key: "session-section-chunks",
                package_name: "@ax-classifier/session-sections",
                kind: "local_model",
                lifecycle_readiness: {
                    status: "ready",
                    required_kinds: ["train", "eval", "review", "status"],
                    present_required_kinds: ["train", "eval", "review", "status"],
                    missing_required_kinds: [],
                },
                operation_count: 10,
                operation_kinds: { train: 1, eval: 2, review: 2, status: 4, publish: 0, debug: 1 },
                graph_operation_count: 3,
                guarded_operation_count: 2,
                failed_operation_count: 1,
                changed_artifact_count: 6,
            }],
            guarded_operations: [],
            failed_operations: [{
                package_key: "session-section-chunks",
                operation_id: "focused-batch-eval",
                operation_kind: "review",
                expensive: false,
                run_count: 1,
                executed_count: 1,
                failed_count: 1,
                guarded_count: 0,
                changed_artifact_count: 1,
                evidence_paths: [".ax/experiments/classifier-package-execution-e118-focused-batch-eval.json"],
            }],
            changed_artifacts: [],
            blocking_items: ["40 blind labels pending"],
            review_pipeline: {
                report_path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
                status: "verified_after_execution",
                command_kind: "stamp_review_provenance",
                prepared_status: "ready_to_execute",
                output_verification_status: "verified",
                can_execute: true,
                can_continue: true,
                missing_required_artifact_count: 0,
                checked_artifact_count: 2,
                prepared_argv: ["bun", "src/cli/index.ts", "classifiers", "workflow-candidates"],
                production_apply_argv: ["bun", "src/cli/index.ts", "--apply-review-facts"],
                review_provenance_stamp_argv: ["bun", "src/cli/index.ts", "--review-provenance-reviewer=<reviewer>"],
                review_issue_repair_argv: ["bun", "src/cli/index.ts", "--coverage-review-brief=review.md"],
                recommended_action_kind: "stamp_review_provenance",
                recommended_action_argv: ["bun", "src/cli/index.ts", "--review-provenance-reviewer=<reviewer>"],
                recommended_action_status: "requires_inputs",
                recommended_action_can_execute: false,
                recommended_action_execution_phase: "bind_inputs",
                recommended_action_execution_summary: "kind=stamp_review_provenance phase=bind_inputs status=requires_inputs can_execute=false missing_inputs=2 output_artifacts=1 output_checks=1",
                recommended_action_next_action: "Bind required pipeline inputs before executing the command.",
                recommended_action_missing_inputs: ["reviewer", "reviewed_at"],
                recommended_action_input_bindings: [
                    "reviewer flag=--review-provenance-reviewer index=8 prefix=--review-provenance-reviewer= placeholder=<reviewer> value_kind=nonempty_string",
                    "reviewed_at flag=--review-provenance-reviewed-at index=9 prefix=--review-provenance-reviewed-at= placeholder=<reviewed-at-iso> value_kind=iso_datetime",
                ],
                recommended_action_output_artifacts: [
                    "review_brief path=.ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md flag=--coverage-review-brief index=10 prefix=--coverage-review-brief= required_for_handoff=true",
                ],
                recommended_action_output_checks: [
                    "review_brief path=.ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md index=10 check=file_exists_after_execution status=pending_execution required_for_command_success=true",
                ],
                output_artifacts: [{
                    kind: "review_brief",
                    path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md",
                    required_for_handoff: true,
                }],
                checked_artifacts: [{
                    kind: "review_brief",
                    path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md",
                    exists: true,
                }],
                failures: [],
                next_action: "continue_review_pipeline",
            },
            totals: {
                package_count: 1,
                local_model_count: 1,
                local_model_ready_count: 1,
                local_model_incomplete_count: 0,
                graph_operation_count: 3,
                guarded_operation_count: 2,
                failed_operation_count: 1,
                changed_artifact_count: 6,
                pending_blind_labels: 40,
                pending_hard_negatives: 20,
            },
            decision: "needs_human_review",
        };

        const output = renderClassifierLifecycleInsightText(report);

        expect(output).toContain("classifier lifecycle");
        expect(output).toContain("decision: needs_human_review");
        expect(output).toContain("- session-section-chunks (local_model)");
        expect(output).toContain("review pending labels/hard-negatives: 40/20");
        expect(output).toContain("graph operations/guarded/failed/changed: 3/2/1/6");
        expect(output).toContain("failed operations:");
        expect(output).toContain("- session-section-chunks/focused-batch-eval: 1");
        expect(output).toContain("focused batch: .ax/experiments/blind-review-batch-current.md");
        expect(output).toContain("batch source: existing_reviewed_batch");
        expect(output).toContain("context enriched sections: 5");
        expect(output).toContain("vocabulary included: yes");
        expect(output).toContain("field completion: 5/21 (23.8%)");
        expect(output).toContain("row completion: 12.5%");
        expect(output).toContain("blocking fields: 16");
        expect(output).toContain("missing fields: review_label=5, review_target=5, review_notes=5");
        expect(output).toContain("invalid fields: review_notes=1");
        expect(output).toContain("invalid refs:");
        expect(output).toContain("#1 blind-row-1 invalid review_notes");
        expect(output).toContain("#1 blind-row-1 missing review_label; invalid review_notes");
        expect(output).toContain("review tasks: 1");
        expect(output).toContain("#1 blind-row-1 suggested environment_or_preference_signal/workflow_state; missing review_label; invalid review_notes; hard-negative none/none");
        expect(output).toContain("evidence: turn:0, tool_call:1");
        expect(output).toContain("suggestion draft: draft_ready_for_human_notes (.ax/experiments/blind-review-batch-current-suggestion-draft.md)");
        expect(output).toContain("blocking fields: 21->8");
        expect(output).toContain("field completion: 0%->61.9%");
        expect(output).toContain("prefilled labels/targets/hard-negatives: 5/5/3");
        expect(output).toContain("note prompts review/hard-negative: 5/3");
        expect(output).toContain("remaining missing: review_notes=5, hard_negative_notes=3");
        expect(output).toContain("draft promotion: needs_human_notes (.ax/experiments/blind-review-batch-current-promotion-report.json)");
        expect(output).toContain("failures: draft batch review is incomplete");
        expect(output).toContain("review pipeline: verified_after_execution (.ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json)");
        expect(output).toContain("command: stamp_review_provenance prepared=ready_to_execute");
        expect(output).toContain("argv: bun src/cli/index.ts classifiers workflow-candidates");
        expect(output).toContain("production apply argv: bun src/cli/index.ts --apply-review-facts");
        expect(output).toContain("provenance stamp argv: bun src/cli/index.ts --review-provenance-reviewer=<reviewer>");
        expect(output).toContain("issue repair argv: bun src/cli/index.ts --coverage-review-brief=review.md");
        expect(output).toContain("recommended action: stamp_review_provenance");
        expect(output).toContain("recommended action argv: bun src/cli/index.ts --review-provenance-reviewer=<reviewer>");
        expect(output).toContain("recommended action status: requires_inputs");
        expect(output).toContain("recommended action can execute: no");
        expect(output).toContain("recommended action phase: bind_inputs");
        expect(output).toContain("recommended action summary: kind=stamp_review_provenance phase=bind_inputs status=requires_inputs can_execute=false missing_inputs=2 output_artifacts=1 output_checks=1");
        expect(output).toContain("recommended action next: Bind required pipeline inputs before executing the command.");
        expect(output).toContain("recommended action missing inputs: reviewer, reviewed_at");
        expect(output).toContain("recommended action input bindings: reviewer flag=--review-provenance-reviewer index=8 prefix=--review-provenance-reviewer= placeholder=<reviewer> value_kind=nonempty_string; reviewed_at flag=--review-provenance-reviewed-at index=9 prefix=--review-provenance-reviewed-at= placeholder=<reviewed-at-iso> value_kind=iso_datetime");
        expect(output).toContain("recommended action output artifacts: review_brief path=.ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md flag=--coverage-review-brief index=10 prefix=--coverage-review-brief= required_for_handoff=true");
        expect(output).toContain("recommended action output checks: review_brief path=.ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md index=10 check=file_exists_after_execution status=pending_execution required_for_command_success=true");
        expect(output).toContain("outputs: verified checked=2 missing=0");
        expect(output).toContain("output artifacts: review_brief=.ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md");
        expect(output).toContain("checked artifacts: review_brief=.ax/experiments/workflow-candidate-review-pipeline-lifecycle-cli-e331.md ok");
        expect(output).toContain("execute/continue: yes/yes next=continue_review_pipeline");
        expect(output).toContain("blocking items:");
        expect(output).toContain("edit suggestion draft notes in .ax/experiments/blind-review-batch-current-suggestion-draft.md then run bun run classifiers:blind-review-batch -- --mode=promote-draft");
    });

    test("renders multi-package summaries", () => {
        const report: ClassifierPackagesOperationsReport = {
            schema: "ax.classifier_packages_operations_report.v1",
            root: "packages",
            manifests: ["packages/demo/ax.classifier.json"],
            packages: [{
                manifest: "packages/demo/ax.classifier.json",
                package_key: "demo",
                package_name: "@ax-classifier/demo",
                version: "0.1.0",
                kind: "local_model",
                input: "event_window",
                label_count: 2,
                target_count: 1,
                fixture_count: 1,
                asset_count: 1,
                operation_count: 1,
                operation_kinds: {
                    train: 0,
                    eval: 1,
                    review: 0,
                    status: 0,
                    publish: 0,
                    debug: 0,
                },
                lifecycle_readiness: {
                    status: "incomplete",
                    required_kinds: ["train", "eval", "review", "status"],
                    present_required_kinds: ["eval"],
                    missing_required_kinds: ["train", "review", "status"],
                },
                operations: [{
                    id: "eval",
                    kind: "eval",
                    description: "Evaluate demo.",
                    command: "bun run demo:eval",
                }],
            }],
            totals: {
                package_count: 1,
                operation_count: 1,
                operation_kinds: {
                    train: 0,
                    eval: 1,
                    review: 0,
                    status: 0,
                    publish: 0,
                    debug: 0,
                },
                local_model_count: 1,
                local_model_ready_count: 0,
                local_model_incomplete_count: 1,
                package_count_with_operations: 1,
                package_count_without_operations: 0,
            },
        };

        const output = renderClassifierPackagesOperationsText(report);

        expect(output).toContain("classifier packages: 1");
        expect(output).toContain("- demo (@ax-classifier/demo)");
        expect(output).toContain("lifecycle: incomplete missing train, review, status");
        expect(output).toContain("operation kinds: eval=1");
        expect(output).toContain("operations: eval");
    });
});
