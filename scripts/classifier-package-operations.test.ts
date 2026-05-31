import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClassifierPackageManifest } from "../src/classifiers/package-manifest.ts";
import {
    buildOperationExecutionPlanReport,
    buildOperationDryRunReport,
    buildOperationPreflightReport,
    buildExecutionHistoryReport,
    buildExecutionFactProjectionReport,
    buildExecutionGraphHealthReport,
    buildExecutionSurrealWritePlanReport,
    applyExecutionSurrealWritePlanReport,
    buildClassifierLifecycleInsightReport,
    buildPackagesOperationsReport,
    buildOperationsReport,
    discoverClassifierPackageExecutionReportPaths,
    discoverClassifierPackageManifestPaths,
    executeOperationPlanReport,
    loadClassifierLifecycleReviewStatus,
    summarizeClassifierPackageOperations,
    writeOperationPreflightReport,
    writeOperationDryRunReport,
    writeOperationExecutionReport,
    writeOperationExecutionPlanReport,
    writeExecutionHistoryReport,
    writeExecutionFactProjectionReport,
    writeExecutionSurrealWritePlanReport,
    writeExecutionSurrealApplyReport,
    writeExecutionGraphHealthReport,
    writeClassifierLifecycleInsightReport,
    writeOperationsReport,
    writePackagesOperationsReport,
} from "../src/classifiers/package-operations.ts";

describe("classifier package operations report", () => {
    test("lists operations from the session-section manifest", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationsReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json");

        expect(report.decision).toBe("operations_listed");
        expect(report.operations.map((operation) => operation.id)).toContain("blind-review-refresh");
        expect(report.failures).toEqual([]);
    });

    test("selects one operation by id", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationsReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "blind-review-refresh");

        expect(report.decision).toBe("operation_found");
        expect(report.operations).toHaveLength(1);
        expect(report.operations[0]?.command).toBe("bun run classifiers:blind-review-refresh");
    });

    test("reports missing operations without throwing", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-verification-event/ax.classifier.json");

        const report = buildOperationsReport(manifest, "packages/ax-classifier-verification-event/ax.classifier.json", "missing");

        expect(report.decision).toBe("operation_missing");
        expect(report.operations).toEqual([]);
        expect(report.failures).toEqual(["classifier package verification-event does not declare operation: missing"]);
    });

    test("preflights selected operation inputs", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationPreflightReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval");

        expect(report.decision).toBe("ready");
        expect(report.operation?.kind).toBe("train");
        expect(report.inputs).toEqual([{
            path: "packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl",
            exists: true,
        }]);
        expect(report.missing_inputs).toEqual([]);
    });

    test("preflight reports missing declared inputs", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const testManifest = {
            ...manifest,
            operations: [
                ...(manifest.operations ?? []),
                {
                    id: "missing-input-demo",
                    kind: "debug" as const,
                    description: "Operation with a deliberately missing input.",
                    command: "echo missing",
                    inputs: [".ax/experiments/does-not-exist-for-preflight-test.json"],
                },
            ],
        };

        const report = buildOperationPreflightReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "missing-input-demo");

        expect(report.decision).toBe("missing_inputs");
        expect(report.missing_inputs).toContain(".ax/experiments/does-not-exist-for-preflight-test.json");
        expect(report.failures).toContain("missing input: .ax/experiments/does-not-exist-for-preflight-test.json");
    });

    test("preflight reports missing selected operations", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationPreflightReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "missing");

        expect(report.decision).toBe("operation_missing");
        expect(report.failures).toEqual(["classifier package session-section-chunks does not declare operation: missing"]);
    });

    test("builds dry-run operation reports without executing", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationDryRunReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval");

        expect(report.schema).toBe("ax.classifier_package_operation_dry_run_report.v1");
        expect(report.decision).toBe("ready_to_run");
        expect(report.would_execute).toBe(false);
        expect(report.command).toContain("bun run classifiers:setfit-eval");
        expect(report.preflight.decision).toBe("ready");
    });

    test("dry-run reports blocked operations when preflight fails", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const testManifest = {
            ...manifest,
            operations: [
                ...(manifest.operations ?? []),
                {
                    id: "blocked-demo",
                    kind: "debug" as const,
                    description: "Blocked dry-run demo.",
                    command: "echo blocked",
                    inputs: [".ax/experiments/does-not-exist-for-dry-run-test.json"],
                },
            ],
        };

        const report = buildOperationDryRunReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "blocked-demo");

        expect(report.decision).toBe("blocked");
        expect(report.would_execute).toBe(false);
        expect(report.preflight.missing_inputs).toContain(".ax/experiments/does-not-exist-for-dry-run-test.json");
    });

    test("execution plan denies execution by default", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationExecutionPlanReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval", {
            allowExecute: false,
            allowExpensive: false,
        });

        expect(report.decision).toBe("denied_requires_execute");
        expect(report.would_execute).toBe(false);
        expect(report.failures).toContain("execution requires --execute");
    });

    test("execution plan blocks expensive operations without explicit allowance", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationExecutionPlanReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval", {
            allowExecute: true,
            allowExpensive: false,
        });

        expect(report.decision).toBe("denied_expensive");
        expect(report.would_execute).toBe(false);
        expect(report.expensive).toBe(true);
        expect(report.failures).toContain("operation kind train requires --allow-expensive");
    });

    test("execution plan marks explicitly allowed operation ready", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const report = buildOperationExecutionPlanReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval", {
            allowExecute: true,
            allowExpensive: true,
        });

        expect(report.decision).toBe("ready_to_execute");
        expect(report.would_execute).toBe(true);
        expect(report.dry_run.preflight.decision).toBe("ready");
    });

    test("executes ready operation plans and captures output", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const outPath = join(mkdtempSync(join(tmpdir(), "ax-exec-output-")), "output.txt");
        const testManifest = {
            ...manifest,
            operations: [{
                id: "print-demo",
                kind: "debug" as const,
                description: "Print a deterministic execution marker.",
                command: `node -e "require('fs').writeFileSync('${outPath}', 'artifact'); process.stdout.write('ax-exec-ok')"`,
                outputs: [outPath],
            }],
        };
        const plan = buildOperationExecutionPlanReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "print-demo", {
            allowExecute: true,
            allowExpensive: false,
        });

        const report = await executeOperationPlanReport(plan);

        expect(report.schema).toBe("ax.classifier_package_operation_execution_report.v1");
        expect(report.decision).toBe("executed");
        expect(report.executed).toBe(true);
        expect(report.exit_code).toBe(0);
        expect(report.stdout).toBe("ax-exec-ok");
        expect(report.outputs).toEqual([{ path: outPath, exists: true }]);
        expect(report.missing_outputs).toEqual([]);
        expect(report.outputs_before).toEqual([{ path: outPath, exists: false }]);
        expect(report.output_changes).toHaveLength(1);
        expect(report.output_changes[0]?.changed_during_run).toBe(true);
        expect(report.output_changes[0]?.after.exists).toBe(true);
    });

    test("marks execution failed when declared outputs are missing", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const missingOutPath = join(mkdtempSync(join(tmpdir(), "ax-missing-output-")), "missing.txt");
        const testManifest = {
            ...manifest,
            operations: [{
                id: "missing-output-demo",
                kind: "debug" as const,
                description: "Exit zero without writing declared output.",
                command: "node -e \"process.stdout.write('no-output')\"",
                outputs: [missingOutPath],
            }],
        };
        const plan = buildOperationExecutionPlanReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "missing-output-demo", {
            allowExecute: true,
            allowExpensive: false,
        });

        const report = await executeOperationPlanReport(plan);

        expect(report.decision).toBe("failed");
        expect(report.executed).toBe(true);
        expect(report.exit_code).toBe(0);
        expect(report.missing_outputs).toEqual([missingOutPath]);
        expect(report.output_changes[0]?.changed_during_run).toBe(false);
        expect(report.failures).toContain(`missing output: ${missingOutPath}`);
    });

    test("does not execute denied operation plans", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const missingOutPath = join(mkdtempSync(join(tmpdir(), "ax-denied-output-")), "missing.txt");
        const testManifest = {
            ...manifest,
            operations: [{
                id: "denied-train-demo",
                kind: "train" as const,
                description: "Expensive operation that must not execute.",
                command: `node -e "require('fs').writeFileSync('${missingOutPath}', 'should-not-run')"`,
                outputs: [missingOutPath],
            }],
        };
        const plan = buildOperationExecutionPlanReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "denied-train-demo", {
            allowExecute: true,
            allowExpensive: false,
        });

        const report = await executeOperationPlanReport(plan);

        expect(report.decision).toBe("not_executed");
        expect(report.executed).toBe(false);
        expect(report.exit_code).toBe(null);
        expect(report.missing_outputs).toEqual([missingOutPath]);
        expect(report.output_changes[0]?.changed_during_run).toBe(false);
        expect(report.failures).toContain("operation kind train requires --allow-expensive");
    });

    test("writes operations report JSON to disk", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const report = buildOperationsReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "blind-workflow-status");
        const path = join(mkdtempSync(join(tmpdir(), "ax-ops-")), "nested", "report.json");

        writeOperationsReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.decision).toBe("operation_found");
        expect(written.operations[0].id).toBe("blind-workflow-status");
    });

    test("writes preflight report JSON to disk", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const report = buildOperationPreflightReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval");
        const path = join(mkdtempSync(join(tmpdir(), "ax-preflight-")), "report.json");

        writeOperationPreflightReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_operation_preflight_report.v1");
        expect(written.decision).toBe("ready");
    });

    test("writes dry-run report JSON to disk", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const report = buildOperationDryRunReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval");
        const path = join(mkdtempSync(join(tmpdir(), "ax-dry-run-")), "report.json");

        writeOperationDryRunReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_operation_dry_run_report.v1");
        expect(written.would_execute).toBe(false);
    });

    test("writes execution plan report JSON to disk", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const report = buildOperationExecutionPlanReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "setfit-train-eval", {
            allowExecute: false,
            allowExpensive: false,
        });
        const path = join(mkdtempSync(join(tmpdir(), "ax-execution-plan-")), "report.json");

        writeOperationExecutionPlanReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_operation_execution_plan_report.v1");
        expect(written.would_execute).toBe(false);
    });

    test("writes execution report JSON to disk", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const outPath = join(mkdtempSync(join(tmpdir(), "ax-exec-write-output-")), "output.txt");
        const testManifest = {
            ...manifest,
            operations: [{
                id: "print-demo",
                kind: "debug" as const,
                description: "Print a deterministic execution marker.",
                command: `node -e "require('fs').writeFileSync('${outPath}', 'artifact'); process.stdout.write('ax-exec-write-ok')"`,
                outputs: [outPath],
            }],
        };
        const plan = buildOperationExecutionPlanReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "print-demo", {
            allowExecute: true,
            allowExpensive: false,
        });
        const report = await executeOperationPlanReport(plan);
        const path = join(mkdtempSync(join(tmpdir(), "ax-execution-report-")), "report.json");

        writeOperationExecutionReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_operation_execution_report.v1");
        expect(written.stdout).toBe("ax-exec-write-ok");
        expect(written.outputs).toEqual([{ path: outPath, exists: true }]);
        expect(written.output_changes[0].changed_during_run).toBe(true);
    });

    test("builds execution history summaries from execution reports", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const outPath = join(mkdtempSync(join(tmpdir(), "ax-history-output-")), "output.txt");
        const testManifest = {
            ...manifest,
            operations: [{
                id: "print-demo",
                kind: "debug" as const,
                description: "Print a deterministic execution marker.",
                command: `node -e "require('fs').writeFileSync('${outPath}', 'artifact')"`,
                outputs: [outPath],
            }],
        };
        const plan = buildOperationExecutionPlanReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "print-demo", {
            allowExecute: true,
            allowExpensive: false,
        });
        const execution = await executeOperationPlanReport(plan);

        const report = buildExecutionHistoryReport(".ax/experiments", [{
            path: ".ax/experiments/demo-execution.json",
            report: execution,
        }]);

        expect(report.schema).toBe("ax.classifier_package_execution_history_report.v1");
        expect(report.totals.report_count).toBe(1);
        expect(report.totals.executed_count).toBe(1);
        expect(report.totals.changed_output_count).toBe(1);
        expect(report.reports[0]?.operation_id).toBe("print-demo");
    });

    test("discovers and writes execution history reports", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-history-"));
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const plan = buildOperationExecutionPlanReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "missing", {
            allowExecute: true,
            allowExpensive: false,
        });
        const execution = await executeOperationPlanReport(plan);
        const executionPath = join(root, "classifier-package-execution-demo.json");
        const historyPath = join(root, "history.json");
        writeOperationExecutionReport(executionPath, execution);

        const paths = discoverClassifierPackageExecutionReportPaths(root);
        const history = buildExecutionHistoryReport(root, paths.map((path) => ({
            path,
            report: JSON.parse(readFileSync(path, "utf8")),
        })));
        writeExecutionHistoryReport(historyPath, history);

        const written = JSON.parse(readFileSync(historyPath, "utf8"));
        expect(paths).toEqual([executionPath]);
        expect(written.totals.not_executed_count).toBe(1);
    });

    test("projects execution reports into graph-ready facts and edges", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const outPath = join(mkdtempSync(join(tmpdir(), "ax-fact-output-")), "output.txt");
        const testManifest = {
            ...manifest,
            operations: [{
                id: "print-demo",
                kind: "debug" as const,
                description: "Print a deterministic execution marker.",
                command: `node -e "require('fs').writeFileSync('${outPath}', 'artifact')"`,
                outputs: [outPath],
            }],
        };
        const plan = buildOperationExecutionPlanReport(testManifest, "packages/ax-classifier-session-sections/ax.classifier.json", "print-demo", {
            allowExecute: true,
            allowExpensive: false,
        });
        const execution = await executeOperationPlanReport(plan);

        const report = buildExecutionFactProjectionReport(".ax/experiments", [{
            path: ".ax/experiments/classifier-package-execution-demo.json",
            report: execution,
        }]);

        expect(report.schema).toBe("ax.classifier_package_execution_fact_projection.v1");
        expect(report.totals.source_report_count).toBe(1);
        expect(report.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["classifier_package", "classifier_operation", "classifier_execution", "artifact"]));
        expect(report.edges.map((edge) => edge.kind)).toEqual(expect.arrayContaining(["declares_operation", "ran_operation", "updated_artifact"]));
        expect(report.facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(["classifier_operation_execution", "classifier_artifact_observation"]));
    });

    test("projects proposal lifecycle review artifacts into graph facts", () => {
        const report = buildExecutionFactProjectionReport(".ax/experiments", [], {
            path: ".ax/experiments/blind-workflow-status-current.json",
            exists: true,
            decision: "needs_human_review",
            proposal_review: {
                report_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                summary_path: ".ax/experiments/workflow-candidate-proposal-review-current.md",
                decision: "needs_workflow_candidate_proposal_review",
                proposal_count: 4,
                ready_count: 0,
                pending_count: 4,
                invalid_count: 0,
                missing_field_count: 16,
                failures: [],
            },
            proposal_promotion: {
                report_path: ".ax/experiments/workflow-candidate-proposal-promotion-current.json",
                decision: "needs_workflow_candidate_proposal_review",
                proposal_count: 4,
                emitted_draft_count: 0,
                skipped_proposal_count: 4,
                failures: [],
            },
            proposal_ready_smoke: {
                promotion_report_path: ".ax/experiments/workflow-candidate-proposal-ready-smoke-promotion-current.json",
                review_decision: "workflow_candidate_proposal_reviews_ready",
                promotion_decision: "workflow_candidate_proposal_promotion_ready",
                proposal_count: 3,
                emitted_draft_count: 2,
                skipped_proposal_count: 1,
                failures: [],
            },
            next_actions: [],
        });

        expect(report.totals.lifecycle_fact_count).toBe(14);
        expect(report.nodes.map((node) => node.kind)).toContain("classifier_lifecycle");
        expect(report.edges.map((edge) => edge.kind)).toContain("has_evidence");
        expect(report.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "classifier_lifecycle_status",
                predicate: "proposal_review_decision",
                value: "needs_workflow_candidate_proposal_review",
            }),
            expect.objectContaining({
                predicate: "proposal_review_missing_field_count",
                value: 16,
            }),
            expect.objectContaining({
                predicate: "proposal_ready_smoke_emitted_draft_count",
                value: 2,
            }),
        ]));
    });

    test("projects review pipeline lifecycle artifacts into graph facts", () => {
        const report = buildExecutionFactProjectionReport(".ax/experiments", [], {
            path: ".ax/experiments/blind-workflow-status-current.json",
            exists: true,
            decision: "needs_human_review",
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
                production_apply_argv: ["bun", "src/cli/index.ts", "--apply-review-facts"],
                review_provenance_stamp_argv: ["bun", "src/cli/index.ts", "--review-provenance-reviewer=<reviewer>"],
                review_issue_repair_argv: ["bun", "src/cli/index.ts", "--coverage-review-brief=review.md"],
                output_artifacts: [
                    { kind: "review_brief", path: ".ax/experiments/review.md", required_for_handoff: true },
                    { kind: "readiness_report", path: ".ax/experiments/readiness.json", required_for_handoff: false },
                ],
                checked_artifacts: [
                    { kind: "review_brief", path: ".ax/experiments/review.md", exists: true },
                    { kind: "readiness_report", path: ".ax/experiments/readiness.json", exists: true },
                ],
                failures: [],
            },
            next_actions: [],
        });

        expect(report.totals.lifecycle_fact_count).toBe(15);
        expect(report.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "classifier_lifecycle:workflow_candidate_review_pipeline",
                kind: "classifier_lifecycle",
            }),
        ]));
        expect(report.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "has_evidence",
                evidence_path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
            }),
        ]));
        expect(report.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "classifier_lifecycle_status",
                subject: "classifier_lifecycle:workflow_candidate_review_pipeline",
                predicate: "review_pipeline_lifecycle_status",
                value: "verified_after_execution",
            }),
            expect.objectContaining({
                predicate: "review_pipeline_command_kind",
                value: "stamp_review_provenance",
            }),
            expect.objectContaining({
                predicate: "review_pipeline_output_verification_status",
                value: "verified",
            }),
            expect.objectContaining({
                predicate: "review_pipeline_can_continue",
                value: true,
            }),
            expect.objectContaining({
                predicate: "review_pipeline_checked_artifact_count",
                value: 2,
            }),
            expect.objectContaining({
                predicate: "review_pipeline_prepared_argv",
                value: ["bun", "src/cli/index.ts", "classifiers", "workflow-candidates"],
            }),
            expect.objectContaining({
                predicate: "review_pipeline_production_apply_argv",
                value: ["bun", "src/cli/index.ts", "--apply-review-facts"],
            }),
            expect.objectContaining({
                predicate: "review_pipeline_provenance_stamp_argv",
                value: ["bun", "src/cli/index.ts", "--review-provenance-reviewer=<reviewer>"],
            }),
            expect.objectContaining({
                predicate: "review_pipeline_issue_repair_argv",
                value: ["bun", "src/cli/index.ts", "--coverage-review-brief=review.md"],
            }),
            expect.objectContaining({
                predicate: "review_pipeline_output_artifact_paths",
                value: [".ax/experiments/review.md", ".ax/experiments/readiness.json"],
            }),
            expect.objectContaining({
                predicate: "review_pipeline_checked_artifact_paths",
                value: [".ax/experiments/review.md", ".ax/experiments/readiness.json"],
            }),
            expect.objectContaining({
                predicate: "review_pipeline_checked_artifact_states",
                value: ["review_brief:ok", "readiness_report:ok"],
            }),
        ]));
    });

    test("loads review pipeline lifecycle status beside workflow status", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-review-pipeline-lifecycle-"));
        const statusPath = join(dir, "blind-workflow-status-current.json");
        const lifecyclePath = join(dir, "workflow-candidate-review-pipeline-lifecycle-current.json");
        writeFileSync(statusPath, JSON.stringify({
            schema: "ax.blind_workflow_status.v1",
            decision: "needs_human_review",
            next_actions: [],
        }), "utf8");
        writeFileSync(lifecyclePath, JSON.stringify({
            schema: "ax.workflow_candidate_review_coverage.v1",
            coverage_review: {
                review_pipeline_command_kind: "stamp_review_provenance",
                production_apply_command_argv: ["bun", "src/cli/index.ts", "--apply-review-facts"],
                review_provenance_stamp_command_argv: ["bun", "src/cli/index.ts", "--review-provenance-reviewer=<reviewer>"],
                review_issue_repair_command_argv: ["bun", "src/cli/index.ts", "--coverage-review-brief=review.md"],
                review_pipeline_lifecycle: {
                    schema: "ax.classifier_review_pipeline_lifecycle.v1",
                    status: "verified_after_execution",
                    can_execute: true,
                    can_continue: true,
                    output_verification: {
                        status: "verified",
                        checked_artifacts: [
                            { kind: "readiness_report", path: "one.json", exists: true },
                            { kind: "review_brief", path: "two.md", exists: true },
                        ],
                        missing_required_artifacts: [],
                    },
                    prepared: {
                        status: "ready_to_execute",
                        argv: ["bun", "src/cli/index.ts", "classifiers", "workflow-candidates"],
                        output_artifacts: [
                            { kind: "readiness_report", path: "one.json", required_for_handoff: false },
                            { kind: "review_brief", path: "two.md", required_for_handoff: true },
                        ],
                    },
                },
            },
        }), "utf8");

        const status = loadClassifierLifecycleReviewStatus(statusPath);

        expect(status.review_pipeline_lifecycle).toMatchObject({
            report_path: lifecyclePath,
            lifecycle_status: "verified_after_execution",
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
            output_artifacts: [
                { kind: "readiness_report", path: "one.json", required_for_handoff: false },
                { kind: "review_brief", path: "two.md", required_for_handoff: true },
            ],
            checked_artifacts: [
                { kind: "readiness_report", path: "one.json", exists: true },
                { kind: "review_brief", path: "two.md", exists: true },
            ],
        });
    });

    test("writes execution fact projection reports", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const plan = buildOperationExecutionPlanReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "missing", {
            allowExecute: true,
            allowExpensive: false,
        });
        const execution = await executeOperationPlanReport(plan);
        const report = buildExecutionFactProjectionReport(".ax/experiments", [{
            path: ".ax/experiments/classifier-package-execution-missing.json",
            report: execution,
        }]);
        const path = join(mkdtempSync(join(tmpdir(), "ax-facts-")), "facts.json");

        writeExecutionFactProjectionReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_execution_fact_projection.v1");
        expect(written.totals.guard_fact_count).toBe(1);
    });

    test("builds Surreal write plans from execution fact projections", async () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");
        const plan = buildOperationExecutionPlanReport(manifest, "packages/ax-classifier-session-sections/ax.classifier.json", "missing", {
            allowExecute: true,
            allowExpensive: false,
        });
        const execution = await executeOperationPlanReport(plan);
        const projection = buildExecutionFactProjectionReport(".ax/experiments", [{
            path: ".ax/experiments/classifier-package-execution-missing.json",
            report: execution,
        }]);

        const writePlan = buildExecutionSurrealWritePlanReport(projection);

        expect(writePlan.schema).toBe("ax.classifier_package_execution_surreal_write_plan.v1");
        expect(writePlan.tables).toEqual(["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"]);
        expect(writePlan.totals.statement_count).toBe(writePlan.totals.node_statement_count + writePlan.totals.edge_statement_count + writePlan.totals.fact_statement_count);
        expect(writePlan.statements.some((statement) => statement.startsWith("UPSERT classifier_graph_node:"))).toBe(true);
        expect(writePlan.statements.some((statement) => statement.startsWith("UPSERT classifier_graph_edge:"))).toBe(true);
        expect(writePlan.statements.some((statement) => statement.startsWith("UPSERT classifier_graph_fact:"))).toBe(true);
    });

    test("writes Surreal write plan reports", async () => {
        const projection = buildExecutionFactProjectionReport(".ax/experiments", []);
        const writePlan = buildExecutionSurrealWritePlanReport(projection);
        const path = join(mkdtempSync(join(tmpdir(), "ax-write-plan-")), "write-plan.json");

        writeExecutionSurrealWritePlanReport(path, writePlan);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_execution_surreal_write_plan.v1");
        expect(written.totals.statement_count).toBe(0);
    });

    test("applies Surreal write plans through a query callback", async () => {
        const writePlan = buildExecutionSurrealWritePlanReport({
            schema: "ax.classifier_package_execution_fact_projection.v1",
            root: ".ax/experiments",
            source_reports: [],
            nodes: [],
            edges: [],
            facts: [],
            totals: {
                source_report_count: 0,
                node_count: 0,
                edge_count: 0,
                fact_count: 0,
                execution_fact_count: 0,
                guard_fact_count: 0,
                artifact_fact_count: 0,
                lifecycle_fact_count: 0,
            },
        });

        const report = await applyExecutionSurrealWritePlanReport({
            ...writePlan,
            statements: ["UPSERT classifier_graph_node:`n` CONTENT {};"],
            totals: {
                statement_count: 1,
                node_statement_count: 1,
                edge_statement_count: 0,
                fact_statement_count: 0,
            },
        }, async () => undefined);

        expect(report.schema).toBe("ax.classifier_package_execution_surreal_apply_report.v1");
        expect(report.decision).toBe("applied");
        expect(report.applied_statement_count).toBe(1);
    });

    test("apply reports capture first Surreal write failure", async () => {
        const writePlan = buildExecutionSurrealWritePlanReport({
            schema: "ax.classifier_package_execution_fact_projection.v1",
            root: ".ax/experiments",
            source_reports: [],
            nodes: [],
            edges: [],
            facts: [],
            totals: {
                source_report_count: 0,
                node_count: 0,
                edge_count: 0,
                fact_count: 0,
                execution_fact_count: 0,
                guard_fact_count: 0,
                artifact_fact_count: 0,
                lifecycle_fact_count: 0,
            },
        });

        const report = await applyExecutionSurrealWritePlanReport({
            ...writePlan,
            statements: ["UPSERT ok", "UPSERT bad"],
            totals: {
                statement_count: 2,
                node_statement_count: 2,
                edge_statement_count: 0,
                fact_statement_count: 0,
            },
        }, async (statement) => {
            if (statement.includes("bad")) throw new Error("db rejected statement");
        });

        expect(report.decision).toBe("failed");
        expect(report.applied_statement_count).toBe(1);
        expect(report.failed_statement_count).toBe(1);
        expect(report.first_failure?.index).toBe(1);
        expect(report.first_failure?.message).toBe("db rejected statement");
    });

    test("writes Surreal apply reports", async () => {
        const report = await applyExecutionSurrealWritePlanReport({
            schema: "ax.classifier_package_execution_surreal_write_plan.v1",
            root: ".ax/experiments",
            source_projection_schema: "ax.classifier_package_execution_fact_projection.v1",
            statements: [],
            tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
            totals: {
                statement_count: 0,
                node_statement_count: 0,
                edge_statement_count: 0,
                fact_statement_count: 0,
            },
        }, async () => undefined);
        const path = join(mkdtempSync(join(tmpdir(), "ax-apply-")), "apply.json");

        writeExecutionSurrealApplyReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_execution_surreal_apply_report.v1");
        expect(written.decision).toBe("applied");
    });

    test("builds graph health reports from persisted classifier graph rows", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [
                {
                    graph_id: "classifier_operation:demo/refresh",
                    kind: "classifier_operation",
                    label: "refresh",
                    properties_json: JSON.stringify({ package_key: "demo", operation_kind: "review", expensive: false }),
                },
                {
                    graph_id: "classifier_execution:.ax/experiments/run.json",
                    kind: "classifier_execution",
                    label: "refresh",
                    properties_json: JSON.stringify({
                        decision: "executed",
                        plan_decision: "ready_to_execute",
                        executed: true,
                        started_at: "2026-05-31T00:00:00.000Z",
                        finished_at: "2026-05-31T00:00:01.000Z",
                        duration_ms: 1000,
                        source_path: ".ax/experiments/run.json",
                    }),
                },
                {
                    graph_id: "artifact:.ax/experiments/out.json",
                    kind: "artifact",
                    label: ".ax/experiments/out.json",
                    properties_json: JSON.stringify({ path: ".ax/experiments/out.json", exists: true }),
                },
            ],
            edges: [
                {
                    graph_id: "edge:run",
                    kind: "ran_operation",
                    from_id: "classifier_execution:.ax/experiments/run.json",
                    to_id: "classifier_operation:demo/refresh",
                    evidence_path: ".ax/experiments/run.json",
                    properties_json: JSON.stringify({ decision: "executed" }),
                },
                {
                    graph_id: "edge:artifact",
                    kind: "updated_artifact",
                    from_id: "classifier_execution:.ax/experiments/run.json",
                    to_id: "artifact:.ax/experiments/out.json",
                    evidence_path: ".ax/experiments/run.json",
                    properties_json: JSON.stringify({ changed_during_run: true }),
                },
            ],
            facts: [
                {
                    graph_id: "fact:run",
                    kind: "classifier_operation_execution",
                    subject: "classifier_execution:.ax/experiments/run.json",
                    predicate: "completed_with_decision",
                    value_json: "\"executed\"",
                    evidence_edges_json: JSON.stringify(["edge:run"]),
                    properties_json: JSON.stringify({ decision: "executed" }),
                },
                {
                    graph_id: "fact:artifact",
                    kind: "classifier_artifact_observation",
                    subject: "classifier_execution:.ax/experiments/run.json",
                    predicate: "updated_artifact",
                    object: "artifact:.ax/experiments/out.json",
                    value_json: "true",
                    evidence_edges_json: JSON.stringify(["edge:artifact"]),
                    properties_json: JSON.stringify({ path: ".ax/experiments/out.json", changed_during_run: true }),
                },
            ],
        });

        expect(report.schema).toBe("ax.classifier_package_execution_graph_health_report.v1");
        expect(report.decision).toBe("healthy");
        expect(report.query.mode).toBe("summary");
        expect(report.totals.operation_count).toBe(1);
        expect(report.result_totals.operation_count).toBe(1);
        expect(report.totals.changed_artifact_count).toBe(1);
        expect(report.totals.lifecycle_fact_count).toBe(0);
        expect(report.result_totals.lifecycle_fact_count).toBe(0);
        expect(report.operations[0]?.changed_artifact_count).toBe(1);
        expect(report.operations[0]?.last_execution?.source_path).toBe(".ax/experiments/run.json");
        expect(report.changed_artifacts[0]?.artifact_path).toBe(".ax/experiments/out.json");
    });

    test("filters graph health reports by mode and operation", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [
                {
                    graph_id: "classifier_operation:demo/refresh",
                    kind: "classifier_operation",
                    label: "refresh",
                    properties_json: JSON.stringify({ package_key: "demo", operation_kind: "review", expensive: false }),
                },
                {
                    graph_id: "classifier_operation:demo/train",
                    kind: "classifier_operation",
                    label: "train",
                    properties_json: JSON.stringify({ package_key: "demo", operation_kind: "train", expensive: true }),
                },
                {
                    graph_id: "classifier_execution:guarded.json",
                    kind: "classifier_execution",
                    label: "train",
                    properties_json: JSON.stringify({ decision: "not_executed", plan_decision: "denied_expensive", executed: false }),
                },
            ],
            edges: [{
                graph_id: "edge:guarded",
                kind: "ran_operation",
                from_id: "classifier_execution:guarded.json",
                to_id: "classifier_operation:demo/train",
                evidence_path: "guarded.json",
                properties_json: JSON.stringify({ plan_decision: "denied_expensive" }),
            }],
            facts: [{
                graph_id: "fact:guarded",
                kind: "classifier_operation_guard",
                subject: "classifier_execution:guarded.json",
                predicate: "guarded_with_decision",
                value_json: "\"denied_expensive\"",
                evidence_edges_json: JSON.stringify(["edge:guarded"]),
                properties_json: JSON.stringify({ plan_decision: "denied_expensive" }),
            }],
            query: { mode: "guarded", operation_id: "train" },
        });

        expect(report.query).toEqual({ mode: "guarded", operation_id: "train" });
        expect(report.operations.map((operation) => operation.operation_id)).toEqual(["train"]);
        expect(report.guarded_operations.map((operation) => operation.operation_id)).toEqual(["train"]);
        expect(report.result_totals.operation_count).toBe(1);
        expect(report.result_totals.guarded_operation_count).toBe(1);
        expect(report.result_totals.lifecycle_fact_count).toBe(0);
        expect(report.evidence_paths).toEqual(["guarded.json"]);
    });

    test("lists lifecycle graph facts in lifecycle mode", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [{
                graph_id: "classifier_lifecycle:workflow_candidate_proposal",
                kind: "classifier_lifecycle",
                label: "workflow candidate proposal lifecycle",
                properties_json: "{}",
            }],
            edges: [{
                graph_id: "edge:lifecycle",
                kind: "has_evidence",
                from_id: "classifier_lifecycle:workflow_candidate_proposal",
                to_id: "artifact:.ax/experiments/workflow-candidate-proposal-review-current.json",
                evidence_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                properties_json: JSON.stringify({ lifecycle_key: "proposal_review" }),
            }],
            facts: [{
                graph_id: "fact:lifecycle",
                kind: "classifier_lifecycle_status",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                predicate: "proposal_review_pending_count",
                value_json: "4",
                evidence_edges_json: JSON.stringify(["edge:lifecycle"]),
                properties_json: JSON.stringify({
                    lifecycle_key: "proposal_review",
                    artifact_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                }),
            }, {
                graph_id: "fact:lifecycle:other-subject",
                kind: "classifier_lifecycle_status",
                subject: "classifier_lifecycle:other_pipeline",
                predicate: "review_pipeline_prepared_argv",
                value_json: JSON.stringify(["other"]),
                evidence_edges_json: JSON.stringify(["edge:lifecycle"]),
                properties_json: JSON.stringify({
                    lifecycle_key: "review_pipeline_lifecycle",
                    artifact_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                }),
            }, {
                graph_id: "fact:lifecycle:argv",
                kind: "classifier_lifecycle_status",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                predicate: "review_pipeline_prepared_argv",
                value_json: JSON.stringify(["bun", "src/cli/index.ts"]),
                evidence_edges_json: JSON.stringify(["edge:lifecycle"]),
                source_kind: "classifier_package_execution",
                properties_json: JSON.stringify({
                    lifecycle_key: "review_pipeline_lifecycle",
                    artifact_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                }),
            }, {
                graph_id: "fact:lifecycle:argv-other-source",
                kind: "classifier_lifecycle_status",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                predicate: "review_pipeline_prepared_argv",
                value_json: JSON.stringify(["bun", "src/cli/index.ts"]),
                evidence_edges_json: JSON.stringify(["edge:lifecycle"]),
                source_kind: "other_projection",
                properties_json: JSON.stringify({
                    lifecycle_key: "review_pipeline_lifecycle",
                    artifact_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                }),
            }, {
                graph_id: "fact:lifecycle:argv-other-value",
                kind: "classifier_lifecycle_status",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                predicate: "review_pipeline_prepared_argv",
                value_json: JSON.stringify(["python", "other.py"]),
                evidence_edges_json: JSON.stringify(["edge:lifecycle"]),
                properties_json: JSON.stringify({
                    lifecycle_key: "review_pipeline_lifecycle",
                    artifact_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                }),
            }],
            query: {
                mode: "lifecycle",
                predicate: "review_pipeline_prepared_argv",
                subject: "classifier_lifecycle:workflow_candidate_proposal",
                source_kind: "classifier_package_execution",
                value_contains: "src/cli/index.ts",
            },
        });

        expect(report.query.mode).toBe("lifecycle");
        expect(report.query.predicate).toBe("review_pipeline_prepared_argv");
        expect(report.query.subject).toBe("classifier_lifecycle:workflow_candidate_proposal");
        expect(report.query.source_kind).toBe("classifier_package_execution");
        expect(report.query.value_contains).toBe("src/cli/index.ts");
        expect(report.totals.lifecycle_fact_count).toBe(5);
        expect(report.result_totals.lifecycle_fact_count).toBe(1);
        expect(report.lifecycle_facts[0]).toMatchObject({
            predicate: "review_pipeline_prepared_argv",
            value: ["bun", "src/cli/index.ts"],
            lifecycle_key: "review_pipeline_lifecycle",
            artifact_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
            evidence_paths: [".ax/experiments/workflow-candidate-proposal-review-current.json"],
        });
        expect(report.evidence_paths).toEqual([".ax/experiments/workflow-candidate-proposal-review-current.json"]);
    });

    test("lists embedding helper graph facts in embedding-helper mode", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [
                {
                    graph_id: "embedding_helper_routing:session-section-chunks",
                    kind: "embedding_helper_routing_candidate",
                    label: "embedding helper routing",
                    properties_json: JSON.stringify({ threshold: "none" }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "embedding_helper_hard_negative:session-section-chunks/none-start-building",
                    kind: "embedding_helper_hard_negative_candidate",
                    label: "session-section-chunks/none-start-building",
                    properties_json: JSON.stringify({ status: "accepted" }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "classifier_promoted_fixture:session-section-chunks/embedding-helper-hard-negative-none-start-building",
                    kind: "classifier_promoted_fixture",
                    label: "session-section-chunks/embedding-helper-hard-negative-none-start-building",
                    properties_json: JSON.stringify({ label: "none", target: "none" }),
                    source_kind: "embedding_helper_review_projection",
                },
            ],
            edges: [
                {
                    graph_id: "edge:routing",
                    kind: "emitted_routing_candidate",
                    from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                    to_id: "embedding_helper_routing:session-section-chunks",
                    evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                    properties_json: "{}",
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "edge:hn",
                    kind: "nearest_reviewed_fixture",
                    from_id: "embedding_helper_hard_negative:session-section-chunks/none-start-building",
                    to_id: "classifier_evidence:session-section-chunks/approval-alright-go",
                    evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                    properties_json: JSON.stringify({ similarity: 0.8565 }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "edge:hn-other-neighbor",
                    kind: "nearest_reviewed_fixture",
                    from_id: "embedding_helper_hard_negative:session-section-chunks/none-other-neighbor",
                    to_id: "classifier_evidence:session-section-chunks/verification-runtime",
                    evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                    properties_json: JSON.stringify({ similarity: 0.8123 }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "edge:promoted",
                    kind: "promoted_as_fixture",
                    from_id: "embedding_helper_hard_negative:session-section-chunks/none-start-building",
                    to_id: "classifier_promoted_fixture:session-section-chunks/embedding-helper-hard-negative-none-start-building",
                    evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                    properties_json: JSON.stringify({ label: "none", target: "none" }),
                    source_kind: "embedding_helper_review_projection",
                },
            ],
            facts: [
                {
                    graph_id: "fact:routing",
                    kind: "embedding_helper_routing_candidate",
                    subject: "embedding_helper_routing:session-section-chunks",
                    predicate: "recommended_threshold",
                    value_json: JSON.stringify({ threshold: "none", positive_recall_after_routing_mean: 0.9028 }),
                    evidence_edges_json: JSON.stringify(["edge:routing"]),
                    properties_json: JSON.stringify({
                        threshold: "none",
                        setfit_call_reduction_rate_mean: 0.1778,
                        positive_recall_after_routing_mean: 0.9028,
                    }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "fact:hard-negative",
                    kind: "embedding_helper_hard_negative_candidate",
                    subject: "embedding_helper_hard_negative:session-section-chunks/none-start-building",
                    predicate: "promoted_hard_negative_fixture",
                    object: "classifier_promoted_fixture:session-section-chunks/embedding-helper-hard-negative-none-start-building",
                    value_json: "true",
                    evidence_edges_json: JSON.stringify(["edge:promoted", "edge:hn"]),
                    properties_json: JSON.stringify({
                        source_fixture_id: "session-section-chunks/none-start-building",
                        status: "accepted",
                        proposed_label: "none",
                        promoted_fixture_id: "session-section-chunks/embedding-helper-hard-negative-none-start-building",
                        seed_count: 2,
                        max_nearest_positive_similarity: 0.8743,
                    }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "fact:hard-negative-other-neighbor",
                    kind: "embedding_helper_hard_negative_candidate",
                    subject: "embedding_helper_hard_negative:session-section-chunks/none-other-neighbor",
                    predicate: "promoted_hard_negative_fixture",
                    value_json: "true",
                    evidence_edges_json: JSON.stringify(["edge:hn-other-neighbor"]),
                    properties_json: JSON.stringify({
                        source_fixture_id: "session-section-chunks/none-other-neighbor",
                        status: "accepted",
                        proposed_label: "none",
                    }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "fact:hard-negative-wrong-label",
                    kind: "embedding_helper_hard_negative_candidate",
                    subject: "embedding_helper_hard_negative:session-section-chunks/direction-example",
                    predicate: "promoted_hard_negative_fixture",
                    value_json: "true",
                    evidence_edges_json: JSON.stringify(["edge:hn"]),
                    properties_json: JSON.stringify({
                        source_fixture_id: "session-section-chunks/direction-example",
                        status: "accepted",
                        proposed_label: "direction",
                    }),
                    source_kind: "embedding_helper_review_projection",
                },
                {
                    graph_id: "fact:hard-negative-rejected",
                    kind: "embedding_helper_hard_negative_candidate",
                    subject: "embedding_helper_hard_negative:session-section-chunks/rejected-example",
                    predicate: "rejected_hard_negative_candidate",
                    value_json: "false",
                    evidence_edges_json: JSON.stringify(["edge:hn"]),
                    properties_json: JSON.stringify({
                        source_fixture_id: "session-section-chunks/rejected-example",
                        status: "rejected",
                        proposed_label: "none",
                    }),
                    source_kind: "embedding_helper_review_projection",
                },
            ],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_hard_negative_candidate",
                status: "accepted",
                proposed_label: "none",
                min_nearest_similarity: 0.85,
            },
        });

        expect(report.query.mode).toBe("embedding-helper");
        expect(report.query.fact_kind).toBe("embedding_helper_hard_negative_candidate");
        expect(report.query.status).toBe("accepted");
        expect(report.query.proposed_label).toBe("none");
        expect(report.query.min_nearest_similarity).toBe(0.85);
        expect(report.totals.embedding_helper_fact_count).toBe(5);
        expect(report.result_totals.embedding_helper_fact_count).toBe(1);
        expect(report.embedding_helper_facts.map((fact) => fact.predicate)).toEqual([
            "promoted_hard_negative_fixture",
        ]);
        expect(report.embedding_helper_facts[0]).toMatchObject({
            source_fixture_id: "session-section-chunks/none-start-building",
            status: "accepted",
            proposed_label: "none",
            promoted_fixture_id: "session-section-chunks/embedding-helper-hard-negative-none-start-building",
            seed_count: 2,
            max_nearest_positive_similarity: 0.8743,
            nearest_neighbors: [{
                fixture_id: "session-section-chunks/approval-alright-go",
                similarity: 0.8565,
            }],
            evidence_paths: [".ax/experiments/embedding-helper-review-e210.json"],
        });
    });

    test("filters embedding helper graph facts by routing threshold", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [],
            edges: [{
                graph_id: "edge:routing-none",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "edge:routing-04",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }],
            facts: [{
                graph_id: "fact:routing-none",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "none", positive_recall_after_routing_mean: 0.9028 }),
                evidence_edges_json: JSON.stringify(["edge:routing-none"]),
                properties_json: JSON.stringify({
                    threshold: "none",
                    setfit_call_reduction_rate_mean: 0.1778,
                    positive_recall_after_routing_mean: 0.9028,
                }),
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "fact:routing-04",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "0.4", positive_recall_after_routing_mean: 0.8123 }),
                evidence_edges_json: JSON.stringify(["edge:routing-04"]),
                properties_json: JSON.stringify({
                    threshold: "0.4",
                    setfit_call_reduction_rate_mean: 0.2912,
                    positive_recall_after_routing_mean: 0.8123,
                }),
                source_kind: "embedding_helper_review_projection",
            }],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_routing_candidate",
                threshold: "none",
            },
        });

        expect(report.query.threshold).toBe("none");
        expect(report.totals.embedding_helper_fact_count).toBe(2);
        expect(report.result_totals.embedding_helper_fact_count).toBe(1);
        expect(report.embedding_helper_facts[0]).toMatchObject({
            kind: "embedding_helper_routing_candidate",
            predicate: "recommended_threshold",
            threshold: "none",
            positive_recall_after_routing_mean: 0.9028,
            setfit_call_reduction_rate_mean: 0.1778,
        });
    });

    test("filters embedding helper graph facts by minimum positive recall", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [],
            edges: [{
                graph_id: "edge:routing-none",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "edge:routing-04",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }],
            facts: [{
                graph_id: "fact:routing-none",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "none", positive_recall_after_routing_mean: 0.9028 }),
                evidence_edges_json: JSON.stringify(["edge:routing-none"]),
                properties_json: JSON.stringify({
                    threshold: "none",
                    setfit_call_reduction_rate_mean: 0.1778,
                    positive_recall_after_routing_mean: 0.9028,
                }),
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "fact:routing-04",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "0.4", positive_recall_after_routing_mean: 0.8123 }),
                evidence_edges_json: JSON.stringify(["edge:routing-04"]),
                properties_json: JSON.stringify({
                    threshold: "0.4",
                    setfit_call_reduction_rate_mean: 0.2912,
                    positive_recall_after_routing_mean: 0.8123,
                }),
                source_kind: "embedding_helper_review_projection",
            }],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_routing_candidate",
                min_positive_recall: 0.9,
            },
        });

        expect(report.query.min_positive_recall).toBe(0.9);
        expect(report.totals.embedding_helper_fact_count).toBe(2);
        expect(report.result_totals.embedding_helper_fact_count).toBe(1);
        expect(report.embedding_helper_facts[0]).toMatchObject({
            threshold: "none",
            positive_recall_after_routing_mean: 0.9028,
        });
    });

    test("filters embedding helper graph facts by minimum call reduction", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [],
            edges: [{
                graph_id: "edge:routing-low",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "edge:routing-high",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }],
            facts: [{
                graph_id: "fact:routing-low",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "none", positive_recall_after_routing_mean: 0.9028 }),
                evidence_edges_json: JSON.stringify(["edge:routing-low"]),
                properties_json: JSON.stringify({
                    threshold: "none",
                    setfit_call_reduction_rate_mean: 0.1778,
                    positive_recall_after_routing_mean: 0.9028,
                }),
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "fact:routing-high",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "0.4", positive_recall_after_routing_mean: 0.8123 }),
                evidence_edges_json: JSON.stringify(["edge:routing-high"]),
                properties_json: JSON.stringify({
                    threshold: "0.4",
                    setfit_call_reduction_rate_mean: 0.2912,
                    positive_recall_after_routing_mean: 0.8123,
                }),
                source_kind: "embedding_helper_review_projection",
            }],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_routing_candidate",
                min_call_reduction: 0.25,
            },
        });

        expect(report.query.min_call_reduction).toBe(0.25);
        expect(report.totals.embedding_helper_fact_count).toBe(2);
        expect(report.result_totals.embedding_helper_fact_count).toBe(1);
        expect(report.embedding_helper_facts[0]).toMatchObject({
            threshold: "0.4",
            setfit_call_reduction_rate_mean: 0.2912,
        });
    });

    test("summarizes routing policies that meet recall and call reduction floors", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [],
            edges: [{
                graph_id: "edge:routing-safe",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "edge:routing-risky",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }],
            facts: [{
                graph_id: "fact:routing-safe",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "none", positive_recall_after_routing_mean: 0.9028 }),
                evidence_edges_json: JSON.stringify(["edge:routing-safe"]),
                properties_json: JSON.stringify({
                    threshold: "none",
                    setfit_call_reduction_rate_mean: 0.1778,
                    positive_recall_after_routing_mean: 0.9028,
                }),
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "fact:routing-risky",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "0.4", positive_recall_after_routing_mean: 0.8123 }),
                evidence_edges_json: JSON.stringify(["edge:routing-risky"]),
                properties_json: JSON.stringify({
                    threshold: "0.4",
                    setfit_call_reduction_rate_mean: 0.2912,
                    positive_recall_after_routing_mean: 0.8123,
                }),
                source_kind: "embedding_helper_review_projection",
            }],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_routing_candidate",
                min_positive_recall: 0.9,
                min_call_reduction: 0.17,
            },
        });

        expect(report.result_totals.embedding_helper_fact_count).toBe(1);
        expect(report.routing_policy_summary).toMatchObject({
            status: "meets_requested_floors",
            next_action: "choose_reviewed_routing_threshold",
            requested_min_positive_recall: 0.9,
            requested_min_call_reduction: 0.17,
            candidate_count: 1,
            best_threshold_by_call_reduction: "none",
            best_positive_recall: 0.9028,
            best_call_reduction: 0.1778,
        });
    });

    test("summarizes routing policies with a no-match remediation", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [],
            edges: [{
                graph_id: "edge:routing-safe",
                kind: "emitted_routing_candidate",
                from_id: "artifact:.ax/experiments/embedding-helper-review-e210.json",
                to_id: "embedding_helper_routing:session-section-chunks",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }],
            facts: [{
                graph_id: "fact:routing-safe",
                kind: "embedding_helper_routing_candidate",
                subject: "embedding_helper_routing:session-section-chunks",
                predicate: "recommended_threshold",
                value_json: JSON.stringify({ threshold: "none", positive_recall_after_routing_mean: 0.9028 }),
                evidence_edges_json: JSON.stringify(["edge:routing-safe"]),
                properties_json: JSON.stringify({
                    threshold: "none",
                    setfit_call_reduction_rate_mean: 0.1778,
                    positive_recall_after_routing_mean: 0.9028,
                }),
                source_kind: "embedding_helper_review_projection",
            }],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_routing_candidate",
                min_positive_recall: 0.95,
                min_call_reduction: 0.2,
            },
        });

        expect(report.result_totals.embedding_helper_fact_count).toBe(0);
        expect(report.routing_policy_summary).toMatchObject({
            status: "no_matching_policy",
            next_action: "lower_floor_or_review_more_candidates",
            remediation: "Lower the requested routing floors or review more routing candidates before enabling this policy.",
            requested_min_positive_recall: 0.95,
            requested_min_call_reduction: 0.2,
            evaluated_policy_count: 1,
            candidate_count: 0,
            best_available_threshold_by_recall: "none",
            best_available_positive_recall: 0.9028,
            best_available_call_reduction: 0.1778,
            positive_recall_gap_to_request: 0.0472,
            call_reduction_gap_to_request: 0.0222,
            blocking_floor_fields: ["positive_recall", "call_reduction"],
            largest_gap_floor: "positive_recall",
            recommended_floor_adjustments: [
                {
                    floor: "positive_recall",
                    requested: 0.95,
                    recommended: 0.9028,
                    gap: 0.0472,
                    source_threshold: "none",
                },
                {
                    floor: "call_reduction",
                    requested: 0.2,
                    recommended: 0.1778,
                    gap: 0.0222,
                    source_threshold: "none",
                },
            ],
            recommended_floor_query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_routing_candidate",
                min_positive_recall: 0.9028,
                min_call_reduction: 0.1778,
            },
            recommended_floor_argv: [
                "bun",
                "src/cli/index.ts",
                "classifiers",
                "graph",
                "--mode",
                "embedding-helper",
                "--fact-kind",
                "embedding_helper_routing_candidate",
                "--min-positive-recall",
                "0.9028",
                "--min-call-reduction",
                "0.1778",
            ],
            recommended_floor_status: "expected_matches",
            recommended_floor_candidate_count: 1,
            recommended_floor_best_threshold_by_call_reduction: "none",
            recommended_floor_best_positive_recall: 0.9028,
            recommended_floor_best_call_reduction: 0.1778,
            recommended_floor_next_action: "choose_recommended_routing_threshold",
        });
    });

    test("filters embedding helper graph facts by minimum seed count", () => {
        const report = buildExecutionGraphHealthReport({
            nodes: [],
            edges: [{
                graph_id: "edge:seeded",
                kind: "promoted_as_fixture",
                from_id: "embedding_helper_hard_negative:session-section-chunks/none-seeded",
                to_id: "classifier_promoted_fixture:session-section-chunks/none-seeded",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "edge:single-seed",
                kind: "promoted_as_fixture",
                from_id: "embedding_helper_hard_negative:session-section-chunks/none-single-seed",
                to_id: "classifier_promoted_fixture:session-section-chunks/none-single-seed",
                evidence_path: ".ax/experiments/embedding-helper-review-e210.json",
                properties_json: "{}",
                source_kind: "embedding_helper_review_projection",
            }],
            facts: [{
                graph_id: "fact:seeded",
                kind: "embedding_helper_hard_negative_candidate",
                subject: "embedding_helper_hard_negative:session-section-chunks/none-seeded",
                predicate: "promoted_hard_negative_fixture",
                value_json: "true",
                evidence_edges_json: JSON.stringify(["edge:seeded"]),
                properties_json: JSON.stringify({
                    source_fixture_id: "session-section-chunks/none-seeded",
                    status: "accepted",
                    proposed_label: "none",
                    seed_count: 2,
                }),
                source_kind: "embedding_helper_review_projection",
            }, {
                graph_id: "fact:single-seed",
                kind: "embedding_helper_hard_negative_candidate",
                subject: "embedding_helper_hard_negative:session-section-chunks/none-single-seed",
                predicate: "promoted_hard_negative_fixture",
                value_json: "true",
                evidence_edges_json: JSON.stringify(["edge:single-seed"]),
                properties_json: JSON.stringify({
                    source_fixture_id: "session-section-chunks/none-single-seed",
                    status: "accepted",
                    proposed_label: "none",
                    seed_count: 1,
                }),
                source_kind: "embedding_helper_review_projection",
            }],
            query: {
                mode: "embedding-helper",
                fact_kind: "embedding_helper_hard_negative_candidate",
                status: "accepted",
                proposed_label: "none",
                min_seed_count: 2,
            },
        });

        expect(report.query.min_seed_count).toBe(2);
        expect(report.totals.embedding_helper_fact_count).toBe(2);
        expect(report.result_totals.embedding_helper_fact_count).toBe(1);
        expect(report.embedding_helper_facts[0]).toMatchObject({
            source_fixture_id: "session-section-chunks/none-seeded",
            status: "accepted",
            proposed_label: "none",
            seed_count: 2,
        });
    });

    test("writes graph health reports", () => {
        const report = buildExecutionGraphHealthReport({ nodes: [], edges: [], facts: [] });
        const path = join(mkdtempSync(join(tmpdir(), "ax-graph-health-")), "health.json");

        writeExecutionGraphHealthReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_package_execution_graph_health_report.v1");
        expect(written.decision).toBe("empty_graph");
    });

    test("builds classifier lifecycle insight reports from packages, graph health, and workflow status", () => {
        const packages = buildPackagesOperationsReport("packages", [{
            manifest: "packages/demo/ax.classifier.json",
            package_key: "demo",
            package_name: "@ax-classifier/demo",
            version: "0.1.0",
            kind: "local_model",
            input: "event_window",
            label_count: 1,
            target_count: 1,
            fixture_count: 1,
            asset_count: 0,
            operation_count: 1,
            operation_kinds: { train: 1, eval: 0, review: 0, status: 0, publish: 0, debug: 0 },
            lifecycle_readiness: {
                status: "incomplete",
                required_kinds: ["train", "eval", "review", "status"],
                present_required_kinds: ["train"],
                missing_required_kinds: ["eval", "review", "status"],
            },
            operations: [],
        }]);
        const graph = buildExecutionGraphHealthReport({
            nodes: [{
                graph_id: "classifier_operation:demo/train",
                kind: "classifier_operation",
                label: "train",
                properties_json: JSON.stringify({ package_key: "demo", operation_kind: "train", expensive: true }),
            }, {
                graph_id: "classifier_execution:failed.json",
                kind: "classifier_execution",
                label: "failed.json",
                properties_json: JSON.stringify({ decision: "failed", plan_decision: "ready_to_execute", executed: true, started_at: "2026-05-30T00:00:00.000Z", source_path: "failed.json" }),
            }],
            edges: [{
                graph_id: "edge:guarded",
                kind: "ran_operation",
                from_id: "classifier_execution:guarded.json",
                to_id: "classifier_operation:demo/train",
                evidence_path: "guarded.json",
                properties_json: "{}",
            }, {
                graph_id: "edge:failed",
                kind: "ran_operation",
                from_id: "classifier_execution:failed.json",
                to_id: "classifier_operation:demo/train",
                evidence_path: "failed.json",
                properties_json: "{}",
            }],
            facts: [{
                graph_id: "fact:guarded",
                kind: "classifier_operation_guard",
                subject: "classifier_execution:guarded.json",
                predicate: "guarded_with_decision",
                value_json: "\"denied_expensive\"",
                evidence_edges_json: JSON.stringify(["edge:guarded"]),
                properties_json: "{}",
            }],
        });

        const report = buildClassifierLifecycleInsightReport({
            packages,
            graph,
            workflowStatus: {
                path: ".ax/status.json",
                exists: true,
                schema: "ax.blind_workflow_status.v1",
                decision: "needs_human_review",
                pending_blind_labels: 2,
                pending_hard_negatives: 1,
                accepted_hard_negatives: 0,
                proposal_review: {
                    report_path: ".ax/experiments/workflow-candidate-proposal-review-current.json",
                    summary_path: ".ax/experiments/workflow-candidate-proposal-review-current.md",
                    decision: "needs_workflow_candidate_proposal_review",
                    proposal_count: 4,
                    ready_count: 0,
                    pending_count: 4,
                    invalid_count: 0,
                    missing_field_count: 16,
                    failures: ["proposal briefs are not promotion-ready"],
                },
                proposal_promotion: {
                    report_path: ".ax/experiments/workflow-candidate-proposal-promotion-current.json",
                    decision: "needs_workflow_candidate_proposal_review",
                    proposal_count: 4,
                    emitted_draft_count: 0,
                    skipped_proposal_count: 4,
                    failures: ["proposal review report is not ready"],
                },
                proposal_ready_smoke: {
                    promotion_report_path: ".ax/experiments/workflow-candidate-proposal-ready-smoke-promotion-current.json",
                    draft_dir: ".ax/experiments/workflow-candidate-proposal-ready-smoke-drafts",
                    review_decision: "workflow_candidate_proposal_reviews_ready",
                    promotion_decision: "workflow_candidate_proposal_promotion_ready",
                    proposal_count: 3,
                    emitted_draft_count: 2,
                    skipped_proposal_count: 1,
                    failures: [],
                },
                next_actions: ["review batch"],
            },
        });

        expect(report.schema).toBe("ax.classifier_lifecycle_insight_report.v1");
        expect(report.decision).toBe("needs_human_review");
        expect(report.totals.local_model_incomplete_count).toBe(1);
        expect(report.totals.guarded_operation_count).toBe(1);
        expect(report.totals.failed_operation_count).toBe(1);
        expect(report.blocking_items).toContain("2 blind labels pending");
        expect(report.blocking_items).toContain("workflow candidate proposal review pending 4 proposal(s)");
        expect(report.blocking_items).toContain("workflow candidate proposal promotion blocked by review");
        expect(report.workflow_status.proposal_review?.missing_field_count).toBe(16);
        expect(report.workflow_status.proposal_promotion?.emitted_draft_count).toBe(0);
        expect(report.workflow_status.proposal_ready_smoke?.emitted_draft_count).toBe(2);
        expect(report.blocking_items).toContain("demo/train failed 1 time(s)");
        expect(report.packages[0]?.guarded_operation_count).toBe(1);
        expect(report.packages[0]?.failed_operation_count).toBe(1);
    });

    test("summarizes review pipeline lifecycle routing in lifecycle insight reports", () => {
        const report = buildClassifierLifecycleInsightReport({
            packages: buildPackagesOperationsReport("packages", []),
            graph: buildExecutionGraphHealthReport({
                nodes: [{
                    graph_id: "classifier_operation:demo/review",
                    kind: "classifier_operation",
                    label: "review",
                    properties_json: JSON.stringify({ package_key: "demo", operation_kind: "review", expensive: false }),
                }],
                edges: [],
                facts: [],
            }),
            workflowStatus: {
                path: ".ax/experiments/blind-workflow-status-current.json",
                exists: true,
                decision: "healthy",
                review_pipeline_lifecycle: {
                    report_path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
                    lifecycle_status: "needs_output_verification",
                    command_kind: "stamp_review_provenance",
                    prepared_status: "ready_to_execute",
                    output_verification_status: "missing_required_outputs",
                    can_execute: true,
                    can_continue: false,
                    missing_required_artifact_count: 2,
                    checked_artifact_count: 1,
                    prepared_argv: ["bun", "src/cli/index.ts", "classifiers", "workflow-candidates"],
                    output_artifacts: [{
                        kind: "review_brief",
                        path: ".ax/experiments/review.md",
                        required_for_handoff: true,
                    }],
                    checked_artifacts: [{
                        kind: "review_brief",
                        path: ".ax/experiments/review.md",
                        exists: false,
                    }],
                    failures: ["missing required output: review facts"],
                },
                next_actions: [],
            },
        });

        expect(report.review_pipeline).toMatchObject({
            report_path: ".ax/experiments/workflow-candidate-review-pipeline-lifecycle-current.json",
            status: "needs_output_verification",
            command_kind: "stamp_review_provenance",
            output_verification_status: "missing_required_outputs",
            can_execute: true,
            can_continue: false,
            missing_required_artifact_count: 2,
            checked_artifact_count: 1,
            next_action: "repair_review_pipeline_outputs",
            prepared_argv: ["bun", "src/cli/index.ts", "classifiers", "workflow-candidates"],
            output_artifacts: [{
                kind: "review_brief",
                path: ".ax/experiments/review.md",
                required_for_handoff: true,
            }],
            checked_artifacts: [{
                kind: "review_brief",
                path: ".ax/experiments/review.md",
                exists: false,
            }],
        });
        expect(report.decision).toBe("needs_human_review");
        expect(report.blocking_items).toContain("review pipeline missing 2 required output artifact(s)");
        expect(report.blocking_items).toContain("review pipeline lifecycle cannot continue: needs_output_verification");
    });

    test("writes lifecycle insight reports", () => {
        const report = buildClassifierLifecycleInsightReport({
            packages: buildPackagesOperationsReport("packages", []),
            graph: buildExecutionGraphHealthReport({ nodes: [], edges: [], facts: [] }),
            workflowStatus: { path: ".ax/status.json", exists: false, next_actions: [] },
        });
        const path = join(mkdtempSync(join(tmpdir(), "ax-lifecycle-")), "lifecycle.json");

        writeClassifierLifecycleInsightReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.schema).toBe("ax.classifier_lifecycle_insight_report.v1");
        expect(written.decision).toBe("needs_graph_apply");
    });

    test("discovers classifier package manifests", () => {
        const paths = discoverClassifierPackageManifestPaths("packages");

        expect(paths).toContain("packages/ax-classifier-session-sections/ax.classifier.json");
        expect(paths).toContain("packages/ax-classifier-direction-event/ax.classifier.json");
        expect(paths).toEqual([...paths].sort());
    });

    test("builds multi-package operation summaries", () => {
        const paths = discoverClassifierPackageManifestPaths("packages");
        const packages = paths.map((path) => summarizeClassifierPackageOperations(loadClassifierPackageManifest(path), path));
        const report = buildPackagesOperationsReport("packages", packages);

        expect(report.schema).toBe("ax.classifier_packages_operations_report.v1");
        expect(report.totals.package_count).toBeGreaterThanOrEqual(3);
        expect(report.totals.operation_count).toBeGreaterThanOrEqual(37);
        expect(report.totals.operation_kinds.train).toBe(1);
        expect(report.totals.operation_kinds.eval).toBe(9);
        expect(report.totals.operation_kinds.review).toBe(18);
        expect(report.totals.operation_kinds.status).toBe(24);
        expect(report.totals.operation_kinds.publish).toBe(4);
        expect(report.totals.operation_kinds.debug).toBe(1);
        expect(report.totals.local_model_ready_count).toBe(1);
        expect(report.totals.local_model_incomplete_count).toBe(0);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.operation_count).toBe(57);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.operation_kinds.train).toBe(1);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.operation_kinds.eval).toBe(9);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.operation_kinds.review).toBe(18);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.operation_kinds.status).toBe(24);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.operation_kinds.publish).toBe(4);
        expect(report.packages.find((entry) => entry.package_key === "session-section-chunks")?.lifecycle_readiness.status).toBe("ready");
        expect(report.packages.find((entry) => entry.package_key === "direction-event")?.lifecycle_readiness.status).toBe("not_applicable");
    });

    test("writes multi-package operations report JSON to disk", () => {
        const paths = discoverClassifierPackageManifestPaths("packages");
        const packages = paths.map((path) => summarizeClassifierPackageOperations(loadClassifierPackageManifest(path), path));
        const report = buildPackagesOperationsReport("packages", packages);
        const path = join(mkdtempSync(join(tmpdir(), "ax-ops-all-")), "report.json");

        writePackagesOperationsReport(path, report);

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.totals.package_count).toBe(report.totals.package_count);
        expect(written.packages.some((entry: { package_key: string }) => entry.package_key === "session-section-chunks")).toBe(true);
    });
});
