import { Effect } from "effect";
import type { SurrealClient } from "../lib/db.ts";
import {
    ClassifierPackageService,
    type ClassifierPackageOperationReportInput,
} from "../classifiers/package-service.ts";
import type {
    ClassifierPackageExecutionFactProjectionReport,
    ClassifierPackageExecutionHistoryReport,
    ClassifierPackageExecutionSurrealApplyReport,
    ClassifierPackageExecutionSurrealWritePlanReport,
    ClassifierPackageExecutionGraphHealthReport,
    ClassifierLifecycleInsightReport,
    ClassifierGraphHealthMode,
    ClassifierPackageOperationDryRunReport,
    ClassifierPackageOperationExecutionReport,
    ClassifierPackageOperationExecutionPlanReport,
    ClassifierPackageOperationPreflightReport,
    ClassifierPackagesOperationsReport,
    ClassifierPackageOperationsReport,
} from "../classifiers/package-operations.ts";

export interface ClassifierPackageOperationsCommandInput extends ClassifierPackageOperationReportInput {
    readonly out?: string;
    readonly json: boolean;
    readonly preflight?: boolean;
    readonly dryRun?: boolean;
    readonly execute?: boolean;
    readonly allowExpensive?: boolean;
    readonly history?: boolean;
    readonly facts?: boolean;
    readonly writePlan?: boolean;
    readonly applyWritePlan?: boolean;
    readonly graphHealth?: boolean;
    readonly graphMode?: ClassifierGraphHealthMode;
    readonly artifact?: string;
    readonly root?: string;
    readonly workflowStatusPath?: string;
}

export interface ClassifierPackagesOperationsCommandInput {
    readonly root?: string;
    readonly out?: string;
    readonly json: boolean;
}

export function renderClassifierPackageOperationsText(report: ClassifierPackageOperationsReport): string {
    const lines = [
        `classifier package operations: ${report.package_key}`,
        `decision: ${report.decision}`,
    ];
    for (const operation of report.operations) {
        lines.push(`- ${operation.kind}/${operation.id}: ${operation.command}`);
        if (operation.inputs && operation.inputs.length > 0) {
            lines.push(`  inputs: ${operation.inputs.join(", ")}`);
        }
        if (operation.outputs && operation.outputs.length > 0) {
            lines.push(`  outputs: ${operation.outputs.join(", ")}`);
        }
    }
    for (const failure of report.failures) {
        lines.push(`failure: ${failure}`);
    }
    return lines.join("\n");
}

export function renderClassifierPackageOperationPreflightText(report: ClassifierPackageOperationPreflightReport): string {
    const lines = [
        `classifier package operation preflight: ${report.package_key}/${report.operation_id}`,
        `decision: ${report.decision}`,
    ];
    if (report.operation) {
        lines.push(`operation: ${report.operation.kind}/${report.operation.id}`);
        lines.push(`command: ${report.operation.command}`);
    }
    for (const input of report.inputs) {
        lines.push(`- ${input.exists ? "ok" : "missing"} ${input.path}`);
    }
    for (const failure of report.failures) {
        lines.push(`failure: ${failure}`);
    }
    return lines.join("\n");
}

function preflightFailed(decision: ClassifierPackageOperationPreflightReport["decision"]): boolean {
    return decision === "missing_inputs" || decision === "operation_missing";
}

export function renderClassifierPackageOperationDryRunText(report: ClassifierPackageOperationDryRunReport): string {
    const lines = [
        `classifier package operation dry-run: ${report.package_key}/${report.operation_id}`,
        `decision: ${report.decision}`,
        `would execute: ${report.would_execute ? "yes" : "no"}`,
    ];
    if (report.operation) {
        lines.push(`operation: ${report.operation.kind}/${report.operation.id}`);
    }
    if (report.command) {
        lines.push(`command: ${report.command}`);
    }
    lines.push(`preflight: ${report.preflight.decision}`);
    for (const failure of report.failures) {
        lines.push(`failure: ${failure}`);
    }
    return lines.join("\n");
}

function dryRunFailed(decision: ClassifierPackageOperationDryRunReport["decision"]): boolean {
    return decision === "blocked" || decision === "operation_missing";
}

export function renderClassifierPackageOperationExecutionPlanText(report: ClassifierPackageOperationExecutionPlanReport): string {
    const lines = [
        `classifier package operation execution plan: ${report.package_key}/${report.operation_id}`,
        `decision: ${report.decision}`,
        `requested execute: ${report.requested_execute ? "yes" : "no"}`,
        `would execute: ${report.would_execute ? "yes" : "no"}`,
        `allow expensive: ${report.allow_expensive ? "yes" : "no"}`,
        `expensive: ${report.expensive ? "yes" : "no"}`,
    ];
    if (report.operation) {
        lines.push(`operation: ${report.operation.kind}/${report.operation.id}`);
    }
    if (report.command) {
        lines.push(`command: ${report.command}`);
    }
    lines.push(`dry-run: ${report.dry_run.decision}`);
    lines.push(`preflight: ${report.dry_run.preflight.decision}`);
    for (const failure of report.failures) {
        lines.push(`failure: ${failure}`);
    }
    return lines.join("\n");
}

export function renderClassifierPackageOperationExecutionText(report: ClassifierPackageOperationExecutionReport): string {
    const lines = [
        `classifier package operation execution: ${report.package_key}/${report.operation_id}`,
        `decision: ${report.decision}`,
        `executed: ${report.executed ? "yes" : "no"}`,
        `exit code: ${report.exit_code === null ? "null" : String(report.exit_code)}`,
        `duration ms: ${report.duration_ms}`,
        `plan: ${report.plan.decision}`,
    ];
    if (report.operation) {
        lines.push(`operation: ${report.operation.kind}/${report.operation.id}`);
    }
    if (report.command) {
        lines.push(`command: ${report.command}`);
    }
    for (const output of report.outputs) {
        const change = report.output_changes.find((entry) => entry.path === output.path);
        lines.push(`- output ${output.exists ? "ok" : "missing"} ${change?.changed_during_run ? "changed" : "unchanged"} ${output.path}`);
    }
    if (report.stdout.length > 0) {
        lines.push("stdout:");
        lines.push(report.stdout.trimEnd());
    }
    if (report.stderr.length > 0) {
        lines.push("stderr:");
        lines.push(report.stderr.trimEnd());
    }
    for (const failure of report.failures) {
        lines.push(`failure: ${failure}`);
    }
    return lines.join("\n");
}

function executionFailed(decision: ClassifierPackageOperationExecutionReport["decision"]): boolean {
    return decision !== "executed";
}

export function renderClassifierPackagesOperationsText(report: ClassifierPackagesOperationsReport): string {
    const lines = [
        `classifier packages: ${report.totals.package_count}`,
        `operations: ${report.totals.operation_count}`,
        `local models: ${report.totals.local_model_count}`,
    ];
    for (const entry of report.packages) {
        lines.push(`- ${entry.package_key} (${entry.package_name})`);
        lines.push(`  manifest: ${entry.manifest}`);
        lines.push(`  kind/input: ${entry.kind}/${entry.input}`);
        lines.push(`  labels/targets: ${entry.label_count}/${entry.target_count}`);
        lines.push(`  fixtures/assets: ${entry.fixture_count}/${entry.asset_count}`);
        lines.push(`  lifecycle: ${entry.lifecycle_readiness.status}${entry.lifecycle_readiness.missing_required_kinds.length > 0 ? ` missing ${entry.lifecycle_readiness.missing_required_kinds.join(", ")}` : ""}`);
        lines.push(`  operation kinds: ${Object.entries(entry.operation_kinds).filter(([, count]) => count > 0).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none"}`);
        lines.push(`  operations: ${entry.operation_count === 0 ? "none" : entry.operations.map((operation) => operation.id).join(", ")}`);
    }
    return lines.join("\n");
}

export function renderClassifierPackageExecutionHistoryText(report: ClassifierPackageExecutionHistoryReport): string {
    const lines = [
        `classifier package execution history: ${report.root}`,
        `reports: ${report.totals.report_count}`,
        `executed/failed/not-executed: ${report.totals.executed_count}/${report.totals.failed_count}/${report.totals.not_executed_count}`,
        `outputs changed/missing: ${report.totals.changed_output_count}/${report.totals.missing_output_count}`,
    ];
    for (const entry of report.reports) {
        lines.push(`- ${entry.decision} ${entry.package_key}/${entry.operation_id}`);
        lines.push(`  plan: ${entry.plan_decision}`);
        lines.push(`  outputs changed/missing: ${entry.changed_output_count}/${entry.missing_output_count}`);
        lines.push(`  report: ${entry.path}`);
        for (const failure of entry.failures) {
            lines.push(`  failure: ${failure}`);
        }
    }
    return lines.join("\n");
}

export function renderClassifierPackageExecutionFactsText(report: ClassifierPackageExecutionFactProjectionReport): string {
    const lines = [
        `classifier package execution facts: ${report.root}`,
        `sources: ${report.totals.source_report_count}`,
        `nodes/edges/facts: ${report.totals.node_count}/${report.totals.edge_count}/${report.totals.fact_count}`,
        `execution/guard/artifact/lifecycle facts: ${report.totals.execution_fact_count}/${report.totals.guard_fact_count}/${report.totals.artifact_fact_count}/${report.totals.lifecycle_fact_count}`,
    ];
    for (const fact of report.facts) {
        lines.push(`- ${fact.kind} ${fact.subject} ${fact.predicate}${fact.object ? ` ${fact.object}` : ""}`);
        lines.push(`  evidence_edges: ${fact.evidence_edges.join(", ") || "none"}`);
    }
    return lines.join("\n");
}

export function renderClassifierPackageExecutionWritePlanText(report: ClassifierPackageExecutionSurrealWritePlanReport): string {
    const lines = [
        `classifier package execution write plan: ${report.root}`,
        `statements: ${report.totals.statement_count}`,
        `nodes/edges/facts: ${report.totals.node_statement_count}/${report.totals.edge_statement_count}/${report.totals.fact_statement_count}`,
        `tables: ${report.tables.join(", ")}`,
    ];
    for (const statement of report.statements.slice(0, 10)) {
        lines.push(`- ${statement}`);
    }
    if (report.statements.length > 10) {
        lines.push(`... ${report.statements.length - 10} more statements`);
    }
    return lines.join("\n");
}

export function renderClassifierPackageExecutionApplyText(report: ClassifierPackageExecutionSurrealApplyReport): string {
    const lines = [
        `classifier package execution apply: ${report.root}`,
        `decision: ${report.decision}`,
        `applied: ${report.applied ? "yes" : "no"}`,
        `statements attempted/applied/failed: ${report.attempted_statement_count}/${report.applied_statement_count}/${report.failed_statement_count}`,
        `tables: ${report.tables.join(", ")}`,
    ];
    if (report.first_failure) {
        lines.push(`first failure: ${report.first_failure.index} ${report.first_failure.message}`);
        lines.push(report.first_failure.statement);
    }
    return lines.join("\n");
}

export function renderClassifierPackageExecutionGraphHealthText(report: ClassifierPackageExecutionGraphHealthReport): string {
    const lines = [
        "classifier package execution graph health",
        `decision: ${report.decision}`,
        `mode: ${report.query.mode}`,
        `filter operation: ${report.query.operation_id ?? "all"}`,
        `filter artifact: ${report.query.artifact_path ?? "all"}`,
        `nodes/edges/facts: ${report.totals.node_count}/${report.totals.edge_count}/${report.totals.fact_count}`,
        `packages/operations/executions/artifacts: ${report.totals.package_count}/${report.totals.operation_count}/${report.totals.execution_count}/${report.totals.artifact_count}`,
        `execution/guard/artifact/lifecycle/helper facts: ${report.totals.execution_fact_count}/${report.totals.guard_fact_count}/${report.totals.artifact_fact_count}/${report.totals.lifecycle_fact_count}/${report.totals.embedding_helper_fact_count}`,
        `results operations/guarded/changed/lifecycle/helper/evidence: ${report.result_totals.operation_count}/${report.result_totals.guarded_operation_count}/${report.result_totals.changed_artifact_count}/${report.result_totals.lifecycle_fact_count}/${report.result_totals.embedding_helper_fact_count}/${report.result_totals.evidence_path_count}`,
    ];
    for (const operation of report.operations) {
        lines.push(`- ${operation.package_key}/${operation.operation_id}`);
        lines.push(`  runs executed/failed/guarded: ${operation.executed_count}/${operation.failed_count}/${operation.guarded_count}`);
        lines.push(`  changed artifacts: ${operation.changed_artifact_count}`);
        if (operation.last_execution) {
            lines.push(`  last: ${operation.last_execution.decision ?? "unknown"} (${operation.last_execution.plan_decision ?? "unknown"})`);
            if (operation.last_execution.source_path) {
                lines.push(`  report: ${operation.last_execution.source_path}`);
            }
        }
    }
    if (report.guarded_operations.length > 0) {
        lines.push("guarded operations:");
        for (const operation of report.guarded_operations) {
            lines.push(`- ${operation.package_key}/${operation.operation_id}: ${operation.guarded_count}`);
        }
    }
    if (report.changed_artifacts.length > 0) {
        lines.push("changed artifacts:");
        for (const artifact of report.changed_artifacts.slice(0, 10)) {
            lines.push(`- ${artifact.package_key ?? "unknown"}/${artifact.operation_id ?? "unknown"} ${artifact.artifact_path}`);
            if (artifact.evidence_path) {
                lines.push(`  evidence: ${artifact.evidence_path}`);
            }
        }
    }
    if (report.lifecycle_facts.length > 0) {
        lines.push("lifecycle facts:");
        for (const fact of report.lifecycle_facts) {
            const value = typeof fact.value === "string"
                ? fact.value
                : JSON.stringify(fact.value);
            lines.push(`- ${fact.predicate}: ${value}`);
            if (fact.lifecycle_key || fact.artifact_path) {
                lines.push(`  source: ${fact.lifecycle_key ?? "unknown"} ${fact.artifact_path ?? ""}`.trimEnd());
            }
            if (fact.evidence_paths.length > 0) {
                lines.push(`  evidence: ${fact.evidence_paths.join(", ")}`);
            }
        }
    }
    if (report.embedding_helper_facts.length > 0) {
        lines.push("embedding helper facts:");
        for (const fact of report.embedding_helper_facts) {
            if (fact.kind === "embedding_helper_routing_candidate") {
                lines.push(`- routing ${fact.predicate}: threshold=${fact.threshold ?? "unknown"} positive_recall=${fact.positive_recall_after_routing_mean ?? "unknown"} call_reduction=${fact.setfit_call_reduction_rate_mean ?? "unknown"}`);
            } else if (fact.kind === "embedding_helper_hard_negative_candidate") {
                lines.push(`- hard-negative ${fact.source_fixture_id ?? fact.subject}: ${fact.predicate} status=${fact.status ?? "unknown"} proposed=${fact.proposed_label ?? "unknown"} seeds=${fact.seed_count ?? "unknown"} nearest=${fact.max_nearest_positive_similarity ?? "unknown"}${fact.promoted_fixture_id ? ` promoted=${fact.promoted_fixture_id}` : ""}`);
                for (const neighbor of fact.nearest_neighbors ?? []) {
                    lines.push(`  nearest: ${neighbor.fixture_id} sim=${neighbor.similarity ?? "unknown"}`);
                }
            } else if (fact.kind === "embedding_helper_dedupe_cluster") {
                lines.push(`- dedupe ${fact.subject}: ${fact.predicate}`);
            } else {
                lines.push(`- ${fact.kind} ${fact.predicate}: ${fact.subject}`);
            }
            if (fact.evidence_paths.length > 0) {
                lines.push(`  evidence: ${fact.evidence_paths.join(", ")}`);
            }
        }
    }
    if (report.evidence_paths.length > 0) {
        lines.push("evidence paths:");
        for (const path of report.evidence_paths) {
            lines.push(`- ${path}`);
        }
    }
    return lines.join("\n");
}

export function renderClassifierLifecycleInsightText(report: ClassifierLifecycleInsightReport): string {
    const lines = [
        "classifier lifecycle",
        `decision: ${report.decision}`,
        `packages local-ready/incomplete: ${report.totals.local_model_ready_count}/${report.totals.local_model_incomplete_count}`,
        `graph operations/guarded/failed/changed: ${report.totals.graph_operation_count}/${report.totals.guarded_operation_count}/${report.totals.failed_operation_count}/${report.totals.changed_artifact_count}`,
        `review pending labels/hard-negatives: ${report.totals.pending_blind_labels}/${report.totals.pending_hard_negatives}`,
    ];
    for (const entry of report.packages) {
        lines.push(`- ${entry.package_key} (${entry.kind})`);
        lines.push(`  lifecycle: ${entry.lifecycle_readiness.status}`);
        lines.push(`  operations manifest/graph/guarded/failed: ${entry.operation_count}/${entry.graph_operation_count}/${entry.guarded_operation_count}/${entry.failed_operation_count}`);
        lines.push(`  changed artifacts: ${entry.changed_artifact_count}`);
        if (entry.last_execution) {
            lines.push(`  last: ${entry.last_execution.decision ?? "unknown"} (${entry.last_execution.plan_decision ?? "unknown"})`);
        }
    }
    if (report.failed_operations.length > 0) {
        lines.push("failed operations:");
        for (const operation of report.failed_operations) {
            lines.push(`- ${operation.package_key}/${operation.operation_id}: ${operation.failed_count}`);
        }
    }
    if (report.workflow_status.exists) {
        lines.push(`workflow status: ${report.workflow_status.decision ?? "unknown"} (${report.workflow_status.path})`);
    } else {
        lines.push(`workflow status: missing (${report.workflow_status.path})`);
    }
    if (report.workflow_status.proposal_review) {
        const review = report.workflow_status.proposal_review;
        lines.push(`proposal review: ${review.decision ?? "unknown"} (${review.report_path})`);
        lines.push(`  ready/pending/invalid: ${review.ready_count ?? 0}/${review.pending_count ?? 0}/${review.invalid_count ?? 0}`);
        if (review.missing_field_count !== undefined) {
            lines.push(`  missing fields: ${review.missing_field_count}`);
        }
        if (review.summary_path) {
            lines.push(`  checklist: ${review.summary_path}`);
        }
    }
    if (report.workflow_status.proposal_promotion) {
        const promotion = report.workflow_status.proposal_promotion;
        lines.push(`proposal promotion: ${promotion.decision ?? "unknown"} (${promotion.report_path})`);
        lines.push(`  drafts/skipped: ${promotion.emitted_draft_count ?? 0}/${promotion.skipped_proposal_count ?? 0}`);
        if (promotion.failures.length > 0) {
            lines.push(`  failures: ${promotion.failures.join("; ")}`);
        }
    }
    if (report.workflow_status.proposal_ready_smoke) {
        const smoke = report.workflow_status.proposal_ready_smoke;
        lines.push(`proposal ready smoke: ${smoke.promotion_decision ?? "unknown"} (${smoke.promotion_report_path})`);
        lines.push(`  drafts/skipped: ${smoke.emitted_draft_count ?? 0}/${smoke.skipped_proposal_count ?? 0}`);
    }
    if (report.review_pipeline) {
        const pipeline = report.review_pipeline;
        lines.push(`review pipeline: ${pipeline.status ?? "unknown"} (${pipeline.report_path})`);
        lines.push(`  command: ${pipeline.command_kind ?? "unknown"} prepared=${pipeline.prepared_status ?? "unknown"}`);
        lines.push(`  outputs: ${pipeline.output_verification_status ?? "unknown"} checked=${pipeline.checked_artifact_count} missing=${pipeline.missing_required_artifact_count}`);
        lines.push(`  execute/continue: ${pipeline.can_execute === true ? "yes" : pipeline.can_execute === false ? "no" : "unknown"}/${pipeline.can_continue === true ? "yes" : pipeline.can_continue === false ? "no" : "unknown"} next=${pipeline.next_action}`);
        if (pipeline.failures.length > 0) {
            lines.push(`  failures: ${pipeline.failures.join("; ")}`);
        }
    }
    if (report.workflow_status.focused_batch) {
        const batch = report.workflow_status.focused_batch;
        lines.push(`focused batch: ${batch.batch_path ?? "unknown"}`);
        if (batch.batch_source) {
            lines.push(`  batch source: ${batch.batch_source}`);
        }
        lines.push(`  selected ordinals: ${batch.selected_ordinals.join(", ") || "none"}`);
        if (batch.context_enriched_sections !== undefined) {
            lines.push(`  context enriched sections: ${batch.context_enriched_sections}`);
        }
        if (batch.vocabulary_included !== undefined) {
            lines.push(`  vocabulary included: ${batch.vocabulary_included ? "yes" : "no"}`);
        }
        lines.push(`  review pending: ${batch.review_pending ?? "unknown"}`);
        lines.push(`  hard negatives pending: ${batch.hard_negative_pending ?? "unknown"}`);
        if (batch.completed_field_total !== undefined && batch.review_field_total !== undefined) {
            lines.push(`  field completion: ${batch.completed_field_total}/${batch.review_field_total} (${batch.field_completion_percent ?? "unknown"}%)`);
        }
        if (batch.row_completion_percent !== undefined) {
            lines.push(`  row completion: ${batch.row_completion_percent}%`);
        }
        if (batch.blocking_field_total !== undefined) {
            lines.push(`  blocking fields: ${batch.blocking_field_total}`);
        }
        if (batch.missing_field_counts && Object.keys(batch.missing_field_counts).length > 0) {
            lines.push(`  missing fields: ${Object.entries(batch.missing_field_counts).map(([field, count]) => `${field}=${count}`).join(", ")}`);
        }
        if (batch.invalid_field_counts && Object.keys(batch.invalid_field_counts).length > 0) {
            lines.push(`  invalid fields: ${Object.entries(batch.invalid_field_counts).map(([field, count]) => `${field}=${count}`).join(", ")}`);
        }
        if (batch.invalid_refs.length > 0) {
            lines.push("  invalid refs:");
            for (const ref of batch.invalid_refs.slice(0, 5)) {
                lines.push(`  - #${ref.ordinal} ${ref.id}${ref.invalid.length > 0 ? ` invalid ${ref.invalid.join(", ")}` : ""}`);
            }
        }
        if (batch.incomplete_refs.length > 0) {
            lines.push("  incomplete refs:");
            for (const ref of batch.incomplete_refs.slice(0, 5)) {
                const parts = [
                    ref.missing.length > 0 ? `missing ${ref.missing.join(", ")}` : "",
                    ref.invalid.length > 0 ? `invalid ${ref.invalid.join(", ")}` : "",
                ].filter(Boolean);
                lines.push(`  - #${ref.ordinal} ${ref.id}${parts.length > 0 ? ` ${parts.join("; ")}` : ""}`);
            }
        }
        if (batch.review_tasks.length > 0) {
            lines.push(`  review tasks: ${batch.review_task_total ?? batch.review_tasks.length}`);
            for (const task of batch.review_tasks.slice(0, 5)) {
                const fieldParts = [
                    task.missing.length > 0 ? `missing ${task.missing.join(", ")}` : "",
                    task.invalid.length > 0 ? `invalid ${task.invalid.join(", ")}` : "",
                ].filter(Boolean);
                const suggestion = task.suggested_label || task.suggested_target
                    ? `suggested ${task.suggested_label ?? "unknown"}/${task.suggested_target ?? "unknown"}`
                    : "suggested unknown";
                const hardNegative = task.hard_negative_candidate_id && task.hard_negative_candidate_id !== "_none_"
                    ? `; hard-negative ${task.hard_negative_proposed_label ?? "unknown"}/${task.hard_negative_proposed_target ?? "unknown"}`
                    : "";
                lines.push(`  - #${task.ordinal} ${task.id} ${suggestion}; ${fieldParts.join("; ") || "no blocking fields"}${hardNegative}`);
                if (task.evidence_refs.length > 0) {
                    lines.push(`    evidence: ${task.evidence_refs.slice(0, 3).join(", ")}${task.evidence_refs.length > 3 ? ` +${task.evidence_refs.length - 3} more` : ""}`);
                }
            }
        }
        if (batch.suggestion_draft) {
            const draft = batch.suggestion_draft;
            lines.push(`  suggestion draft: ${draft.decision ?? "unknown"} (${draft.path})`);
            if (draft.before_blocking_field_total !== undefined && draft.after_blocking_field_total !== undefined) {
                lines.push(`    blocking fields: ${draft.before_blocking_field_total}->${draft.after_blocking_field_total}`);
            }
            if (draft.before_field_completion_percent !== undefined && draft.after_field_completion_percent !== undefined) {
                lines.push(`    field completion: ${draft.before_field_completion_percent}%->${draft.after_field_completion_percent}%`);
            }
            lines.push(`    prefilled labels/targets/hard-negatives: ${draft.prefilled_review_label ?? 0}/${draft.prefilled_review_target ?? 0}/${draft.prefilled_hard_negative_status ?? 0}`);
            if (draft.review_note_prompts !== undefined || draft.hard_negative_note_prompts !== undefined) {
                lines.push(`    note prompts review/hard-negative: ${draft.review_note_prompts ?? 0}/${draft.hard_negative_note_prompts ?? 0}`);
            }
            if (draft.after_missing_field_counts && Object.keys(draft.after_missing_field_counts).length > 0) {
                lines.push(`    remaining missing: ${Object.entries(draft.after_missing_field_counts).map(([field, count]) => `${field}=${count}`).join(", ")}`);
            }
            if (draft.eval_decision) {
                lines.push(`    draft eval: ${draft.eval_decision}${draft.eval_blocking_field_total === undefined ? "" : ` (${draft.eval_blocking_field_total} blocking fields)`}`);
            }
        }
        if (batch.draft_promotion) {
            const promotion = batch.draft_promotion;
            lines.push(`  draft promotion: ${promotion.decision ?? "unknown"} (${promotion.report_path})`);
            if (promotion.draft_eval_decision) {
                lines.push(`    draft eval: ${promotion.draft_eval_decision}`);
            }
            if (promotion.blocking_field_total !== undefined) {
                lines.push(`    blocking fields: ${promotion.blocking_field_total}`);
            }
            if (promotion.failures.length > 0) {
                lines.push(`    failures: ${promotion.failures.join("; ")}`);
            }
        }
    }
    if (report.workflow_status.invalid_blind_label_note_count) {
        lines.push(`invalid blind label notes: ${report.workflow_status.invalid_blind_label_note_count}`);
    }
    if (report.workflow_status.invalid_hard_negative_note_count) {
        lines.push(`invalid hard-negative notes: ${report.workflow_status.invalid_hard_negative_note_count}`);
    }
    if (report.blocking_items.length > 0) {
        lines.push("blocking items:");
        for (const item of report.blocking_items) {
            lines.push(`- ${item}`);
        }
    }
    if (report.workflow_status.next_actions.length > 0) {
        lines.push("next actions:");
        for (const action of report.workflow_status.next_actions.slice(0, 5)) {
            lines.push(`- ${action}`);
        }
    }
    return lines.join("\n");
}

const serviceErrorText = (error: unknown): string => {
    if (error && typeof error === "object" && "_tag" in error) {
        if ("message" in error && typeof error.message === "string") {
            return `${String(error._tag)}: ${error.message}`;
        }
        return String(error._tag);
    }
    return error instanceof Error ? error.message : String(error);
};

export const runClassifiersPackageOperations = (
    input: ClassifierPackageOperationsCommandInput,
): Effect.Effect<void, never, ClassifierPackageService | SurrealClient> =>
    Effect.gen(function* () {
        const packages = yield* ClassifierPackageService;
        if (input.applyWritePlan) {
            const root = input.root ?? ".ax/experiments";
            const report = input.out
                ? yield* packages.writeExecutionSurrealApplyReport({
                    root,
                    ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
                    out: input.out,
                })
                : yield* packages.applyExecutionSurrealWritePlanReport({
                    root,
                    ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
                });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageExecutionApplyText(report));
            }
            if (report.decision !== "applied") {
                process.exitCode = 1;
            }
            return;
        }
        if (input.graphHealth) {
            const query = {
                mode: input.graphMode ?? "summary",
                ...(input.operationId ? { operation_id: input.operationId } : {}),
                ...(input.artifact ? { artifact_path: input.artifact } : {}),
            } as const;
            const report = input.out
                ? yield* packages.writeExecutionGraphHealthReport({ out: input.out, query })
                : yield* packages.executionGraphHealthReport({ query });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageExecutionGraphHealthText(report));
            }
            if (report.decision !== "healthy") {
                process.exitCode = 1;
            }
            return;
        }
        if (input.writePlan) {
            const root = input.root ?? ".ax/experiments";
            const report = input.out
                ? yield* packages.writeExecutionSurrealWritePlanReport({
                    root,
                    ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
                    out: input.out,
                })
                : yield* packages.executionSurrealWritePlanReport({
                    root,
                    ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
                });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageExecutionWritePlanText(report));
            }
            return;
        }
        if (input.facts) {
            const root = input.root ?? ".ax/experiments";
            const report = input.out
                ? yield* packages.writeExecutionFactProjectionReport({
                    root,
                    ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
                    out: input.out,
                })
                : yield* packages.executionFactProjectionReport({
                    root,
                    ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
                });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageExecutionFactsText(report));
            }
            return;
        }
        if (input.history) {
            const root = input.root ?? ".ax/experiments";
            const report = input.out
                ? yield* packages.writeExecutionHistoryReport({ root, out: input.out })
                : yield* packages.executionHistoryReport({ root });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageExecutionHistoryText(report));
            }
            return;
        }
        if (input.execute) {
            if (!input.operationId) {
                console.error("axctl classifiers package-operations: --execute requires --operation=<id>");
                process.exitCode = 2;
                return;
            }
            const report = input.out
                ? yield* packages.writeOperationExecutionReport({
                    manifestPath: input.manifestPath,
                    operationId: input.operationId,
                    allowExecute: true,
                    allowExpensive: input.allowExpensive ?? false,
                    out: input.out,
                })
                : yield* packages.executeOperation({
                    manifestPath: input.manifestPath,
                    operationId: input.operationId,
                    allowExecute: true,
                    allowExpensive: input.allowExpensive ?? false,
                });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageOperationExecutionText(report));
            }
            if (executionFailed(report.decision)) {
                process.exitCode = 1;
            }
            return;
        }
        if (input.dryRun) {
            if (!input.operationId) {
                console.error("axctl classifiers package-operations: --dry-run requires --operation=<id>");
                process.exitCode = 2;
                return;
            }
            const report = input.out
                ? yield* packages.writeOperationDryRunReport({
                    manifestPath: input.manifestPath,
                    operationId: input.operationId,
                    out: input.out,
                })
                : yield* packages.operationDryRunReport({
                    manifestPath: input.manifestPath,
                    operationId: input.operationId,
                });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageOperationDryRunText(report));
            }
            if (dryRunFailed(report.decision)) {
                process.exitCode = 1;
            }
            return;
        }
        if (input.preflight) {
            if (!input.operationId) {
                console.error("axctl classifiers package-operations: --preflight requires --operation=<id>");
                process.exitCode = 2;
                return;
            }
            const report = input.out
                ? yield* packages.writeOperationPreflightReport({
                    manifestPath: input.manifestPath,
                    operationId: input.operationId,
                    out: input.out,
                })
                : yield* packages.operationPreflightReport({
                    manifestPath: input.manifestPath,
                    operationId: input.operationId,
                });
            if (input.json) {
                console.log(JSON.stringify(report, null, 2));
            } else if (!input.out) {
                console.log(renderClassifierPackageOperationPreflightText(report));
            }
            if (preflightFailed(report.decision)) {
                process.exitCode = 1;
            }
            return;
        }
        const report = input.out
            ? yield* packages.writeOperationsReport({ ...input, out: input.out })
            : yield* packages.operationsReport(input);

        if (input.json) {
            console.log(JSON.stringify(report, null, 2));
        } else if (!input.out) {
            console.log(renderClassifierPackageOperationsText(report));
        }
        if (report.decision === "operation_missing") {
            process.exitCode = 1;
        }
    }).pipe(
        Effect.catch((error) =>
            Effect.sync(() => {
                console.error(`axctl classifiers package-operations: ${serviceErrorText(error)}`);
                process.exitCode = 1;
            })
        ),
    );

export const runClassifiersLifecycle = (
    input: {
        readonly root?: string;
        readonly workflowStatusPath?: string;
        readonly out?: string;
        readonly json: boolean;
    },
): Effect.Effect<void, never, ClassifierPackageService | SurrealClient> =>
    Effect.gen(function* () {
        const packages = yield* ClassifierPackageService;
        const report = input.out
            ? yield* packages.writeLifecycleInsightReport({
                ...(input.root === undefined ? {} : { root: input.root }),
                ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
                out: input.out,
            })
            : yield* packages.lifecycleInsightReport({
                ...(input.root === undefined ? {} : { root: input.root }),
                ...(input.workflowStatusPath === undefined ? {} : { workflowStatusPath: input.workflowStatusPath }),
            });

        if (input.json) {
            console.log(JSON.stringify(report, null, 2));
        } else if (!input.out) {
            console.log(renderClassifierLifecycleInsightText(report));
        }
        if (!input.out && report.decision !== "healthy") {
            process.exitCode = 1;
        }
    }).pipe(
        Effect.catch((error) =>
            Effect.sync(() => {
                console.error(`axctl classifiers lifecycle: ${serviceErrorText(error)}`);
                process.exitCode = 1;
            })
        ),
    );

export const runClassifiersPackagesOperations = (
    input: ClassifierPackagesOperationsCommandInput,
): Effect.Effect<void, never, ClassifierPackageService> =>
    Effect.gen(function* () {
        const packages = yield* ClassifierPackageService;
        const root = input.root ?? "packages";
        const report = input.out
            ? yield* packages.writePackagesOperationsReport({ root, out: input.out })
            : yield* packages.packagesOperationsReport({ root });

        if (input.json) {
            console.log(JSON.stringify(report, null, 2));
        } else if (!input.out) {
            console.log(renderClassifierPackagesOperationsText(report));
        }
    }).pipe(
        Effect.catch((error) =>
            Effect.sync(() => {
                console.error(`axctl classifiers package-operations: ${serviceErrorText(error)}`);
                process.exitCode = 1;
            })
        ),
    );
