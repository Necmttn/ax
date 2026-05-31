import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec } from "node:child_process";
import { safeJsonParse } from "../lib/shared/safe-json.ts";
import {
    recordRef,
    surrealJson,
    surrealJsonOption,
    surrealJsonText,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "../lib/shared/surql.ts";
import {
    findClassifierPackageOperation,
    listClassifierPackageOperations,
    type ClassifierPackageManifest,
    type ClassifierPackageOperation,
    type ClassifierPackageOperationKind,
} from "./package-manifest.ts";

const OPERATION_KINDS: readonly ClassifierPackageOperationKind[] = ["train", "eval", "review", "status", "publish", "debug"];
const LOCAL_MODEL_REQUIRED_OPERATION_KINDS: readonly ClassifierPackageOperationKind[] = ["train", "eval", "review", "status"];
const EXPENSIVE_OPERATION_KINDS = new Set<ClassifierPackageOperationKind>(["train", "eval", "publish"]);

export type ClassifierPackageOperationKindCounts = Record<ClassifierPackageOperationKind, number>;

export interface ClassifierPackageLifecycleReadiness {
    readonly status: "ready" | "incomplete" | "not_applicable";
    readonly required_kinds: readonly ClassifierPackageOperationKind[];
    readonly present_required_kinds: readonly ClassifierPackageOperationKind[];
    readonly missing_required_kinds: readonly ClassifierPackageOperationKind[];
}

export interface ClassifierPackageOperationsReport {
    readonly schema: "ax.classifier_package_operations_report.v1";
    readonly manifest: string;
    readonly package_key: string;
    readonly package_name: string;
    readonly operation_id?: string;
    readonly operations: readonly ClassifierPackageOperation[];
    readonly failures: readonly string[];
    readonly decision: "operations_listed" | "operation_found" | "operation_missing";
}

export interface ClassifierPackageOperationInputStatus {
    readonly path: string;
    readonly exists: boolean;
}

export interface ClassifierPackageOperationArtifactStatus {
    readonly path: string;
    readonly exists: boolean;
    readonly size_bytes?: number;
    readonly modified_at?: string;
}

export interface ClassifierPackageOperationOutputChange {
    readonly path: string;
    readonly before: ClassifierPackageOperationArtifactStatus;
    readonly after: ClassifierPackageOperationArtifactStatus;
    readonly changed_during_run: boolean;
}

export interface ClassifierPackageOperationPreflightReport {
    readonly schema: "ax.classifier_package_operation_preflight_report.v1";
    readonly manifest: string;
    readonly package_key: string;
    readonly package_name: string;
    readonly operation_id: string;
    readonly operation?: ClassifierPackageOperation;
    readonly inputs: readonly ClassifierPackageOperationInputStatus[];
    readonly missing_inputs: readonly string[];
    readonly failures: readonly string[];
    readonly decision: "ready" | "missing_inputs" | "operation_missing";
}

export interface ClassifierPackageOperationDryRunReport {
    readonly schema: "ax.classifier_package_operation_dry_run_report.v1";
    readonly manifest: string;
    readonly package_key: string;
    readonly package_name: string;
    readonly operation_id: string;
    readonly operation?: ClassifierPackageOperation;
    readonly command?: string;
    readonly would_execute: false;
    readonly preflight: ClassifierPackageOperationPreflightReport;
    readonly failures: readonly string[];
    readonly decision: "ready_to_run" | "blocked" | "operation_missing";
}

export interface ClassifierPackageOperationExecutionPlanInput {
    readonly allowExecute: boolean;
    readonly allowExpensive: boolean;
}

export interface ClassifierPackageOperationExecutionPlanReport {
    readonly schema: "ax.classifier_package_operation_execution_plan_report.v1";
    readonly manifest: string;
    readonly package_key: string;
    readonly package_name: string;
    readonly operation_id: string;
    readonly operation?: ClassifierPackageOperation;
    readonly command?: string;
    readonly would_execute: boolean;
    readonly requested_execute: boolean;
    readonly allow_expensive: boolean;
    readonly expensive: boolean;
    readonly dry_run: ClassifierPackageOperationDryRunReport;
    readonly failures: readonly string[];
    readonly decision: "ready_to_execute" | "denied_requires_execute" | "denied_expensive" | "blocked" | "operation_missing";
}

export interface ClassifierPackageOperationExecutionReport {
    readonly schema: "ax.classifier_package_operation_execution_report.v1";
    readonly manifest: string;
    readonly package_key: string;
    readonly package_name: string;
    readonly operation_id: string;
    readonly operation?: ClassifierPackageOperation;
    readonly command?: string;
    readonly plan: ClassifierPackageOperationExecutionPlanReport;
    readonly executed: boolean;
    readonly started_at: string;
    readonly finished_at: string;
    readonly duration_ms: number;
    readonly exit_code: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly outputs: readonly ClassifierPackageOperationInputStatus[];
    readonly missing_outputs: readonly string[];
    readonly outputs_before: readonly ClassifierPackageOperationArtifactStatus[];
    readonly output_changes: readonly ClassifierPackageOperationOutputChange[];
    readonly failures: readonly string[];
    readonly decision: "executed" | "failed" | "not_executed";
}

export interface ClassifierPackageOperationsSummary {
    readonly manifest: string;
    readonly package_key: string;
    readonly package_name: string;
    readonly version: string;
    readonly kind: ClassifierPackageManifest["kind"];
    readonly input: ClassifierPackageManifest["input"];
    readonly label_count: number;
    readonly target_count: number;
    readonly fixture_count: number;
    readonly asset_count: number;
    readonly operation_count: number;
    readonly operation_kinds: ClassifierPackageOperationKindCounts;
    readonly lifecycle_readiness: ClassifierPackageLifecycleReadiness;
    readonly operations: readonly ClassifierPackageOperation[];
}

export interface ClassifierPackagesOperationsReport {
    readonly schema: "ax.classifier_packages_operations_report.v1";
    readonly root: string;
    readonly manifests: readonly string[];
    readonly packages: readonly ClassifierPackageOperationsSummary[];
    readonly totals: {
        readonly package_count: number;
        readonly operation_count: number;
        readonly operation_kinds: ClassifierPackageOperationKindCounts;
        readonly local_model_count: number;
        readonly local_model_ready_count: number;
        readonly local_model_incomplete_count: number;
        readonly package_count_with_operations: number;
        readonly package_count_without_operations: number;
    };
}

export interface ClassifierPackageExecutionHistoryEntry {
    readonly path: string;
    readonly package_key: string;
    readonly operation_id: string;
    readonly decision: ClassifierPackageOperationExecutionReport["decision"];
    readonly plan_decision: ClassifierPackageOperationExecutionPlanReport["decision"];
    readonly executed: boolean;
    readonly exit_code: number | null;
    readonly started_at: string;
    readonly finished_at: string;
    readonly duration_ms: number;
    readonly output_count: number;
    readonly missing_output_count: number;
    readonly changed_output_count: number;
    readonly failures: readonly string[];
}

export interface ClassifierPackageExecutionHistoryReport {
    readonly schema: "ax.classifier_package_execution_history_report.v1";
    readonly root: string;
    readonly reports: readonly ClassifierPackageExecutionHistoryEntry[];
    readonly totals: {
        readonly report_count: number;
        readonly executed_count: number;
        readonly failed_count: number;
        readonly not_executed_count: number;
        readonly output_count: number;
        readonly missing_output_count: number;
        readonly changed_output_count: number;
        readonly failure_count: number;
    };
}

export interface ClassifierPackageExecutionFactNode {
    readonly id: string;
    readonly kind: "classifier_package" | "classifier_operation" | "classifier_execution" | "artifact" | "classifier_lifecycle";
    readonly label: string;
    readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ClassifierPackageExecutionFactEdge {
    readonly id: string;
    readonly kind: "declares_operation" | "ran_operation" | "observed_artifact" | "updated_artifact" | "has_evidence";
    readonly from: string;
    readonly to: string;
    readonly evidence_path: string;
    readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ClassifierPackageExecutionFact {
    readonly id: string;
    readonly kind: "classifier_operation_execution" | "classifier_operation_guard" | "classifier_artifact_observation" | "classifier_lifecycle_status";
    readonly subject: string;
    readonly predicate: string;
    readonly object?: string;
    readonly value?: string | number | boolean | readonly string[] | null;
    readonly evidence_edges: readonly string[];
    readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ClassifierPackageExecutionFactProjectionReport {
    readonly schema: "ax.classifier_package_execution_fact_projection.v1";
    readonly root: string;
    readonly source_reports: readonly string[];
    readonly nodes: readonly ClassifierPackageExecutionFactNode[];
    readonly edges: readonly ClassifierPackageExecutionFactEdge[];
    readonly facts: readonly ClassifierPackageExecutionFact[];
    readonly totals: {
        readonly source_report_count: number;
        readonly node_count: number;
        readonly edge_count: number;
        readonly fact_count: number;
        readonly execution_fact_count: number;
        readonly guard_fact_count: number;
        readonly artifact_fact_count: number;
        readonly lifecycle_fact_count: number;
    };
}

export interface ClassifierPackageExecutionSurrealWritePlanReport {
    readonly schema: "ax.classifier_package_execution_surreal_write_plan.v1";
    readonly root: string;
    readonly source_projection_schema: ClassifierPackageExecutionFactProjectionReport["schema"];
    readonly statements: readonly string[];
    readonly tables: readonly string[];
    readonly totals: {
        readonly statement_count: number;
        readonly node_statement_count: number;
        readonly edge_statement_count: number;
        readonly fact_statement_count: number;
    };
}

export interface ClassifierPackageExecutionSurrealApplyReport {
    readonly schema: "ax.classifier_package_execution_surreal_apply_report.v1";
    readonly root: string;
    readonly source_write_plan_schema: ClassifierPackageExecutionSurrealWritePlanReport["schema"];
    readonly applied: boolean;
    readonly attempted_statement_count: number;
    readonly applied_statement_count: number;
    readonly failed_statement_count: number;
    readonly first_failure?: {
        readonly index: number;
        readonly statement: string;
        readonly message: string;
    };
    readonly tables: readonly string[];
    readonly decision: "applied" | "failed";
}

export interface ClassifierGraphNodeRow {
    readonly graph_id: string;
    readonly kind: string;
    readonly label: string;
    readonly properties_json: string;
    readonly source_kind?: string;
}

export interface ClassifierGraphEdgeRow {
    readonly graph_id: string;
    readonly kind: string;
    readonly from_id: string;
    readonly to_id: string;
    readonly evidence_path: string;
    readonly properties_json: string;
    readonly source_kind?: string;
}

export interface ClassifierGraphFactRow {
    readonly graph_id: string;
    readonly kind: string;
    readonly subject: string;
    readonly predicate: string;
    readonly object?: string;
    readonly value_json?: string;
    readonly evidence_edges_json: string;
    readonly properties_json: string;
    readonly source_kind?: string;
}

export interface ClassifierGraphOperationHealth {
    readonly package_key: string;
    readonly operation_id: string;
    readonly operation_kind: string | null;
    readonly expensive: boolean | null;
    readonly run_count: number;
    readonly executed_count: number;
    readonly failed_count: number;
    readonly guarded_count: number;
    readonly changed_artifact_count: number;
    readonly evidence_paths: readonly string[];
    readonly last_execution?: {
        readonly graph_id: string;
        readonly decision: string | null;
        readonly plan_decision: string | null;
        readonly executed: boolean | null;
        readonly started_at: string | null;
        readonly finished_at: string | null;
        readonly duration_ms: number | null;
        readonly source_path: string | null;
    };
}

export interface ClassifierGraphChangedArtifact {
    readonly execution_id: string;
    readonly artifact_id: string;
    readonly artifact_path: string;
    readonly operation_id?: string;
    readonly package_key?: string;
    readonly evidence_path: string;
}

export interface ClassifierGraphLifecycleFact {
    readonly graph_id: string;
    readonly subject: string;
    readonly predicate: string;
    readonly value: unknown;
    readonly lifecycle_key?: string;
    readonly artifact_path?: string;
    readonly evidence_edges: readonly string[];
    readonly evidence_paths: readonly string[];
}

export interface ClassifierGraphEmbeddingHelperFact {
    readonly graph_id: string;
    readonly kind: string;
    readonly subject: string;
    readonly predicate: string;
    readonly object?: string;
    readonly value: unknown;
    readonly status?: string;
    readonly source_fixture_id?: string;
    readonly promoted_fixture_id?: string;
    readonly threshold?: string;
    readonly proposed_label?: string;
    readonly seed_count?: number;
    readonly max_nearest_positive_similarity?: number;
    readonly setfit_call_reduction_rate_mean?: number;
    readonly positive_recall_after_routing_mean?: number;
    readonly nearest_neighbors?: readonly {
        readonly fixture_id: string;
        readonly similarity?: number;
    }[];
    readonly evidence_edges: readonly string[];
    readonly evidence_paths: readonly string[];
}

export type ClassifierGraphHealthMode = "summary" | "guarded" | "changed-artifacts" | "evidence" | "lifecycle" | "embedding-helper";

export interface ClassifierGraphHealthQuery {
    readonly mode: ClassifierGraphHealthMode;
    readonly operation_id?: string;
    readonly artifact_path?: string;
    readonly predicate?: string;
}

export interface ClassifierPackageExecutionGraphHealthReport {
    readonly schema: "ax.classifier_package_execution_graph_health_report.v1";
    readonly tables: readonly string[];
    readonly query: ClassifierGraphHealthQuery;
    readonly operations: readonly ClassifierGraphOperationHealth[];
    readonly guarded_operations: readonly ClassifierGraphOperationHealth[];
    readonly changed_artifacts: readonly ClassifierGraphChangedArtifact[];
    readonly lifecycle_facts: readonly ClassifierGraphLifecycleFact[];
    readonly embedding_helper_facts: readonly ClassifierGraphEmbeddingHelperFact[];
    readonly evidence_paths: readonly string[];
    readonly totals: {
        readonly node_count: number;
        readonly edge_count: number;
        readonly fact_count: number;
        readonly package_count: number;
        readonly operation_count: number;
        readonly execution_count: number;
        readonly artifact_count: number;
        readonly execution_fact_count: number;
        readonly guard_fact_count: number;
        readonly artifact_fact_count: number;
        readonly lifecycle_fact_count: number;
        readonly embedding_helper_fact_count: number;
        readonly changed_artifact_count: number;
        readonly evidence_path_count: number;
    };
    readonly result_totals: {
        readonly operation_count: number;
        readonly guarded_operation_count: number;
        readonly changed_artifact_count: number;
        readonly lifecycle_fact_count: number;
        readonly embedding_helper_fact_count: number;
        readonly evidence_path_count: number;
    };
    readonly decision: "healthy" | "empty_graph";
}

export interface ClassifierLifecycleReviewStatus {
    readonly path: string;
    readonly exists: boolean;
    readonly schema?: string;
    readonly decision?: string;
    readonly pending_blind_labels?: number;
    readonly pending_hard_negatives?: number;
    readonly accepted_hard_negatives?: number;
    readonly invalid_blind_label_note_count?: number;
    readonly invalid_hard_negative_note_count?: number;
    readonly proposal_review?: {
        readonly report_path: string;
        readonly summary_path?: string;
        readonly decision?: string;
        readonly proposal_count?: number;
        readonly ready_count?: number;
        readonly pending_count?: number;
        readonly invalid_count?: number;
        readonly missing_field_count?: number;
        readonly failures: readonly string[];
    };
    readonly proposal_promotion?: {
        readonly report_path: string;
        readonly decision?: string;
        readonly proposal_count?: number;
        readonly emitted_draft_count?: number;
        readonly skipped_proposal_count?: number;
        readonly failures: readonly string[];
    };
    readonly proposal_ready_smoke?: {
        readonly promotion_report_path: string;
        readonly draft_dir?: string;
        readonly review_decision?: string;
        readonly promotion_decision?: string;
        readonly proposal_count?: number;
        readonly emitted_draft_count?: number;
        readonly skipped_proposal_count?: number;
        readonly failures: readonly string[];
    };
    readonly review_pipeline_lifecycle?: {
        readonly report_path: string;
        readonly lifecycle_status?: string;
        readonly command_kind?: string;
        readonly prepared_status?: string;
        readonly output_verification_status?: string;
        readonly can_execute?: boolean;
        readonly can_continue?: boolean;
        readonly missing_required_artifact_count?: number;
        readonly checked_artifact_count?: number;
        readonly prepared_argv?: readonly string[];
        readonly output_artifacts?: readonly ClassifierReviewPipelineArtifactSummary[];
        readonly checked_artifacts?: readonly ClassifierReviewPipelineArtifactSummary[];
        readonly failures: readonly string[];
    };
    readonly focused_batch?: {
        readonly batch_path?: string;
        readonly batch_report_path?: string;
        readonly batch_eval_path?: string;
        readonly batch_sync_path?: string;
        readonly refresh_report_path?: string;
        readonly batch_source?: string;
        readonly selected_ordinals: readonly number[];
        readonly context_enriched_sections?: number;
        readonly vocabulary_included?: boolean;
        readonly allowed_label_count?: number;
        readonly allowed_target_count?: number;
        readonly allowed_hard_negative_status_count?: number;
        readonly review_pending?: number;
        readonly hard_negative_pending?: number;
        readonly missing_field_total?: number;
        readonly invalid_field_total?: number;
        readonly blocking_field_total?: number;
        readonly completed_field_total?: number;
        readonly review_field_total?: number;
        readonly field_completion_percent?: number;
        readonly row_completion_percent?: number;
        readonly missing_field_counts?: Record<string, number>;
        readonly invalid_field_counts?: Record<string, number>;
        readonly incomplete_refs: readonly {
            readonly ordinal: number;
            readonly id: string;
            readonly missing: readonly string[];
            readonly invalid: readonly string[];
        }[];
        readonly invalid_refs: readonly {
            readonly ordinal: number;
            readonly id: string;
            readonly invalid: readonly string[];
        }[];
        readonly review_task_total?: number;
        readonly review_tasks: readonly {
            readonly ordinal: number;
            readonly id: string;
            readonly missing: readonly string[];
            readonly invalid: readonly string[];
            readonly blocking_field_count: number;
            readonly suggested_label?: string;
            readonly suggested_target?: string;
            readonly confidence_bucket?: string;
            readonly risk_reasons: readonly string[];
            readonly hard_negative_candidate_id?: string;
            readonly hard_negative_proposed_label?: string;
            readonly hard_negative_proposed_target?: string;
            readonly hard_negative_review_instruction?: string;
            readonly source_turn?: string;
            readonly source_session?: string;
            readonly source_seq?: string;
            readonly evidence_refs: readonly string[];
        }[];
        readonly suggestion_draft?: {
            readonly path: string;
            readonly report_path?: string;
            readonly eval_report_path?: string;
            readonly decision?: string;
            readonly after_decision?: string;
            readonly prefilled_review_label?: number;
            readonly prefilled_review_target?: number;
            readonly prefilled_hard_negative_status?: number;
            readonly review_note_prompts?: number;
            readonly hard_negative_note_prompts?: number;
            readonly before_blocking_field_total?: number;
            readonly after_blocking_field_total?: number;
            readonly before_field_completion_percent?: number;
            readonly after_field_completion_percent?: number;
            readonly after_missing_field_counts?: Record<string, number>;
            readonly eval_decision?: string;
            readonly eval_blocking_field_total?: number;
        };
        readonly draft_promotion?: {
            readonly report_path: string;
            readonly decision?: string;
            readonly draft_eval_decision?: string;
            readonly blocking_field_total?: number;
            readonly missing_field_counts?: Record<string, number>;
            readonly invalid_field_counts?: Record<string, number>;
            readonly failures: readonly string[];
        };
        readonly artifact_consistency_decision?: string;
    };
    readonly next_actions: readonly string[];
}

export interface ClassifierReviewPipelineArtifactSummary {
    readonly kind?: string;
    readonly path: string;
    readonly required_for_handoff?: boolean;
    readonly exists?: boolean;
}

export interface ClassifierLifecyclePackageInsight {
    readonly package_key: string;
    readonly package_name: string;
    readonly kind: ClassifierPackageManifest["kind"];
    readonly lifecycle_readiness: ClassifierPackageLifecycleReadiness;
    readonly operation_count: number;
    readonly operation_kinds: ClassifierPackageOperationKindCounts;
    readonly graph_operation_count: number;
    readonly guarded_operation_count: number;
    readonly failed_operation_count: number;
    readonly changed_artifact_count: number;
    readonly last_execution?: ClassifierGraphOperationHealth["last_execution"];
}

export interface ClassifierReviewPipelineLifecycleInsight {
    readonly report_path: string;
    readonly status?: string;
    readonly command_kind?: string;
    readonly prepared_status?: string;
    readonly output_verification_status?: string;
    readonly can_execute?: boolean;
    readonly can_continue?: boolean;
    readonly missing_required_artifact_count: number;
    readonly checked_artifact_count: number;
    readonly prepared_argv?: readonly string[];
    readonly output_artifacts: readonly ClassifierReviewPipelineArtifactSummary[];
    readonly checked_artifacts: readonly ClassifierReviewPipelineArtifactSummary[];
    readonly failures: readonly string[];
    readonly next_action: "execute_review_pipeline_command" | "repair_review_pipeline_outputs" | "continue_review_pipeline" | "inspect_review_pipeline_lifecycle";
}

export interface ClassifierLifecycleInsightReport {
    readonly schema: "ax.classifier_lifecycle_insight_report.v1";
    readonly packages_root: string;
    readonly graph_tables: readonly string[];
    readonly workflow_status: ClassifierLifecycleReviewStatus;
    readonly packages: readonly ClassifierLifecyclePackageInsight[];
    readonly guarded_operations: readonly ClassifierGraphOperationHealth[];
    readonly failed_operations: readonly ClassifierGraphOperationHealth[];
    readonly changed_artifacts: readonly ClassifierGraphChangedArtifact[];
    readonly blocking_items: readonly string[];
    readonly review_pipeline?: ClassifierReviewPipelineLifecycleInsight;
    readonly totals: {
        readonly package_count: number;
        readonly local_model_count: number;
        readonly local_model_ready_count: number;
        readonly local_model_incomplete_count: number;
        readonly graph_operation_count: number;
        readonly guarded_operation_count: number;
        readonly failed_operation_count: number;
        readonly changed_artifact_count: number;
        readonly pending_blind_labels: number;
        readonly pending_hard_negatives: number;
    };
    readonly decision: "healthy" | "needs_graph_apply" | "needs_human_review" | "has_guarded_operations";
}

function reviewPipelineLifecycleNextAction(
    lifecycle: NonNullable<ClassifierLifecycleReviewStatus["review_pipeline_lifecycle"]>,
): ClassifierReviewPipelineLifecycleInsight["next_action"] {
    if (
        (lifecycle.missing_required_artifact_count ?? 0) > 0 ||
        lifecycle.output_verification_status === "missing_required_outputs" ||
        (lifecycle.failures ?? []).length > 0
    ) {
        return "repair_review_pipeline_outputs";
    }
    if (lifecycle.can_execute === true && lifecycle.lifecycle_status !== "verified_after_execution") {
        return "execute_review_pipeline_command";
    }
    if (lifecycle.can_continue === true) {
        return "continue_review_pipeline";
    }
    return "inspect_review_pipeline_lifecycle";
}

function countOperationKinds(operations: readonly ClassifierPackageOperation[]): ClassifierPackageOperationKindCounts {
    const counts = Object.fromEntries(OPERATION_KINDS.map((kind) => [kind, 0])) as ClassifierPackageOperationKindCounts;
    for (const operation of operations) {
        counts[operation.kind] += 1;
    }
    return counts;
}

function lifecycleReadiness(
    manifest: ClassifierPackageManifest,
    operationKinds: ClassifierPackageOperationKindCounts,
): ClassifierPackageLifecycleReadiness {
    if (manifest.kind !== "local_model") {
        return {
            status: "not_applicable",
            required_kinds: [],
            present_required_kinds: [],
            missing_required_kinds: [],
        };
    }
    const present = LOCAL_MODEL_REQUIRED_OPERATION_KINDS.filter((kind) => operationKinds[kind] > 0);
    const missing = LOCAL_MODEL_REQUIRED_OPERATION_KINDS.filter((kind) => operationKinds[kind] === 0);
    return {
        status: missing.length === 0 ? "ready" : "incomplete",
        required_kinds: LOCAL_MODEL_REQUIRED_OPERATION_KINDS,
        present_required_kinds: present,
        missing_required_kinds: missing,
    };
}

function artifactStatus(path: string): ClassifierPackageOperationArtifactStatus {
    if (!existsSync(path)) {
        return { path, exists: false };
    }
    const stat = statSync(path);
    return {
        path,
        exists: true,
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
    };
}

function outputChanges(
    before: readonly ClassifierPackageOperationArtifactStatus[],
    after: readonly ClassifierPackageOperationArtifactStatus[],
): readonly ClassifierPackageOperationOutputChange[] {
    const beforeByPath = new Map(before.map((status) => [status.path, status]));
    return after.map((afterStatus) => {
        const beforeStatus = beforeByPath.get(afterStatus.path) ?? { path: afterStatus.path, exists: false };
        return {
            path: afterStatus.path,
            before: beforeStatus,
            after: afterStatus,
            changed_during_run: beforeStatus.exists !== afterStatus.exists ||
                beforeStatus.size_bytes !== afterStatus.size_bytes ||
                beforeStatus.modified_at !== afterStatus.modified_at,
        };
    });
}

function factId(value: string): string {
    return value.replace(/[^A-Za-z0-9:_./-]/g, "_");
}

function pathArtifactId(path: string): string {
    return `artifact:${factId(path)}`;
}

function executionId(path: string): string {
    return `classifier_execution:${factId(path)}`;
}

function jsonRecord(value: string | undefined): Record<string, unknown> {
    if (!value) return {};
    const parsed = safeJsonParse<unknown>(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
}

function jsonString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function jsonNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}

function jsonArrayOfStrings(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function jsonArrayOfRecords(value: unknown): readonly Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
        : [];
}

function reviewPipelineArtifactSummaries(value: unknown): readonly ClassifierReviewPipelineArtifactSummary[] {
    return jsonArrayOfRecords(value)
        .map((entry) => {
            const path = stringAt(entry, "path");
            if (!path) return undefined;
            const requiredForHandoff = jsonBoolean(entry.required_for_handoff);
            const exists = jsonBoolean(entry.exists);
            return {
                ...(stringAt(entry, "kind") === undefined ? {} : { kind: stringAt(entry, "kind") as string }),
                path,
                ...(requiredForHandoff === null ? {} : { required_for_handoff: requiredForHandoff }),
                ...(exists === null ? {} : { exists }),
            };
        })
        .filter((entry): entry is ClassifierReviewPipelineArtifactSummary => entry !== undefined);
}

function jsonRecordAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = record[key];
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function numberArrayAt(record: Record<string, unknown>, key: string): readonly number[] {
    const value = record[key];
    return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry)) : [];
}

function numberRecordAt(record: Record<string, unknown>, key: string): Record<string, number> | undefined {
    const value = record[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const entries = Object.entries(value)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
    return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function loadJsonRecord(path: string): Record<string, unknown> {
    if (!existsSync(path)) {
        return {};
    }
    const parsed = safeJsonParse<unknown>(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
}

function loadProposalLifecycleStatus(baseDir: string): Pick<ClassifierLifecycleReviewStatus, "proposal_review" | "proposal_promotion" | "proposal_ready_smoke"> {
    const reviewPath = join(baseDir, "workflow-candidate-proposal-review-current.json");
    const reviewSummaryPath = join(baseDir, "workflow-candidate-proposal-review-current.md");
    const promotionPath = join(baseDir, "workflow-candidate-proposal-promotion-current.json");
    const smokePromotionPath = join(baseDir, "workflow-candidate-proposal-ready-smoke-promotion-current.json");
    const smokeDraftDir = join(baseDir, "workflow-candidate-proposal-ready-smoke-drafts");
    const review = loadJsonRecord(reviewPath);
    const reviewTotals = jsonRecordAt(review, "totals");
    const promotion = loadJsonRecord(promotionPath);
    const smokePromotion = loadJsonRecord(smokePromotionPath);
    return {
        ...(Object.keys(review).length === 0 ? {} : {
            proposal_review: {
                report_path: reviewPath,
                ...(existsSync(reviewSummaryPath) ? { summary_path: reviewSummaryPath } : {}),
                ...(stringAt(review, "decision") === undefined ? {} : { decision: stringAt(review, "decision") as string }),
                ...(numberAt(reviewTotals, "proposal_count") === undefined ? {} : { proposal_count: numberAt(reviewTotals, "proposal_count") as number }),
                ...(numberAt(reviewTotals, "ready_count") === undefined ? {} : { ready_count: numberAt(reviewTotals, "ready_count") as number }),
                ...(numberAt(reviewTotals, "pending_count") === undefined ? {} : { pending_count: numberAt(reviewTotals, "pending_count") as number }),
                ...(numberAt(reviewTotals, "invalid_count") === undefined ? {} : { invalid_count: numberAt(reviewTotals, "invalid_count") as number }),
                ...(numberAt(reviewTotals, "missing_field_count") === undefined ? {} : { missing_field_count: numberAt(reviewTotals, "missing_field_count") as number }),
                failures: jsonArrayOfStrings(review.failures),
            },
        }),
        ...(Object.keys(promotion).length === 0 ? {} : {
            proposal_promotion: {
                report_path: promotionPath,
                ...(stringAt(promotion, "decision") === undefined ? {} : { decision: stringAt(promotion, "decision") as string }),
                ...(numberAt(promotion, "proposal_count") === undefined ? {} : { proposal_count: numberAt(promotion, "proposal_count") as number }),
                ...(numberAt(promotion, "emitted_draft_count") === undefined ? {} : { emitted_draft_count: numberAt(promotion, "emitted_draft_count") as number }),
                ...(numberAt(promotion, "skipped_proposal_count") === undefined ? {} : { skipped_proposal_count: numberAt(promotion, "skipped_proposal_count") as number }),
                failures: jsonArrayOfStrings(promotion.failures),
            },
        }),
        ...(Object.keys(smokePromotion).length === 0 ? {} : {
            proposal_ready_smoke: {
                promotion_report_path: smokePromotionPath,
                ...(existsSync(smokeDraftDir) ? { draft_dir: smokeDraftDir } : {}),
                review_decision: "workflow_candidate_proposal_reviews_ready",
                ...(stringAt(smokePromotion, "decision") === undefined ? {} : { promotion_decision: stringAt(smokePromotion, "decision") as string }),
                ...(numberAt(smokePromotion, "proposal_count") === undefined ? {} : { proposal_count: numberAt(smokePromotion, "proposal_count") as number }),
                ...(numberAt(smokePromotion, "emitted_draft_count") === undefined ? {} : { emitted_draft_count: numberAt(smokePromotion, "emitted_draft_count") as number }),
                ...(numberAt(smokePromotion, "skipped_proposal_count") === undefined ? {} : { skipped_proposal_count: numberAt(smokePromotion, "skipped_proposal_count") as number }),
                failures: jsonArrayOfStrings(smokePromotion.failures),
            },
        }),
    };
}

function loadReviewPipelineLifecycleStatus(baseDir: string): Pick<ClassifierLifecycleReviewStatus, "review_pipeline_lifecycle"> {
    const reportPath = join(baseDir, "workflow-candidate-review-pipeline-lifecycle-current.json");
    if (!existsSync(reportPath)) return {};
    const report = loadJsonRecord(reportPath);
    const coverageReview = jsonRecordAt(report, "coverage_review");
    const lifecycle = jsonRecordAt(coverageReview, "review_pipeline_lifecycle");
    if (Object.keys(lifecycle).length === 0) return {};
    const prepared = jsonRecordAt(lifecycle, "prepared");
    const outputVerification = jsonRecordAt(lifecycle, "output_verification");
    const checkedArtifacts = Array.isArray(outputVerification.checked_artifacts)
        ? outputVerification.checked_artifacts
        : [];
    const preparedArgv = jsonArrayOfStrings(prepared.argv);
    const outputArtifacts = reviewPipelineArtifactSummaries(prepared.output_artifacts);
    const checkedArtifactSummaries = reviewPipelineArtifactSummaries(outputVerification.checked_artifacts);
    const missingRequiredArtifacts = jsonArrayOfStrings(outputVerification.missing_required_artifacts);
    const failures = [
        ...jsonArrayOfStrings(report.failures),
        ...jsonArrayOfStrings(coverageReview.failures),
        ...jsonArrayOfStrings(lifecycle.failures),
    ];
    return {
        review_pipeline_lifecycle: {
            report_path: reportPath,
            ...(stringAt(lifecycle, "status") === undefined ? {} : { lifecycle_status: stringAt(lifecycle, "status") as string }),
            ...(stringAt(coverageReview, "review_pipeline_command_kind") === undefined ? {} : { command_kind: stringAt(coverageReview, "review_pipeline_command_kind") as string }),
            ...(stringAt(prepared, "status") === undefined ? {} : { prepared_status: stringAt(prepared, "status") as string }),
            ...(stringAt(outputVerification, "status") === undefined ? {} : { output_verification_status: stringAt(outputVerification, "status") as string }),
            ...(jsonBoolean(lifecycle.can_execute) === null ? {} : { can_execute: jsonBoolean(lifecycle.can_execute) as boolean }),
            ...(jsonBoolean(lifecycle.can_continue) === null ? {} : { can_continue: jsonBoolean(lifecycle.can_continue) as boolean }),
            missing_required_artifact_count: missingRequiredArtifacts.length,
            checked_artifact_count: checkedArtifacts.length,
            ...(preparedArgv.length === 0 ? {} : { prepared_argv: preparedArgv }),
            ...(outputArtifacts.length === 0 ? {} : { output_artifacts: outputArtifacts }),
            ...(checkedArtifactSummaries.length === 0 ? {} : { checked_artifacts: checkedArtifactSummaries }),
            failures,
        },
    };
}

export function buildOperationsReport(
    manifest: ClassifierPackageManifest,
    manifestPath: string,
    operationId?: string,
): ClassifierPackageOperationsReport {
    const operations = operationId
        ? [findClassifierPackageOperation(manifest, operationId)].filter((operation): operation is ClassifierPackageOperation => Boolean(operation))
        : listClassifierPackageOperations(manifest);
    const failures = operationId && operations.length === 0
        ? [`classifier package ${manifest.key} does not declare operation: ${operationId}`]
        : [];
    return {
        schema: "ax.classifier_package_operations_report.v1",
        manifest: manifestPath,
        package_key: manifest.key,
        package_name: manifest.package,
        ...(operationId ? { operation_id: operationId } : {}),
        operations,
        failures,
        decision: operationId
            ? operations.length > 0 ? "operation_found" : "operation_missing"
            : "operations_listed",
    };
}

export function buildOperationPreflightReport(
    manifest: ClassifierPackageManifest,
    manifestPath: string,
    operationId: string,
): ClassifierPackageOperationPreflightReport {
    const operation = findClassifierPackageOperation(manifest, operationId);
    if (!operation) {
        return {
            schema: "ax.classifier_package_operation_preflight_report.v1",
            manifest: manifestPath,
            package_key: manifest.key,
            package_name: manifest.package,
            operation_id: operationId,
            inputs: [],
            missing_inputs: [],
            failures: [`classifier package ${manifest.key} does not declare operation: ${operationId}`],
            decision: "operation_missing",
        };
    }
    const inputs = (operation.inputs ?? []).map((path) => ({
        path,
        exists: existsSync(path),
    }));
    const missingInputs = inputs.filter((input) => !input.exists).map((input) => input.path);
    return {
        schema: "ax.classifier_package_operation_preflight_report.v1",
        manifest: manifestPath,
        package_key: manifest.key,
        package_name: manifest.package,
        operation_id: operationId,
        operation,
        inputs,
        missing_inputs: missingInputs,
        failures: missingInputs.map((path) => `missing input: ${path}`),
        decision: missingInputs.length === 0 ? "ready" : "missing_inputs",
    };
}

export function buildOperationDryRunReport(
    manifest: ClassifierPackageManifest,
    manifestPath: string,
    operationId: string,
): ClassifierPackageOperationDryRunReport {
    const preflight = buildOperationPreflightReport(manifest, manifestPath, operationId);
    return {
        schema: "ax.classifier_package_operation_dry_run_report.v1",
        manifest: manifestPath,
        package_key: manifest.key,
        package_name: manifest.package,
        operation_id: operationId,
        ...(preflight.operation ? { operation: preflight.operation, command: preflight.operation.command } : {}),
        would_execute: false,
        preflight,
        failures: preflight.failures,
        decision: preflight.decision === "ready"
            ? "ready_to_run"
            : preflight.decision === "operation_missing" ? "operation_missing" : "blocked",
    };
}

export function buildOperationExecutionPlanReport(
    manifest: ClassifierPackageManifest,
    manifestPath: string,
    operationId: string,
    input: ClassifierPackageOperationExecutionPlanInput,
): ClassifierPackageOperationExecutionPlanReport {
    const dryRun = buildOperationDryRunReport(manifest, manifestPath, operationId);
    const expensive = dryRun.operation ? EXPENSIVE_OPERATION_KINDS.has(dryRun.operation.kind) : false;
    const guardFailures: string[] = [];
    let decision: ClassifierPackageOperationExecutionPlanReport["decision"];
    if (dryRun.decision === "operation_missing") {
        decision = "operation_missing";
    } else if (dryRun.decision === "blocked") {
        decision = "blocked";
    } else if (!input.allowExecute) {
        decision = "denied_requires_execute";
        guardFailures.push("execution requires --execute");
    } else if (expensive && !input.allowExpensive) {
        decision = "denied_expensive";
        guardFailures.push(`operation kind ${dryRun.operation?.kind ?? "unknown"} requires --allow-expensive`);
    } else {
        decision = "ready_to_execute";
    }
    return {
        schema: "ax.classifier_package_operation_execution_plan_report.v1",
        manifest: manifestPath,
        package_key: manifest.key,
        package_name: manifest.package,
        operation_id: operationId,
        ...(dryRun.operation ? { operation: dryRun.operation, command: dryRun.command } : {}),
        would_execute: decision === "ready_to_execute",
        requested_execute: input.allowExecute,
        allow_expensive: input.allowExpensive,
        expensive,
        dry_run: dryRun,
        failures: [...dryRun.failures, ...guardFailures],
        decision,
    };
}

export async function executeOperationPlanReport(
    plan: ClassifierPackageOperationExecutionPlanReport,
): Promise<ClassifierPackageOperationExecutionReport> {
    const started = new Date();
    const outputStatuses = (): readonly ClassifierPackageOperationInputStatus[] =>
        (plan.operation?.outputs ?? []).map((path) => ({
            path,
            exists: existsSync(path),
        }));
    const artifactStatuses = (): readonly ClassifierPackageOperationArtifactStatus[] =>
        (plan.operation?.outputs ?? []).map((path) => artifactStatus(path));
    const outputsBefore = artifactStatuses();
    if (plan.decision !== "ready_to_execute" || !plan.command) {
        const finished = new Date();
        const outputs = outputStatuses();
        const outputsAfter = artifactStatuses();
        return {
            schema: "ax.classifier_package_operation_execution_report.v1",
            manifest: plan.manifest,
            package_key: plan.package_key,
            package_name: plan.package_name,
            operation_id: plan.operation_id,
            ...(plan.operation ? { operation: plan.operation } : {}),
            ...(plan.command ? { command: plan.command } : {}),
            plan,
            executed: false,
            started_at: started.toISOString(),
            finished_at: finished.toISOString(),
            duration_ms: finished.getTime() - started.getTime(),
            exit_code: null,
            signal: null,
            stdout: "",
            stderr: "",
            outputs,
            missing_outputs: outputs.filter((output) => !output.exists).map((output) => output.path),
            outputs_before: outputsBefore,
            output_changes: outputChanges(outputsBefore, outputsAfter),
            failures: plan.failures.length > 0 ? plan.failures : [`execution plan decision was ${plan.decision}`],
            decision: "not_executed",
        };
    }
    const command = plan.command;

    const result = await new Promise<{
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly stdout: string;
        readonly stderr: string;
    }>((resolve) => {
        exec(command, {
            cwd: process.cwd(),
            encoding: "utf8",
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            shell: "/bin/sh",
        }, (error, stdout, stderr) => {
            const processError = error as (Error & {
                readonly code?: number | string | null;
                readonly signal?: NodeJS.Signals | null;
            }) | null;
            const exitCode = processError
                ? typeof processError.code === "number" ? processError.code : 1
                : 0;
            resolve({
                exitCode,
                signal: processError?.signal ?? null,
                stdout,
                stderr,
            });
        });
    });
    const finished = new Date();
    const outputs = outputStatuses();
    const outputsAfter = artifactStatuses();
    const missingOutputs = outputs.filter((output) => !output.exists).map((output) => output.path);
    const failures = [
        ...(result.exitCode === 0
        ? []
        : [`operation exited with code ${result.exitCode ?? "null"}${result.signal ? ` signal ${result.signal}` : ""}`]),
        ...missingOutputs.map((path) => `missing output: ${path}`),
    ];
    return {
        schema: "ax.classifier_package_operation_execution_report.v1",
        manifest: plan.manifest,
        package_key: plan.package_key,
        package_name: plan.package_name,
        operation_id: plan.operation_id,
        ...(plan.operation ? { operation: plan.operation } : {}),
        command,
        plan,
        executed: true,
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        duration_ms: finished.getTime() - started.getTime(),
        exit_code: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        outputs,
        missing_outputs: missingOutputs,
        outputs_before: outputsBefore,
        output_changes: outputChanges(outputsBefore, outputsAfter),
        failures,
        decision: result.exitCode === 0 && missingOutputs.length === 0 ? "executed" : "failed",
    };
}

export function discoverClassifierPackageManifestPaths(root = "packages"): readonly string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .map((entry) => join(root, entry))
        .filter((path) => statSync(path).isDirectory())
        .map((path) => join(path, "ax.classifier.json"))
        .filter((path) => existsSync(path))
        .sort();
}

export function summarizeClassifierPackageOperations(
    manifest: ClassifierPackageManifest,
    manifestPath: string,
): ClassifierPackageOperationsSummary {
    const operations = listClassifierPackageOperations(manifest);
    const operationKinds = countOperationKinds(operations);
    return {
        manifest: manifestPath,
        package_key: manifest.key,
        package_name: manifest.package,
        version: manifest.version,
        kind: manifest.kind,
        input: manifest.input,
        label_count: manifest.labels.length,
        target_count: manifest.targets.length,
        fixture_count: manifest.fixtures?.length ?? 0,
        asset_count: manifest.assets?.length ?? 0,
        operation_count: operations.length,
        operation_kinds: operationKinds,
        lifecycle_readiness: lifecycleReadiness(manifest, operationKinds),
        operations,
    };
}

export function buildPackagesOperationsReport(
    root: string,
    packages: readonly ClassifierPackageOperationsSummary[],
): ClassifierPackagesOperationsReport {
    return {
        schema: "ax.classifier_packages_operations_report.v1",
        root,
        manifests: packages.map((entry) => entry.manifest),
        packages,
        totals: {
            package_count: packages.length,
            operation_count: packages.reduce((total, entry) => total + entry.operation_count, 0),
            operation_kinds: packages.reduce((counts, entry) => {
                for (const kind of OPERATION_KINDS) {
                    counts[kind] += entry.operation_kinds[kind];
                }
                return counts;
            }, countOperationKinds([])),
            local_model_count: packages.filter((entry) => entry.kind === "local_model").length,
            local_model_ready_count: packages.filter((entry) => entry.kind === "local_model" && entry.lifecycle_readiness.status === "ready").length,
            local_model_incomplete_count: packages.filter((entry) => entry.kind === "local_model" && entry.lifecycle_readiness.status === "incomplete").length,
            package_count_with_operations: packages.filter((entry) => entry.operation_count > 0).length,
            package_count_without_operations: packages.filter((entry) => entry.operation_count === 0).length,
        },
    };
}

function isExecutionReport(value: unknown): value is ClassifierPackageOperationExecutionReport {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    const plan = record.plan;
    return record.schema === "ax.classifier_package_operation_execution_report.v1" &&
        typeof record.package_key === "string" &&
        typeof record.operation_id === "string" &&
        typeof record.executed === "boolean" &&
        (record.exit_code === null || typeof record.exit_code === "number") &&
        typeof record.started_at === "string" &&
        typeof record.finished_at === "string" &&
        typeof record.duration_ms === "number" &&
        (record.decision === "executed" || record.decision === "failed" || record.decision === "not_executed") &&
        Array.isArray(record.failures) &&
        plan !== null &&
        plan !== undefined &&
        typeof plan === "object" &&
        "decision" in plan &&
        typeof (plan as { readonly decision?: unknown }).decision === "string";
}

export function discoverClassifierPackageExecutionReportPaths(root = ".ax/experiments"): readonly string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .map((entry) => join(root, entry))
        .filter((path) => statSync(path).isFile())
        .filter((path) => path.includes("classifier-package-execution-") && path.endsWith(".json"))
        .filter((path) => !path.includes("classifier-package-execution-plan-"))
        .filter((path) => !path.includes("classifier-package-execution-history-"))
        .filter((path) => !path.includes("classifier-package-execution-facts-"))
        .filter((path) => !path.includes("classifier-package-execution-write-plan-"))
        .filter((path) => !path.includes("classifier-package-execution-apply-"))
        .filter((path) => !path.includes("classifier-package-execution-graph-health-"))
        .sort();
}

export function loadClassifierPackageExecutionReport(path: string): ClassifierPackageOperationExecutionReport {
    const parsed = safeJsonParse<unknown>(readFileSync(path, "utf8"));
    if (!isExecutionReport(parsed)) {
        throw new Error(`invalid classifier package execution report: ${path}`);
    }
    const normalizedOutputs = Array.isArray((parsed as { readonly outputs?: unknown }).outputs)
        ? (parsed as { readonly outputs: readonly ClassifierPackageOperationInputStatus[] }).outputs
        : (parsed.operation?.outputs ?? []).map((path) => ({
            path,
            exists: existsSync(path),
        }));
    const normalizedMissingOutputs = Array.isArray((parsed as { readonly missing_outputs?: unknown }).missing_outputs)
        ? (parsed as { readonly missing_outputs: readonly string[] }).missing_outputs
        : normalizedOutputs.filter((output) => !output.exists).map((output) => output.path);
    const outputsBefore = Array.isArray((parsed as { readonly outputs_before?: unknown }).outputs_before)
        ? (parsed as { readonly outputs_before: readonly ClassifierPackageOperationArtifactStatus[] }).outputs_before
        : [];
    const changes = Array.isArray((parsed as { readonly output_changes?: unknown }).output_changes)
        ? (parsed as { readonly output_changes: readonly ClassifierPackageOperationOutputChange[] }).output_changes
        : normalizedOutputs.map((output) => ({
            path: output.path,
            before: { path: output.path, exists: false },
            after: { path: output.path, exists: output.exists },
            changed_during_run: false,
        }));
    return {
        ...parsed,
        outputs: normalizedOutputs,
        missing_outputs: normalizedMissingOutputs,
        outputs_before: outputsBefore,
        output_changes: changes,
    };
}

export function buildExecutionHistoryReport(
    root: string,
    entries: readonly {
        readonly path: string;
        readonly report: ClassifierPackageOperationExecutionReport;
    }[],
): ClassifierPackageExecutionHistoryReport {
    const reports = entries.map(({ path, report }) => ({
        path,
        package_key: report.package_key,
        operation_id: report.operation_id,
        decision: report.decision,
        plan_decision: report.plan.decision,
        executed: report.executed,
        exit_code: report.exit_code,
        started_at: report.started_at,
        finished_at: report.finished_at,
        duration_ms: report.duration_ms,
        output_count: report.outputs.length,
        missing_output_count: report.missing_outputs.length,
        changed_output_count: report.output_changes.filter((change) => change.changed_during_run).length,
        failures: report.failures,
    }));
    return {
        schema: "ax.classifier_package_execution_history_report.v1",
        root,
        reports,
        totals: {
            report_count: reports.length,
            executed_count: reports.filter((report) => report.decision === "executed").length,
            failed_count: reports.filter((report) => report.decision === "failed").length,
            not_executed_count: reports.filter((report) => report.decision === "not_executed").length,
            output_count: reports.reduce((total, report) => total + report.output_count, 0),
            missing_output_count: reports.reduce((total, report) => total + report.missing_output_count, 0),
            changed_output_count: reports.reduce((total, report) => total + report.changed_output_count, 0),
            failure_count: reports.reduce((total, report) => total + report.failures.length, 0),
        },
    };
}

export function buildExecutionFactProjectionReport(
    root: string,
    entries: readonly {
        readonly path: string;
        readonly report: ClassifierPackageOperationExecutionReport;
    }[],
    workflowStatus?: ClassifierLifecycleReviewStatus,
): ClassifierPackageExecutionFactProjectionReport {
    const nodes = new Map<string, ClassifierPackageExecutionFactNode>();
    const edges: ClassifierPackageExecutionFactEdge[] = [];
    const facts: ClassifierPackageExecutionFact[] = [];
    const addNode = (node: ClassifierPackageExecutionFactNode): void => {
        if (!nodes.has(node.id)) nodes.set(node.id, node);
    };
    for (const { path, report } of entries) {
        const packageNode = `classifier_package:${factId(report.package_key)}`;
        const operationNode = `classifier_operation:${factId(`${report.package_key}/${report.operation_id}`)}`;
        const executionNode = executionId(path);
        addNode({
            id: packageNode,
            kind: "classifier_package",
            label: report.package_key,
            properties: {
                package_name: report.package_name,
                manifest: report.manifest,
            },
        });
        addNode({
            id: operationNode,
            kind: "classifier_operation",
            label: report.operation_id,
            properties: {
                package_key: report.package_key,
                operation_kind: report.operation?.kind ?? null,
                expensive: report.plan.expensive,
            },
        });
        addNode({
            id: executionNode,
            kind: "classifier_execution",
            label: report.operation_id,
            properties: {
                decision: report.decision,
                plan_decision: report.plan.decision,
                executed: report.executed,
                exit_code: report.exit_code,
                started_at: report.started_at,
                finished_at: report.finished_at,
                duration_ms: report.duration_ms,
                source_path: path,
            },
        });
        const declaresEdge = `edge:${factId(`${packageNode}->declares_operation->${operationNode}`)}`;
        edges.push({
            id: declaresEdge,
            kind: "declares_operation",
            from: packageNode,
            to: operationNode,
            evidence_path: report.manifest,
            properties: {
                operation_id: report.operation_id,
                operation_kind: report.operation?.kind ?? null,
            },
        });
        const runEdge = `edge:${factId(`${executionNode}->ran_operation->${operationNode}`)}`;
        edges.push({
            id: runEdge,
            kind: "ran_operation",
            from: executionNode,
            to: operationNode,
            evidence_path: path,
            properties: {
                decision: report.decision,
                plan_decision: report.plan.decision,
                executed: report.executed,
            },
        });
        facts.push({
            id: `fact:${factId(`${path}:execution`)}`,
            kind: report.executed ? "classifier_operation_execution" : "classifier_operation_guard",
            subject: executionNode,
            predicate: report.executed ? "completed_with_decision" : "guarded_with_decision",
            value: report.executed ? report.decision : report.plan.decision,
            evidence_edges: [runEdge],
            properties: {
                package_key: report.package_key,
                operation_id: report.operation_id,
                decision: report.decision,
                plan_decision: report.plan.decision,
                failure_count: report.failures.length,
            },
        });
        for (const output of report.outputs) {
            const artifactNode = pathArtifactId(output.path);
            const change = report.output_changes.find((entry) => entry.path === output.path);
            addNode({
                id: artifactNode,
                kind: "artifact",
                label: output.path,
                properties: {
                    path: output.path,
                    exists: output.exists,
                },
            });
            const observedEdge = `edge:${factId(`${executionNode}->observed_artifact->${artifactNode}`)}`;
            edges.push({
                id: observedEdge,
                kind: change?.changed_during_run ? "updated_artifact" : "observed_artifact",
                from: executionNode,
                to: artifactNode,
                evidence_path: path,
                properties: {
                    exists: output.exists,
                    missing: !output.exists,
                    changed_during_run: change?.changed_during_run ?? false,
                },
            });
            facts.push({
                id: `fact:${factId(`${path}:artifact:${output.path}`)}`,
                kind: "classifier_artifact_observation",
                subject: executionNode,
                predicate: change?.changed_during_run ? "updated_artifact" : "observed_artifact",
                object: artifactNode,
                value: output.exists,
                evidence_edges: [observedEdge],
                properties: {
                    path: output.path,
                    exists: output.exists,
                    changed_during_run: change?.changed_during_run ?? false,
                },
            });
        }
    }
    if (workflowStatus) {
        const proposalLifecycleNode = "classifier_lifecycle:workflow_candidate_proposal";
        addNode({
            id: proposalLifecycleNode,
            kind: "classifier_lifecycle",
            label: "workflow candidate proposal lifecycle",
            properties: {
                workflow_status_path: workflowStatus.path,
                workflow_status_exists: workflowStatus.exists,
                decision: workflowStatus.decision ?? null,
            },
        });
        const addLifecycleArtifactFacts = (input: {
            readonly lifecycleNode: string;
            readonly key: string;
            readonly artifactPath: string;
            readonly decisionPredicate: string;
            readonly decision?: string;
            readonly numericFacts: Readonly<Record<string, number | undefined>>;
            readonly booleanFacts?: Readonly<Record<string, boolean | undefined>>;
            readonly stringFacts?: Readonly<Record<string, string | undefined>>;
            readonly arrayFacts?: Readonly<Record<string, readonly string[] | undefined>>;
        }): void => {
            const artifactNode = pathArtifactId(input.artifactPath);
            const edgeId = `edge:${factId(`${input.lifecycleNode}->has_evidence->${artifactNode}:${input.key}`)}`;
            addNode({
                id: artifactNode,
                kind: "artifact",
                label: input.artifactPath,
                properties: {
                    path: input.artifactPath,
                    exists: true,
                },
            });
            edges.push({
                id: edgeId,
                kind: "has_evidence",
                from: input.lifecycleNode,
                to: artifactNode,
                evidence_path: input.artifactPath,
                properties: {
                    lifecycle_key: input.key,
                },
            });
            if (input.decision !== undefined) {
                facts.push({
                    id: `fact:${factId(`${input.lifecycleNode}:${input.decisionPredicate}`)}`,
                    kind: "classifier_lifecycle_status",
                    subject: input.lifecycleNode,
                    predicate: input.decisionPredicate,
                    value: input.decision,
                    evidence_edges: [edgeId],
                    properties: {
                        lifecycle_key: input.key,
                        artifact_path: input.artifactPath,
                    },
                });
            }
            for (const [predicate, value] of Object.entries(input.numericFacts)) {
                if (value === undefined) continue;
                facts.push({
                    id: `fact:${factId(`${input.lifecycleNode}:${predicate}`)}`,
                    kind: "classifier_lifecycle_status",
                    subject: input.lifecycleNode,
                    predicate,
                    value,
                    evidence_edges: [edgeId],
                    properties: {
                        lifecycle_key: input.key,
                        artifact_path: input.artifactPath,
                    },
                });
            }
            for (const [predicate, value] of Object.entries(input.booleanFacts ?? {})) {
                if (value === undefined) continue;
                facts.push({
                    id: `fact:${factId(`${input.lifecycleNode}:${predicate}`)}`,
                    kind: "classifier_lifecycle_status",
                    subject: input.lifecycleNode,
                    predicate,
                    value,
                    evidence_edges: [edgeId],
                    properties: {
                        lifecycle_key: input.key,
                        artifact_path: input.artifactPath,
                    },
                });
            }
            for (const [predicate, value] of Object.entries(input.stringFacts ?? {})) {
                if (value === undefined) continue;
                facts.push({
                    id: `fact:${factId(`${input.lifecycleNode}:${predicate}`)}`,
                    kind: "classifier_lifecycle_status",
                    subject: input.lifecycleNode,
                    predicate,
                    value,
                    evidence_edges: [edgeId],
                    properties: {
                        lifecycle_key: input.key,
                        artifact_path: input.artifactPath,
                    },
                });
            }
            for (const [predicate, value] of Object.entries(input.arrayFacts ?? {})) {
                if (value === undefined || value.length === 0) continue;
                facts.push({
                    id: `fact:${factId(`${input.lifecycleNode}:${predicate}`)}`,
                    kind: "classifier_lifecycle_status",
                    subject: input.lifecycleNode,
                    predicate,
                    value,
                    evidence_edges: [edgeId],
                    properties: {
                        lifecycle_key: input.key,
                        artifact_path: input.artifactPath,
                    },
                });
            }
        };
        if (workflowStatus.proposal_review) {
            addLifecycleArtifactFacts({
                lifecycleNode: proposalLifecycleNode,
                key: "proposal_review",
                artifactPath: workflowStatus.proposal_review.report_path,
                decisionPredicate: "proposal_review_decision",
                ...(workflowStatus.proposal_review.decision === undefined ? {} : { decision: workflowStatus.proposal_review.decision }),
                numericFacts: {
                    proposal_review_proposal_count: workflowStatus.proposal_review.proposal_count,
                    proposal_review_ready_count: workflowStatus.proposal_review.ready_count,
                    proposal_review_pending_count: workflowStatus.proposal_review.pending_count,
                    proposal_review_invalid_count: workflowStatus.proposal_review.invalid_count,
                    proposal_review_missing_field_count: workflowStatus.proposal_review.missing_field_count,
                },
            });
        }
        if (workflowStatus.proposal_promotion) {
            addLifecycleArtifactFacts({
                lifecycleNode: proposalLifecycleNode,
                key: "proposal_promotion",
                artifactPath: workflowStatus.proposal_promotion.report_path,
                decisionPredicate: "proposal_promotion_decision",
                ...(workflowStatus.proposal_promotion.decision === undefined ? {} : { decision: workflowStatus.proposal_promotion.decision }),
                numericFacts: {
                    proposal_promotion_proposal_count: workflowStatus.proposal_promotion.proposal_count,
                    proposal_promotion_emitted_draft_count: workflowStatus.proposal_promotion.emitted_draft_count,
                    proposal_promotion_skipped_proposal_count: workflowStatus.proposal_promotion.skipped_proposal_count,
                },
            });
        }
        if (workflowStatus.proposal_ready_smoke) {
            addLifecycleArtifactFacts({
                lifecycleNode: proposalLifecycleNode,
                key: "proposal_ready_smoke",
                artifactPath: workflowStatus.proposal_ready_smoke.promotion_report_path,
                decisionPredicate: "proposal_ready_smoke_promotion_decision",
                ...(workflowStatus.proposal_ready_smoke.promotion_decision === undefined ? {} : { decision: workflowStatus.proposal_ready_smoke.promotion_decision }),
                numericFacts: {
                    proposal_ready_smoke_proposal_count: workflowStatus.proposal_ready_smoke.proposal_count,
                    proposal_ready_smoke_emitted_draft_count: workflowStatus.proposal_ready_smoke.emitted_draft_count,
                    proposal_ready_smoke_skipped_proposal_count: workflowStatus.proposal_ready_smoke.skipped_proposal_count,
                },
            });
        }
        if (workflowStatus.review_pipeline_lifecycle) {
            const reviewPipelineLifecycleNode = "classifier_lifecycle:workflow_candidate_review_pipeline";
            addNode({
                id: reviewPipelineLifecycleNode,
                kind: "classifier_lifecycle",
                label: "workflow candidate review pipeline lifecycle",
                properties: {
                    workflow_status_path: workflowStatus.path,
                    workflow_status_exists: workflowStatus.exists,
                    report_path: workflowStatus.review_pipeline_lifecycle.report_path,
                    lifecycle_status: workflowStatus.review_pipeline_lifecycle.lifecycle_status ?? null,
                },
            });
            addLifecycleArtifactFacts({
                lifecycleNode: reviewPipelineLifecycleNode,
                key: "review_pipeline_lifecycle",
                artifactPath: workflowStatus.review_pipeline_lifecycle.report_path,
                decisionPredicate: "review_pipeline_lifecycle_status",
                ...(workflowStatus.review_pipeline_lifecycle.lifecycle_status === undefined ? {} : {
                    decision: workflowStatus.review_pipeline_lifecycle.lifecycle_status,
                }),
                numericFacts: {
                    review_pipeline_missing_required_artifact_count: workflowStatus.review_pipeline_lifecycle.missing_required_artifact_count,
                    review_pipeline_checked_artifact_count: workflowStatus.review_pipeline_lifecycle.checked_artifact_count,
                },
                booleanFacts: {
                    review_pipeline_can_execute: workflowStatus.review_pipeline_lifecycle.can_execute,
                    review_pipeline_can_continue: workflowStatus.review_pipeline_lifecycle.can_continue,
                },
                stringFacts: {
                    review_pipeline_command_kind: workflowStatus.review_pipeline_lifecycle.command_kind,
                    review_pipeline_prepared_status: workflowStatus.review_pipeline_lifecycle.prepared_status,
                    review_pipeline_output_verification_status: workflowStatus.review_pipeline_lifecycle.output_verification_status,
                },
                arrayFacts: {
                    review_pipeline_prepared_argv: workflowStatus.review_pipeline_lifecycle.prepared_argv,
                    review_pipeline_output_artifact_paths: workflowStatus.review_pipeline_lifecycle.output_artifacts?.map((artifact) => artifact.path),
                    review_pipeline_checked_artifact_paths: workflowStatus.review_pipeline_lifecycle.checked_artifacts?.map((artifact) => artifact.path),
                    review_pipeline_checked_artifact_states: workflowStatus.review_pipeline_lifecycle.checked_artifacts?.map((artifact) =>
                        `${artifact.kind ?? "artifact"}:${artifact.exists === true ? "ok" : artifact.exists === false ? "missing" : "unknown"}`,
                    ),
                },
            });
        }
    }
    const uniqueEdges = Array.from(new Map(edges.map((edge) => [edge.id, edge])).values());
    return {
        schema: "ax.classifier_package_execution_fact_projection.v1",
        root,
        source_reports: [
            ...entries.map((entry) => entry.path),
            ...(workflowStatus ? [workflowStatus.path] : []),
        ],
        nodes: [...nodes.values()],
        edges: uniqueEdges,
        facts,
        totals: {
            source_report_count: entries.length,
            node_count: nodes.size,
            edge_count: uniqueEdges.length,
            fact_count: facts.length,
            execution_fact_count: facts.filter((fact) => fact.kind === "classifier_operation_execution").length,
            guard_fact_count: facts.filter((fact) => fact.kind === "classifier_operation_guard").length,
            artifact_fact_count: facts.filter((fact) => fact.kind === "classifier_artifact_observation").length,
            lifecycle_fact_count: facts.filter((fact) => fact.kind === "classifier_lifecycle_status").length,
        },
    };
}

export function buildExecutionSurrealWritePlanReport(
    projection: ClassifierPackageExecutionFactProjectionReport,
): ClassifierPackageExecutionSurrealWritePlanReport {
    const nodeStatements = projection.nodes.map((node) =>
        `UPSERT ${recordRef("classifier_graph_node", node.id)} CONTENT ${surrealObject([
            ["graph_id", surrealString(node.id)],
            ["kind", surrealString(node.kind)],
            ["label", surrealString(node.label)],
            ["properties_json", surrealJson(node.properties)],
            ["source_kind", surrealString("classifier_package_execution")],
            ["updated_at", "time::now()"],
        ])};`
    );
    const edgeStatements = projection.edges.map((edge) =>
        `UPSERT ${recordRef("classifier_graph_edge", edge.id)} CONTENT ${surrealObject([
            ["graph_id", surrealString(edge.id)],
            ["kind", surrealString(edge.kind)],
            ["from_id", surrealString(edge.from)],
            ["to_id", surrealString(edge.to)],
            ["evidence_path", surrealString(edge.evidence_path)],
            ["properties_json", surrealJson(edge.properties)],
            ["source_kind", surrealString("classifier_package_execution")],
            ["updated_at", "time::now()"],
        ])};`
    );
    const factStatements = projection.facts.map((fact) =>
        `UPSERT ${recordRef("classifier_graph_fact", fact.id)} CONTENT ${surrealObject([
            ["graph_id", surrealString(fact.id)],
            ["kind", surrealString(fact.kind)],
            ["subject", surrealString(fact.subject)],
            ["predicate", surrealString(fact.predicate)],
            ["object", surrealOptionString(fact.object)],
            ["value_json", surrealJsonOption(fact.value)],
            ["evidence_edges_json", surrealJsonText(fact.evidence_edges)],
            ["properties_json", surrealJson(fact.properties)],
            ["source_kind", surrealString("classifier_package_execution")],
            ["updated_at", "time::now()"],
        ])};`
    );
    const statements = [...nodeStatements, ...edgeStatements, ...factStatements];
    return {
        schema: "ax.classifier_package_execution_surreal_write_plan.v1",
        root: projection.root,
        source_projection_schema: projection.schema,
        statements,
        tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
        totals: {
            statement_count: statements.length,
            node_statement_count: nodeStatements.length,
            edge_statement_count: edgeStatements.length,
            fact_statement_count: factStatements.length,
        },
    };
}

export async function applyExecutionSurrealWritePlanReport(
    writePlan: ClassifierPackageExecutionSurrealWritePlanReport,
    query: (statement: string) => Promise<unknown>,
): Promise<ClassifierPackageExecutionSurrealApplyReport> {
    let appliedStatementCount = 0;
    for (let index = 0; index < writePlan.statements.length; index += 1) {
        const statement = writePlan.statements[index] ?? "";
        try {
            await query(statement);
            appliedStatementCount += 1;
        } catch (error) {
            return {
                schema: "ax.classifier_package_execution_surreal_apply_report.v1",
                root: writePlan.root,
                source_write_plan_schema: writePlan.schema,
                applied: false,
                attempted_statement_count: writePlan.statements.length,
                applied_statement_count: appliedStatementCount,
                failed_statement_count: writePlan.statements.length - appliedStatementCount,
                first_failure: {
                    index,
                    statement,
                    message: error instanceof Error ? error.message : String(error),
                },
                tables: writePlan.tables,
                decision: "failed",
            };
        }
    }
    return {
        schema: "ax.classifier_package_execution_surreal_apply_report.v1",
        root: writePlan.root,
        source_write_plan_schema: writePlan.schema,
        applied: true,
        attempted_statement_count: writePlan.statements.length,
        applied_statement_count: appliedStatementCount,
        failed_statement_count: 0,
        tables: writePlan.tables,
        decision: "applied",
    };
}

export const classifierGraphHealthSql = (): string => `
SELECT graph_id, kind, label, properties_json, source_kind FROM classifier_graph_node ORDER BY graph_id;
SELECT graph_id, kind, from_id, to_id, evidence_path, properties_json, source_kind FROM classifier_graph_edge ORDER BY graph_id;
SELECT graph_id, kind, subject, predicate, object, value_json, evidence_edges_json, properties_json, source_kind FROM classifier_graph_fact ORDER BY graph_id;
`;

export function buildExecutionGraphHealthReport(input: {
    readonly nodes: readonly ClassifierGraphNodeRow[];
    readonly edges: readonly ClassifierGraphEdgeRow[];
    readonly facts: readonly ClassifierGraphFactRow[];
    readonly query?: Partial<ClassifierGraphHealthQuery>;
}): ClassifierPackageExecutionGraphHealthReport {
    const query: ClassifierGraphHealthQuery = {
        mode: input.query?.mode ?? "summary",
        ...(input.query?.operation_id ? { operation_id: input.query.operation_id } : {}),
        ...(input.query?.artifact_path ? { artifact_path: input.query.artifact_path } : {}),
        ...(input.query?.predicate ? { predicate: input.query.predicate } : {}),
    };
    const nodesById = new Map(input.nodes.map((node) => [node.graph_id, node]));
    const operationByExecution = new Map<string, string>();
    const evidencePaths = new Set<string>();
    for (const edge of input.edges) {
        if (edge.evidence_path) evidencePaths.add(edge.evidence_path);
        if (edge.kind === "ran_operation") {
            operationByExecution.set(edge.from_id, edge.to_id);
        }
    }

    const changedArtifactFacts = input.facts.filter((fact) =>
        fact.kind === "classifier_artifact_observation" && fact.predicate === "updated_artifact"
    );
    const changedArtifactCountByOperation = new Map<string, number>();
    for (const fact of changedArtifactFacts) {
        const operationId = operationByExecution.get(fact.subject);
        if (operationId) {
            changedArtifactCountByOperation.set(operationId, (changedArtifactCountByOperation.get(operationId) ?? 0) + 1);
        }
    }

    const operations = input.nodes
        .filter((node) => node.kind === "classifier_operation")
        .map((operationNode): ClassifierGraphOperationHealth => {
            const operationProperties = jsonRecord(operationNode.properties_json);
            const runEdges = input.edges.filter((edge) => edge.kind === "ran_operation" && edge.to_id === operationNode.graph_id);
            const executionNodes = runEdges
                .map((edge) => nodesById.get(edge.from_id))
                .filter((node): node is ClassifierGraphNodeRow => Boolean(node));
            const executionProperties = executionNodes.map((node) => ({
                node,
                properties: jsonRecord(node.properties_json),
            }));
            const lastExecution = executionProperties
                .slice()
                .sort((a, b) => String(jsonString(b.properties.started_at) ?? "").localeCompare(String(jsonString(a.properties.started_at) ?? "")))[0];
            const guardCount = input.facts.filter((fact) =>
                fact.kind === "classifier_operation_guard" && operationByExecution.get(fact.subject) === operationNode.graph_id
            ).length;
            const operationEvidencePaths = Array.from(new Set(runEdges.map((edge) => edge.evidence_path).filter(Boolean))).sort();
            return {
                package_key: jsonString(operationProperties.package_key) ?? "unknown",
                operation_id: operationNode.label,
                operation_kind: jsonString(operationProperties.operation_kind),
                expensive: jsonBoolean(operationProperties.expensive),
                run_count: runEdges.length,
                executed_count: executionProperties.filter((entry) => jsonBoolean(entry.properties.executed) === true).length,
                failed_count: executionProperties.filter((entry) => jsonString(entry.properties.decision) === "failed").length,
                guarded_count: guardCount,
                changed_artifact_count: changedArtifactCountByOperation.get(operationNode.graph_id) ?? 0,
                evidence_paths: operationEvidencePaths,
                ...(lastExecution
                    ? {
                        last_execution: {
                            graph_id: lastExecution.node.graph_id,
                            decision: jsonString(lastExecution.properties.decision),
                            plan_decision: jsonString(lastExecution.properties.plan_decision),
                            executed: jsonBoolean(lastExecution.properties.executed),
                            started_at: jsonString(lastExecution.properties.started_at),
                            finished_at: jsonString(lastExecution.properties.finished_at),
                            duration_ms: jsonNumber(lastExecution.properties.duration_ms),
                            source_path: jsonString(lastExecution.properties.source_path),
                        },
                    }
                    : {}),
            };
        })
        .sort((a, b) => `${a.package_key}/${a.operation_id}`.localeCompare(`${b.package_key}/${b.operation_id}`));

    const operationByNode = new Map(operations.map((operation) => [
        input.nodes.find((node) => node.kind === "classifier_operation" && node.label === operation.operation_id && jsonString(jsonRecord(node.properties_json).package_key) === operation.package_key)?.graph_id ?? "",
        operation,
    ]));
    const changedArtifacts = changedArtifactFacts.map((fact): ClassifierGraphChangedArtifact => {
        const artifactNode = fact.object ? nodesById.get(fact.object) : undefined;
        const factProperties = jsonRecord(fact.properties_json);
        const evidenceEdgeId = safeJsonParse<unknown>(fact.evidence_edges_json);
        const firstEvidenceEdgeId = Array.isArray(evidenceEdgeId) && typeof evidenceEdgeId[0] === "string" ? evidenceEdgeId[0] : undefined;
        const evidenceEdge = firstEvidenceEdgeId ? input.edges.find((edge) => edge.graph_id === firstEvidenceEdgeId) : undefined;
        const operationNodeId = operationByExecution.get(fact.subject);
        const operation = operationNodeId ? operationByNode.get(operationNodeId) : undefined;
        return {
            execution_id: fact.subject,
            artifact_id: fact.object ?? "",
            artifact_path: jsonString(factProperties.path) ?? artifactNode?.label ?? fact.object ?? "",
            ...(operation ? { operation_id: operation.operation_id, package_key: operation.package_key } : {}),
            evidence_path: evidenceEdge?.evidence_path ?? "",
        };
    });
    const lifecycleFacts = input.facts
        .filter((fact) => fact.kind === "classifier_lifecycle_status")
        .map((fact): ClassifierGraphLifecycleFact => {
            const properties = jsonRecord(fact.properties_json);
            const evidenceEdgesValue = safeJsonParse<unknown>(fact.evidence_edges_json);
            const evidenceEdges = Array.isArray(evidenceEdgesValue)
                ? evidenceEdgesValue.filter((entry): entry is string => typeof entry === "string")
                : [];
            const evidencePaths = Array.from(new Set(evidenceEdges
                .map((edgeId) => input.edges.find((edge) => edge.graph_id === edgeId)?.evidence_path)
                .filter((path): path is string => Boolean(path))))
                .sort();
            const value = fact.value_json === undefined ? null : safeJsonParse<unknown>(fact.value_json);
            return {
                graph_id: fact.graph_id,
                subject: fact.subject,
                predicate: fact.predicate,
                value,
                ...(jsonString(properties.lifecycle_key) === undefined ? {} : { lifecycle_key: jsonString(properties.lifecycle_key) as string }),
                ...(jsonString(properties.artifact_path) === undefined ? {} : { artifact_path: jsonString(properties.artifact_path) as string }),
                evidence_edges: evidenceEdges,
                evidence_paths: evidencePaths,
            };
        })
        .sort((a, b) => a.predicate.localeCompare(b.predicate));
    const embeddingHelperFacts = input.facts
        .filter((fact) => fact.source_kind === "embedding_helper_review_projection")
        .map((fact): ClassifierGraphEmbeddingHelperFact => {
            const properties = jsonRecord(fact.properties_json);
            const evidenceEdgesValue = safeJsonParse<unknown>(fact.evidence_edges_json);
            const evidenceEdges = Array.isArray(evidenceEdgesValue)
                ? evidenceEdgesValue.filter((entry): entry is string => typeof entry === "string")
                : [];
            const nearestNeighbors = evidenceEdges
                .map((edgeId) => input.edges.find((edge) => edge.graph_id === edgeId))
                .filter((edge): edge is ClassifierGraphEdgeRow => edge?.kind === "nearest_reviewed_fixture")
                .map((edge) => {
                    const edgeProperties = jsonRecord(edge.properties_json);
                    const fixtureId = edge.to_id.startsWith("classifier_evidence:")
                        ? edge.to_id.slice("classifier_evidence:".length)
                        : edge.to_id;
                    return {
                        fixture_id: fixtureId,
                        ...(jsonNumber(edgeProperties.similarity) === null ? {} : { similarity: jsonNumber(edgeProperties.similarity) as number }),
                    };
                });
            const evidencePaths = Array.from(new Set(evidenceEdges
                .map((edgeId) => input.edges.find((edge) => edge.graph_id === edgeId)?.evidence_path)
                .filter((path): path is string => Boolean(path))))
                .sort();
            const value = fact.value_json === undefined ? null : safeJsonParse<unknown>(fact.value_json);
            const promotedFixtureId = jsonString(properties.promoted_fixture_id) ??
                (fact.object?.startsWith("classifier_promoted_fixture:") ? fact.object.slice("classifier_promoted_fixture:".length) : undefined);
            return {
                graph_id: fact.graph_id,
                kind: fact.kind,
                subject: fact.subject,
                predicate: fact.predicate,
                ...(fact.object === undefined ? {} : { object: fact.object }),
                value,
                ...(jsonString(properties.status) === null ? {} : { status: jsonString(properties.status) as string }),
                ...(jsonString(properties.source_fixture_id) === null ? {} : { source_fixture_id: jsonString(properties.source_fixture_id) as string }),
                ...(promotedFixtureId === undefined ? {} : { promoted_fixture_id: promotedFixtureId }),
                ...(jsonString(properties.threshold) === null ? {} : { threshold: jsonString(properties.threshold) as string }),
                ...(jsonString(properties.proposed_label) === null ? {} : { proposed_label: jsonString(properties.proposed_label) as string }),
                ...(jsonNumber(properties.seed_count) === null ? {} : { seed_count: jsonNumber(properties.seed_count) as number }),
                ...(jsonNumber(properties.max_nearest_positive_similarity) === null ? {} : { max_nearest_positive_similarity: jsonNumber(properties.max_nearest_positive_similarity) as number }),
                ...(jsonNumber(properties.setfit_call_reduction_rate_mean) === null ? {} : { setfit_call_reduction_rate_mean: jsonNumber(properties.setfit_call_reduction_rate_mean) as number }),
                ...(jsonNumber(properties.positive_recall_after_routing_mean) === null ? {} : { positive_recall_after_routing_mean: jsonNumber(properties.positive_recall_after_routing_mean) as number }),
                ...(nearestNeighbors.length === 0 ? {} : { nearest_neighbors: nearestNeighbors }),
                evidence_edges: evidenceEdges,
                evidence_paths: evidencePaths,
            };
        })
        .sort((a, b) => `${a.predicate}/${a.source_fixture_id ?? a.subject}`.localeCompare(`${b.predicate}/${b.source_fixture_id ?? b.subject}`));
    const operationMatches = (operation: ClassifierGraphOperationHealth): boolean =>
        !query.operation_id || operation.operation_id === query.operation_id || `${operation.package_key}/${operation.operation_id}` === query.operation_id;
    const artifactMatches = (artifact: ClassifierGraphChangedArtifact): boolean =>
        !query.artifact_path || artifact.artifact_path === query.artifact_path || artifact.artifact_id === query.artifact_path;
    const changedArtifactMatches = (artifact: ClassifierGraphChangedArtifact): boolean =>
        artifactMatches(artifact) &&
        (!query.operation_id || artifact.operation_id === query.operation_id || `${artifact.package_key}/${artifact.operation_id}` === query.operation_id);
    const filteredOperations = operations.filter(operationMatches);
    const filteredGuardedOperations = operations.filter((operation) => operation.guarded_count > 0).filter(operationMatches);
    const filteredChangedArtifacts = changedArtifacts.filter(changedArtifactMatches);
    const graphFactOnlyMode = query.mode === "lifecycle" || query.mode === "embedding-helper";
    const resultGuardedOperations = graphFactOnlyMode ? [] : filteredGuardedOperations;
    const resultOperations = graphFactOnlyMode
        ? []
        : query.mode === "guarded"
        ? resultGuardedOperations
        : query.mode === "changed-artifacts"
            ? filteredOperations.filter((operation) => operation.changed_artifact_count > 0)
            : filteredOperations;
    const resultChangedArtifacts = query.mode === "guarded" || graphFactOnlyMode
        ? []
        : filteredChangedArtifacts;
    const resultLifecycleFacts = query.mode === "lifecycle" || query.mode === "evidence"
        ? lifecycleFacts.filter((fact) =>
            (!query.artifact_path ||
                fact.artifact_path === query.artifact_path ||
                fact.evidence_paths.includes(query.artifact_path)) &&
            (!query.predicate || fact.predicate === query.predicate)
        )
        : [];
    const resultEmbeddingHelperFacts = query.mode === "embedding-helper" || query.mode === "evidence"
        ? embeddingHelperFacts.filter((fact) =>
            (!query.artifact_path ||
                fact.evidence_paths.includes(query.artifact_path) ||
                fact.source_fixture_id === query.artifact_path ||
                fact.subject === query.artifact_path ||
                fact.object === query.artifact_path) &&
            (!query.predicate || fact.predicate === query.predicate)
        )
        : [];
    const resultEvidencePaths = Array.from(new Set([
        ...resultOperations.flatMap((operation) => operation.evidence_paths),
        ...resultChangedArtifacts.map((artifact) => artifact.evidence_path).filter(Boolean),
        ...resultLifecycleFacts.flatMap((fact) => fact.evidence_paths),
        ...resultEmbeddingHelperFacts.flatMap((fact) => fact.evidence_paths),
    ])).sort();

    return {
        schema: "ax.classifier_package_execution_graph_health_report.v1",
        tables: ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
        query,
        operations: resultOperations,
        guarded_operations: resultGuardedOperations,
        changed_artifacts: resultChangedArtifacts,
        lifecycle_facts: resultLifecycleFacts,
        embedding_helper_facts: resultEmbeddingHelperFacts,
        evidence_paths: resultEvidencePaths,
        totals: {
            node_count: input.nodes.length,
            edge_count: input.edges.length,
            fact_count: input.facts.length,
            package_count: input.nodes.filter((node) => node.kind === "classifier_package").length,
            operation_count: input.nodes.filter((node) => node.kind === "classifier_operation").length,
            execution_count: input.nodes.filter((node) => node.kind === "classifier_execution").length,
            artifact_count: input.nodes.filter((node) => node.kind === "artifact").length,
            execution_fact_count: input.facts.filter((fact) => fact.kind === "classifier_operation_execution").length,
            guard_fact_count: input.facts.filter((fact) => fact.kind === "classifier_operation_guard").length,
            artifact_fact_count: input.facts.filter((fact) => fact.kind === "classifier_artifact_observation").length,
            lifecycle_fact_count: lifecycleFacts.length,
            embedding_helper_fact_count: embeddingHelperFacts.length,
            changed_artifact_count: changedArtifacts.length,
            evidence_path_count: evidencePaths.size,
        },
        result_totals: {
            operation_count: resultOperations.length,
            guarded_operation_count: resultGuardedOperations.length,
            changed_artifact_count: resultChangedArtifacts.length,
            lifecycle_fact_count: resultLifecycleFacts.length,
            embedding_helper_fact_count: resultEmbeddingHelperFacts.length,
            evidence_path_count: resultEvidencePaths.length,
        },
        decision: input.nodes.length === 0 && input.edges.length === 0 && input.facts.length === 0 ? "empty_graph" : "healthy",
    };
}

export function loadClassifierLifecycleReviewStatus(path: string): ClassifierLifecycleReviewStatus {
    const proposalLifecycle = loadProposalLifecycleStatus(dirname(path));
    const reviewPipelineLifecycle = loadReviewPipelineLifecycleStatus(dirname(path));
    if (!existsSync(path)) {
        return {
            path,
            exists: false,
            ...proposalLifecycle,
            ...reviewPipelineLifecycle,
            next_actions: [],
        };
    }
    const record = loadJsonRecord(path);
    const stages = jsonRecordAt(record, "stages");
    const blindLabels = jsonRecordAt(stages, "blind_labels");
    const hardNegativeReview = jsonRecordAt(stages, "hard_negative_review");
    const reviewBatch = jsonRecordAt(stages, "review_batch");
    const reviewBatchDetails = jsonRecordAt(reviewBatch, "details");
    const reviewBatchEval = jsonRecordAt(stages, "review_batch_eval");
    const reviewBatchEvalDetails = jsonRecordAt(reviewBatchEval, "details");
    const invalidRefs = Array.isArray(reviewBatchEvalDetails.invalid_refs)
        ? reviewBatchEvalDetails.invalid_refs
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => ({
                ordinal: numberAt(entry, "ordinal") ?? 0,
                id: stringAt(entry, "id") ?? "",
                invalid: jsonArrayOfStrings(entry.invalid),
            }))
            .filter((entry) => entry.ordinal > 0 && entry.id.length > 0)
        : [];
    const incompleteRefs = Array.isArray(reviewBatchEvalDetails.incomplete_refs)
        ? reviewBatchEvalDetails.incomplete_refs
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => ({
                ordinal: numberAt(entry, "ordinal") ?? 0,
                id: stringAt(entry, "id") ?? "",
                missing: jsonArrayOfStrings(entry.missing),
                invalid: jsonArrayOfStrings(entry.invalid),
            }))
            .filter((entry) => entry.ordinal > 0 && entry.id.length > 0)
        : [];
    const reviewTasks = Array.isArray(reviewBatchEvalDetails.review_tasks)
        ? reviewBatchEvalDetails.review_tasks
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => ({
                ordinal: numberAt(entry, "ordinal") ?? 0,
                id: stringAt(entry, "id") ?? "",
                missing: jsonArrayOfStrings(entry.missing),
                invalid: jsonArrayOfStrings(entry.invalid),
                blocking_field_count: numberAt(entry, "blocking_field_count") ?? 0,
                ...(stringAt(entry, "suggested_label") === undefined ? {} : { suggested_label: stringAt(entry, "suggested_label") as string }),
                ...(stringAt(entry, "suggested_target") === undefined ? {} : { suggested_target: stringAt(entry, "suggested_target") as string }),
                ...(stringAt(entry, "confidence_bucket") === undefined ? {} : { confidence_bucket: stringAt(entry, "confidence_bucket") as string }),
                risk_reasons: jsonArrayOfStrings(entry.risk_reasons),
                ...(stringAt(entry, "hard_negative_candidate_id") === undefined ? {} : { hard_negative_candidate_id: stringAt(entry, "hard_negative_candidate_id") as string }),
                ...(stringAt(entry, "hard_negative_proposed_label") === undefined ? {} : { hard_negative_proposed_label: stringAt(entry, "hard_negative_proposed_label") as string }),
                ...(stringAt(entry, "hard_negative_proposed_target") === undefined ? {} : { hard_negative_proposed_target: stringAt(entry, "hard_negative_proposed_target") as string }),
                ...(stringAt(entry, "hard_negative_review_instruction") === undefined ? {} : { hard_negative_review_instruction: stringAt(entry, "hard_negative_review_instruction") as string }),
                ...(stringAt(entry, "source_turn") === undefined ? {} : { source_turn: stringAt(entry, "source_turn") as string }),
                ...(stringAt(entry, "source_session") === undefined ? {} : { source_session: stringAt(entry, "source_session") as string }),
                ...(stringAt(entry, "source_seq") === undefined ? {} : { source_seq: stringAt(entry, "source_seq") as string }),
                evidence_refs: jsonArrayOfStrings(entry.evidence_refs),
            }))
            .filter((entry) => entry.ordinal > 0 && entry.id.length > 0)
        : [];
    const refreshReportPath = path.endsWith("blind-workflow-status-current.json")
        ? path.replace("blind-workflow-status-current.json", "blind-review-batch-current-refresh-report.json")
        : undefined;
    const refreshRecord = refreshReportPath && existsSync(refreshReportPath)
        ? safeJsonParse<unknown>(readFileSync(refreshReportPath, "utf8"))
        : undefined;
    const refresh = refreshRecord && typeof refreshRecord === "object" && !Array.isArray(refreshRecord)
        ? refreshRecord as Record<string, unknown>
        : {};
    const suggestionDraftPath = path.endsWith("blind-workflow-status-current.json")
        ? path.replace("blind-workflow-status-current.json", "blind-review-batch-current-suggestion-draft.md")
        : undefined;
    const suggestionDraftReportPath = path.endsWith("blind-workflow-status-current.json")
        ? path.replace("blind-workflow-status-current.json", "blind-review-batch-current-suggestion-draft-report.json")
        : undefined;
    const suggestionDraftEvalReportPath = path.endsWith("blind-workflow-status-current.json")
        ? path.replace("blind-workflow-status-current.json", "blind-review-batch-current-suggestion-draft-eval-report.json")
        : undefined;
    const promotionReportPath = path.endsWith("blind-workflow-status-current.json")
        ? path.replace("blind-workflow-status-current.json", "blind-review-batch-current-promotion-report.json")
        : undefined;
    const suggestionDraftReportRecord = suggestionDraftReportPath && existsSync(suggestionDraftReportPath)
        ? safeJsonParse<unknown>(readFileSync(suggestionDraftReportPath, "utf8"))
        : undefined;
    const suggestionDraftReport = suggestionDraftReportRecord && typeof suggestionDraftReportRecord === "object" && !Array.isArray(suggestionDraftReportRecord)
        ? suggestionDraftReportRecord as Record<string, unknown>
        : {};
    const suggestionDraftEvalRecord = suggestionDraftEvalReportPath && existsSync(suggestionDraftEvalReportPath)
        ? safeJsonParse<unknown>(readFileSync(suggestionDraftEvalReportPath, "utf8"))
        : undefined;
    const suggestionDraftEval = suggestionDraftEvalRecord && typeof suggestionDraftEvalRecord === "object" && !Array.isArray(suggestionDraftEvalRecord)
        ? suggestionDraftEvalRecord as Record<string, unknown>
        : {};
    const promotionReportRecord = promotionReportPath && existsSync(promotionReportPath)
        ? safeJsonParse<unknown>(readFileSync(promotionReportPath, "utf8"))
        : undefined;
    const promotionReport = promotionReportRecord && typeof promotionReportRecord === "object" && !Array.isArray(promotionReportRecord)
        ? promotionReportRecord as Record<string, unknown>
        : {};
    const schema = stringAt(record, "schema");
    const decision = stringAt(record, "decision");
    const pendingBlindLabels = numberAt(blindLabels, "pending");
    const pendingHardNegatives = numberAt(hardNegativeReview, "pending");
    const acceptedHardNegatives = numberAt(hardNegativeReview, "accepted");
    const invalidBlindLabelNoteCount = jsonArrayOfStrings(jsonRecordAt(blindLabels, "details").reviewed_labels_invalid_notes).length;
    const invalidHardNegativeNoteCount = jsonArrayOfStrings(jsonRecordAt(hardNegativeReview, "details").reviewed_invalid_notes).length;
    const selectedOrdinals = numberArrayAt(reviewBatchDetails, "selected_ordinals");
    const focusedBatch = selectedOrdinals.length > 0 || incompleteRefs.length > 0 || invalidRefs.length > 0
        ? {
            ...(stringAt(refresh, "batch") === undefined ? {} : { batch_path: stringAt(refresh, "batch") as string }),
            ...(stringAt(refresh, "batch_report") === undefined ? {} : { batch_report_path: stringAt(refresh, "batch_report") as string }),
            ...(stringAt(refresh, "batch_eval") === undefined ? {} : { batch_eval_path: stringAt(refresh, "batch_eval") as string }),
            ...(stringAt(refresh, "batch_sync") === undefined ? {} : { batch_sync_path: stringAt(refresh, "batch_sync") as string }),
            ...(refreshReportPath && existsSync(refreshReportPath) ? { refresh_report_path: refreshReportPath } : {}),
            ...(stringAt(refresh, "batch_source") === undefined ? {} : { batch_source: stringAt(refresh, "batch_source") as string }),
            selected_ordinals: selectedOrdinals,
            ...(numberAt(reviewBatchDetails, "context_enriched_sections") === undefined ? {} : { context_enriched_sections: numberAt(reviewBatchDetails, "context_enriched_sections") as number }),
            ...(jsonBoolean(reviewBatchDetails.vocabulary_included) === undefined ? {} : { vocabulary_included: jsonBoolean(reviewBatchDetails.vocabulary_included) as boolean }),
            ...(numberAt(reviewBatchDetails, "allowed_label_count") === undefined ? {} : { allowed_label_count: numberAt(reviewBatchDetails, "allowed_label_count") as number }),
            ...(numberAt(reviewBatchDetails, "allowed_target_count") === undefined ? {} : { allowed_target_count: numberAt(reviewBatchDetails, "allowed_target_count") as number }),
            ...(numberAt(reviewBatchDetails, "allowed_hard_negative_status_count") === undefined ? {} : { allowed_hard_negative_status_count: numberAt(reviewBatchDetails, "allowed_hard_negative_status_count") as number }),
            ...(numberAt(reviewBatchEvalDetails, "review_pending") === undefined ? {} : { review_pending: numberAt(reviewBatchEvalDetails, "review_pending") as number }),
            ...(numberAt(reviewBatchEvalDetails, "hard_negative_pending") === undefined ? {} : { hard_negative_pending: numberAt(reviewBatchEvalDetails, "hard_negative_pending") as number }),
            ...(numberAt(reviewBatchEvalDetails, "missing_field_total") === undefined ? {} : { missing_field_total: numberAt(reviewBatchEvalDetails, "missing_field_total") as number }),
            ...(numberAt(reviewBatchEvalDetails, "invalid_field_total") === undefined ? {} : { invalid_field_total: numberAt(reviewBatchEvalDetails, "invalid_field_total") as number }),
            ...(numberAt(reviewBatchEvalDetails, "blocking_field_total") === undefined ? {} : { blocking_field_total: numberAt(reviewBatchEvalDetails, "blocking_field_total") as number }),
            ...(numberAt(reviewBatchEvalDetails, "completed_field_total") === undefined ? {} : { completed_field_total: numberAt(reviewBatchEvalDetails, "completed_field_total") as number }),
            ...(numberAt(reviewBatchEvalDetails, "review_field_total") === undefined ? {} : { review_field_total: numberAt(reviewBatchEvalDetails, "review_field_total") as number }),
            ...(numberAt(reviewBatchEvalDetails, "field_completion_percent") === undefined ? {} : { field_completion_percent: numberAt(reviewBatchEvalDetails, "field_completion_percent") as number }),
            ...(numberAt(reviewBatchEvalDetails, "row_completion_percent") === undefined ? {} : { row_completion_percent: numberAt(reviewBatchEvalDetails, "row_completion_percent") as number }),
            ...(numberRecordAt(reviewBatchEvalDetails, "missing_field_counts") === undefined ? {} : { missing_field_counts: numberRecordAt(reviewBatchEvalDetails, "missing_field_counts") as Record<string, number> }),
            ...(numberRecordAt(reviewBatchEvalDetails, "invalid_field_counts") === undefined ? {} : { invalid_field_counts: numberRecordAt(reviewBatchEvalDetails, "invalid_field_counts") as Record<string, number> }),
            incomplete_refs: incompleteRefs,
            invalid_refs: invalidRefs,
            ...(numberAt(reviewBatchEvalDetails, "review_task_total") === undefined ? {} : { review_task_total: numberAt(reviewBatchEvalDetails, "review_task_total") as number }),
            review_tasks: reviewTasks,
            ...(suggestionDraftPath && existsSync(suggestionDraftPath) ? {
                suggestion_draft: {
                    path: suggestionDraftPath,
                    ...(suggestionDraftReportPath && existsSync(suggestionDraftReportPath) ? { report_path: suggestionDraftReportPath } : {}),
                    ...(suggestionDraftEvalReportPath && existsSync(suggestionDraftEvalReportPath) ? { eval_report_path: suggestionDraftEvalReportPath } : {}),
                    ...(stringAt(suggestionDraftReport, "decision") === undefined ? {} : { decision: stringAt(suggestionDraftReport, "decision") as string }),
                    ...(stringAt(suggestionDraftReport, "after_decision") === undefined ? {} : { after_decision: stringAt(suggestionDraftReport, "after_decision") as string }),
                    ...(numberAt(suggestionDraftReport, "prefilled_review_label") === undefined ? {} : { prefilled_review_label: numberAt(suggestionDraftReport, "prefilled_review_label") as number }),
                    ...(numberAt(suggestionDraftReport, "prefilled_review_target") === undefined ? {} : { prefilled_review_target: numberAt(suggestionDraftReport, "prefilled_review_target") as number }),
                    ...(numberAt(suggestionDraftReport, "prefilled_hard_negative_status") === undefined ? {} : { prefilled_hard_negative_status: numberAt(suggestionDraftReport, "prefilled_hard_negative_status") as number }),
                    ...(numberAt(suggestionDraftReport, "review_note_prompts") === undefined ? {} : { review_note_prompts: numberAt(suggestionDraftReport, "review_note_prompts") as number }),
                    ...(numberAt(suggestionDraftReport, "hard_negative_note_prompts") === undefined ? {} : { hard_negative_note_prompts: numberAt(suggestionDraftReport, "hard_negative_note_prompts") as number }),
                    ...(numberAt(suggestionDraftReport, "before_blocking_field_total") === undefined ? {} : { before_blocking_field_total: numberAt(suggestionDraftReport, "before_blocking_field_total") as number }),
                    ...(numberAt(suggestionDraftReport, "after_blocking_field_total") === undefined ? {} : { after_blocking_field_total: numberAt(suggestionDraftReport, "after_blocking_field_total") as number }),
                    ...(numberAt(suggestionDraftReport, "before_field_completion_percent") === undefined ? {} : { before_field_completion_percent: numberAt(suggestionDraftReport, "before_field_completion_percent") as number }),
                    ...(numberAt(suggestionDraftReport, "after_field_completion_percent") === undefined ? {} : { after_field_completion_percent: numberAt(suggestionDraftReport, "after_field_completion_percent") as number }),
                    ...(numberRecordAt(suggestionDraftReport, "after_missing_field_counts") === undefined ? {} : { after_missing_field_counts: numberRecordAt(suggestionDraftReport, "after_missing_field_counts") as Record<string, number> }),
                    ...(stringAt(suggestionDraftEval, "decision") === undefined ? {} : { eval_decision: stringAt(suggestionDraftEval, "decision") as string }),
                    ...(numberAt(suggestionDraftEval, "blocking_field_total") === undefined ? {} : { eval_blocking_field_total: numberAt(suggestionDraftEval, "blocking_field_total") as number }),
                },
            } : {}),
            ...(promotionReportPath && existsSync(promotionReportPath) ? {
                draft_promotion: {
                    report_path: promotionReportPath,
                    ...(stringAt(promotionReport, "decision") === undefined ? {} : { decision: stringAt(promotionReport, "decision") as string }),
                    ...(stringAt(promotionReport, "draft_eval_decision") === undefined ? {} : { draft_eval_decision: stringAt(promotionReport, "draft_eval_decision") as string }),
                    ...(numberAt(promotionReport, "blocking_field_total") === undefined ? {} : { blocking_field_total: numberAt(promotionReport, "blocking_field_total") as number }),
                    ...(numberRecordAt(promotionReport, "missing_field_counts") === undefined ? {} : { missing_field_counts: numberRecordAt(promotionReport, "missing_field_counts") as Record<string, number> }),
                    ...(numberRecordAt(promotionReport, "invalid_field_counts") === undefined ? {} : { invalid_field_counts: numberRecordAt(promotionReport, "invalid_field_counts") as Record<string, number> }),
                    failures: jsonArrayOfStrings(promotionReport.failures),
                },
            } : {}),
            ...(stringAt(refresh, "artifact_consistency_decision") === undefined ? {} : { artifact_consistency_decision: stringAt(refresh, "artifact_consistency_decision") as string }),
        }
        : undefined;
    const baseNextActions = jsonArrayOfStrings(record.next_actions);
    const proposalReviewAction = proposalLifecycle.proposal_review?.decision === "needs_workflow_candidate_proposal_review"
        ? [`edit proposal briefs listed in ${proposalLifecycle.proposal_review.summary_path ?? proposalLifecycle.proposal_review.report_path} then run workflow-candidate-proposal-review`]
        : [];
    const nextActions = focusedBatch?.suggestion_draft?.eval_decision === "needs_batch_review" && focusedBatch?.draft_promotion?.decision === "needs_human_notes"
        ? [
            `edit suggestion draft notes in ${focusedBatch.suggestion_draft.path} then run bun run classifiers:blind-review-batch -- --mode=promote-draft --batch=${focusedBatch.suggestion_draft.path} --out=.ax/experiments/blind-review-batch-current.md --summary=.ax/experiments/blind-review-batch-current-promotion-report.json --json`,
            ...proposalReviewAction,
            ...baseNextActions.filter((action) => action !== "complete focused batch review fields"),
        ]
        : [...proposalReviewAction, ...baseNextActions];
    return {
        path,
        exists: true,
        ...(schema === undefined ? {} : { schema }),
        ...(decision === undefined ? {} : { decision }),
        ...(pendingBlindLabels === undefined ? {} : { pending_blind_labels: pendingBlindLabels }),
        ...(pendingHardNegatives === undefined ? {} : { pending_hard_negatives: pendingHardNegatives }),
        ...(acceptedHardNegatives === undefined ? {} : { accepted_hard_negatives: acceptedHardNegatives }),
        ...(invalidBlindLabelNoteCount === 0 ? {} : { invalid_blind_label_note_count: invalidBlindLabelNoteCount }),
        ...(invalidHardNegativeNoteCount === 0 ? {} : { invalid_hard_negative_note_count: invalidHardNegativeNoteCount }),
        ...proposalLifecycle,
        ...reviewPipelineLifecycle,
        ...(focusedBatch === undefined ? {} : { focused_batch: focusedBatch }),
        next_actions: nextActions,
    };
}

export function buildClassifierLifecycleInsightReport(input: {
    readonly packages: ClassifierPackagesOperationsReport;
    readonly graph: ClassifierPackageExecutionGraphHealthReport;
    readonly workflowStatus: ClassifierLifecycleReviewStatus;
}): ClassifierLifecycleInsightReport {
    const failedOperations = input.graph.operations.filter((operation) => operation.failed_count > 0);
    const graphOperationsByPackage = new Map<string, readonly ClassifierGraphOperationHealth[]>();
    for (const operation of input.graph.operations) {
        const current = graphOperationsByPackage.get(operation.package_key) ?? [];
        graphOperationsByPackage.set(operation.package_key, [...current, operation]);
    }
    const packages = input.packages.packages.map((entry): ClassifierLifecyclePackageInsight => {
        const graphOperations = graphOperationsByPackage.get(entry.package_key) ?? [];
        const lastExecution = graphOperations
            .map((operation) => operation.last_execution)
            .filter((execution): execution is NonNullable<ClassifierGraphOperationHealth["last_execution"]> => Boolean(execution))
            .slice()
            .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")))[0];
        return {
            package_key: entry.package_key,
            package_name: entry.package_name,
            kind: entry.kind,
            lifecycle_readiness: entry.lifecycle_readiness,
            operation_count: entry.operation_count,
            operation_kinds: entry.operation_kinds,
            graph_operation_count: graphOperations.length,
            guarded_operation_count: graphOperations.filter((operation) => operation.guarded_count > 0).length,
            failed_operation_count: graphOperations.filter((operation) => operation.failed_count > 0).length,
            changed_artifact_count: graphOperations.reduce((total, operation) => total + operation.changed_artifact_count, 0),
            ...(lastExecution ? { last_execution: lastExecution } : {}),
        };
    });
    const reviewPipeline = input.workflowStatus.review_pipeline_lifecycle
        ? {
            report_path: input.workflowStatus.review_pipeline_lifecycle.report_path,
            ...(input.workflowStatus.review_pipeline_lifecycle.lifecycle_status === undefined ? {} : {
                status: input.workflowStatus.review_pipeline_lifecycle.lifecycle_status,
            }),
            ...(input.workflowStatus.review_pipeline_lifecycle.command_kind === undefined ? {} : {
                command_kind: input.workflowStatus.review_pipeline_lifecycle.command_kind,
            }),
            ...(input.workflowStatus.review_pipeline_lifecycle.prepared_status === undefined ? {} : {
                prepared_status: input.workflowStatus.review_pipeline_lifecycle.prepared_status,
            }),
            ...(input.workflowStatus.review_pipeline_lifecycle.output_verification_status === undefined ? {} : {
                output_verification_status: input.workflowStatus.review_pipeline_lifecycle.output_verification_status,
            }),
            ...(input.workflowStatus.review_pipeline_lifecycle.can_execute === undefined ? {} : {
                can_execute: input.workflowStatus.review_pipeline_lifecycle.can_execute,
            }),
            ...(input.workflowStatus.review_pipeline_lifecycle.can_continue === undefined ? {} : {
                can_continue: input.workflowStatus.review_pipeline_lifecycle.can_continue,
            }),
            missing_required_artifact_count: input.workflowStatus.review_pipeline_lifecycle.missing_required_artifact_count ?? 0,
            checked_artifact_count: input.workflowStatus.review_pipeline_lifecycle.checked_artifact_count ?? 0,
            ...(input.workflowStatus.review_pipeline_lifecycle.prepared_argv === undefined ? {} : {
                prepared_argv: input.workflowStatus.review_pipeline_lifecycle.prepared_argv,
            }),
            output_artifacts: input.workflowStatus.review_pipeline_lifecycle.output_artifacts ?? [],
            checked_artifacts: input.workflowStatus.review_pipeline_lifecycle.checked_artifacts ?? [],
            failures: input.workflowStatus.review_pipeline_lifecycle.failures ?? [],
            next_action: reviewPipelineLifecycleNextAction(input.workflowStatus.review_pipeline_lifecycle),
        } satisfies ClassifierReviewPipelineLifecycleInsight
        : undefined;
    const blockingItems = [
        ...packages
            .filter((entry) => entry.lifecycle_readiness.status === "incomplete")
            .map((entry) => `${entry.package_key} missing lifecycle operation kinds: ${entry.lifecycle_readiness.missing_required_kinds.join(", ")}`),
        ...(input.graph.decision === "empty_graph" ? ["classifier lifecycle graph is empty; run apply-write-plan before graph queries"] : []),
        ...input.graph.guarded_operations.map((operation) =>
            `${operation.package_key}/${operation.operation_id} guarded ${operation.guarded_count} time(s)`,
        ),
        ...failedOperations.map((operation) =>
            `${operation.package_key}/${operation.operation_id} failed ${operation.failed_count} time(s)`,
        ),
        ...(input.workflowStatus.exists && input.workflowStatus.decision && input.workflowStatus.decision !== "ready_for_next_model_run" && input.workflowStatus.decision !== "healthy"
            ? [`workflow status ${input.workflowStatus.decision}`]
            : []),
        ...(input.workflowStatus.proposal_review?.decision === "needs_workflow_candidate_proposal_review"
            ? [`workflow candidate proposal review pending ${input.workflowStatus.proposal_review.pending_count ?? 0} proposal(s)`]
            : []),
        ...(input.workflowStatus.proposal_promotion?.decision === "needs_workflow_candidate_proposal_review"
            ? ["workflow candidate proposal promotion blocked by review"]
            : []),
        ...(reviewPipeline && reviewPipeline.missing_required_artifact_count > 0
            ? [`review pipeline missing ${reviewPipeline.missing_required_artifact_count} required output artifact(s)`]
            : []),
        ...(reviewPipeline && reviewPipeline.can_continue === false
            ? [`review pipeline lifecycle cannot continue: ${reviewPipeline.status ?? "unknown"}`]
            : []),
        ...(reviewPipeline
            ? reviewPipeline.failures.map((failure) => `review pipeline failure: ${failure}`)
            : []),
        ...((input.workflowStatus.pending_blind_labels ?? 0) > 0
            ? [`${input.workflowStatus.pending_blind_labels} blind labels pending`]
            : []),
        ...((input.workflowStatus.pending_hard_negatives ?? 0) > 0
            ? [`${input.workflowStatus.pending_hard_negatives} hard-negative decisions pending`]
            : []),
    ];
    const pendingBlindLabels = input.workflowStatus.pending_blind_labels ?? 0;
    const pendingHardNegatives = input.workflowStatus.pending_hard_negatives ?? 0;
    const proposalReviewPending = input.workflowStatus.proposal_review?.decision === "needs_workflow_candidate_proposal_review";
    const proposalPromotionBlocked = input.workflowStatus.proposal_promotion?.decision === "needs_workflow_candidate_proposal_review";
    const reviewPipelineBlocked = reviewPipeline?.next_action === "repair_review_pipeline_outputs" || reviewPipeline?.can_continue === false;
    const decision: ClassifierLifecycleInsightReport["decision"] = input.graph.decision === "empty_graph"
        ? "needs_graph_apply"
        : pendingBlindLabels > 0 || pendingHardNegatives > 0 || input.workflowStatus.decision === "needs_human_review" || proposalReviewPending || proposalPromotionBlocked || reviewPipelineBlocked
            ? "needs_human_review"
            : input.graph.guarded_operations.length > 0
                ? "has_guarded_operations"
                : "healthy";
    return {
        schema: "ax.classifier_lifecycle_insight_report.v1",
        packages_root: input.packages.root,
        graph_tables: input.graph.tables,
        workflow_status: input.workflowStatus,
        packages,
        guarded_operations: input.graph.guarded_operations,
        failed_operations: failedOperations,
        changed_artifacts: input.graph.changed_artifacts,
        blocking_items: blockingItems,
        ...(reviewPipeline ? { review_pipeline: reviewPipeline } : {}),
        totals: {
            package_count: input.packages.totals.package_count,
            local_model_count: input.packages.totals.local_model_count,
            local_model_ready_count: input.packages.totals.local_model_ready_count,
            local_model_incomplete_count: input.packages.totals.local_model_incomplete_count,
            graph_operation_count: input.graph.totals.operation_count,
            guarded_operation_count: input.graph.result_totals.guarded_operation_count,
            failed_operation_count: failedOperations.length,
            changed_artifact_count: input.graph.result_totals.changed_artifact_count,
            pending_blind_labels: pendingBlindLabels,
            pending_hard_negatives: pendingHardNegatives,
        },
        decision,
    };
}

export function writeOperationsReport(path: string, report: ClassifierPackageOperationsReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeOperationPreflightReport(path: string, report: ClassifierPackageOperationPreflightReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeOperationDryRunReport(path: string, report: ClassifierPackageOperationDryRunReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeOperationExecutionPlanReport(path: string, report: ClassifierPackageOperationExecutionPlanReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeOperationExecutionReport(path: string, report: ClassifierPackageOperationExecutionReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writePackagesOperationsReport(path: string, report: ClassifierPackagesOperationsReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeExecutionHistoryReport(path: string, report: ClassifierPackageExecutionHistoryReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeExecutionFactProjectionReport(path: string, report: ClassifierPackageExecutionFactProjectionReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeExecutionSurrealWritePlanReport(path: string, report: ClassifierPackageExecutionSurrealWritePlanReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeExecutionSurrealApplyReport(path: string, report: ClassifierPackageExecutionSurrealApplyReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeExecutionGraphHealthReport(path: string, report: ClassifierPackageExecutionGraphHealthReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeClassifierLifecycleInsightReport(path: string, report: ClassifierLifecycleInsightReport): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}
