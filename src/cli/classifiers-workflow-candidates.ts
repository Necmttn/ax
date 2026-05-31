import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { prettyPrint } from "../lib/json.ts";
import { recordKeyPart, safeKeyPart } from "../lib/shared/derive-keys.ts";
import { safeJsonParse } from "../lib/shared/safe-json.ts";
import {
    recordRef,
    surrealJson,
    surrealJsonText,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "../lib/shared/surql.ts";
import { catchDbErrorAndExit } from "./output.ts";

export type WorkflowCandidateTaskLikeMode = "include" | "exclude" | "only";
export type WorkflowCandidatePromotionMode = "per-candidate" | "merge-evidence";
export type WorkflowCandidatePromotionArtifact = "guidance" | "harness_check" | "classifier_fixture" | "review";
export type WorkflowCandidateProposalStatusFilter = "all" | "open" | "accepted" | "rejected";

export interface WorkflowCandidateCommandInput {
    readonly sourceKind: string;
    readonly limit: number;
    readonly examples: number;
    readonly action?: string;
    readonly classifier?: string;
    readonly search?: string;
    readonly taskLike: WorkflowCandidateTaskLikeMode;
    readonly topicReport?: boolean;
    readonly listProposals?: boolean;
    readonly listHarnessFacts?: boolean;
    readonly reviewCoverage?: boolean;
    readonly includeHarnessFacts?: boolean;
    readonly includeHelperFacts?: boolean;
    readonly includeReviewFacts?: boolean;
    readonly proposalStatus?: WorkflowCandidateProposalStatusFilter;
    readonly expandEvidence?: boolean;
    readonly evidencePack?: string;
    readonly classifierFixturePack?: string;
    readonly coverageFixturePack?: string;
    readonly coverageReviewPack?: string;
    readonly coverageReviewBrief?: string;
    readonly syncCoverageReviewBrief?: string;
    readonly harnessFacts?: string;
    readonly harnessWritePlan?: string;
    readonly applyHarnessFacts?: boolean;
    readonly reviewFacts?: string;
    readonly reviewWritePlan?: string;
    readonly applyReviewFacts?: boolean;
    readonly requireReviewProvenance?: boolean;
    readonly requireReviewHandoff?: boolean;
    readonly reviewProvenanceReviewer?: string;
    readonly reviewProvenanceReviewedAt?: string;
    readonly out?: string;
    readonly brief?: string;
    readonly syncBrief?: string;
    readonly promoteTasks?: boolean;
    readonly emitAdjacentTasks?: boolean;
    readonly promoteHarnessProposals?: boolean;
    readonly requireHarnessChecks?: boolean;
    readonly promoteProposals?: boolean;
    readonly proposalDryRun?: boolean;
    readonly taskDir?: string;
    readonly promotionMode?: WorkflowCandidatePromotionMode;
    readonly proposalTarget?: string;
    readonly proposalSection?: string;
    readonly json: boolean;
}

export interface WorkflowCandidateProposalListRow {
    readonly proposal_id?: string | null;
    readonly dedupe_sig: string;
    readonly title: string;
    readonly form: string;
    readonly status: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly target?: string | null;
    readonly section?: string | null;
    readonly experiment_id?: string | null;
    readonly experiment_status?: string | null;
    readonly artifact_path?: string | null;
    readonly task_path?: string | null;
    readonly updated_at?: string | null;
    readonly evidence?: readonly WorkflowCandidateProposalEvidence[];
}

export interface WorkflowCandidateProposalEvidenceExample {
    readonly result_id?: unknown;
    readonly turn?: unknown;
    readonly confidence?: unknown;
    readonly text_excerpt: string;
}

export interface WorkflowCandidateProposalEvidence {
    readonly candidate_id: string;
    readonly candidate_label: string;
    readonly classifier_key?: unknown;
    readonly target?: unknown;
    readonly proposed_action?: unknown;
    readonly examples: readonly WorkflowCandidateProposalEvidenceExample[];
}

export interface WorkflowCandidateProposalListReport {
    readonly schema: "ax.workflow_candidate_proposal_list.v1";
    readonly prefix: "guidance__workflow_candidate__";
    readonly query: {
        readonly limit: number;
        readonly status: WorkflowCandidateProposalStatusFilter;
        readonly expand_evidence: boolean;
        readonly search?: string;
    };
    readonly proposals: readonly WorkflowCandidateProposalListRow[];
    readonly totals: {
        readonly proposal_count: number;
        readonly accepted_count: number;
        readonly open_count: number;
        readonly rejected_count: number;
        readonly scaffolded_experiment_count: number;
        readonly evidence_candidate_count: number;
        readonly evidence_example_count: number;
    };
}

export interface WorkflowCandidateProposalEvidenceEdgeRow {
    readonly proposal_id?: string | null;
    readonly candidate_ref?: string | null;
}

export interface WorkflowCandidateTopicReport {
    readonly schema: "ax.workflow_candidate_topic_report.v1";
    readonly source_kind: string;
    readonly topic: string;
    readonly proposals: WorkflowCandidateProposalListReport;
    readonly candidates: WorkflowCandidateReport;
    readonly totals: {
        readonly proposal_count: number;
        readonly experiment_count: number;
        readonly proposal_evidence_candidate_count: number;
        readonly ranked_candidate_count: number;
        readonly candidate_evidence_fact_count: number;
        readonly source_turn_count: number;
    };
    readonly decision: "workflow_topic_evidence_found" | "needs_workflow_topic_evidence";
    readonly failures: readonly string[];
    readonly adjacent_tasks?: WorkflowCandidateTopicTaskSummary;
    readonly classifier_fixtures?: WorkflowCandidateTopicClassifierFixtureSummary;
    readonly harness_proposals?: WorkflowCandidateHarnessProposalSummary;
    readonly harness_evidence?: WorkflowCandidateTopicHarnessEvidenceSummary;
    readonly harness_checks?: WorkflowCandidateTopicHarnessCheckSummary;
    readonly persisted_harness_facts?: WorkflowCandidateTopicHarnessGraphListReport;
    readonly persisted_review_facts?: WorkflowCandidateTopicReviewGraphListReport;
    readonly helper_explanations?: WorkflowCandidateTopicHelperExplanationReport;
}

export interface WorkflowCandidateTopicTaskSummary {
    readonly task_dir: string;
    readonly emitted_task_count: number;
    readonly tasks: readonly WorkflowCandidatePromotionTask[];
}

export interface WorkflowCandidateTopicClassifierFixtureSummary {
    readonly path: string;
    readonly emitted_fixture_count: number;
    readonly candidate_count: number;
    readonly skipped_candidate_count: number;
    readonly fixtures: readonly WorkflowCandidateTopicClassifierFixtureRow[];
}

export interface WorkflowCandidateReviewCoverageFixtureSummary {
    readonly path: string;
    readonly emitted_fixture_count: number;
    readonly candidate_count: number;
    readonly skipped_candidate_count: number;
    readonly fixtures: readonly WorkflowCandidateTopicClassifierFixtureRow[];
}

export type WorkflowCandidateReviewCoverageApplyGuard =
    | "ready_to_apply"
    | "blocked_smoke_review"
    | "invalid_review_pack"
    | "missing_review_handoff"
    | "missing_review_provenance"
    | "missing_review_rationale"
    | "no_reviewed_fixtures";

export type WorkflowCandidateReviewCoverageApplyBlocker =
    | "blocked_smoke_review"
    | "empty_write_plan"
    | "invalid_review_pack"
    | "missing_review_handoff"
    | "missing_review_provenance"
    | "missing_review_rationale"
    | "no_reviewed_fixtures";

export interface WorkflowCandidateReviewCoverageApplyBlockerDetail {
    readonly blocker: WorkflowCandidateReviewCoverageApplyBlocker;
    readonly count: number;
    readonly remediation: string;
}

export type WorkflowCandidateReviewVerdict = "accept" | "revise" | "reject" | "defer";

export type WorkflowCandidateReviewCoverageProvenanceStatus =
    | "complete_review_provenance"
    | "missing_review_provenance";

export interface WorkflowCandidateReviewCoverageApplyAuditRow {
    readonly fixture_id: string;
    readonly candidate_id: string;
    readonly verdict: WorkflowCandidateReviewVerdict;
    readonly projected_fact_id: string | null;
    readonly reviewer: string;
    readonly reviewed_at: string;
}

export type WorkflowCandidateReviewCoverageProvenanceIssue =
    | "invalid_reviewed_at"
    | "missing_reviewed_at"
    | "missing_reviewer";

export interface WorkflowCandidateReviewCoverageProvenanceIssueRow {
    readonly fixture_id: string;
    readonly candidate_id: string;
    readonly issue: WorkflowCandidateReviewCoverageProvenanceIssue;
    readonly reviewer: string;
    readonly reviewed_at: string;
}

export type WorkflowCandidateReviewCoverageReviewIssue =
    | "blocked_smoke_review"
    | "invalid_review_status"
    | "invalid_reviewed_at"
    | "missing_review_rationale"
    | "missing_reviewed_at"
    | "missing_reviewer";

export type WorkflowCandidateReviewCoverageReviewIssueBlockingScope =
    | "base_apply"
    | "production_apply";

export interface WorkflowCandidateReviewCoverageReviewIssueRow {
    readonly fixture_id: string;
    readonly candidate_id: string;
    readonly issue: WorkflowCandidateReviewCoverageReviewIssue;
    readonly review_status: string;
    readonly blocking_scope: WorkflowCandidateReviewCoverageReviewIssueBlockingScope;
    readonly remediation: string;
}

export interface WorkflowCandidateReviewCoverageReviewIssueCount {
    readonly issue: WorkflowCandidateReviewCoverageReviewIssue;
    readonly count: number;
}

export interface WorkflowCandidateReviewCoverageReviewIssueScopeCount {
    readonly blocking_scope: WorkflowCandidateReviewCoverageReviewIssueBlockingScope;
    readonly count: number;
}

export interface WorkflowCandidateReviewCoverageReviewIssueScopeSummary {
    readonly blocking_scope: WorkflowCandidateReviewCoverageReviewIssueBlockingScope;
    readonly issue_count: number;
    readonly fixture_count: number;
    readonly candidate_count: number;
}

export type WorkflowCandidateReviewCoverageReviewIssueStatus =
    | "needs_review_repair"
    | "review_repair_complete";

export type WorkflowCandidateReviewCoveragePipelineStage =
    | "needs_review_decisions"
    | "needs_review_repair"
    | "needs_review_provenance"
    | "needs_review_handoff"
    | "ready_for_production_apply";

export type WorkflowCandidateReviewCoveragePipelineCommandKind =
    | "repair_review_issues"
    | "stamp_review_provenance"
    | "apply_review_facts";

export type WorkflowCandidateReviewCoverageRecheckStatus =
    | "gap_closed"
    | "gap_reduced"
    | "gap_regressed"
    | "gap_unchanged";

export interface WorkflowCandidateReviewCoveragePostApplyRecheckSummary {
    readonly schema: "ax.workflow_candidate_review_coverage_recheck.v1";
    readonly status: WorkflowCandidateReviewCoverageRecheckStatus;
    readonly before_reviewed_candidate_count: number;
    readonly before_unreviewed_candidate_count: number;
    readonly projected_reviewed_candidate_count: number;
    readonly projected_unreviewed_candidate_count: number;
    readonly after_reviewed_candidate_count: number;
    readonly after_unreviewed_candidate_count: number;
    readonly reviewed_candidate_delta: number;
    readonly unreviewed_candidate_delta: number;
    readonly projected_reviewed_delta: number;
    readonly projected_unreviewed_delta: number;
    readonly command: string;
}

export type WorkflowCandidateReviewCoverageHandoffStatus =
    | "complete_review_handoff"
    | "incomplete_review_handoff";

export type WorkflowCandidateReviewCoverageHandoffMissingPath =
    | "review_brief_path"
    | "review_facts_path"
    | "review_write_plan_path"
    | "synced_review_brief_path";

export interface WorkflowCandidateReviewCoverageApplySummary {
    readonly schema: "ax.workflow_candidate_review_readiness.v1";
    readonly source_path: string;
    readonly review_facts_path?: string;
    readonly review_write_plan_path?: string;
    readonly review_brief_path?: string;
    readonly synced_review_brief_path?: string;
    readonly review_handoff_status: WorkflowCandidateReviewCoverageHandoffStatus;
    readonly review_handoff_missing_paths: readonly WorkflowCandidateReviewCoverageHandoffMissingPath[];
    readonly handoff_apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly handoff_can_apply: boolean;
    readonly handoff_apply_blockers: readonly WorkflowCandidateReviewCoverageApplyBlocker[];
    readonly handoff_apply_blocker_details: readonly WorkflowCandidateReviewCoverageApplyBlockerDetail[];
    readonly apply_requested: boolean;
    readonly applied: boolean;
    readonly apply_result: "not_requested" | "blocked" | "applied";
    readonly applied_statement_count: number;
    readonly reviewed_fixture_count: number;
    readonly pending_fixture_count: number;
    readonly invalid_fixture_count: number;
    readonly missing_rationale_count: number;
    readonly missing_reviewer_count: number;
    readonly missing_reviewed_at_count: number;
    readonly invalid_reviewed_at_count: number;
    readonly provenance_status: WorkflowCandidateReviewCoverageProvenanceStatus;
    readonly provenance_next_action: string;
    readonly synced_fixture_count: number;
    readonly unknown_fixture_count: number;
    readonly stamped_reviewer_count: number;
    readonly stamped_reviewed_at_count: number;
    readonly pack_candidate_count: number;
    readonly new_candidate_count: number;
    readonly existing_candidate_count: number;
    readonly unknown_candidate_count: number;
    readonly projected_reviewed_candidate_count: number;
    readonly projected_unreviewed_candidate_count: number;
    readonly smoke_marker_count: number;
    readonly apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly can_apply: boolean;
    readonly apply_blockers: readonly WorkflowCandidateReviewCoverageApplyBlocker[];
    readonly apply_blocker_details: readonly WorkflowCandidateReviewCoverageApplyBlockerDetail[];
    readonly strict_apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly strict_can_apply: boolean;
    readonly strict_apply_blockers: readonly WorkflowCandidateReviewCoverageApplyBlocker[];
    readonly strict_apply_blocker_details: readonly WorkflowCandidateReviewCoverageApplyBlockerDetail[];
    readonly production_apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly production_can_apply: boolean;
    readonly production_apply_blockers: readonly WorkflowCandidateReviewCoverageApplyBlocker[];
    readonly production_apply_blocker_details: readonly WorkflowCandidateReviewCoverageApplyBlockerDetail[];
    readonly production_next_action: string;
    readonly production_apply_command?: string;
    readonly review_provenance_stamp_command?: string;
    readonly next_action: string;
    readonly post_apply_recheck_command: string;
    readonly post_apply_recheck?: WorkflowCandidateReviewCoveragePostApplyRecheckSummary;
    readonly reviewed_fixture_ids: readonly string[];
    readonly projected_fact_ids: readonly string[];
    readonly apply_audit_rows: readonly WorkflowCandidateReviewCoverageApplyAuditRow[];
    readonly review_issue_rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[];
    readonly review_issue_counts: readonly WorkflowCandidateReviewCoverageReviewIssueCount[];
    readonly review_issue_scope_counts: readonly WorkflowCandidateReviewCoverageReviewIssueScopeCount[];
    readonly review_issue_scope_fixture_counts: readonly WorkflowCandidateReviewCoverageReviewIssueScopeCount[];
    readonly review_issue_scope_candidate_counts: readonly WorkflowCandidateReviewCoverageReviewIssueScopeCount[];
    readonly review_issue_scope_summaries: readonly WorkflowCandidateReviewCoverageReviewIssueScopeSummary[];
    readonly review_issue_fixture_count: number;
    readonly review_issue_candidate_count: number;
    readonly review_issue_status: WorkflowCandidateReviewCoverageReviewIssueStatus;
    readonly review_issue_next_action: string;
    readonly review_issue_repair_command?: string;
    readonly review_pipeline_stage: WorkflowCandidateReviewCoveragePipelineStage;
    readonly review_pipeline_next_action: string;
    readonly review_pipeline_command_kind?: WorkflowCandidateReviewCoveragePipelineCommandKind;
    readonly review_pipeline_command?: string;
    readonly provenance_issue_rows: readonly WorkflowCandidateReviewCoverageProvenanceIssueRow[];
    readonly projection_totals: WorkflowCandidateTopicReviewGraphProjection["totals"];
    readonly write_plan_totals: WorkflowCandidateTopicReviewGraphWritePlan["totals"];
}

export interface WorkflowCandidateFixtureBriefSyncResult {
    readonly rows: readonly WorkflowCandidateTopicClassifierFixtureRow[];
    readonly synced_fixture_count: number;
    readonly unknown_fixture_count: number;
}

export interface WorkflowCandidateReviewProvenanceStampResult {
    readonly rows: readonly WorkflowCandidateTopicClassifierFixtureRow[];
    readonly stamped_reviewer_count: number;
    readonly stamped_reviewed_at_count: number;
}

export interface WorkflowCandidateReviewCoverageBriefContext {
    readonly sourceKind?: string;
    readonly limit?: number;
    readonly coverageFixturePack?: string;
    readonly coverageReviewPack?: string;
    readonly coverageReviewBrief?: string;
    readonly outputPath?: string;
}

export interface WorkflowCandidateTopicClassifierFixtureRow {
    readonly id: string;
    readonly suite: "workflow-candidate-topic" | "workflow-candidate-review-coverage";
    readonly name: string;
    readonly label: string;
    readonly target: string;
    readonly text: string;
    readonly source_group: "workflow-candidate";
    readonly review_status: "pending" | "accept" | "revise" | "reject" | "defer";
    readonly review_rationale?: string;
    readonly review_reviewer?: string;
    readonly review_reviewed_at?: string;
    readonly topic: string;
    readonly candidate_id: string;
    readonly candidate_label: string;
    readonly proposed_action: string;
    readonly result_id?: string;
    readonly turn?: string;
    readonly confidence?: number;
    readonly candidate_support_count?: number;
    readonly candidate_evidence_count?: number;
    readonly candidate_score?: number;
}

export interface WorkflowCandidateHarnessProposalSummary {
    readonly dry_run: boolean;
    readonly emitted_proposal_count: number;
    readonly skipped_proposal_count: number;
    readonly statement_count: number;
    readonly statements?: readonly string[];
    readonly proposals: readonly WorkflowCandidateHarnessProposal[];
    readonly failures: readonly string[];
}

export interface WorkflowCandidateHarnessProposal {
    readonly candidate_id: string;
    readonly proposal_id: string;
    readonly dedupe_sig: string;
    readonly title: string;
    readonly recommended_artifact: WorkflowCandidatePromotionRecommendation;
    readonly status: "created_or_refreshed" | "skipped";
    readonly reason?: string;
}

export interface WorkflowCandidateTopicHarnessCheckSummary {
    readonly passed_count: number;
    readonly failed_count: number;
    readonly checks: readonly WorkflowCandidateTopicHarnessCheck[];
}

export type WorkflowCandidateTopicHarnessGateEvidenceSource =
    | "none"
    | "computed"
    | "persisted"
    | "computed_and_persisted";

export interface WorkflowCandidateTopicHarnessEvidenceSummary {
    readonly gate_satisfied: boolean;
    readonly gate_evidence_source: WorkflowCandidateTopicHarnessGateEvidenceSource;
    readonly computed_check_count: number;
    readonly computed_passed_count: number;
    readonly computed_failed_count: number;
    readonly persisted_fact_count: number;
    readonly persisted_passed_count: number;
    readonly persisted_failed_count: number;
}

export interface WorkflowCandidateTopicHarnessCheck {
    readonly id: string;
    readonly candidate_id: string;
    readonly label: string;
    readonly status: "passed" | "failed";
    readonly expectation: string;
    readonly evidence_refs: readonly string[];
    readonly failures: readonly string[];
}

export interface WorkflowCandidateTopicHarnessGraphNode {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly properties: Record<string, unknown>;
}

export interface WorkflowCandidateTopicHarnessGraphEdge {
    readonly id: string;
    readonly kind: string;
    readonly from: string;
    readonly to: string;
    readonly evidence_path: string;
    readonly properties: Record<string, unknown>;
}

export interface WorkflowCandidateTopicHarnessGraphFact {
    readonly id: string;
    readonly kind: string;
    readonly subject: string;
    readonly predicate: string;
    readonly object: string | null;
    readonly value: unknown;
    readonly evidence_edges: readonly string[];
    readonly properties: Record<string, unknown>;
}

export interface WorkflowCandidateTopicHarnessGraphProjection {
    readonly schema: "ax.workflow_topic_harness_graph_projection.v1";
    readonly source_report_schema: WorkflowCandidateTopicReport["schema"];
    readonly topic: string;
    readonly nodes: readonly WorkflowCandidateTopicHarnessGraphNode[];
    readonly edges: readonly WorkflowCandidateTopicHarnessGraphEdge[];
    readonly facts: readonly WorkflowCandidateTopicHarnessGraphFact[];
    readonly totals: {
        readonly check_count: number;
        readonly passed_count: number;
        readonly failed_count: number;
        readonly node_count: number;
        readonly edge_count: number;
        readonly fact_count: number;
    };
}

export interface WorkflowCandidateTopicHarnessGraphWritePlan {
    readonly schema: "ax.workflow_topic_harness_graph_write_plan.v1";
    readonly source_projection_schema: WorkflowCandidateTopicHarnessGraphProjection["schema"];
    readonly topic: string;
    readonly statements: readonly string[];
    readonly tables: readonly string[];
    readonly totals: {
        readonly statement_count: number;
        readonly node_statement_count: number;
        readonly edge_statement_count: number;
        readonly fact_statement_count: number;
    };
}

export interface WorkflowCandidateTopicReviewGraphProjection {
    readonly schema: "ax.workflow_topic_review_graph_projection.v1";
    readonly source_report_schema: WorkflowCandidateTopicReport["schema"] | "ax.workflow_candidate_review_coverage_fixture_pack.v1";
    readonly topic: string;
    readonly nodes: readonly WorkflowCandidateTopicHarnessGraphNode[];
    readonly edges: readonly WorkflowCandidateTopicHarnessGraphEdge[];
    readonly facts: readonly WorkflowCandidateTopicHarnessGraphFact[];
    readonly totals: {
        readonly reviewed_candidate_count: number;
        readonly rejected_count: number;
        readonly accepted_count: number;
        readonly deferred_count: number;
        readonly revised_count: number;
        readonly node_count: number;
        readonly edge_count: number;
        readonly fact_count: number;
    };
}

export interface WorkflowCandidateTopicReviewGraphWritePlan {
    readonly schema: "ax.workflow_topic_review_graph_write_plan.v1";
    readonly source_projection_schema: WorkflowCandidateTopicReviewGraphProjection["schema"];
    readonly topic: string;
    readonly statements: readonly string[];
    readonly tables: readonly string[];
    readonly totals: {
        readonly statement_count: number;
        readonly node_statement_count: number;
        readonly edge_statement_count: number;
        readonly fact_statement_count: number;
    };
}

export interface WorkflowCandidateTopicHarnessGraphFactRow {
    readonly graph_id?: string;
    readonly subject?: string;
    readonly predicate?: string;
    readonly object?: string | null;
    readonly value_json?: string | null;
    readonly properties_json?: string;
    readonly updated_at?: string | null;
}

export interface WorkflowCandidateTopicHarnessGraphEdgeRow {
    readonly graph_id?: string;
    readonly kind?: string;
    readonly from_id?: string;
    readonly to_id?: string;
    readonly evidence_path?: string;
    readonly properties_json?: string;
    readonly updated_at?: string | null;
}

export interface WorkflowCandidateTopicHarnessGraphListReport {
    readonly schema: "ax.workflow_topic_harness_graph_list.v1";
    readonly topic?: string;
    readonly facts: readonly WorkflowCandidateTopicHarnessGraphFactRow[];
    readonly edges: readonly WorkflowCandidateTopicHarnessGraphEdgeRow[];
    readonly totals: {
        readonly fact_count: number;
        readonly edge_count: number;
        readonly passed_count: number;
        readonly failed_count: number;
    };
}

export interface WorkflowCandidateTopicReviewGraphListReport {
    readonly schema: "ax.workflow_topic_review_graph_list.v1";
    readonly topic?: string;
    readonly facts: readonly WorkflowCandidateTopicHarnessGraphFactRow[];
    readonly edges: readonly WorkflowCandidateTopicHarnessGraphEdgeRow[];
    readonly totals: {
        readonly fact_count: number;
        readonly edge_count: number;
        readonly rejected_count: number;
        readonly accepted_count: number;
        readonly deferred_count: number;
        readonly revised_count: number;
    };
}

export interface WorkflowCandidateEmbeddingHelperGraphFactRow {
    readonly graph_id?: string;
    readonly subject?: string;
    readonly predicate?: string;
    readonly object?: string | null;
    readonly value_json?: string | null;
    readonly evidence_edges_json?: string | null;
    readonly properties_json?: string;
    readonly updated_at?: string;
}

export interface WorkflowCandidateEmbeddingHelperGraphEdgeRow {
    readonly graph_id?: string;
    readonly kind?: string;
    readonly from_id?: string;
    readonly to_id?: string;
    readonly evidence_path?: string;
    readonly properties_json?: string;
    readonly updated_at?: string;
}

export interface WorkflowCandidateHelperFixtureRow {
    readonly id: string;
    readonly text: string;
}

export interface WorkflowCandidateTopicHelperExplanation {
    readonly source_fixture_id: string;
    readonly promoted_fixture_id?: string;
    readonly fact_id: string;
    readonly status?: string;
    readonly proposed_label?: string;
    readonly candidate_id: string;
    readonly candidate_label: string;
    readonly proposed_action: string;
    readonly turn?: string;
    readonly result_id?: string;
    readonly match_score: number;
    readonly text_excerpt: string;
    readonly nearest_neighbors: readonly { readonly fixture_id: string; readonly similarity?: number }[];
    readonly evidence_paths: readonly string[];
}

export interface WorkflowCandidateTopicHelperExplanationReport {
    readonly schema: "ax.workflow_candidate_topic_helper_explanations.v1";
    readonly min_token_overlap: number;
    readonly explanations: readonly WorkflowCandidateTopicHelperExplanation[];
    readonly totals: {
        readonly promoted_helper_fact_count: number;
        readonly fixture_text_count: number;
        readonly matched_example_count: number;
        readonly matched_candidate_count: number;
    };
}

export interface WorkflowCandidateGroupRow {
    readonly graph_id?: string;
    readonly label?: string;
    readonly properties_json?: string;
}

export interface WorkflowCandidateEvidenceRow {
    readonly graph_id?: string;
    readonly subject?: string;
    readonly object?: string | null;
    readonly properties_json?: string;
}

export interface WorkflowCandidateExample {
    readonly result_id?: unknown;
    readonly turn?: unknown;
    readonly confidence?: unknown;
    readonly task_like: boolean;
    readonly text_excerpt: string;
}

export interface WorkflowCandidate {
    readonly group_id: string;
    readonly label: string;
    readonly classifier_key?: unknown;
    readonly classifier_label?: unknown;
    readonly target?: unknown;
    readonly proposed_action: string;
    readonly raw_support_count: number;
    readonly support_count: number;
    readonly evidence_count: number;
    readonly turn_ref_count: number;
    readonly average_confidence: number;
    readonly wrapper_like_count: number;
    readonly task_like_count: number;
    readonly task_like_ratio: number;
    readonly score: number;
    readonly examples: readonly WorkflowCandidateExample[];
    readonly review?: WorkflowCandidateReview;
    readonly persisted_review_facts?: readonly WorkflowCandidatePersistedReviewFact[];
}

export interface WorkflowCandidateReview {
    readonly verdict: string;
    readonly rationale: string;
}

export interface WorkflowCandidatePersistedReviewFact {
    readonly graph_id?: string;
    readonly topic?: string;
    readonly subject?: string;
    readonly predicate?: string;
    readonly object?: string;
    readonly candidate_id?: string;
    readonly rationale?: string;
    readonly helper_source_fixture_ids: readonly string[];
    readonly updated_at?: string;
    readonly value_json?: string;
}

export interface WorkflowCandidateReviewCoverageRow {
    readonly candidate_id: string;
    readonly label: string;
    readonly proposed_action: string;
    readonly support_count: number;
    readonly evidence_count: number;
    readonly review_fact_count: number;
    readonly topics: readonly string[];
    readonly verdict_counts: {
        readonly reject: number;
        readonly accept: number;
        readonly defer: number;
        readonly revise: number;
        readonly other: number;
    };
    readonly helper_source_fixture_ids: readonly string[];
}

export interface WorkflowCandidateReviewCoverageReport {
    readonly schema: "ax.workflow_candidate_review_coverage.v1";
    readonly source_kind: string;
    readonly query: {
        readonly limit: number;
        readonly search?: string;
    };
    readonly candidates: readonly WorkflowCandidateReviewCoverageRow[];
    readonly totals: {
        readonly candidate_group_count: number;
        readonly returned_candidate_count: number;
        readonly reviewed_candidate_count: number;
        readonly unreviewed_candidate_count: number;
        readonly review_fact_count: number;
        readonly rejected_fact_count: number;
        readonly accepted_fact_count: number;
        readonly deferred_fact_count: number;
        readonly revised_fact_count: number;
        readonly helper_source_fixture_count: number;
    };
    readonly fixture_pack?: WorkflowCandidateReviewCoverageFixtureSummary;
    readonly coverage_review?: WorkflowCandidateReviewCoverageApplySummary;
    readonly decision: "workflow_candidate_review_coverage_ready" | "needs_workflow_candidate_reviews";
}

export interface WorkflowCandidateReport {
    readonly schema: "ax.workflow_candidate_report.v1";
    readonly source_kind: string;
    readonly query: {
        readonly limit: number;
        readonly examples_per_group: number;
        readonly action?: string;
        readonly classifier?: string;
        readonly search?: string;
        readonly task_like: WorkflowCandidateTaskLikeMode;
    };
    readonly candidates: readonly WorkflowCandidate[];
    readonly all_candidate_labels: readonly string[];
    readonly totals: {
        readonly candidate_group_count: number;
        readonly returned_candidate_count: number;
        readonly evidence_fact_count: number;
        readonly considered_evidence_fact_count: number;
        readonly candidate_with_evidence_count: number;
        readonly wrapper_like_count: number;
        readonly task_like_count: number;
        readonly persisted_review_fact_count: number;
    };
    readonly failures: readonly string[];
    readonly decision: "workflow_candidates_ranked" | "needs_workflow_candidate_review";
    readonly review?: WorkflowCandidateReviewSummary;
    readonly promotion?: WorkflowCandidatePromotionSummary;
}

export interface WorkflowCandidateReviewSummary {
    readonly synced_from: string;
    readonly reviewed_candidate_count: number;
    readonly pending_candidate_count: number;
    readonly invalid_verdict_count: number;
    readonly missing_rationale_count: number;
    readonly unknown_candidate_count: number;
}

export interface WorkflowCandidatePromotionTask {
    readonly candidate_id: string;
    readonly candidate_ids?: readonly string[];
    readonly label: string;
    readonly verdict: string;
    readonly recommended_artifact: WorkflowCandidatePromotionRecommendation;
    readonly path: string;
}

export interface WorkflowCandidatePromotionRecommendation {
    readonly primary: WorkflowCandidatePromotionArtifact;
    readonly alternatives: readonly WorkflowCandidatePromotionArtifact[];
    readonly confidence: "low" | "medium" | "high";
    readonly rationale: string;
}

export interface WorkflowCandidatePromotionSummary {
    readonly mode: WorkflowCandidatePromotionMode;
    readonly task_dir: string;
    readonly emitted_task_count: number;
    readonly skipped_candidate_count: number;
    readonly blocked_candidate_count: number;
    readonly tasks: readonly WorkflowCandidatePromotionTask[];
    readonly failures: readonly string[];
    readonly proposals?: WorkflowCandidateProposalPromotionSummary;
}

export interface WorkflowCandidateProposalPromotionSummary {
    readonly dry_run: boolean;
    readonly emitted_proposal_count: number;
    readonly skipped_proposal_count: number;
    readonly statement_count: number;
    readonly statements?: readonly string[];
    readonly proposals: readonly WorkflowCandidateProposalPromotion[];
    readonly failures: readonly string[];
}

export interface WorkflowCandidateProposalPromotion {
    readonly candidate_id: string;
    readonly candidate_ids?: readonly string[];
    readonly proposal_id: string;
    readonly guidance_payload_id: string;
    readonly dedupe_sig: string;
    readonly title: string;
    readonly file_target: string;
    readonly section: string;
    readonly recommended_artifact: WorkflowCandidatePromotionRecommendation;
    readonly status: "created_or_refreshed" | "skipped";
    readonly reason?: string;
}

interface WorkflowCandidateTaskDraft {
    readonly path: string;
    readonly content: string;
    readonly task: WorkflowCandidatePromotionTask;
}

interface WorkflowCandidateProposalPlan {
    readonly summary: WorkflowCandidateProposalPromotionSummary;
    readonly statements: readonly string[];
}

interface CandidateBuildInput {
    readonly groupRows: readonly WorkflowCandidateGroupRow[];
    readonly evidenceRows: readonly WorkflowCandidateEvidenceRow[];
    readonly sourceKind: string;
    readonly limit: number;
    readonly examplesPerGroup: number;
    readonly action?: string;
    readonly classifier?: string;
    readonly search?: string;
    readonly taskLike: WorkflowCandidateTaskLikeMode;
}

const workflowCandidateSql = `
SELECT graph_id, label, properties_json
FROM classifier_graph_node
WHERE source_kind = $sourceKind AND kind = "classifier_candidate_group";
SELECT graph_id, subject, object, properties_json
FROM classifier_graph_fact
WHERE source_kind = $sourceKind AND kind = "classifier_candidate_evidence";
`;

const WORKFLOW_CANDIDATE_PROPOSAL_PREFIX = "guidance__workflow_candidate__" as const;
const WORKFLOW_CANDIDATE_HARNESS_PROPOSAL_PREFIX = "harness_check__workflow_candidate__" as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const parseProperties = (value: string | undefined): Record<string, unknown> => {
    if (!value) return {};
    const parsed = safeJsonParse<unknown>(value);
    return isObject(parsed) ? parsed : {};
};

const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

const compactText = (text: string, limit = 220): string => {
    const squashed = text.split(/\s+/).filter(Boolean).join(" ");
    if (squashed.length <= limit) return squashed;
    return `${squashed.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
};

const userProjectionText = (text: string): string => {
    const match = text.match(/USER:\s*([\s\S]*?)(?:\n\s*(?:PREVIOUS_ASSISTANT|RECENT_TOOL_FAILURES|RECENT_FILES|NEXT_ACTION):|$)/i);
    return match?.[1]?.trim() || text;
};

const textTokens = (text: string): readonly string[] =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 3 && token !== "previous_assistant");

const tokenOverlapScore = (fixtureText: string, exampleText: string): number => {
    const fixtureTokens = new Set(textTokens(userProjectionText(fixtureText)));
    if (fixtureTokens.size === 0) return 0;
    const exampleTokens = new Set(textTokens(exampleText));
    let matches = 0;
    for (const token of fixtureTokens) {
        if (exampleTokens.has(token)) matches += 1;
    }
    return Number((matches / fixtureTokens.size).toFixed(4));
};

export function isTaskLikeWorkflowText(text: string): boolean {
    const lowered = text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
    return lowered.startsWith("you are implementing task") ||
        lowered.startsWith("implement task ") ||
        lowered.startsWith("spec compliance review") ||
        lowered.startsWith("re-review task") ||
        lowered.startsWith("quick review of") ||
        lowered.includes("worktree:") ||
        lowered.includes("do not edit files. review only");
}

const containsSearchText = (text: string, search: string | undefined): boolean =>
    search === undefined || text.toLowerCase().includes(search.toLowerCase());

const stripInlineCode = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
};

export function parseWorkflowCandidateBriefReview(brief: string): Record<string, WorkflowCandidateReview> {
    const updates: Record<string, WorkflowCandidateReview> = {};
    let currentCandidateId: string | undefined;
    for (const rawLine of brief.split(/\r?\n/)) {
        const line = rawLine.trim();
        const candidateMatch = line.match(/^- Candidate id:\s*(.+)$/);
        if (candidateMatch) {
            currentCandidateId = stripInlineCode(candidateMatch[1]);
            updates[currentCandidateId] = updates[currentCandidateId] ?? { verdict: "pending", rationale: "" };
            continue;
        }
        if (currentCandidateId === undefined) continue;
        const verdictMatch = line.match(/^- Verdict:\s*(.+)$/);
        if (verdictMatch) {
            updates[currentCandidateId] = {
                ...updates[currentCandidateId],
                verdict: stripInlineCode(verdictMatch[1]).toLowerCase(),
            };
            continue;
        }
        const rationaleMatch = line.match(/^- Rationale:\s*(.*)$/);
        if (rationaleMatch) {
            const rationale = rationaleMatch[1].trim();
            updates[currentCandidateId] = {
                ...updates[currentCandidateId],
                rationale: rationale === "_pending_" ? "" : rationale,
            };
        }
    }
    return updates;
}

const REVIEWED_VERDICTS = new Set(["accept", "revise", "reject", "defer"]);
const VALID_VERDICTS = new Set(["pending", ...REVIEWED_VERDICTS]);
const PROMOTABLE_VERDICTS = new Set(["accept", "revise"]);

export function syncWorkflowCandidateReportFromBrief(
    report: WorkflowCandidateReport,
    brief: string,
    syncedFrom: string,
): WorkflowCandidateReport {
    const updates = parseWorkflowCandidateBriefReview(brief);
    const knownIds = new Set(report.candidates.map((candidate) => candidate.group_id));
    const candidates = report.candidates.map((candidate) => {
        const review = updates[candidate.group_id];
        return review === undefined ? candidate : { ...candidate, review };
    });
    let reviewedCandidateCount = 0;
    let pendingCandidateCount = 0;
    let invalidVerdictCount = 0;
    let missingRationaleCount = 0;
    for (const candidate of candidates) {
        const verdict = candidate.review?.verdict ?? "pending";
        if (!VALID_VERDICTS.has(verdict)) invalidVerdictCount += 1;
        if (REVIEWED_VERDICTS.has(verdict)) {
            reviewedCandidateCount += 1;
            if ((candidate.review?.rationale ?? "").trim().length === 0) missingRationaleCount += 1;
        } else {
            pendingCandidateCount += 1;
        }
    }
    const unknownCandidateCount = Object.keys(updates).filter((id) => !knownIds.has(id)).length;
    const review = {
        synced_from: syncedFrom,
        reviewed_candidate_count: reviewedCandidateCount,
        pending_candidate_count: pendingCandidateCount,
        invalid_verdict_count: invalidVerdictCount,
        missing_rationale_count: missingRationaleCount,
        unknown_candidate_count: unknownCandidateCount,
    };
    const reviewFailures = [
        ...(invalidVerdictCount > 0 ? [`review has invalid verdicts: ${invalidVerdictCount}`] : []),
        ...(missingRationaleCount > 0 ? [`reviewed candidates missing rationale: ${missingRationaleCount}`] : []),
        ...(unknownCandidateCount > 0 ? [`brief references unknown candidates: ${unknownCandidateCount}`] : []),
    ];
    const failures = [...report.failures, ...reviewFailures];
    return {
        ...report,
        candidates,
        failures,
        review,
        decision: failures.length === 0 ? "workflow_candidates_ranked" : "needs_workflow_candidate_review",
    };
}

export function syncWorkflowCandidateTopicReportFromBrief(
    report: WorkflowCandidateTopicReport,
    brief: string,
    syncedFrom: string,
): WorkflowCandidateTopicReport {
    const syncedCandidates = syncWorkflowCandidateReportFromBrief(report.candidates, brief, syncedFrom);
    const nonCandidateFailures = report.failures.filter((failure) => !report.candidates.failures.includes(failure));
    const failures = [...nonCandidateFailures, ...syncedCandidates.failures];
    return withWorkflowCandidateTopicHarnessEvidence({
        ...report,
        candidates: syncedCandidates,
        failures,
        decision: failures.length === 0 ? "workflow_topic_evidence_found" : "needs_workflow_topic_evidence",
    });
}

const shortHash = (value: string): string => {
    let hash = 0;
    for (const char of value) {
        hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }
    return Math.abs(hash).toString(36).padStart(6, "0").slice(0, 6);
};

const slugPart = (value: string): string => {
    const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return slug.length > 0 ? slug.slice(0, 80) : "candidate";
};

const taskPathForCandidate = (taskDir: string, candidate: WorkflowCandidate): string =>
    join(taskDir, `workflow-candidate-${slugPart(candidate.label)}-${shortHash(candidate.group_id)}.md`);

const evidenceTurnsForCandidate = (candidate: WorkflowCandidate): readonly string[] => {
    const turns = candidate.examples
        .map((example) => typeof example.turn === "string" ? example.turn : "")
        .filter((turn) => turn.length > 0);
    return [...new Set(turns)].sort();
};

const evidenceMergeKeyForCandidate = (candidate: WorkflowCandidate): string => {
    const turns = evidenceTurnsForCandidate(candidate);
    return [
        candidate.proposed_action,
        turns.length > 0 ? turns.join("|") : candidate.group_id,
    ].join("::");
};

const taskPathForCandidateGroup = (taskDir: string, candidates: readonly WorkflowCandidate[]): string => {
    const label = candidates.map((candidate) => candidate.label).join("--");
    const hash = shortHash(candidates.map((candidate) => candidate.group_id).sort().join("|"));
    return join(taskDir, `workflow-candidate-merged-${slugPart(label)}-${hash}.md`);
};

const includesAny = (values: readonly unknown[], needles: readonly string[]): boolean => {
    const text = values.map((value) => String(value ?? "").toLowerCase()).join(" ");
    return needles.some((needle) => text.includes(needle));
};

export function recommendWorkflowCandidatePromotionArtifact(
    candidates: readonly WorkflowCandidate[],
    report: WorkflowCandidateReport,
): WorkflowCandidatePromotionRecommendation {
    const actions = candidates.map((candidate) => candidate.proposed_action);
    const targets = candidates.map((candidate) => candidate.target);
    const labels = candidates.map((candidate) => candidate.label);
    const support = candidates.reduce((sum, candidate) => sum + candidate.support_count, 0);
    const searchScoped = (report.query.search ?? "").trim().length > 0;
    const hasVerification = actions.includes("add_verification_gate");
    const hasContextGuardrail = actions.includes("add_context_guardrail");
    const hasArtifactOrCompleteness = includesAny([...targets, ...labels], [
        "wrong_artifact",
        "wrong_output",
        "prototype_completeness",
        "missing_context",
    ]);

    if (hasVerification) {
        return {
            primary: "harness_check",
            alternatives: ["guidance", "classifier_fixture"],
            confidence: support >= 2 ? "high" : "medium",
            rationale: "The candidate asks for a verification gate, so the next artifact should make the expected check executable before changing guidance.",
        };
    }

    if (hasContextGuardrail && hasArtifactOrCompleteness) {
        return {
            primary: "guidance",
            alternatives: ["harness_check", "classifier_fixture"],
            confidence: searchScoped || support >= 2 ? "medium" : "low",
            rationale: "The evidence is a correction about context, artifact shape, or prototype completeness; start with agent guidance, then convert repeated cases into harness checks or classifier fixtures.",
        };
    }

    if (searchScoped) {
        return {
            primary: "classifier_fixture",
            alternatives: ["review", "guidance"],
            confidence: "medium",
            rationale: "The candidate was found through a scoped search, so preserving it as a classifier fixture can stabilize future package evaluation.",
        };
    }

    return {
        primary: "review",
        alternatives: ["guidance", "harness_check"],
        confidence: "low",
        rationale: "The candidate is promotable but does not clearly indicate the artifact type; keep it as a reviewed task before choosing durable guidance or executable checks.",
    };
}

const renderPromotionRecommendationLines = (
    recommendation: WorkflowCandidatePromotionRecommendation,
): readonly string[] => [
    "## Promotion Recommendation",
    "",
    `- Primary: \`${recommendation.primary}\``,
    `- Alternatives: \`${recommendation.alternatives.join("`, `")}\``,
    `- Confidence: \`${recommendation.confidence}\``,
    `- Rationale: ${recommendation.rationale}`,
    "",
];

const workflowCandidateProposalSig = (task: WorkflowCandidatePromotionTask): string =>
    `guidance__workflow_candidate__${Bun.hash([
        task.label,
        task.candidate_id,
        ...(task.candidate_ids ?? []),
    ].join("|")).toString(16).slice(0, 16)}`;

const workflowCandidateProposalTitle = (
    task: WorkflowCandidatePromotionTask,
    report: WorkflowCandidateReport,
): string => {
    const search = report.query.search?.trim();
    if (search) return `Require applied classifier results for ${search}`;
    return `Workflow guardrail for ${task.label}`;
};

const workflowCandidateProposalKey = (title: string, sig: string): string =>
    `guidance__${safeKeyPart(title).slice(0, 60)}__${sig.slice(-12)}`;

const workflowCandidateSuggestedGuidance = (
    task: WorkflowCandidatePromotionTask,
    report: WorkflowCandidateReport,
): string => [
    `When a user correction matches \`${task.label}\`, do not stop at a surface artifact or plan.`,
    "Use the preceding agent action and the user correction as context, then produce the concrete result the user asked for.",
    report.query.search
        ? `For the scoped topic \`${report.query.search}\`, set up and run the relevant classifier or explain the blocking reason, then show the applied result evidence.`
        : "If the request involves a classifier, setup, or evaluation, run it or explain the blocking reason, then show concrete result evidence.",
    "Preserve the classifier candidate ids and evidence refs when turning this into a durable guidance or harness change.",
].join(" ");

const workflowCandidateProposalHypothesis = (
    task: WorkflowCandidatePromotionTask,
    report: WorkflowCandidateReport,
): string => {
    const candidates = report.candidates.filter((candidate) =>
        (task.candidate_ids ?? [task.candidate_id]).includes(candidate.group_id)
    );
    const labels = candidates.map((candidate) => candidate.label).join(", ");
    return [
        task.recommended_artifact.rationale,
        labels.length > 0 ? `Evidence-backed workflow candidates: ${labels}.` : "",
    ].filter(Boolean).join(" ");
};

export const buildWorkflowCandidateGuidanceProposalPlan = (
    report: WorkflowCandidateReport,
    existingSigs: ReadonlySet<string>,
    opts: {
        readonly fileTarget?: string;
        readonly section?: string;
        readonly dryRun?: boolean;
        readonly includeStatements?: boolean;
    } = {},
): WorkflowCandidateProposalPlan => {
    const promotion = report.promotion;
    if (promotion === undefined) {
        return {
            summary: {
                dry_run: opts.dryRun ?? false,
                emitted_proposal_count: 0,
                skipped_proposal_count: 0,
                statement_count: 0,
                ...(opts.includeStatements ? { statements: [] } : {}),
                proposals: [],
                failures: ["promotion required before proposal seeding"],
            },
            statements: [],
        };
    }

    const proposals: WorkflowCandidateProposalPromotion[] = [];
    const statements: string[] = [];
    const failures: string[] = [];
    let skipped = 0;
    for (const task of promotion.tasks) {
        if (task.recommended_artifact.primary !== "guidance") {
            skipped += 1;
            proposals.push({
                candidate_id: task.candidate_id,
                ...(task.candidate_ids === undefined ? {} : { candidate_ids: task.candidate_ids }),
                proposal_id: "",
                guidance_payload_id: "",
                dedupe_sig: "",
                title: task.label,
                file_target: opts.fileTarget ?? "AGENTS.md",
                section: opts.section ?? "Workflow Candidate Guardrails",
                recommended_artifact: task.recommended_artifact,
                status: "skipped",
                reason: `recommended artifact is ${task.recommended_artifact.primary}`,
            });
            continue;
        }

        const title = workflowCandidateProposalTitle(task, report);
        const sig = workflowCandidateProposalSig(task);
        const proposalKey = workflowCandidateProposalKey(title, sig);
        const proposalRef = recordRef("proposal", proposalKey);
        const payloadRef = recordRef("guidance_proposal", proposalKey);
        const fileTarget = opts.fileTarget ?? "AGENTS.md";
        const section = opts.section ?? "Workflow Candidate Guardrails";
        const candidateIds = task.candidate_ids ?? [task.candidate_id];
        const baseline = prettyPrint({
            source: "workflow_candidates",
            frequency: Math.max(1, candidateIds.length),
            candidate_ids: candidateIds,
            recommendation: task.recommended_artifact,
        });
        const existing = existingSigs.has(sig);

        if (existing) {
            statements.push(
                `UPDATE ${proposalRef} SET ${[
                    ["title", surrealString(title)],
                    ["hypothesis", surrealString(workflowCandidateProposalHypothesis(task, report))],
                    ["frequency", String(Math.max(1, candidateIds.length))],
                    ["confidence", surrealString(task.recommended_artifact.confidence)],
                    ["updated_at", "time::now()"],
                ].map(([name, value]) => `${name} = ${value}`).join(", ")};`,
            );
        } else {
            statements.push(
                `CREATE ${proposalRef} CONTENT ${surrealObject([
                    ["form", surrealString("guidance")],
                    ["title", surrealString(title)],
                    ["hypothesis", surrealString(workflowCandidateProposalHypothesis(task, report))],
                    ["dedupe_sig", surrealString(sig)],
                    ["frequency", String(Math.max(1, candidateIds.length))],
                    ["confidence", surrealString(task.recommended_artifact.confidence)],
                    ["status", surrealString("open")],
                    ["baseline", surrealOptionString(baseline)],
                    ["updated_at", "time::now()"],
                ])};`,
            );
        }

        statements.push(
            `UPSERT ${payloadRef} MERGE ${surrealObject([
                ["proposal", proposalRef],
                ["file_target", surrealString(fileTarget)],
                ["section", surrealOptionString(section)],
                ["suggested_text", surrealString(workflowCandidateSuggestedGuidance(task, report))],
            ])};`,
        );
        for (const candidateId of candidateIds) {
            const candidateKey = safeKeyPart(candidateId);
            const edgeKey = `${proposalKey}__${candidateKey}`;
            statements.push(
                `DELETE ${recordRef("cites_evidence", edgeKey)};`,
                `RELATE ${proposalRef}->cites_evidence:\`${edgeKey}\`->${recordRef("classifier_graph_node", candidateId)} SET count = 1, kind = "workflow_candidate", ts = time::now();`,
            );
        }

        proposals.push({
            candidate_id: task.candidate_id,
            ...(task.candidate_ids === undefined ? {} : { candidate_ids: task.candidate_ids }),
            proposal_id: `proposal:${proposalKey}`,
            guidance_payload_id: `guidance_proposal:${proposalKey}`,
            dedupe_sig: sig,
            title,
            file_target: fileTarget,
            section,
            recommended_artifact: task.recommended_artifact,
            status: "created_or_refreshed",
        });
    }

    return {
        summary: {
            dry_run: opts.dryRun ?? false,
            emitted_proposal_count: proposals.filter((proposal) => proposal.status === "created_or_refreshed").length,
            skipped_proposal_count: skipped,
            statement_count: statements.length,
            ...(opts.includeStatements ? { statements } : {}),
            proposals,
            failures,
        },
        statements,
    };
};

export function renderWorkflowCandidateTaskMarkdown(candidate: WorkflowCandidate, report: WorkflowCandidateReport): string {
    const review = candidate.review;
    const recommendation = recommendWorkflowCandidatePromotionArtifact([candidate], report);
    const lines = [
        `# ax workflow candidate task: ${candidate.label}`,
        "",
        "**Action:** draft candidate-backed improvement",
        `**Candidate:** \`${candidate.group_id}\``,
        `**Verdict:** \`${review?.verdict ?? "pending"}\``,
        `**Proposed graph action:** \`${candidate.proposed_action}\``,
        "",
        "## Why",
        "",
        review?.rationale ?? "",
        "",
        "## Candidate Signal",
        "",
        `- Source kind: \`${report.source_kind}\``,
        `- Query search: \`${report.query.search ?? "none"}\``,
        `- Classifier: \`${String(candidate.classifier_key ?? "unknown")}\``,
        `- Target: \`${String(candidate.target ?? "unknown")}\``,
        `- Score: \`${candidate.score}\``,
        `- Support: \`${candidate.support_count}\``,
        `- Evidence facts: \`${candidate.evidence_count}\``,
        `- Average confidence: \`${candidate.average_confidence}\``,
        "",
        ...renderPromotionRecommendationLines(recommendation),
        "## Apply",
        "",
        "1. Review the evidence below and decide the smallest durable improvement.",
        "2. If this becomes guidance, preserve the candidate id and evidence refs in the task or commit.",
        "3. If this becomes a harness/check, make the failing pattern executable before changing behavior.",
        "4. Do not promote model-derived conclusions without these evidence refs.",
        "",
        "## Evidence",
        "",
    ];
    for (const example of candidate.examples) {
        lines.push(
            `- Turn: \`${typeof example.turn === "string" ? example.turn : "unknown-turn"}\``,
            `  - Result: \`${String(example.result_id ?? "unknown-result")}\``,
            `  - Confidence: \`${typeof example.confidence === "number" ? example.confidence : "n/a"}\``,
            `  - Task-like: \`${example.task_like ? "yes" : "no"}\``,
            `  - Text: ${example.text_excerpt}`,
        );
    }
    lines.push(
        "",
        "## References",
        "",
        `- workflow-candidate-report-source: \`${report.source_kind}\``,
        `- candidate-id: \`${candidate.group_id}\``,
    );
    return `${lines.join("\n").trimEnd()}\n`;
}

export function renderMergedWorkflowCandidateTaskMarkdown(candidates: readonly WorkflowCandidate[], report: WorkflowCandidateReport): string {
    const primary = candidates[0];
    const recommendation = recommendWorkflowCandidatePromotionArtifact(candidates, report);
    const lines = [
        `# ax workflow candidate task: merged ${primary?.proposed_action ?? "workflow-candidate"}`,
        "",
        "**Action:** draft merged candidate-backed improvement",
        `**Proposed graph action:** \`${primary?.proposed_action ?? "unknown"}\``,
        `**Candidates:** \`${candidates.length}\``,
        "",
        "## Why",
        "",
    ];
    for (const candidate of candidates) {
        lines.push(
            `- \`${candidate.label}\` (${candidate.review?.verdict ?? "pending"}): ${candidate.review?.rationale ?? ""}`,
        );
    }
    lines.push(
        "",
        "## Candidate Signals",
        "",
    );
    for (const candidate of candidates) {
        lines.push(
            `- Candidate: \`${candidate.group_id}\``,
            `  - Label: \`${candidate.label}\``,
            `  - Classifier: \`${String(candidate.classifier_key ?? "unknown")}\``,
            `  - Target: \`${String(candidate.target ?? "unknown")}\``,
            `  - Verdict: \`${candidate.review?.verdict ?? "pending"}\``,
            `  - Score/support/confidence: \`${candidate.score}\` / \`${candidate.support_count}\` / \`${candidate.average_confidence}\``,
        );
    }
    lines.push(
        "",
        ...renderPromotionRecommendationLines(recommendation),
        "## Apply",
        "",
        "1. Treat these candidates as overlapping evidence for one improvement.",
        "2. Prefer one guidance or harness change that addresses the shared evidence.",
        "3. Preserve all candidate ids and evidence refs in the final task or commit.",
        "4. Do not promote model-derived conclusions without these evidence refs.",
        "",
        "## Evidence",
        "",
    );
    for (const candidate of candidates) {
        lines.push(`### ${candidate.label}`, "");
        for (const example of candidate.examples) {
            lines.push(
                `- Turn: \`${typeof example.turn === "string" ? example.turn : "unknown-turn"}\``,
                `  - Result: \`${String(example.result_id ?? "unknown-result")}\``,
                `  - Confidence: \`${typeof example.confidence === "number" ? example.confidence : "n/a"}\``,
                `  - Task-like: \`${example.task_like ? "yes" : "no"}\``,
                `  - Text: ${example.text_excerpt}`,
            );
        }
        lines.push("");
    }
    lines.push(
        "## References",
        "",
        `- workflow-candidate-report-source: \`${report.source_kind}\``,
    );
    for (const candidate of candidates) {
        lines.push(`- candidate-id: \`${candidate.group_id}\``);
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

const candidateHasPromotionEvidence = (candidate: WorkflowCandidate): boolean =>
    candidate.examples.some((example) =>
        typeof example.turn === "string" && example.turn.length > 0 &&
        typeof example.result_id === "string" && example.result_id.length > 0
    );

export function buildWorkflowCandidateTaskDrafts(
    report: WorkflowCandidateReport,
    taskDir: string,
    mode: WorkflowCandidatePromotionMode = "per-candidate",
): { readonly report: WorkflowCandidateReport; readonly drafts: readonly WorkflowCandidateTaskDraft[] } {
    const failures: string[] = [];
    if (report.review === undefined) failures.push("review sync required before promotion");
    if (report.failures.length > 0) failures.push("report has failures; refusing promotion");
    const drafts: WorkflowCandidateTaskDraft[] = [];
    let skippedCandidateCount = 0;
    let blockedCandidateCount = 0;
    const promotableCandidates: WorkflowCandidate[] = [];
    if (failures.length === 0) {
        for (const candidate of report.candidates) {
            const verdict = candidate.review?.verdict ?? "pending";
            if (!PROMOTABLE_VERDICTS.has(verdict)) {
                skippedCandidateCount += 1;
                continue;
            }
            const rationale = candidate.review?.rationale.trim() ?? "";
            if (rationale.length === 0 || !candidateHasPromotionEvidence(candidate)) {
                blockedCandidateCount += 1;
                failures.push(`candidate ${candidate.group_id} missing rationale or evidence refs`);
                continue;
            }
            promotableCandidates.push(candidate);
        }
        if (mode === "per-candidate") {
            for (const candidate of promotableCandidates) {
                const verdict = candidate.review?.verdict ?? "pending";
                const path = taskPathForCandidate(taskDir, candidate);
                const recommendedArtifact = recommendWorkflowCandidatePromotionArtifact([candidate], report);
                drafts.push({
                    path,
                    content: renderWorkflowCandidateTaskMarkdown(candidate, report),
                    task: {
                        candidate_id: candidate.group_id,
                        label: candidate.label,
                        verdict,
                        recommended_artifact: recommendedArtifact,
                        path,
                    },
                });
            }
        } else {
            const groups = new Map<string, WorkflowCandidate[]>();
            for (const candidate of promotableCandidates) {
                const key = evidenceMergeKeyForCandidate(candidate);
                groups.set(key, [...(groups.get(key) ?? []), candidate]);
            }
            for (const candidates of groups.values()) {
                const sortedCandidates = [...candidates].sort((a, b) => {
                    const verdictScore = (candidate: WorkflowCandidate) => candidate.review?.verdict === "accept" ? 0 : 1;
                    return verdictScore(a) - verdictScore(b) || b.score - a.score || a.label.localeCompare(b.label);
                });
                const primary = sortedCandidates[0];
                const path = taskPathForCandidateGroup(taskDir, sortedCandidates);
                const recommendedArtifact = recommendWorkflowCandidatePromotionArtifact(sortedCandidates, report);
                drafts.push({
                    path,
                    content: renderMergedWorkflowCandidateTaskMarkdown(sortedCandidates, report),
                    task: {
                        candidate_id: `merged:${shortHash(sortedCandidates.map((candidate) => candidate.group_id).sort().join("|"))}`,
                        candidate_ids: sortedCandidates.map((candidate) => candidate.group_id),
                        label: sortedCandidates.map((candidate) => candidate.label).join(" + "),
                        verdict: sortedCandidates.some((candidate) => candidate.review?.verdict === "accept") ? "accept" : primary.review?.verdict ?? "revise",
                        recommended_artifact: recommendedArtifact,
                        path,
                    },
                });
            }
        }
    }
    const promotion: WorkflowCandidatePromotionSummary = {
        mode,
        task_dir: taskDir,
        emitted_task_count: drafts.length,
        skipped_candidate_count: skippedCandidateCount,
        blocked_candidate_count: blockedCandidateCount,
        tasks: drafts.map((draft) => draft.task),
        failures,
    };
    const nextFailures = [...report.failures, ...failures];
    return {
        report: {
            ...report,
            promotion,
            failures: nextFailures,
            decision: nextFailures.length === 0 ? "workflow_candidates_ranked" : "needs_workflow_candidate_review",
        },
        drafts,
    };
}

const averageConfidence = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const total = values.reduce((sum, value) => sum + value, 0);
    return Number((total / values.length).toFixed(4));
};

export function workflowCandidateScore(
    supportCount: number,
    evidenceCount: number,
    averageConfidenceValue: number,
    action: string,
    taskLikeCount: number,
): number {
    const actionWeight = ({
        add_verification_gate: 1.15,
        add_context_guardrail: 1.1,
        record_guidance_or_environment_preference: 1.0,
        record_approval_checkpoint: 0.65,
    } as Record<string, number>)[action] ?? 0.8;
    const rawScore = (supportCount + Math.min(evidenceCount, 10) * 0.25) *
        Math.max(averageConfidenceValue, 0.1) *
        actionWeight;
    const taskRatio = supportCount > 0 ? taskLikeCount / supportCount : 0;
    const penalty = 1 - Math.min(taskRatio, 0.75) * 0.6;
    return Number((rawScore * penalty).toFixed(4));
}

export function buildWorkflowCandidateReport(input: CandidateBuildInput): WorkflowCandidateReport {
    const evidenceByGroup = new Map<string, WorkflowCandidateEvidenceRow[]>();
    for (const row of input.evidenceRows) {
        const subject = String(row.subject ?? "");
        if (!evidenceByGroup.has(subject)) evidenceByGroup.set(subject, []);
        evidenceByGroup.get(subject)!.push(row);
    }

    const candidates: WorkflowCandidate[] = [];
    let consideredEvidenceFactCount = 0;

    for (const groupRow of input.groupRows) {
        const groupId = String(groupRow.graph_id ?? "");
        const props = parseProperties(groupRow.properties_json);
        const action = String(props.proposed_action ?? "review_section_pattern");
        const classifierKey = typeof props.classifier_key === "string" ? props.classifier_key : undefined;
        if (input.action && action !== input.action) continue;
        if (input.classifier && classifierKey !== input.classifier) continue;

        const rawEvidence = evidenceByGroup.get(groupId) ?? [];
        const evidence = rawEvidence.filter((evidenceRow) => {
            const evidenceProps = parseProperties(evidenceRow.properties_json);
            const textExcerpt = String(evidenceProps.text_excerpt ?? "");
            const taskLike = isTaskLikeWorkflowText(textExcerpt);
            if (input.taskLike === "exclude" && taskLike) return false;
            if (input.taskLike === "only" && !taskLike) return false;
            return containsSearchText(textExcerpt, input.search);
        });
        consideredEvidenceFactCount += evidence.length;
        if (input.search && evidence.length === 0) continue;

        const examples: WorkflowCandidateExample[] = [];
        const confidenceValues: number[] = [];
        const turnRefs = new Set<string>();
        let wrapperLikeCount = 0;
        let taskLikeCount = 0;

        for (const evidenceRow of evidence) {
            const evidenceProps = parseProperties(evidenceRow.properties_json);
            const confidence = asNumber(evidenceProps.confidence);
            if (confidence !== undefined) confidenceValues.push(confidence);
            if (evidenceProps.wrapper_like === true) wrapperLikeCount += 1;
            const textExcerpt = String(evidenceProps.text_excerpt ?? "");
            const taskLike = isTaskLikeWorkflowText(textExcerpt);
            if (taskLike) taskLikeCount += 1;
            const turn = evidenceProps.turn;
            if (typeof turn === "string" && turn.length > 0) turnRefs.add(turn);
            if (examples.length < input.examplesPerGroup) {
                examples.push({
                    result_id: evidenceProps.result_id,
                    turn,
                    confidence: evidenceProps.confidence,
                    task_like: taskLike,
                    text_excerpt: compactText(textExcerpt),
                });
            }
        }

        const rawSupportCount = Math.trunc(asNumber(props.support_count) ?? rawEvidence.length);
        const supportCount = evidence.length;
        const avgConfidence = averageConfidence(confidenceValues);
        candidates.push({
            group_id: groupId,
            label: String(groupRow.label ?? ""),
            classifier_key: props.classifier_key,
            classifier_label: props.label,
            target: props.target,
            proposed_action: action,
            raw_support_count: rawSupportCount,
            support_count: supportCount,
            evidence_count: evidence.length,
            turn_ref_count: turnRefs.size,
            average_confidence: avgConfidence,
            wrapper_like_count: wrapperLikeCount,
            task_like_count: taskLikeCount,
            task_like_ratio: supportCount > 0 ? Number((taskLikeCount / supportCount).toFixed(4)) : 0,
            score: workflowCandidateScore(supportCount, evidence.length, avgConfidence, action, taskLikeCount),
            examples,
        });
    }

    candidates.sort((a, b) =>
        b.score - a.score ||
        b.support_count - a.support_count ||
        a.label.localeCompare(b.label)
    );
    const topCandidates = candidates.slice(0, Math.max(1, input.limit));
    const failures: string[] = [];
    if (candidates.length === 0) failures.push("no transcript-backed workflow candidates");
    if (candidates.some((candidate) => candidate.wrapper_like_count > 0)) {
        failures.push("candidate evidence includes wrapper-like turns");
    }
    if (candidates.some((candidate) => candidate.evidence_count === 0)) {
        failures.push("candidate missing evidence facts");
    }

    const query = {
        limit: input.limit,
        examples_per_group: input.examplesPerGroup,
        task_like: input.taskLike,
        ...(input.action ? { action: input.action } : {}),
        ...(input.classifier ? { classifier: input.classifier } : {}),
        ...(input.search ? { search: input.search } : {}),
    } satisfies WorkflowCandidateReport["query"];

    return {
        schema: "ax.workflow_candidate_report.v1",
        source_kind: input.sourceKind,
        query,
        candidates: topCandidates,
        all_candidate_labels: candidates.map((candidate) => candidate.label),
        totals: {
            candidate_group_count: candidates.length,
            returned_candidate_count: topCandidates.length,
            evidence_fact_count: input.evidenceRows.length,
            considered_evidence_fact_count: consideredEvidenceFactCount,
            candidate_with_evidence_count: candidates.filter((candidate) => candidate.evidence_count > 0).length,
            wrapper_like_count: candidates.reduce((sum, candidate) => sum + candidate.wrapper_like_count, 0),
            task_like_count: candidates.reduce((sum, candidate) => sum + candidate.task_like_count, 0),
            persisted_review_fact_count: 0,
        },
        failures,
        decision: failures.length === 0 ? "workflow_candidates_ranked" : "needs_workflow_candidate_review",
    };
}

export function attachWorkflowCandidatePersistedReviewFacts(
    report: WorkflowCandidateReport,
    facts: readonly WorkflowCandidateTopicHarnessGraphFactRow[],
): WorkflowCandidateReport {
    const factsByCandidate = new Map<string, WorkflowCandidatePersistedReviewFact[]>();
    for (const fact of facts) {
        const props = parseProperties(fact.properties_json);
        const candidateId = typeof fact.object === "string" && fact.object.length > 0
            ? fact.object
            : typeof props.candidate_id === "string" && props.candidate_id.length > 0
                ? props.candidate_id
                : undefined;
        if (candidateId === undefined) continue;
        const helperSourceFixtureIds = Array.isArray(props.helper_source_fixture_ids)
            ? props.helper_source_fixture_ids.filter((entry): entry is string => typeof entry === "string")
            : [];
        const persistedFact: WorkflowCandidatePersistedReviewFact = {
            ...(fact.graph_id === undefined ? {} : { graph_id: fact.graph_id }),
            ...(typeof props.topic === "string" ? { topic: props.topic } : {}),
            ...(fact.subject === undefined ? {} : { subject: fact.subject }),
            ...(fact.predicate === undefined ? {} : { predicate: fact.predicate }),
            ...(typeof fact.object === "string" ? { object: fact.object } : {}),
            candidate_id: candidateId,
            ...(typeof props.rationale === "string" ? { rationale: props.rationale } : {}),
            helper_source_fixture_ids: helperSourceFixtureIds,
            ...(typeof fact.updated_at === "string" ? { updated_at: fact.updated_at } : {}),
            ...(typeof fact.value_json === "string" ? { value_json: fact.value_json } : {}),
        };
        factsByCandidate.set(candidateId, [
            ...(factsByCandidate.get(candidateId) ?? []),
            persistedFact,
        ]);
    }

    const candidates = report.candidates.map((candidate) => {
        const persisted = factsByCandidate.get(candidate.group_id) ?? [];
        return persisted.length === 0
            ? candidate
            : { ...candidate, persisted_review_facts: persisted };
    });
    return {
        ...report,
        candidates,
        totals: {
            ...report.totals,
            persisted_review_fact_count: candidates.reduce(
                (sum, candidate) => sum + (candidate.persisted_review_facts?.length ?? 0),
                0,
            ),
        },
    };
}

export function buildWorkflowCandidateReviewCoverageReport(input: {
    readonly groupRows: readonly WorkflowCandidateGroupRow[];
    readonly evidenceRows: readonly WorkflowCandidateEvidenceRow[];
    readonly reviewFactRows: readonly WorkflowCandidateTopicHarnessGraphFactRow[];
    readonly sourceKind: string;
    readonly limit: number;
    readonly search?: string;
}): WorkflowCandidateReviewCoverageReport {
    const evidenceByGroup = new Map<string, WorkflowCandidateEvidenceRow[]>();
    for (const row of input.evidenceRows) {
        const subject = String(row.subject ?? "");
        if (!evidenceByGroup.has(subject)) evidenceByGroup.set(subject, []);
        evidenceByGroup.get(subject)!.push(row);
    }
    const reviewsByCandidate = new Map<string, WorkflowCandidatePersistedReviewFact[]>();
    const allHelperSources = new Set<string>();
    for (const fact of input.reviewFactRows) {
        const props = parseProperties(fact.properties_json);
        const candidateId = typeof fact.object === "string" && fact.object.length > 0
            ? fact.object
            : typeof props.candidate_id === "string" && props.candidate_id.length > 0
                ? props.candidate_id
                : undefined;
        if (candidateId === undefined) continue;
        const helperSourceFixtureIds = Array.isArray(props.helper_source_fixture_ids)
            ? props.helper_source_fixture_ids.filter((entry): entry is string => typeof entry === "string")
            : [];
        for (const fixtureId of helperSourceFixtureIds) allHelperSources.add(fixtureId);
        const persistedFact: WorkflowCandidatePersistedReviewFact = {
            ...(fact.graph_id === undefined ? {} : { graph_id: fact.graph_id }),
            ...(typeof props.topic === "string" ? { topic: props.topic } : {}),
            ...(fact.subject === undefined ? {} : { subject: fact.subject }),
            ...(fact.predicate === undefined ? {} : { predicate: fact.predicate }),
            ...(typeof fact.object === "string" ? { object: fact.object } : {}),
            candidate_id: candidateId,
            ...(typeof props.rationale === "string" ? { rationale: props.rationale } : {}),
            helper_source_fixture_ids: helperSourceFixtureIds,
            ...(typeof fact.updated_at === "string" ? { updated_at: fact.updated_at } : {}),
            ...(typeof fact.value_json === "string" ? { value_json: fact.value_json } : {}),
        };
        reviewsByCandidate.set(candidateId, [
            ...(reviewsByCandidate.get(candidateId) ?? []),
            persistedFact,
        ]);
    }

    const search = input.search?.toLowerCase();
    const rows: WorkflowCandidateReviewCoverageRow[] = [];
    for (const groupRow of input.groupRows) {
        const candidateId = String(groupRow.graph_id ?? "");
        if (candidateId.length === 0) continue;
        const props = parseProperties(groupRow.properties_json);
        const label = String(groupRow.label ?? "");
        const action = String(props.proposed_action ?? "review_section_pattern");
        const evidence = evidenceByGroup.get(candidateId) ?? [];
        const reviews = reviewsByCandidate.get(candidateId) ?? [];
        const topicSet = new Set<string>();
        const helperSourceSet = new Set<string>();
        const verdictCounts = { reject: 0, accept: 0, defer: 0, revise: 0, other: 0 };
        for (const review of reviews) {
            if (review.topic) topicSet.add(review.topic);
            for (const fixtureId of review.helper_source_fixture_ids) helperSourceSet.add(fixtureId);
            switch (review.predicate) {
                case "reject":
                    verdictCounts.reject += 1;
                    break;
                case "accept":
                    verdictCounts.accept += 1;
                    break;
                case "defer":
                    verdictCounts.defer += 1;
                    break;
                case "revise":
                    verdictCounts.revise += 1;
                    break;
                default:
                    verdictCounts.other += 1;
                    break;
            }
        }
        const haystack = [
            candidateId,
            label,
            action,
            ...topicSet,
            ...helperSourceSet,
        ].join("\n").toLowerCase();
        if (search && !haystack.includes(search)) continue;
        rows.push({
            candidate_id: candidateId,
            label,
            proposed_action: action,
            support_count: Math.trunc(asNumber(props.support_count) ?? evidence.length),
            evidence_count: evidence.length,
            review_fact_count: reviews.length,
            topics: [...topicSet].sort(),
            verdict_counts: verdictCounts,
            helper_source_fixture_ids: [...helperSourceSet].sort(),
        });
    }

    rows.sort((a, b) =>
        b.review_fact_count - a.review_fact_count ||
        b.evidence_count - a.evidence_count ||
        b.support_count - a.support_count ||
        a.label.localeCompare(b.label)
    );
    const returned = rows.slice(0, Math.max(1, input.limit));
    const reviewedCandidateCount = rows.filter((row) => row.review_fact_count > 0).length;
    return {
        schema: "ax.workflow_candidate_review_coverage.v1",
        source_kind: input.sourceKind,
        query: {
            limit: input.limit,
            ...(input.search === undefined ? {} : { search: input.search }),
        },
        candidates: returned,
        totals: {
            candidate_group_count: rows.length,
            returned_candidate_count: returned.length,
            reviewed_candidate_count: reviewedCandidateCount,
            unreviewed_candidate_count: rows.length - reviewedCandidateCount,
            review_fact_count: rows.reduce((sum, row) => sum + row.review_fact_count, 0),
            rejected_fact_count: rows.reduce((sum, row) => sum + row.verdict_counts.reject, 0),
            accepted_fact_count: rows.reduce((sum, row) => sum + row.verdict_counts.accept, 0),
            deferred_fact_count: rows.reduce((sum, row) => sum + row.verdict_counts.defer, 0),
            revised_fact_count: rows.reduce((sum, row) => sum + row.verdict_counts.revise, 0),
            helper_source_fixture_count: allHelperSources.size,
        },
        decision: reviewedCandidateCount > 0
            ? "workflow_candidate_review_coverage_ready"
            : "needs_workflow_candidate_reviews",
    };
}

export function renderWorkflowCandidateReviewCoverageText(report: WorkflowCandidateReviewCoverageReport): string {
    const lines = [
        "workflow candidate review coverage",
        `decision: ${report.decision}`,
        `source: ${report.source_kind}`,
        ...(report.query.search ? [`search: ${report.query.search}`] : []),
        `candidate groups: ${report.totals.candidate_group_count}`,
        `reviewed/unreviewed: ${report.totals.reviewed_candidate_count}/${report.totals.unreviewed_candidate_count}`,
        `review facts: ${report.totals.review_fact_count}`,
        `review status: ${report.totals.rejected_fact_count} rejected, ${report.totals.accepted_fact_count} accepted, ${report.totals.deferred_fact_count} deferred, ${report.totals.revised_fact_count} revised`,
        `helper source fixtures: ${report.totals.helper_source_fixture_count}`,
        ...(report.coverage_review ? [
            `coverage review schema: ${report.coverage_review.schema}`,
            `coverage review source: ${report.coverage_review.source_path}`,
            ...(report.coverage_review.review_facts_path === undefined ? [] : [
                `coverage review facts path: ${report.coverage_review.review_facts_path}`,
            ]),
            ...(report.coverage_review.review_write_plan_path === undefined ? [] : [
                `coverage review write plan path: ${report.coverage_review.review_write_plan_path}`,
            ]),
            ...(report.coverage_review.review_brief_path === undefined ? [] : [
                `coverage review brief path: ${report.coverage_review.review_brief_path}`,
            ]),
            ...(report.coverage_review.synced_review_brief_path === undefined ? [] : [
                `coverage review synced brief path: ${report.coverage_review.synced_review_brief_path}`,
            ]),
            `coverage review handoff status: ${report.coverage_review.review_handoff_status}`,
            `coverage review handoff missing paths: ${report.coverage_review.review_handoff_missing_paths.length === 0 ? "none" : report.coverage_review.review_handoff_missing_paths.join(", ")}`,
            `coverage review handoff apply guard: ${report.coverage_review.handoff_apply_guard}`,
            `coverage review handoff can apply: ${report.coverage_review.handoff_can_apply ? "yes" : "no"}`,
            `coverage review fixtures: ${report.coverage_review.reviewed_fixture_count} reviewed, ${report.coverage_review.pending_fixture_count} pending`,
            `coverage review sync: synced=${report.coverage_review.synced_fixture_count} unknown=${report.coverage_review.unknown_fixture_count}`,
            `coverage review provenance stamp: reviewer=${report.coverage_review.stamped_reviewer_count} reviewed_at=${report.coverage_review.stamped_reviewed_at_count}`,
            `coverage review impact: pack_candidates=${report.coverage_review.pack_candidate_count} new=${report.coverage_review.new_candidate_count} existing=${report.coverage_review.existing_candidate_count} unknown=${report.coverage_review.unknown_candidate_count}`,
            `coverage review projected coverage: reviewed=${report.coverage_review.projected_reviewed_candidate_count} unreviewed=${report.coverage_review.projected_unreviewed_candidate_count}`,
            `coverage review issues: invalid=${report.coverage_review.invalid_fixture_count} missing_rationale=${report.coverage_review.missing_rationale_count} smoke=${report.coverage_review.smoke_marker_count}`,
            `coverage review provenance: missing_reviewer=${report.coverage_review.missing_reviewer_count} missing_reviewed_at=${report.coverage_review.missing_reviewed_at_count} invalid_reviewed_at=${report.coverage_review.invalid_reviewed_at_count}`,
            `coverage review provenance status: ${report.coverage_review.provenance_status}`,
            `coverage review provenance next action: ${report.coverage_review.provenance_next_action}`,
            `coverage review apply guard: ${report.coverage_review.apply_guard}`,
            `coverage review can apply: ${report.coverage_review.can_apply ? "yes" : "no"}`,
            `coverage review strict apply guard: ${report.coverage_review.strict_apply_guard}`,
            `coverage review strict can apply: ${report.coverage_review.strict_can_apply ? "yes" : "no"}`,
            `coverage review production apply guard: ${report.coverage_review.production_apply_guard}`,
            `coverage review production can apply: ${report.coverage_review.production_can_apply ? "yes" : "no"}`,
            `coverage review production next action: ${report.coverage_review.production_next_action}`,
            ...(report.coverage_review.production_apply_command === undefined ? [] : [
                `coverage review production apply command: ${report.coverage_review.production_apply_command}`,
            ]),
            ...(report.coverage_review.review_provenance_stamp_command === undefined ? [] : [
                `coverage review provenance stamp command: ${report.coverage_review.review_provenance_stamp_command}`,
            ]),
            `coverage review apply result: ${report.coverage_review.apply_result} statements=${report.coverage_review.applied_statement_count}`,
            `coverage review blockers: ${report.coverage_review.apply_blockers.length === 0 ? "none" : report.coverage_review.apply_blockers.join(", ")}`,
            `coverage review blocker details: ${report.coverage_review.apply_blocker_details.length === 0 ? "none" : report.coverage_review.apply_blocker_details.map((detail) => `${detail.blocker}=${detail.count}`).join(", ")}`,
            `coverage review blocker remediations: ${report.coverage_review.apply_blocker_details.length === 0 ? "none" : report.coverage_review.apply_blocker_details.map((detail) => `${detail.blocker}: ${detail.remediation}`).join(" | ")}`,
            `coverage review strict blockers: ${report.coverage_review.strict_apply_blockers.length === 0 ? "none" : report.coverage_review.strict_apply_blockers.join(", ")}`,
            `coverage review strict blocker details: ${report.coverage_review.strict_apply_blocker_details.length === 0 ? "none" : report.coverage_review.strict_apply_blocker_details.map((detail) => `${detail.blocker}=${detail.count}`).join(", ")}`,
            `coverage review strict blocker remediations: ${report.coverage_review.strict_apply_blocker_details.length === 0 ? "none" : report.coverage_review.strict_apply_blocker_details.map((detail) => `${detail.blocker}: ${detail.remediation}`).join(" | ")}`,
            `coverage review production blockers: ${report.coverage_review.production_apply_blockers.length === 0 ? "none" : report.coverage_review.production_apply_blockers.join(", ")}`,
            `coverage review production blocker details: ${report.coverage_review.production_apply_blocker_details.length === 0 ? "none" : report.coverage_review.production_apply_blocker_details.map((detail) => `${detail.blocker}=${detail.count}`).join(", ")}`,
            `coverage review production blocker remediations: ${report.coverage_review.production_apply_blocker_details.length === 0 ? "none" : report.coverage_review.production_apply_blocker_details.map((detail) => `${detail.blocker}: ${detail.remediation}`).join(" | ")}`,
            `coverage review issue rows: ${report.coverage_review.review_issue_rows.length}`,
            `coverage review issue fixtures: ${report.coverage_review.review_issue_fixture_count}`,
            `coverage review issue candidates: ${report.coverage_review.review_issue_candidate_count}`,
            `coverage review issue status: ${report.coverage_review.review_issue_status}`,
            `coverage review issue next action: ${report.coverage_review.review_issue_next_action}`,
            `coverage review pipeline stage: ${report.coverage_review.review_pipeline_stage}`,
            `coverage review pipeline next action: ${report.coverage_review.review_pipeline_next_action}`,
            ...(report.coverage_review.review_pipeline_command_kind === undefined ? [] : [
                `coverage review pipeline command kind: ${report.coverage_review.review_pipeline_command_kind}`,
            ]),
            ...(report.coverage_review.review_pipeline_command === undefined ? [] : [
                `coverage review pipeline command: ${report.coverage_review.review_pipeline_command}`,
            ]),
            ...(report.coverage_review.review_issue_repair_command === undefined ? [] : [
                `coverage review issue repair command: ${report.coverage_review.review_issue_repair_command}`,
            ]),
            `coverage review issue counts: ${report.coverage_review.review_issue_counts.length === 0 ? "none" : report.coverage_review.review_issue_counts.map((item) => `${item.issue}=${item.count}`).join(", ")}`,
            `coverage review issue scope counts: ${report.coverage_review.review_issue_scope_counts.length === 0 ? "none" : report.coverage_review.review_issue_scope_counts.map((item) => `${item.blocking_scope}=${item.count}`).join(", ")}`,
            `coverage review issue scope fixtures: ${report.coverage_review.review_issue_scope_fixture_counts.length === 0 ? "none" : report.coverage_review.review_issue_scope_fixture_counts.map((item) => `${item.blocking_scope}=${item.count}`).join(", ")}`,
            `coverage review issue scope candidates: ${report.coverage_review.review_issue_scope_candidate_counts.length === 0 ? "none" : report.coverage_review.review_issue_scope_candidate_counts.map((item) => `${item.blocking_scope}=${item.count}`).join(", ")}`,
            `coverage review issue scope summaries: ${report.coverage_review.review_issue_scope_summaries.length === 0 ? "none" : report.coverage_review.review_issue_scope_summaries.map((item) => `${item.blocking_scope} issues=${item.issue_count} fixtures=${item.fixture_count} candidates=${item.candidate_count}`).join("; ")}`,
            ...report.coverage_review.review_issue_rows.map((row) =>
                `coverage review issue: ${row.issue} fixture=${row.fixture_id} candidate=${row.candidate_id} status=${row.review_status} scope=${row.blocking_scope}`
            ),
            `coverage review provenance issue rows: ${report.coverage_review.provenance_issue_rows.length}`,
            ...report.coverage_review.provenance_issue_rows.map((row) =>
                `coverage review provenance issue: ${row.issue} fixture=${row.fixture_id} candidate=${row.candidate_id} reviewed_at=${row.reviewed_at || "none"}`
            ),
            `coverage review post-apply recheck: ${report.coverage_review.post_apply_recheck_command}`,
            ...(report.coverage_review.post_apply_recheck === undefined ? [] : [
                `coverage review post-apply status: ${report.coverage_review.post_apply_recheck.status}`,
                `coverage review post-apply reviewed delta: ${report.coverage_review.post_apply_recheck.reviewed_candidate_delta} projected_delta=${report.coverage_review.post_apply_recheck.projected_reviewed_delta}`,
                `coverage review post-apply unreviewed delta: ${report.coverage_review.post_apply_recheck.unreviewed_candidate_delta} projected_delta=${report.coverage_review.post_apply_recheck.projected_unreviewed_delta}`,
            ]),
            `coverage review audit ids: fixtures=${report.coverage_review.reviewed_fixture_ids.length} facts=${report.coverage_review.projected_fact_ids.length}`,
            `coverage review audit rows: ${report.coverage_review.apply_audit_rows.length}`,
            ...report.coverage_review.apply_audit_rows.map((row) =>
                `coverage review audit row: ${row.verdict} fixture=${row.fixture_id} candidate=${row.candidate_id} fact=${row.projected_fact_id ?? "none"} reviewer=${row.reviewer || "none"} reviewed_at=${row.reviewed_at || "none"}`
            ),
            `coverage review next action: ${report.coverage_review.next_action}`,
            `coverage review applied: ${report.coverage_review.applied ? "yes" : "no"}`,
        ] : []),
        ...(report.fixture_pack ? [
            `coverage fixture pack: ${report.fixture_pack.emitted_fixture_count} fixtures`,
            `coverage fixture candidates: ${report.fixture_pack.candidate_count} emitted, ${report.fixture_pack.skipped_candidate_count} skipped`,
            `coverage fixture path: ${report.fixture_pack.path}`,
        ] : []),
    ];
    for (const row of report.candidates) {
        lines.push(
            `- ${row.label} reviews=${row.review_fact_count} evidence=${row.evidence_count} support=${row.support_count}`,
            `  id: ${row.candidate_id}`,
            `  action: ${row.proposed_action}`,
            `  verdicts: reject=${row.verdict_counts.reject} accept=${row.verdict_counts.accept} defer=${row.verdict_counts.defer} revise=${row.verdict_counts.revise} other=${row.verdict_counts.other}`,
            `  topics: ${row.topics.length > 0 ? row.topics.join(", ") : "none"}`,
            `  helper fixtures: ${row.helper_source_fixture_ids.length > 0 ? row.helper_source_fixture_ids.join(", ") : "none"}`,
        );
    }
    return lines.join("\n");
}

export function renderWorkflowCandidateReportText(report: WorkflowCandidateReport): string {
    const proposalPreviewLines = (summary: WorkflowCandidateProposalPromotionSummary): readonly string[] => {
        const lines = ["proposal preview:"];
        for (const proposal of summary.proposals) {
            if (proposal.status === "skipped") {
                lines.push(`  - skipped ${proposal.title}: ${proposal.reason ?? "no reason"}`);
                continue;
            }
            const candidateCount = proposal.candidate_ids?.length ?? 1;
            lines.push(
                `  - ${summary.dry_run ? "would write" : "wrote"} ${proposal.dedupe_sig}`,
                `    title: ${proposal.title}`,
                `    proposal: ${proposal.proposal_id}`,
                `    target: ${proposal.file_target}#${proposal.section}`,
                `    artifact: ${proposal.recommended_artifact.primary} confidence=${proposal.recommended_artifact.confidence} alternatives=${proposal.recommended_artifact.alternatives.join(",")}`,
                `    evidence candidates: ${candidateCount}`,
            );
        }
        return lines;
    };
    const lines = [
        "workflow candidate report",
        `decision: ${report.decision}`,
        `source: ${report.source_kind}`,
        `candidate groups: ${report.totals.candidate_group_count}`,
        `evidence facts: ${report.totals.evidence_fact_count}`,
        `considered evidence: ${report.totals.considered_evidence_fact_count}`,
        ...(report.query.search ? [`search: ${report.query.search}`] : []),
        `task-like mode/count: ${report.query.task_like}/${report.totals.task_like_count}`,
        `wrapper-like evidence: ${report.totals.wrapper_like_count}`,
        `persisted review facts: ${report.totals.persisted_review_fact_count}`,
        ...(report.review ? [
            `reviewed/pending: ${report.review.reviewed_candidate_count}/${report.review.pending_candidate_count}`,
            `review issues: invalid=${report.review.invalid_verdict_count} missing_rationale=${report.review.missing_rationale_count} unknown=${report.review.unknown_candidate_count}`,
        ] : []),
        ...(report.promotion ? [
            `promotion tasks: ${report.promotion.emitted_task_count} emitted, ${report.promotion.skipped_candidate_count} skipped, ${report.promotion.blocked_candidate_count} blocked`,
            `promotion dir: ${report.promotion.task_dir}`,
            ...(report.promotion.proposals ? [
                `promotion proposals: ${report.promotion.proposals.emitted_proposal_count} emitted, ${report.promotion.proposals.skipped_proposal_count} skipped`,
                `promotion proposal writes: ${report.promotion.proposals.dry_run ? "dry-run" : "executed"} (${report.promotion.proposals.statement_count} statements)`,
                ...proposalPreviewLines(report.promotion.proposals),
            ] : []),
        ] : []),
    ];
    for (const candidate of report.candidates) {
        lines.push(`- ${candidate.score} ${candidate.label} -> ${candidate.proposed_action} support=${candidate.support_count} evidence=${candidate.evidence_count} avg_conf=${candidate.average_confidence}`);
        if (candidate.review) {
            lines.push(`  review: ${candidate.review.verdict}${candidate.review.rationale ? ` - ${candidate.review.rationale}` : ""}`);
        }
        for (const fact of candidate.persisted_review_facts ?? []) {
            lines.push(
                `  persisted review: ${fact.predicate ?? "unknown"}${fact.topic ? ` topic=${fact.topic}` : ""}${fact.rationale ? ` - ${fact.rationale}` : ""}`,
            );
            for (const source of fact.helper_source_fixture_ids) {
                lines.push(`    helper source fixture: ${source}`);
            }
        }
        for (const example of candidate.examples) {
            const turn = typeof example.turn === "string" ? example.turn : "unknown-turn";
            const confidence = typeof example.confidence === "number" ? example.confidence.toFixed(2) : "n/a";
            lines.push(`  example ${turn} conf=${confidence}${example.task_like ? " task-like" : ""}: ${example.text_excerpt}`);
        }
    }
    for (const failure of report.failures) {
        lines.push(`failure: ${failure}`);
    }
    return lines.join("\n");
}

export function renderWorkflowCandidateProposalListText(report: WorkflowCandidateProposalListReport): string {
    const lines = [
        "workflow candidate proposals",
        `prefix: ${report.prefix}`,
        `status: ${report.query.status}`,
        ...(report.query.search ? [`search: ${report.query.search}`] : []),
        `proposals: ${report.totals.proposal_count} total, ${report.totals.accepted_count} accepted, ${report.totals.open_count} open, ${report.totals.rejected_count} rejected`,
        `scaffolded experiments: ${report.totals.scaffolded_experiment_count}`,
        ...(report.query.expand_evidence ? [
            `evidence candidates: ${report.totals.evidence_candidate_count}, examples: ${report.totals.evidence_example_count}`,
        ] : []),
    ];
    for (const proposal of report.proposals) {
        lines.push(
            `- ${proposal.frequency} ${proposal.confidence} ${proposal.status} ${proposal.dedupe_sig}`,
            `  title: ${proposal.title}`,
            `  target: ${proposal.target ?? "unknown"}${proposal.section ? `#${proposal.section}` : ""}`,
            `  experiment: ${proposal.experiment_status ?? "none"}${proposal.experiment_id ? ` (${proposal.experiment_id})` : ""}`,
        );
        if (proposal.artifact_path) lines.push(`  artifact: ${proposal.artifact_path}`);
        if (proposal.task_path) lines.push(`  task: ${proposal.task_path}`);
        if ((proposal.evidence?.length ?? 0) > 0) {
            lines.push("  evidence:");
            for (const candidate of proposal.evidence ?? []) {
                lines.push(
                    `    - ${candidate.candidate_label}`,
                    `      id: ${candidate.candidate_id}`,
                    `      action: ${String(candidate.proposed_action ?? "unknown")} target: ${String(candidate.target ?? "unknown")}`,
                );
                for (const example of candidate.examples) {
                    const turn = typeof example.turn === "string" ? example.turn : "unknown-turn";
                    const confidence = typeof example.confidence === "number" ? example.confidence.toFixed(2) : "n/a";
                    lines.push(`      example ${turn} conf=${confidence}: ${example.text_excerpt}`);
                }
            }
        }
    }
    if (report.proposals.length === 0) lines.push("(no workflow-candidate proposals match)");
    return lines.join("\n");
}

export function attachWorkflowCandidateProposalEvidence(input: {
    readonly rows: readonly WorkflowCandidateProposalListRow[];
    readonly edges: readonly WorkflowCandidateProposalEvidenceEdgeRow[];
    readonly candidateRows: readonly WorkflowCandidateGroupRow[];
    readonly factRows: readonly WorkflowCandidateEvidenceRow[];
    readonly examplesPerCandidate: number;
}): readonly WorkflowCandidateProposalListRow[] {
    const candidateById = new Map(input.candidateRows.map((row) => [String(row.graph_id ?? ""), row]));
    const factsByCandidate = new Map<string, WorkflowCandidateEvidenceRow[]>();
    for (const row of input.factRows) {
        const subject = String(row.subject ?? "");
        factsByCandidate.set(subject, [...(factsByCandidate.get(subject) ?? []), row]);
    }
    const edgesByProposal = new Map<string, string[]>();
    for (const edge of input.edges) {
        const proposalId = String(edge.proposal_id ?? "");
        const candidateId = recordKeyPart(edge.candidate_ref, "classifier_graph_node");
        if (proposalId.length === 0 || candidateId === null) continue;
        edgesByProposal.set(proposalId, [...(edgesByProposal.get(proposalId) ?? []), candidateId]);
    }

    return input.rows.map((row) => {
        const proposalId = row.proposal_id ?? "";
        const candidateIds = [...new Set(edgesByProposal.get(proposalId) ?? [])].sort();
        if (candidateIds.length === 0) return row;
        const evidence = candidateIds.map((candidateId): WorkflowCandidateProposalEvidence => {
            const candidateRow = candidateById.get(candidateId);
            const candidateProps = parseProperties(candidateRow?.properties_json);
            const examples = (factsByCandidate.get(candidateId) ?? [])
                .slice(0, Math.max(0, input.examplesPerCandidate))
                .map((fact): WorkflowCandidateProposalEvidenceExample => {
                    const props = parseProperties(fact.properties_json);
                    return {
                        result_id: props.result_id,
                        turn: props.turn,
                        confidence: props.confidence,
                        text_excerpt: compactText(String(props.text_excerpt ?? "")),
                    };
                });
            return {
                candidate_id: candidateId,
                candidate_label: String(candidateRow?.label ?? candidateId),
                classifier_key: candidateProps.classifier_key,
                target: candidateProps.target,
                proposed_action: candidateProps.proposed_action,
                examples,
            };
        });
        return { ...row, evidence };
    });
}

export function buildWorkflowCandidateProposalListReport(input: {
    readonly rows: readonly WorkflowCandidateProposalListRow[];
    readonly limit: number;
    readonly status: WorkflowCandidateProposalStatusFilter;
    readonly expandEvidence?: boolean;
    readonly search?: string;
}): WorkflowCandidateProposalListReport {
    const evidenceCandidateCount = input.rows.reduce((sum, row) => sum + (row.evidence?.length ?? 0), 0);
    const evidenceExampleCount = input.rows.reduce(
        (sum, row) => sum + (row.evidence ?? []).reduce((innerSum, evidence) => innerSum + evidence.examples.length, 0),
        0,
    );
    return {
        schema: "ax.workflow_candidate_proposal_list.v1",
        prefix: WORKFLOW_CANDIDATE_PROPOSAL_PREFIX,
        query: {
            limit: input.limit,
            status: input.status,
            expand_evidence: input.expandEvidence ?? false,
            ...(input.search === undefined ? {} : { search: input.search }),
        },
        proposals: input.rows,
        totals: {
            proposal_count: input.rows.length,
            accepted_count: input.rows.filter((row) => row.status === "accepted").length,
            open_count: input.rows.filter((row) => row.status === "open").length,
            rejected_count: input.rows.filter((row) => row.status === "rejected").length,
            scaffolded_experiment_count: input.rows.filter((row) => row.experiment_status === "scaffolded").length,
            evidence_candidate_count: evidenceCandidateCount,
            evidence_example_count: evidenceExampleCount,
        },
    };
}

export function buildWorkflowCandidateTopicReport(input: {
    readonly sourceKind: string;
    readonly topic: string;
    readonly proposals: WorkflowCandidateProposalListReport;
    readonly candidates: WorkflowCandidateReport;
}): WorkflowCandidateTopicReport {
    const sourceTurns = new Set<string>();
    for (const proposal of input.proposals.proposals) {
        for (const evidence of proposal.evidence ?? []) {
            for (const example of evidence.examples) {
                if (typeof example.turn === "string" && example.turn.length > 0) sourceTurns.add(example.turn);
            }
        }
    }
    for (const candidate of input.candidates.candidates) {
        for (const example of candidate.examples) {
            if (typeof example.turn === "string" && example.turn.length > 0) sourceTurns.add(example.turn);
        }
    }
    const experimentCount = input.proposals.proposals
        .filter((proposal) => (proposal.experiment_id ?? "").length > 0)
        .length;
    const failures = [
        ...(input.proposals.totals.proposal_count === 0 ? ["no workflow-candidate proposals matched topic"] : []),
        ...(input.candidates.totals.returned_candidate_count === 0 ? ["no classifier candidates matched topic"] : []),
        ...input.candidates.failures,
    ];
    const report: WorkflowCandidateTopicReport = {
        schema: "ax.workflow_candidate_topic_report.v1",
        source_kind: input.sourceKind,
        topic: input.topic,
        proposals: input.proposals,
        candidates: input.candidates,
        totals: {
            proposal_count: input.proposals.totals.proposal_count,
            experiment_count: experimentCount,
            proposal_evidence_candidate_count: input.proposals.totals.evidence_candidate_count,
            ranked_candidate_count: input.candidates.totals.returned_candidate_count,
            candidate_evidence_fact_count: input.candidates.totals.considered_evidence_fact_count,
            source_turn_count: sourceTurns.size,
        },
        decision: failures.length === 0 ? "workflow_topic_evidence_found" : "needs_workflow_topic_evidence",
        failures,
    };
    const harnessChecks = buildWorkflowCandidateTopicHarnessChecks(report);
    return withWorkflowCandidateTopicHarnessEvidence(
        harnessChecks.checks.length > 0
            ? { ...report, harness_checks: harnessChecks }
            : report,
    );
}

export function renderWorkflowCandidateTopicReportText(report: WorkflowCandidateTopicReport): string {
    const harnessEvidence = buildWorkflowCandidateTopicHarnessEvidenceSummary(report);
    const lines = [
        "workflow topic evidence",
        `decision: ${report.decision}`,
        `topic: ${report.topic}`,
        `source: ${report.source_kind}`,
        `proposals: ${report.totals.proposal_count}`,
        `experiments: ${report.totals.experiment_count}`,
        `proposal evidence candidates: ${report.totals.proposal_evidence_candidate_count}`,
        `ranked candidates: ${report.totals.ranked_candidate_count}`,
        `candidate evidence facts: ${report.totals.candidate_evidence_fact_count}`,
        `source turns: ${report.totals.source_turn_count}`,
        ...(report.adjacent_tasks ? [
            `adjacent tasks: ${report.adjacent_tasks.emitted_task_count}`,
            `adjacent task dir: ${report.adjacent_tasks.task_dir}`,
        ] : []),
        ...(report.classifier_fixtures ? [
            `classifier fixture pack: ${report.classifier_fixtures.emitted_fixture_count} fixtures`,
            `classifier fixture candidates: ${report.classifier_fixtures.candidate_count} emitted, ${report.classifier_fixtures.skipped_candidate_count} skipped`,
            `classifier fixture path: ${report.classifier_fixtures.path}`,
        ] : []),
        ...(report.harness_proposals ? [
            `harness proposals: ${report.harness_proposals.emitted_proposal_count} emitted, ${report.harness_proposals.skipped_proposal_count} skipped`,
            `harness proposal writes: ${report.harness_proposals.dry_run ? "dry-run" : "executed"} (${report.harness_proposals.statement_count} statements)`,
        ] : []),
        ...(report.harness_checks ? [
            `harness checks: ${report.harness_checks.passed_count} passed, ${report.harness_checks.failed_count} failed`,
        ] : []),
        ...(report.persisted_harness_facts ? [
            `persisted harness facts: ${report.persisted_harness_facts.totals.fact_count}`,
            `persisted harness edges: ${report.persisted_harness_facts.totals.edge_count}`,
            `persisted harness status: ${report.persisted_harness_facts.totals.passed_count} passed, ${report.persisted_harness_facts.totals.failed_count} failed`,
        ] : []),
        ...(report.persisted_review_facts ? [
            `persisted review facts: ${report.persisted_review_facts.totals.fact_count}`,
            `persisted review status: ${report.persisted_review_facts.totals.rejected_count} rejected, ${report.persisted_review_facts.totals.accepted_count} accepted, ${report.persisted_review_facts.totals.deferred_count} deferred, ${report.persisted_review_facts.totals.revised_count} revised`,
        ] : []),
        ...(report.helper_explanations ? [
            `helper explanations: ${report.helper_explanations.totals.matched_example_count}`,
            `helper matched candidates: ${report.helper_explanations.totals.matched_candidate_count}`,
        ] : []),
        `harness gate: ${harnessEvidence.gate_satisfied ? "satisfied" : "unsatisfied"} (${harnessEvidence.gate_evidence_source})`,
        `harness gate computed: ${harnessEvidence.computed_passed_count} passed, ${harnessEvidence.computed_failed_count} failed (${harnessEvidence.computed_check_count} checks)`,
        `harness gate persisted: ${harnessEvidence.persisted_passed_count} passed, ${harnessEvidence.persisted_failed_count} failed (${harnessEvidence.persisted_fact_count} facts)`,
        "",
        "proposals:",
    ];
    if (report.proposals.proposals.length === 0) {
        lines.push("  (none)");
    }
    for (const proposal of report.proposals.proposals) {
        lines.push(
            `  - ${proposal.status} ${proposal.dedupe_sig}`,
            `    title: ${proposal.title}`,
            `    target: ${proposal.target ?? "unknown"}${proposal.section ? `#${proposal.section}` : ""}`,
            `    experiment: ${proposal.experiment_status ?? "none"}${proposal.experiment_id ? ` (${proposal.experiment_id})` : ""}`,
        );
        for (const evidence of proposal.evidence ?? []) {
            lines.push(`    evidence: ${evidence.candidate_label} (${evidence.examples.length} examples)`);
        }
    }
    lines.push("", "ranked candidates:");
    if (report.candidates.candidates.length === 0) {
        lines.push("  (none)");
    }
    for (const candidate of report.candidates.candidates) {
        lines.push(
            `  - ${candidate.score} ${candidate.label}`,
            `    action: ${candidate.proposed_action} target=${String(candidate.target ?? "unknown")} support=${candidate.support_count} evidence=${candidate.evidence_count}`,
        );
        for (const example of candidate.examples) {
            const turn = typeof example.turn === "string" ? example.turn : "unknown-turn";
            const confidence = typeof example.confidence === "number" ? example.confidence.toFixed(2) : "n/a";
            lines.push(`    example ${turn} conf=${confidence}: ${example.text_excerpt}`);
        }
    }
    if (report.harness_checks && report.harness_checks.checks.length > 0) {
        lines.push("", "harness checks:");
        for (const check of report.harness_checks.checks) {
            lines.push(
                `  - ${check.status} ${check.id}`,
                `    candidate: ${check.label}`,
            );
            for (const failure of check.failures) lines.push(`    failure: ${failure}`);
        }
    }
    if (report.persisted_harness_facts && report.persisted_harness_facts.facts.length > 0) {
        lines.push("", "persisted harness facts:");
        for (const fact of report.persisted_harness_facts.facts) {
            lines.push(
                `  - ${fact.predicate ?? "unknown"} ${fact.graph_id ?? "unknown-fact"}`,
                `    subject: ${fact.subject ?? "unknown-subject"}`,
                `    object: ${fact.object ?? "unknown-object"}`,
            );
        }
    }
    if (report.persisted_review_facts && report.persisted_review_facts.facts.length > 0) {
        lines.push("", "persisted review facts:");
        for (const fact of report.persisted_review_facts.facts) {
            lines.push(
                `  - ${fact.predicate ?? "unknown"} ${fact.graph_id ?? "unknown-fact"}`,
                `    subject: ${fact.subject ?? "unknown-subject"}`,
                `    object: ${fact.object ?? "unknown-object"}`,
            );
        }
    }
    if (report.helper_explanations && report.helper_explanations.explanations.length > 0) {
        lines.push("", "promoted helper controls:");
        for (const explanation of report.helper_explanations.explanations) {
            lines.push(
                `  - ${explanation.source_fixture_id} match=${explanation.match_score}`,
                `    candidate: ${explanation.candidate_label}`,
                `    promoted: ${explanation.promoted_fixture_id ?? "unknown"}`,
            );
        }
    }
    for (const failure of report.failures) lines.push(`failure: ${failure}`);
    return lines.join("\n");
}

const persistedHarnessFactPassed = (fact: WorkflowCandidateTopicHarnessGraphFactRow): boolean => {
    const value = safeJsonParse(fact.value_json ?? "null") as { passed?: unknown } | null;
    return fact.predicate === "passed" || value?.passed === true;
};

export function buildWorkflowCandidateTopicHarnessEvidenceSummary(
    report: WorkflowCandidateTopicReport,
): WorkflowCandidateTopicHarnessEvidenceSummary {
    const checks = report.harness_checks?.checks ?? [];
    const computedPassedCount = checks.filter((check) => check.status === "passed").length;
    const computedFailedCount = checks.filter((check) => check.status === "failed").length;
    const persistedFacts = report.persisted_harness_facts?.facts ?? [];
    const persistedPassedCount = persistedFacts.filter(persistedHarnessFactPassed).length;
    const persistedFailedCount = Math.max(0, persistedFacts.length - persistedPassedCount);
    const hasComputedEvidence = computedPassedCount > 0;
    const hasPersistedEvidence = persistedPassedCount > 0;
    const gateEvidenceSource: WorkflowCandidateTopicHarnessGateEvidenceSource = hasComputedEvidence && hasPersistedEvidence
        ? "computed_and_persisted"
        : hasComputedEvidence
            ? "computed"
            : hasPersistedEvidence
                ? "persisted"
                : "none";
    return {
        gate_satisfied: computedFailedCount === 0 && (checks.length > 0 || persistedPassedCount > 0),
        gate_evidence_source: gateEvidenceSource,
        computed_check_count: checks.length,
        computed_passed_count: computedPassedCount,
        computed_failed_count: computedFailedCount,
        persisted_fact_count: persistedFacts.length,
        persisted_passed_count: persistedPassedCount,
        persisted_failed_count: persistedFailedCount,
    };
}

const withWorkflowCandidateTopicHarnessEvidence = (
    report: WorkflowCandidateTopicReport,
): WorkflowCandidateTopicReport => ({
    ...report,
    harness_evidence: buildWorkflowCandidateTopicHarnessEvidenceSummary(report),
});

export function readWorkflowCandidateHelperFixtures(path: string): readonly WorkflowCandidateHelperFixtureRow[] {
    const rows: WorkflowCandidateHelperFixtureRow[] = [];
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const parsed = safeJsonParse<unknown>(line.trim());
        if (!isObject(parsed)) continue;
        const id = asString(parsed.id);
        const text = asString(parsed.text);
        if (id && text) rows.push({ id, text });
    }
    return rows;
}

export function buildWorkflowCandidateTopicHelperExplanations(input: {
    readonly report: WorkflowCandidateTopicReport;
    readonly facts: readonly WorkflowCandidateEmbeddingHelperGraphFactRow[];
    readonly edges: readonly WorkflowCandidateEmbeddingHelperGraphEdgeRow[];
    readonly fixtures: readonly WorkflowCandidateHelperFixtureRow[];
    readonly minTokenOverlap?: number;
}): WorkflowCandidateTopicHelperExplanationReport {
    const minTokenOverlap = input.minTokenOverlap ?? 0.72;
    const fixtureTextById = new Map(input.fixtures.map((fixture) => [fixture.id, fixture.text]));
    const edgeById = new Map(input.edges.map((edge) => [edge.graph_id, edge]));
    const explanations: WorkflowCandidateTopicHelperExplanation[] = [];
    for (const fact of input.facts) {
        if (fact.predicate !== "promoted_hard_negative_fixture") continue;
        const props = parseProperties(fact.properties_json);
        const sourceFixtureId = asString(props.source_fixture_id) ??
            (fact.subject?.startsWith("embedding_helper_hard_negative:")
                ? fact.subject.slice("embedding_helper_hard_negative:".length)
                : undefined);
        if (!sourceFixtureId) continue;
        const fixtureText = fixtureTextById.get(sourceFixtureId);
        if (!fixtureText) continue;
        const promotedFixtureId = asString(props.promoted_fixture_id) ??
            (fact.object?.startsWith("classifier_promoted_fixture:")
                ? fact.object.slice("classifier_promoted_fixture:".length)
                : undefined);
        const evidenceEdgesValue = safeJsonParse<unknown>(fact.evidence_edges_json ?? "[]");
        const evidenceEdges = Array.isArray(evidenceEdgesValue)
            ? evidenceEdgesValue.filter((edge): edge is string => typeof edge === "string")
            : [];
        const nearestNeighbors = evidenceEdges
            .map((edgeId) => edgeById.get(edgeId))
            .filter((edge): edge is WorkflowCandidateEmbeddingHelperGraphEdgeRow => edge?.kind === "nearest_reviewed_fixture")
            .map((edge) => {
                const edgeProps = parseProperties(edge.properties_json);
                const fixtureId = edge.to_id?.startsWith("classifier_evidence:")
                    ? edge.to_id.slice("classifier_evidence:".length)
                    : edge.to_id ?? "unknown-fixture";
                const similarity = asNumber(edgeProps.similarity);
                return {
                    fixture_id: fixtureId,
                    ...(similarity === undefined ? {} : { similarity }),
                };
            });
        const evidencePaths = Array.from(new Set(evidenceEdges
            .map((edgeId) => edgeById.get(edgeId)?.evidence_path)
            .filter((path): path is string => typeof path === "string" && path.length > 0)))
            .sort();
        for (const candidate of input.report.candidates.candidates) {
            for (const example of candidate.examples) {
                const matchScore = tokenOverlapScore(fixtureText, example.text_excerpt);
                if (matchScore < minTokenOverlap) continue;
                const status = asString(props.status);
                const proposedLabel = asString(props.proposed_label);
                explanations.push({
                    source_fixture_id: sourceFixtureId,
                    ...(promotedFixtureId ? { promoted_fixture_id: promotedFixtureId } : {}),
                    fact_id: fact.graph_id ?? sourceFixtureId,
                    ...(status ? { status } : {}),
                    ...(proposedLabel ? { proposed_label: proposedLabel } : {}),
                    candidate_id: candidate.group_id,
                    candidate_label: candidate.label,
                    proposed_action: candidate.proposed_action,
                    ...(typeof example.turn === "string" ? { turn: example.turn } : {}),
                    ...(typeof example.result_id === "string" ? { result_id: example.result_id } : {}),
                    match_score: matchScore,
                    text_excerpt: example.text_excerpt,
                    nearest_neighbors: nearestNeighbors,
                    evidence_paths: evidencePaths,
                });
            }
        }
    }
    const matchedCandidates = new Set(explanations.map((explanation) => explanation.candidate_id));
    return {
        schema: "ax.workflow_candidate_topic_helper_explanations.v1",
        min_token_overlap: minTokenOverlap,
        explanations: explanations.sort((a, b) => b.match_score - a.match_score || a.source_fixture_id.localeCompare(b.source_fixture_id)),
        totals: {
            promoted_helper_fact_count: input.facts.filter((fact) => fact.predicate === "promoted_hard_negative_fixture").length,
            fixture_text_count: fixtureTextById.size,
            matched_example_count: explanations.length,
            matched_candidate_count: matchedCandidates.size,
        },
    };
}

const citedCandidateIdsForTopic = (report: WorkflowCandidateTopicReport): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const proposal of report.proposals.proposals) {
        for (const evidence of proposal.evidence ?? []) ids.add(evidence.candidate_id);
    }
    for (const fact of report.persisted_harness_facts?.facts ?? []) {
        if (!persistedHarnessFactPassed(fact)) continue;
        if (typeof fact.object === "string" && fact.object.length > 0) ids.add(fact.object);
        const props = parseProperties(fact.properties_json);
        if (typeof props.candidate_id === "string" && props.candidate_id.length > 0) ids.add(props.candidate_id);
    }
    return ids;
};

export function topicAdjacentCandidates(report: WorkflowCandidateTopicReport): readonly WorkflowCandidate[] {
    const citedCandidateIds = citedCandidateIdsForTopic(report);
    return report.candidates.candidates.filter((candidate) => !citedCandidateIds.has(candidate.group_id));
}

const exampleTextMatchesTopic = (example: WorkflowCandidateExample, topic: string): boolean => {
    const normalizedTopic = topic.trim().toLowerCase();
    if (normalizedTopic.length === 0) return true;
    return example.text_excerpt.toLowerCase().includes(normalizedTopic);
};

const exampleHasAppliedClassifierResultEvidence = (example: WorkflowCandidateExample, topic: string): boolean => {
    const resultId = typeof example.result_id === "string" ? example.result_id : "";
    const text = example.text_excerpt.toLowerCase();
    return resultId.startsWith("classifier_result:")
        && exampleTextMatchesTopic(example, topic)
        && text.includes("classifier")
        && /\bresults?\b/.test(text);
};

const evidenceRefsForExamples = (examples: readonly WorkflowCandidateExample[]): readonly string[] => {
    const refs: string[] = [];
    for (const example of examples) {
        if (typeof example.result_id === "string" && example.result_id.length > 0) refs.push(example.result_id);
        if (typeof example.turn === "string" && example.turn.length > 0) refs.push(example.turn);
    }
    return [...new Set(refs)].sort();
};

export function buildWorkflowCandidateTopicHarnessChecks(
    report: WorkflowCandidateTopicReport,
): WorkflowCandidateTopicHarnessCheckSummary {
    const checks: WorkflowCandidateTopicHarnessCheck[] = [];
    for (const candidate of topicAdjacentCandidates(report)) {
        const recommendation = recommendWorkflowCandidatePromotionArtifact([candidate], report.candidates);
        if (recommendation.primary !== "harness_check") continue;

        const matchingExamples = candidate.examples.filter((example) =>
            exampleHasAppliedClassifierResultEvidence(example, report.topic)
        );
        const turns = evidenceTurnsForCandidate(candidate);
        const failures = [
            ...(candidate.proposed_action === "add_verification_gate" ? [] : ["candidate is not an add_verification_gate action"]),
            ...(matchingExamples.length > 0 ? [] : ["missing applied classifier result evidence for topic"]),
            ...(turns.length > 0 ? [] : ["missing source turn evidence"]),
        ];
        checks.push({
            id: `${safeKeyPart(candidate.group_id)}__applied_classifier_result_evidence`,
            candidate_id: candidate.group_id,
            label: candidate.label,
            status: failures.length === 0 ? "passed" : "failed",
            expectation: "harness-worthy verification candidates must include applied classifier result evidence before guidance changes",
            evidence_refs: evidenceRefsForExamples(matchingExamples.length > 0 ? matchingExamples : candidate.examples),
            failures,
        });
    }
    return {
        passed_count: checks.filter((check) => check.status === "passed").length,
        failed_count: checks.filter((check) => check.status === "failed").length,
        checks,
    };
}

export function workflowCandidateTopicHarnessGateFailures(report: WorkflowCandidateTopicReport): readonly string[] {
    const checks = report.harness_checks?.checks ?? [];
    const persistedPassingFacts = (report.persisted_harness_facts?.facts ?? []).filter(persistedHarnessFactPassed);
    if (checks.length === 0 && persistedPassingFacts.length === 0) {
        return ["no passing topic harness checks were produced or persisted"];
    }
    const failures: string[] = [];
    for (const check of checks) {
        if (check.status === "passed") continue;
        failures.push(
            `harness check ${check.id} failed`
                + (check.failures.length > 0 ? `: ${check.failures.join("; ")}` : ""),
        );
    }
    return failures;
}

const topicHarnessGraphId = (topic: string): string =>
    `workflow_topic:${safeKeyPart(topic.toLowerCase()) || "unknown_topic"}`;

const graphKeyWithHash = (value: string, slugLength = 72): string =>
    `${safeKeyPart(value).slice(0, slugLength)}__${Bun.hash(value).toString(16).slice(0, 12)}`;

const harnessCheckGraphId = (topic: string, checkId: string): string =>
    `workflow_topic_harness_check:${safeKeyPart(topic.toLowerCase()) || "unknown_topic"}:${graphKeyWithHash(checkId)}`;

export function buildWorkflowCandidateTopicHarnessGraphProjection(
    report: WorkflowCandidateTopicReport,
): WorkflowCandidateTopicHarnessGraphProjection {
    const checks = report.harness_checks?.checks ?? [];
    const topicNode = topicHarnessGraphId(report.topic);
    const nodes = new Map<string, WorkflowCandidateTopicHarnessGraphNode>();
    const edges: WorkflowCandidateTopicHarnessGraphEdge[] = [];
    const facts: WorkflowCandidateTopicHarnessGraphFact[] = [];

    nodes.set(topicNode, {
        id: topicNode,
        kind: "workflow_topic",
        label: report.topic || "unknown-topic",
        properties: {
            topic: report.topic,
            source_kind: report.source_kind,
            decision: report.decision,
        },
    });

    for (const check of checks) {
        const checkNode = harnessCheckGraphId(report.topic, check.id);
        nodes.set(checkNode, {
            id: checkNode,
            kind: "workflow_topic_harness_check",
            label: check.label,
            properties: {
                topic: report.topic,
                check_id: check.id,
                candidate_id: check.candidate_id,
                status: check.status,
                expectation: check.expectation,
                failures: check.failures,
                evidence_refs: check.evidence_refs,
            },
        });
        const topicEdge = `edge:${graphKeyWithHash(`${topicNode}:has_harness_check:${checkNode}`)}`;
        edges.push({
            id: topicEdge,
            kind: "topic_has_harness_check",
            from: topicNode,
            to: checkNode,
            evidence_path: report.topic,
            properties: {
                topic: report.topic,
                status: check.status,
            },
        });
        const candidateEdge = `edge:${graphKeyWithHash(`${checkNode}:checks_candidate:${check.candidate_id}`)}`;
        edges.push({
            id: candidateEdge,
            kind: "harness_check_checks_candidate",
            from: checkNode,
            to: check.candidate_id,
            evidence_path: check.evidence_refs.join(" "),
            properties: {
                topic: report.topic,
                candidate_id: check.candidate_id,
                evidence_refs: check.evidence_refs,
            },
        });
        facts.push({
            id: `fact:${graphKeyWithHash(`${checkNode}:status`)}`,
            kind: "workflow_topic_harness_check",
            subject: checkNode,
            predicate: check.status === "passed" ? "passed" : "failed",
            object: check.candidate_id,
            value: {
                passed: check.status === "passed",
                status: check.status,
                failure_count: check.failures.length,
            },
            evidence_edges: [topicEdge, candidateEdge],
            properties: {
                topic: report.topic,
                check_id: check.id,
                candidate_id: check.candidate_id,
                label: check.label,
                expectation: check.expectation,
                failures: check.failures,
                evidence_refs: check.evidence_refs,
            },
        });
    }

    return {
        schema: "ax.workflow_topic_harness_graph_projection.v1",
        source_report_schema: report.schema,
        topic: report.topic,
        nodes: [...nodes.values()],
        edges,
        facts,
        totals: {
            check_count: checks.length,
            passed_count: checks.filter((check) => check.status === "passed").length,
            failed_count: checks.filter((check) => check.status === "failed").length,
            node_count: nodes.size,
            edge_count: edges.length,
            fact_count: facts.length,
        },
    };
}

export function buildWorkflowCandidateTopicHarnessGraphWritePlan(
    projection: WorkflowCandidateTopicHarnessGraphProjection,
): WorkflowCandidateTopicHarnessGraphWritePlan {
    const sourceKind = "workflow_topic_harness_check";
    const nodeStatements = projection.nodes.map((node) =>
        `UPSERT ${recordRef("classifier_graph_node", node.id)} CONTENT ${surrealObject([
            ["graph_id", surrealString(node.id)],
            ["kind", surrealString(node.kind)],
            ["label", surrealString(node.label)],
            ["properties_json", surrealJson(node.properties)],
            ["source_kind", surrealString(sourceKind)],
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
            ["source_kind", surrealString(sourceKind)],
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
            ["value_json", surrealJsonTextOption(fact.value)],
            ["evidence_edges_json", surrealJsonText(fact.evidence_edges)],
            ["properties_json", surrealJson(fact.properties)],
            ["source_kind", surrealString(sourceKind)],
            ["updated_at", "time::now()"],
        ])};`
    );
    const statements = [...nodeStatements, ...edgeStatements, ...factStatements];
    return {
        schema: "ax.workflow_topic_harness_graph_write_plan.v1",
        source_projection_schema: projection.schema,
        topic: projection.topic,
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

const topicReviewGraphId = (topic: string, candidateId: string): string =>
    `workflow_topic_candidate_review:${safeKeyPart(topic.toLowerCase()) || "unknown_topic"}:${graphKeyWithHash(candidateId)}`;

export function buildWorkflowCandidateTopicReviewGraphProjection(
    report: WorkflowCandidateTopicReport,
): WorkflowCandidateTopicReviewGraphProjection {
    const reviewedCandidates = report.candidates.candidates.filter((candidate) => {
        const verdict = candidate.review?.verdict ?? "pending";
        return REVIEWED_VERDICTS.has(verdict);
    });
    const topicNode = topicHarnessGraphId(report.topic);
    const nodes = new Map<string, WorkflowCandidateTopicHarnessGraphNode>();
    const edges: WorkflowCandidateTopicHarnessGraphEdge[] = [];
    const facts: WorkflowCandidateTopicHarnessGraphFact[] = [];

    nodes.set(topicNode, {
        id: topicNode,
        kind: "workflow_topic",
        label: report.topic || "unknown-topic",
        properties: {
            topic: report.topic,
            source_kind: report.source_kind,
            decision: report.decision,
        },
    });

    for (const candidate of reviewedCandidates) {
        const review = candidate.review;
        if (!review) continue;
        const reviewNode = topicReviewGraphId(report.topic, candidate.group_id);
        const helperExplanations = (report.helper_explanations?.explanations ?? [])
            .filter((explanation) => explanation.candidate_id === candidate.group_id);
        const evidenceRefs = evidenceRefsForExamples(candidate.examples);
        const helperFactIds = helperExplanations.map((explanation) => explanation.fact_id);
        nodes.set(reviewNode, {
            id: reviewNode,
            kind: "workflow_topic_candidate_review",
            label: candidate.label,
            properties: {
                topic: report.topic,
                candidate_id: candidate.group_id,
                candidate_label: candidate.label,
                proposed_action: candidate.proposed_action,
                verdict: review.verdict,
                rationale: review.rationale,
                synced_from: report.candidates.review?.synced_from ?? null,
                helper_fact_ids: helperFactIds,
                evidence_refs: evidenceRefs,
            },
        });
        const topicEdge = `edge:${graphKeyWithHash(`${topicNode}:has_candidate_review:${reviewNode}`)}`;
        edges.push({
            id: topicEdge,
            kind: "topic_has_candidate_review",
            from: topicNode,
            to: reviewNode,
            evidence_path: report.candidates.review?.synced_from ?? report.topic,
            properties: {
                topic: report.topic,
                verdict: review.verdict,
            },
        });
        const candidateEdge = `edge:${graphKeyWithHash(`${reviewNode}:reviews_candidate:${candidate.group_id}`)}`;
        edges.push({
            id: candidateEdge,
            kind: "candidate_review_reviews_candidate",
            from: reviewNode,
            to: candidate.group_id,
            evidence_path: evidenceRefs.join(" "),
            properties: {
                topic: report.topic,
                candidate_id: candidate.group_id,
                evidence_refs: evidenceRefs,
            },
        });
        facts.push({
            id: `fact:${graphKeyWithHash(`${reviewNode}:verdict:${review.verdict}`)}`,
            kind: "workflow_topic_candidate_review",
            subject: reviewNode,
            predicate: review.verdict,
            object: candidate.group_id,
            value: {
                reviewed: true,
                verdict: review.verdict,
            },
            evidence_edges: [topicEdge, candidateEdge],
            properties: {
                topic: report.topic,
                candidate_id: candidate.group_id,
                candidate_label: candidate.label,
                proposed_action: candidate.proposed_action,
                verdict: review.verdict,
                rationale: review.rationale,
                synced_from: report.candidates.review?.synced_from ?? null,
                helper_fact_ids: helperFactIds,
                helper_source_fixture_ids: helperExplanations.map((explanation) => explanation.source_fixture_id),
                evidence_refs: evidenceRefs,
            },
        });
    }

    return {
        schema: "ax.workflow_topic_review_graph_projection.v1",
        source_report_schema: report.schema,
        topic: report.topic,
        nodes: [...nodes.values()],
        edges,
        facts,
        totals: {
            reviewed_candidate_count: reviewedCandidates.length,
            rejected_count: reviewedCandidates.filter((candidate) => candidate.review?.verdict === "reject").length,
            accepted_count: reviewedCandidates.filter((candidate) => candidate.review?.verdict === "accept").length,
            deferred_count: reviewedCandidates.filter((candidate) => candidate.review?.verdict === "defer").length,
            revised_count: reviewedCandidates.filter((candidate) => candidate.review?.verdict === "revise").length,
            node_count: nodes.size,
            edge_count: edges.length,
            fact_count: facts.length,
        },
    };
}

const fixtureReviewVerdict = (row: WorkflowCandidateTopicClassifierFixtureRow): WorkflowCandidateReviewVerdict | undefined =>
    REVIEWED_VERDICTS.has(row.review_status) ? row.review_status as WorkflowCandidateReviewVerdict : undefined;

const workflowCandidateReviewCoverageGuardNextAction = (
    guard: WorkflowCandidateReviewCoverageApplyGuard,
): string => {
    switch (guard) {
        case "invalid_review_pack":
            return "Fix invalid review statuses before syncing or applying.";
        case "no_reviewed_fixtures":
            return "Set at least one fixture to accept, revise, reject, or defer and add a rationale.";
        case "missing_review_rationale":
            return "Add rationale text for every reviewed fixture.";
        case "missing_review_provenance":
            return "Add reviewer and reviewed-at metadata, or rerun without strict provenance if legacy review packs are acceptable.";
        case "missing_review_handoff":
            return "Complete the review handoff artifacts before applying.";
        case "blocked_smoke_review":
            return "Replace smoke or example review markers with real review decisions before applying.";
        case "ready_to_apply":
            return "Run the apply command after confirming the review pack is intentional.";
    }
};

const workflowCandidateReviewCoverageBlockerRemediation = (
    blocker: WorkflowCandidateReviewCoverageApplyBlocker,
): string => {
    switch (blocker) {
        case "invalid_review_pack":
            return "Replace invalid review statuses with accept, revise, reject, defer, or pending.";
        case "no_reviewed_fixtures":
            return "Review at least one fixture and add a rationale before applying.";
        case "missing_review_rationale":
            return "Add rationale text to each reviewed fixture.";
        case "missing_review_provenance":
            return "Add reviewer and valid reviewed-at metadata or rerun without strict provenance.";
        case "missing_review_handoff":
            return "Run the review handoff command with review facts, write plan, rendered brief, and synced brief paths before applying.";
        case "blocked_smoke_review":
            return "Replace smoke or example review markers with real review decisions.";
        case "empty_write_plan":
            return "Regenerate the review write plan or keep the pack as a no-op.";
    }
};

const postApplyOutputPath = (outputPath: string): string => {
    if (outputPath.endsWith(".json")) return outputPath.replace(/\.json$/, "-post-apply.json");
    return `${outputPath}-post-apply.json`;
};

const siblingOutputPath = (outputPath: string, suffix: string): string => {
    if (outputPath.endsWith(".json")) return outputPath.replace(/\.json$/, `${suffix}.json`);
    return `${outputPath}${suffix}.json`;
};

const workflowCandidateReviewCoverageRecheckCommand = (input: {
    readonly sourceKind?: string;
    readonly limit?: number;
    readonly outputPath?: string;
}): string => [
    "bun src/cli/index.ts classifiers workflow-candidates",
    "--review-coverage",
    `--source-kind=${input.sourceKind ?? "hybrid_window_classifier_projection"}`,
    `--limit=${input.limit ?? 10}`,
    `--out=${postApplyOutputPath(input.outputPath ?? ".ax/experiments/workflow-candidate-review-coverage.json")}`,
    "--json",
].join(" ");

export function buildWorkflowCandidateReviewCoveragePostApplyRecheckSummary(input: {
    readonly before: {
        readonly reviewedCandidateCount: number;
        readonly unreviewedCandidateCount: number;
        readonly projectedReviewedCandidateCount: number;
        readonly projectedUnreviewedCandidateCount: number;
    };
    readonly after: {
        readonly reviewedCandidateCount: number;
        readonly unreviewedCandidateCount: number;
    };
    readonly command: string;
}): WorkflowCandidateReviewCoveragePostApplyRecheckSummary {
    const reviewedCandidateDelta = input.after.reviewedCandidateCount - input.before.reviewedCandidateCount;
    const unreviewedCandidateDelta = input.after.unreviewedCandidateCount - input.before.unreviewedCandidateCount;
    const projectedReviewedDelta = input.after.reviewedCandidateCount - input.before.projectedReviewedCandidateCount;
    const projectedUnreviewedDelta = input.after.unreviewedCandidateCount - input.before.projectedUnreviewedCandidateCount;
    const status: WorkflowCandidateReviewCoverageRecheckStatus =
        projectedReviewedDelta >= 0 && projectedUnreviewedDelta <= 0
            ? "gap_closed"
            : reviewedCandidateDelta > 0 || unreviewedCandidateDelta < 0
                ? "gap_reduced"
            : reviewedCandidateDelta < 0 || unreviewedCandidateDelta > 0
                ? "gap_regressed"
                : "gap_unchanged";
    return {
        schema: "ax.workflow_candidate_review_coverage_recheck.v1",
        status,
        before_reviewed_candidate_count: input.before.reviewedCandidateCount,
        before_unreviewed_candidate_count: input.before.unreviewedCandidateCount,
        projected_reviewed_candidate_count: input.before.projectedReviewedCandidateCount,
        projected_unreviewed_candidate_count: input.before.projectedUnreviewedCandidateCount,
        after_reviewed_candidate_count: input.after.reviewedCandidateCount,
        after_unreviewed_candidate_count: input.after.unreviewedCandidateCount,
        reviewed_candidate_delta: reviewedCandidateDelta,
        unreviewed_candidate_delta: unreviewedCandidateDelta,
        projected_reviewed_delta: projectedReviewedDelta,
        projected_unreviewed_delta: projectedUnreviewedDelta,
        command: input.command,
    };
}

export function parseWorkflowCandidateFixtureRowsJsonl(
    content: string,
): readonly WorkflowCandidateTopicClassifierFixtureRow[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => safeJsonParse<WorkflowCandidateTopicClassifierFixtureRow>(line))
        .filter((row): row is WorkflowCandidateTopicClassifierFixtureRow => row !== null);
}

export function renderWorkflowCandidateReviewCoverageBriefMarkdown(
    rows: readonly WorkflowCandidateTopicClassifierFixtureRow[],
    context: WorkflowCandidateReviewCoverageBriefContext = {},
): string {
    const candidateSummaries = new Map<string, {
        readonly label: string;
        readonly proposed_action: string;
        readonly fixture_count: number;
        readonly support_count: number | undefined;
        readonly evidence_count: number | undefined;
        readonly score: number | undefined;
    }>();
    for (const row of rows) {
        const existing = candidateSummaries.get(row.candidate_id);
        candidateSummaries.set(row.candidate_id, {
            label: row.candidate_label,
            proposed_action: row.proposed_action,
            fixture_count: (existing?.fixture_count ?? 0) + 1,
            support_count: row.candidate_support_count ?? existing?.support_count,
            evidence_count: row.candidate_evidence_count ?? existing?.evidence_count,
            score: row.candidate_score ?? existing?.score,
        });
    }
    const sortedCandidateSummaries = [...candidateSummaries.entries()].sort(([, a], [, b]) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        (b.support_count ?? 0) - (a.support_count ?? 0) ||
        (b.evidence_count ?? 0) - (a.evidence_count ?? 0) ||
        a.label.localeCompare(b.label)
    );
    const pendingCount = rows.filter((row) => row.review_status === "pending").length;
    const reviewedCount = rows.length - pendingCount;
    const acceptedCount = rows.filter((row) => row.review_status === "accept").length;
    const revisedCount = rows.filter((row) => row.review_status === "revise").length;
    const rejectedCount = rows.filter((row) => row.review_status === "reject").length;
    const deferredCount = rows.filter((row) => row.review_status === "defer").length;
    const invalidCount = rows.filter((row) => !VALID_VERDICTS.has(row.review_status)).length;
    const reviewedRows = rows.filter((row) => fixtureReviewVerdict(row) !== undefined);
    const missingRationaleCount = reviewedRows.filter((row) => (row.review_rationale ?? "").trim().length === 0).length;
    const completeRationaleCount = reviewedRows.length - missingRationaleCount;
    const missingReviewerCount = reviewedRows.filter((row) => (row.review_reviewer ?? "").trim().length === 0).length;
    const missingReviewedAtCount = reviewedRows.filter((row) => (row.review_reviewed_at ?? "").trim().length === 0).length;
    const invalidReviewedAtCount = reviewedRows.filter(hasInvalidReviewedAt).length;
    const provenanceStatus: WorkflowCandidateReviewCoverageProvenanceStatus =
        missingReviewerCount === 0 && missingReviewedAtCount === 0 && invalidReviewedAtCount === 0
            ? "complete_review_provenance"
            : "missing_review_provenance";
    const provenanceNextAction = provenanceStatus === "complete_review_provenance"
        ? "Review provenance is complete."
        : "Add reviewer and reviewed-at metadata before applying if audit provenance is required.";
    const reviewPackPath = context.coverageReviewPack ?? context.coverageFixturePack;
    const smokeMarkerCount = reviewedRows.filter(fixtureRowHasSmokeMarker).length +
        (reviewPackPath?.toLowerCase().includes("smoke") ? 1 : 0);
    const applyGuard: WorkflowCandidateReviewCoverageApplyGuard = invalidCount > 0
        ? "invalid_review_pack"
        : reviewedRows.length === 0
        ? "no_reviewed_fixtures"
        : missingRationaleCount > 0
            ? "missing_review_rationale"
        : smokeMarkerCount > 0
            ? "blocked_smoke_review"
            : "ready_to_apply";
    const applyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [];
    if (invalidCount > 0) applyBlockers.push("invalid_review_pack");
    if (reviewedRows.length === 0) applyBlockers.push("no_reviewed_fixtures");
    if (missingRationaleCount > 0) applyBlockers.push("missing_review_rationale");
    if (smokeMarkerCount > 0) applyBlockers.push("blocked_smoke_review");
    const strictApplyGuard: WorkflowCandidateReviewCoverageApplyGuard = applyGuard !== "ready_to_apply"
        ? applyGuard
        : provenanceStatus === "missing_review_provenance"
            ? "missing_review_provenance"
            : "ready_to_apply";
    const strictApplyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [
        ...applyBlockers,
        ...(applyGuard === "ready_to_apply" && provenanceStatus === "missing_review_provenance"
            ? ["missing_review_provenance" as const]
            : []),
    ];
    const provenanceIssueRows = workflowCandidateReviewCoverageProvenanceIssueRows(reviewedRows);
    const reviewIssueRows = workflowCandidateReviewCoverageReviewIssueRows(rows);
    const reviewIssueCounts = workflowCandidateReviewCoverageReviewIssueCounts(reviewIssueRows);
    const reviewIssueScopeCounts = workflowCandidateReviewCoverageReviewIssueScopeCounts(reviewIssueRows);
    const reviewIssueScopeFixtureCounts = workflowCandidateReviewCoverageReviewIssueScopeDistinctCounts(reviewIssueRows, (row) => row.fixture_id);
    const reviewIssueScopeCandidateCounts = workflowCandidateReviewCoverageReviewIssueScopeDistinctCounts(reviewIssueRows, (row) => row.candidate_id);
    const reviewIssueScopeSummaries = workflowCandidateReviewCoverageReviewIssueScopeSummaries(reviewIssueRows);
    const reviewIssueFixtureCount = workflowCandidateReviewCoverageReviewIssueFixtureCount(reviewIssueRows);
    const reviewIssueCandidateCount = workflowCandidateReviewCoverageReviewIssueCandidateCount(reviewIssueRows);
    const reviewIssueStatus = workflowCandidateReviewCoverageReviewIssueStatus(reviewIssueRows);
    const reviewIssueNextAction = workflowCandidateReviewCoverageReviewIssueNextAction(reviewIssueStatus);
    const sourceKind = context.sourceKind ?? "hybrid_window_classifier_projection";
    const readinessOutputPath = context.outputPath ?? ".ax/experiments/workflow-candidate-review-coverage-reviewed.json";
    const syncedBriefPath = context.coverageReviewBrief ?? ".ax/experiments/workflow-candidate-review-coverage-reviewed.md";
    const reviewFactsPath = siblingOutputPath(readinessOutputPath, "-review-facts");
    const reviewWritePlanPath = siblingOutputPath(readinessOutputPath, "-review-write-plan");
    const handoffMissingPaths = workflowCandidateReviewCoverageHandoffMissingPaths({
        reviewFactsPath,
        reviewWritePlanPath,
        ...(context.coverageReviewBrief === undefined ? {} : {
            reviewBriefPath: context.coverageReviewBrief,
            syncedReviewBriefPath: context.coverageReviewBrief,
        }),
    });
    const handoffStatus: WorkflowCandidateReviewCoverageHandoffStatus = handoffMissingPaths.length === 0
        ? "complete_review_handoff"
        : "incomplete_review_handoff";
    const handoffApplyGuard: WorkflowCandidateReviewCoverageApplyGuard =
        applyGuard === "ready_to_apply" && handoffMissingPaths.length > 0
            ? "missing_review_handoff"
            : applyGuard;
    const handoffApplyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [
        ...applyBlockers,
        ...(applyGuard === "ready_to_apply" && handoffMissingPaths.length > 0
            ? ["missing_review_handoff" as const]
            : []),
    ];
    const productionApplyGuard: WorkflowCandidateReviewCoverageApplyGuard =
        strictApplyGuard === "ready_to_apply" && handoffMissingPaths.length > 0
            ? "missing_review_handoff"
            : strictApplyGuard;
    const productionApplyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [
        ...strictApplyBlockers,
        ...(applyGuard === "ready_to_apply" && handoffMissingPaths.length > 0
            ? ["missing_review_handoff" as const]
            : []),
    ];
    const reviewPipelineStage = workflowCandidateReviewCoveragePipelineStage({
        reviewed_fixture_count: reviewedCount,
        apply_guard: applyGuard,
        provenance_status: provenanceStatus,
        handoff_apply_guard: handoffApplyGuard,
        production_can_apply: productionApplyGuard === "ready_to_apply",
    });
    const reviewPipelineNextAction = workflowCandidateReviewCoveragePipelineNextAction(
        reviewPipelineStage,
        reviewIssueNextAction,
        provenanceNextAction,
    );
    const postApplyRecheckCommand = workflowCandidateReviewCoverageRecheckCommand({
        sourceKind,
        ...(context.limit === undefined ? {} : { limit: context.limit }),
        outputPath: readinessOutputPath,
    });
    const nextCommand = reviewPackPath === undefined
        ? undefined
        : [
            "bun src/cli/index.ts classifiers workflow-candidates",
            "--review-coverage",
            `--source-kind=${sourceKind}`,
            `--coverage-review-pack=${reviewPackPath}`,
            context.coverageReviewBrief === undefined ? undefined : `--sync-coverage-review-brief=${context.coverageReviewBrief}`,
            `--coverage-review-brief=${syncedBriefPath}`,
            `--out=${readinessOutputPath}`,
            "--json",
        ].filter((part): part is string => part !== undefined).join(" ");
    const applyCommand = reviewPackPath === undefined
        ? undefined
        : [
            "bun src/cli/index.ts classifiers workflow-candidates",
            "--review-coverage",
            `--source-kind=${sourceKind}`,
            `--coverage-review-pack=${reviewPackPath}`,
            context.coverageReviewBrief === undefined ? undefined : `--sync-coverage-review-brief=${context.coverageReviewBrief}`,
            "--apply-review-facts",
            `--out=${readinessOutputPath}`,
            "--json",
        ].filter((part): part is string => part !== undefined).join(" ");
    const inspectWriteCommand = reviewPackPath === undefined
        ? undefined
        : [
            "bun src/cli/index.ts classifiers workflow-candidates",
            "--review-coverage",
            `--source-kind=${sourceKind}`,
            `--coverage-review-pack=${reviewPackPath}`,
            context.coverageReviewBrief === undefined ? undefined : `--sync-coverage-review-brief=${context.coverageReviewBrief}`,
            `--review-facts=${reviewFactsPath}`,
            `--review-write-plan=${reviewWritePlanPath}`,
            `--out=${readinessOutputPath}`,
            "--json",
        ].filter((part): part is string => part !== undefined).join(" ");
    const strictApplyCommand = reviewPackPath === undefined
        ? undefined
        : [
            "bun src/cli/index.ts classifiers workflow-candidates",
            "--review-coverage",
            `--source-kind=${sourceKind}`,
            `--coverage-review-pack=${reviewPackPath}`,
            context.coverageReviewBrief === undefined ? undefined : `--sync-coverage-review-brief=${context.coverageReviewBrief}`,
            context.coverageReviewBrief === undefined ? undefined : `--coverage-review-brief=${context.coverageReviewBrief}`,
            `--review-facts=${reviewFactsPath}`,
            `--review-write-plan=${reviewWritePlanPath}`,
            "--apply-review-facts",
            "--require-review-provenance",
            "--require-review-handoff",
            `--out=${readinessOutputPath}`,
            "--json",
        ].filter((part): part is string => part !== undefined).join(" ");
    const provenanceStampCommand = reviewPackPath === undefined
        ? undefined
        : [
            "bun src/cli/index.ts classifiers workflow-candidates",
            "--review-coverage",
            `--source-kind=${sourceKind}`,
            `--coverage-review-pack=${reviewPackPath}`,
            context.coverageReviewBrief === undefined ? undefined : `--sync-coverage-review-brief=${context.coverageReviewBrief}`,
            "--review-provenance-reviewer=<reviewer>",
            "--review-provenance-reviewed-at=<reviewed-at-iso>",
            `--coverage-review-brief=${syncedBriefPath}`,
            `--out=${readinessOutputPath}`,
            "--json",
        ].filter((part): part is string => part !== undefined).join(" ");
    const reviewIssueRepairCommand = reviewIssueRows.length === 0 ? undefined : nextCommand;
    const reviewPipelineCommand = workflowCandidateReviewCoveragePipelineCommand(reviewPipelineStage, {
        reviewIssueRepairCommand,
        reviewProvenanceStampCommand: provenanceStampCommand,
        productionApplyCommand: strictApplyCommand,
    });
    const reviewPipelineCommandKind = workflowCandidateReviewCoveragePipelineCommandKind(reviewPipelineStage, reviewPipelineCommand);
    const lines = [
        "# Workflow Candidate Coverage Review",
        "",
        "Allowed review statuses: `accept`, `revise`, `reject`, `defer`, `pending`.",
        "",
        "Review each fixture and replace `pending` plus `_pending_` with a reviewed status and rationale when ready.",
        "",
        "## Review Queue Summary",
        "",
        `- Fixtures: \`${rows.length}\``,
        `- Candidate groups: \`${candidateSummaries.size}\``,
        `- Pending fixtures: \`${pendingCount}\``,
        `- Reviewed fixtures: \`${reviewedCount}\``,
        `- Accepted fixtures: \`${acceptedCount}\``,
        `- Revised fixtures: \`${revisedCount}\``,
        `- Rejected fixtures: \`${rejectedCount}\``,
        `- Deferred fixtures: \`${deferredCount}\``,
        `- Invalid fixtures: \`${invalidCount}\``,
        `- Complete rationales: \`${completeRationaleCount}\``,
        `- Missing rationales: \`${missingRationaleCount}\``,
        `- Missing reviewers: \`${missingReviewerCount}\``,
        `- Missing reviewed-at timestamps: \`${missingReviewedAtCount}\``,
        `- Invalid reviewed-at timestamps: \`${invalidReviewedAtCount}\``,
        `- Provenance status: \`${provenanceStatus}\``,
        `- Handoff status: \`${handoffStatus}\``,
        `- Handoff missing paths: ${handoffMissingPaths.length === 0 ? "`none`" : handoffMissingPaths.map((path) => `\`${path}\``).join(", ")}`,
        `- Handoff apply guard: \`${handoffApplyGuard}\``,
        `- Handoff blockers: ${handoffApplyBlockers.length === 0 ? "`none`" : handoffApplyBlockers.map((blocker) => `\`${blocker}\``).join(", ")}`,
        `- Smoke markers: \`${smokeMarkerCount}\``,
        `- Apply guard: \`${applyGuard}\``,
        `- Apply blockers: ${applyBlockers.length === 0 ? "`none`" : applyBlockers.map((blocker) => `\`${blocker}\``).join(", ")}`,
        `- Strict provenance apply guard: \`${strictApplyGuard}\``,
        `- Strict provenance blockers: ${strictApplyBlockers.length === 0 ? "`none`" : strictApplyBlockers.map((blocker) => `\`${blocker}\``).join(", ")}`,
        `- Production apply guard: \`${productionApplyGuard}\``,
        `- Production blockers: ${productionApplyBlockers.length === 0 ? "`none`" : productionApplyBlockers.map((blocker) => `\`${blocker}\``).join(", ")}`,
        `- Blocker remediations: ${applyBlockers.length === 0 ? "none" : applyBlockers.map((blocker) => `${blocker}: ${workflowCandidateReviewCoverageBlockerRemediation(blocker)}`).join(" | ")}`,
        `- Handoff blocker remediations: ${handoffApplyBlockers.length === 0 ? "none" : handoffApplyBlockers.map((blocker) => `${blocker}: ${workflowCandidateReviewCoverageBlockerRemediation(blocker)}`).join(" | ")}`,
        `- Strict provenance blocker remediations: ${strictApplyBlockers.length === 0 ? "none" : strictApplyBlockers.map((blocker) => `${blocker}: ${workflowCandidateReviewCoverageBlockerRemediation(blocker)}`).join(" | ")}`,
        `- Production blocker remediations: ${productionApplyBlockers.length === 0 ? "none" : productionApplyBlockers.map((blocker) => `${blocker}: ${workflowCandidateReviewCoverageBlockerRemediation(blocker)}`).join(" | ")}`,
        `- Production next action: ${workflowCandidateReviewCoverageGuardNextAction(productionApplyGuard)}`,
        `- Next action: ${workflowCandidateReviewCoverageGuardNextAction(applyGuard)}`,
        `- Pipeline stage: \`${reviewPipelineStage}\``,
        `- Pipeline next action: ${reviewPipelineNextAction}`,
        ...(reviewPipelineCommand === undefined ? [] : [
            `- Pipeline command kind: \`${reviewPipelineCommandKind}\``,
            `- Pipeline command: \`${reviewPipelineCommand}\``,
        ]),
        "",
        "## Review Issues",
        "",
        ...(reviewIssueRows.length === 0
            ? ["- _none_"]
            : [
                `- Issue fixtures: \`${reviewIssueFixtureCount}\``,
                `- Issue candidates: \`${reviewIssueCandidateCount}\``,
                `- Issue status: \`${reviewIssueStatus}\``,
                `- Issue next action: ${reviewIssueNextAction}`,
                ...(reviewIssueRepairCommand === undefined ? [] : [
                    `- Issue repair command: \`${reviewIssueRepairCommand}\``,
                ]),
                `- Issue counts: ${reviewIssueCounts.map((item) => `\`${item.issue}=${item.count}\``).join(", ")}`,
                `- Issue scope counts: ${reviewIssueScopeCounts.map((item) => `\`${item.blocking_scope}=${item.count}\``).join(", ")}`,
                `- Issue scope fixtures: ${reviewIssueScopeFixtureCounts.map((item) => `\`${item.blocking_scope}=${item.count}\``).join(", ")}`,
                `- Issue scope candidates: ${reviewIssueScopeCandidateCounts.map((item) => `\`${item.blocking_scope}=${item.count}\``).join(", ")}`,
                `- Issue scope summaries: ${reviewIssueScopeSummaries.map((item) => `\`${item.blocking_scope} issues=${item.issue_count} fixtures=${item.fixture_count} candidates=${item.candidate_count}\``).join(", ")}`,
                ...reviewIssueRows.map((row) =>
                    `- \`${row.issue}\` fixture=\`${row.fixture_id}\` candidate=\`${row.candidate_id}\` status=\`${row.review_status}\` scope=\`${row.blocking_scope}\` remediation=\`${row.remediation}\``
                ),
            ]),
        "",
        "## Provenance Issues",
        "",
        ...(provenanceIssueRows.length === 0
            ? ["- _none_"]
            : provenanceIssueRows.map((row) =>
                `- \`${row.issue}\` fixture=\`${row.fixture_id}\` candidate=\`${row.candidate_id}\` reviewed_at=\`${row.reviewed_at || "none"}\``
            )),
        "",
        ...(nextCommand === undefined ? [] : [
            "## Review Commands",
            "",
            "After editing review statuses and rationales, run:",
            "",
            "```sh",
            nextCommand,
            "```",
            "",
            "Apply only after the readiness report returns `ready_to_apply`:",
            "",
            "```sh",
            applyCommand ?? "",
            "```",
            "",
            "To inspect the review graph write before applying, run:",
            "",
            "```sh",
            inspectWriteCommand ?? "",
            "```",
            "",
            "For production or shared graph updates, require review provenance and a complete handoff:",
            "",
            "```sh",
            strictApplyCommand ?? "",
            "```",
            "",
            "To stamp provenance from a review service, run:",
            "",
            "```sh",
            provenanceStampCommand ?? "",
            "```",
            "",
            "After applying, re-run coverage to verify the gap closed:",
            "",
            "```sh",
            postApplyRecheckCommand,
            "```",
            "",
        ]),
        "## Candidate Queue",
        "",
        ...(sortedCandidateSummaries.length === 0
            ? ["- _none_"]
            : sortedCandidateSummaries.map(([candidateId, summary]) =>
                [
                    `- ${summary.label}`,
                    `id=\`${candidateId}\``,
                    `fixtures=\`${summary.fixture_count}\``,
                    `action=\`${summary.proposed_action}\``,
                    `support=\`${summary.support_count ?? "n/a"}\``,
                    `evidence=\`${summary.evidence_count ?? "n/a"}\``,
                    `score=\`${summary.score ?? "n/a"}\``,
                ].join(" ")
            )),
        "",
    ];
    for (const [index, row] of rows.entries()) {
        lines.push(
            `## Fixture ${index + 1}: ${row.candidate_label}`,
            "",
            `- Fixture id: \`${row.id}\``,
            `- Candidate id: \`${row.candidate_id}\``,
            `- Candidate label: \`${row.candidate_label}\``,
            `- Proposed action: \`${row.proposed_action}\``,
            ...(row.suite === "workflow-candidate-review-coverage"
                ? [`- Review impact: \`new_candidate_review\``]
                : []),
            ...(row.candidate_support_count === undefined ? [] : [`- Candidate support: \`${row.candidate_support_count}\``]),
            ...(row.candidate_evidence_count === undefined ? [] : [`- Candidate evidence: \`${row.candidate_evidence_count}\``]),
            ...(row.candidate_score === undefined ? [] : [`- Candidate score: \`${row.candidate_score}\``]),
            `- Result: \`${row.result_id ?? "unknown-result"}\``,
            `- Turn: \`${row.turn ?? "unknown-turn"}\``,
            `- Confidence: \`${row.confidence ?? "n/a"}\``,
            `- Review status: \`${row.review_status}\``,
            `- Review rationale: ${row.review_rationale && row.review_rationale.length > 0 ? row.review_rationale : "_pending_"}`,
            `- Reviewer: ${row.review_reviewer && row.review_reviewer.length > 0 ? row.review_reviewer : "_pending_"}`,
            `- Reviewed at: ${row.review_reviewed_at && row.review_reviewed_at.length > 0 ? row.review_reviewed_at : "_pending_"}`,
            "",
            "Fixture text:",
            "",
            "```text",
            row.text.trimEnd(),
            "```",
            "",
        );
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

export function syncWorkflowCandidateFixtureRowsFromBrief(
    rows: readonly WorkflowCandidateTopicClassifierFixtureRow[],
    brief: string,
): readonly WorkflowCandidateTopicClassifierFixtureRow[] {
    return syncWorkflowCandidateFixtureRowsFromBriefWithSummary(rows, brief).rows;
}

export function syncWorkflowCandidateFixtureRowsFromBriefWithSummary(
    rows: readonly WorkflowCandidateTopicClassifierFixtureRow[],
    brief: string,
): WorkflowCandidateFixtureBriefSyncResult {
    const updates = new Map<string, { status?: string; rationale?: string; reviewer?: string; reviewedAt?: string }>();
    let currentFixtureId: string | undefined;
    for (const rawLine of brief.split(/\r?\n/)) {
        const line = rawLine.trim();
        const fixtureMatch = line.match(/^- Fixture id:\s*(.+)$/);
        if (fixtureMatch) {
            currentFixtureId = stripInlineCode(fixtureMatch[1]);
            updates.set(currentFixtureId, updates.get(currentFixtureId) ?? {});
            continue;
        }
        if (currentFixtureId === undefined) continue;
        const statusMatch = line.match(/^- Review status:\s*(.+)$/);
        if (statusMatch) {
            updates.set(currentFixtureId, {
                ...(updates.get(currentFixtureId) ?? {}),
                status: stripInlineCode(statusMatch[1]).toLowerCase(),
            });
            continue;
        }
        const rationaleMatch = line.match(/^- Review rationale:\s*(.*)$/);
        if (rationaleMatch) {
            const rationale = rationaleMatch[1].trim();
            updates.set(currentFixtureId, {
                ...(updates.get(currentFixtureId) ?? {}),
                rationale: rationale === "_pending_" ? "" : rationale,
            });
            continue;
        }
        const reviewerMatch = line.match(/^- Reviewer:\s*(.*)$/);
        if (reviewerMatch) {
            const reviewer = reviewerMatch[1].trim();
            updates.set(currentFixtureId, {
                ...(updates.get(currentFixtureId) ?? {}),
                reviewer: reviewer === "_pending_" ? "" : reviewer,
            });
            continue;
        }
        const reviewedAtMatch = line.match(/^- Reviewed at:\s*(.*)$/);
        if (reviewedAtMatch) {
            const reviewedAt = reviewedAtMatch[1].trim();
            updates.set(currentFixtureId, {
                ...(updates.get(currentFixtureId) ?? {}),
                reviewedAt: reviewedAt === "_pending_" ? "" : reviewedAt,
            });
        }
    }
    const knownIds = new Set(rows.map((row) => row.id));
    const rowsWithUpdates = rows.map((row) => {
        const update = updates.get(row.id);
        if (update === undefined) return row;
        return {
            ...row,
            ...(update.status === undefined ? {} : {
                review_status: update.status as WorkflowCandidateTopicClassifierFixtureRow["review_status"],
            }),
            ...(update.rationale === undefined ? {} : { review_rationale: update.rationale }),
            ...(update.reviewer === undefined ? {} : { review_reviewer: update.reviewer }),
            ...(update.reviewedAt === undefined ? {} : { review_reviewed_at: update.reviewedAt }),
        };
    });
    return {
        rows: rowsWithUpdates,
        synced_fixture_count: rows.filter((row) => updates.has(row.id)).length,
        unknown_fixture_count: [...updates.keys()].filter((fixtureId) => !knownIds.has(fixtureId)).length,
    };
}

export function stampWorkflowCandidateReviewProvenance(
    rows: readonly WorkflowCandidateTopicClassifierFixtureRow[],
    input: { readonly reviewer?: string; readonly reviewedAt?: string },
): WorkflowCandidateReviewProvenanceStampResult {
    const reviewer = input.reviewer?.trim();
    const reviewedAt = input.reviewedAt?.trim();
    let stampedReviewerCount = 0;
    let stampedReviewedAtCount = 0;
    const stampedRows = rows.map((row) => {
        if (fixtureReviewVerdict(row) === undefined) return row;
        let next: WorkflowCandidateTopicClassifierFixtureRow = row;
        if (reviewer !== undefined && reviewer.length > 0 && (row.review_reviewer ?? "").trim().length === 0) {
            next = { ...next, review_reviewer: reviewer };
            stampedReviewerCount += 1;
        }
        if (
            reviewedAt !== undefined &&
            reviewedAt.length > 0 &&
            ((row.review_reviewed_at ?? "").trim().length === 0 || hasInvalidReviewedAt(row))
        ) {
            next = { ...next, review_reviewed_at: reviewedAt };
            stampedReviewedAtCount += 1;
        }
        return next;
    });
    return {
        rows: stampedRows,
        stamped_reviewer_count: stampedReviewerCount,
        stamped_reviewed_at_count: stampedReviewedAtCount,
    };
}

export function buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures(input: {
    readonly rows: readonly WorkflowCandidateTopicClassifierFixtureRow[];
    readonly syncedFrom: string;
}): WorkflowCandidateTopicReviewGraphProjection {
    const reviewedRows = input.rows.filter((row) => fixtureReviewVerdict(row) !== undefined);
    const topic = "review-coverage";
    const topicNode = topicHarnessGraphId(topic);
    const nodes = new Map<string, WorkflowCandidateTopicHarnessGraphNode>();
    const edges: WorkflowCandidateTopicHarnessGraphEdge[] = [];
    const facts: WorkflowCandidateTopicHarnessGraphFact[] = [];
    nodes.set(topicNode, {
        id: topicNode,
        kind: "workflow_topic",
        label: topic,
        properties: {
            topic,
            source_kind: "workflow_candidate_review_coverage",
            synced_from: input.syncedFrom,
        },
    });

    for (const row of reviewedRows) {
        const verdict = fixtureReviewVerdict(row);
        if (verdict === undefined) continue;
        const reviewNode = topicReviewGraphId(topic, `${row.candidate_id}:${row.id}`);
        const evidenceRefs = [row.result_id, row.turn]
            .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
            .sort();
        nodes.set(reviewNode, {
            id: reviewNode,
            kind: "workflow_topic_candidate_review",
            label: row.candidate_label,
            properties: {
                topic,
                candidate_id: row.candidate_id,
                candidate_label: row.candidate_label,
                proposed_action: row.proposed_action,
                verdict,
                rationale: row.review_rationale ?? "",
                reviewer: row.review_reviewer ?? "",
                reviewed_at: row.review_reviewed_at ?? "",
                synced_from: input.syncedFrom,
                fixture_id: row.id,
                evidence_refs: evidenceRefs,
            },
        });
        const topicEdge = `edge:${graphKeyWithHash(`${topicNode}:has_candidate_review:${reviewNode}`)}`;
        edges.push({
            id: topicEdge,
            kind: "topic_has_candidate_review",
            from: topicNode,
            to: reviewNode,
            evidence_path: input.syncedFrom,
            properties: {
                topic,
                verdict,
                fixture_id: row.id,
            },
        });
        const candidateEdge = `edge:${graphKeyWithHash(`${reviewNode}:reviews_candidate:${row.candidate_id}`)}`;
        edges.push({
            id: candidateEdge,
            kind: "candidate_review_reviews_candidate",
            from: reviewNode,
            to: row.candidate_id,
            evidence_path: evidenceRefs.join(" "),
            properties: {
                topic,
                candidate_id: row.candidate_id,
                fixture_id: row.id,
                evidence_refs: evidenceRefs,
            },
        });
        facts.push({
            id: `fact:${graphKeyWithHash(`${reviewNode}:fixture:${row.id}:verdict:${verdict}`)}`,
            kind: "workflow_topic_candidate_review",
            subject: reviewNode,
            predicate: verdict,
            object: row.candidate_id,
            value: {
                reviewed: true,
                verdict,
            },
            evidence_edges: [topicEdge, candidateEdge],
            properties: {
                topic,
                candidate_id: row.candidate_id,
                candidate_label: row.candidate_label,
                proposed_action: row.proposed_action,
                verdict,
                rationale: row.review_rationale ?? "",
                reviewer: row.review_reviewer ?? "",
                reviewed_at: row.review_reviewed_at ?? "",
                synced_from: input.syncedFrom,
                fixture_id: row.id,
                evidence_refs: evidenceRefs,
            },
        });
    }

    return {
        schema: "ax.workflow_topic_review_graph_projection.v1",
        source_report_schema: "ax.workflow_candidate_review_coverage_fixture_pack.v1",
        topic,
        nodes: [...nodes.values()],
        edges,
        facts,
        totals: {
            reviewed_candidate_count: reviewedRows.length,
            rejected_count: reviewedRows.filter((row) => fixtureReviewVerdict(row) === "reject").length,
            accepted_count: reviewedRows.filter((row) => fixtureReviewVerdict(row) === "accept").length,
            deferred_count: reviewedRows.filter((row) => fixtureReviewVerdict(row) === "defer").length,
            revised_count: reviewedRows.filter((row) => fixtureReviewVerdict(row) === "revise").length,
            node_count: nodes.size,
            edge_count: edges.length,
            fact_count: facts.length,
        },
    };
}

const fixtureRowHasSmokeMarker = (row: WorkflowCandidateTopicClassifierFixtureRow): boolean => {
    const text = [
        row.id,
        row.name,
        row.review_rationale ?? "",
    ].join("\n").toLowerCase();
    return text.includes("smoke review") ||
        text.includes("review smoke") ||
        text.includes("-smoke-") ||
        text.includes("smoke_");
};

const hasInvalidReviewedAt = (row: WorkflowCandidateTopicClassifierFixtureRow): boolean => {
    const reviewedAt = (row.review_reviewed_at ?? "").trim();
    return reviewedAt.length > 0 && Number.isNaN(Date.parse(reviewedAt));
};

const workflowCandidateReviewCoverageProvenanceIssueRows = (
    rows: readonly WorkflowCandidateTopicClassifierFixtureRow[],
): WorkflowCandidateReviewCoverageProvenanceIssueRow[] => rows.flatMap((row) => {
    const reviewer = row.review_reviewer ?? "";
    const reviewedAt = row.review_reviewed_at ?? "";
    const issues: WorkflowCandidateReviewCoverageProvenanceIssue[] = [];
    if (reviewer.trim().length === 0) issues.push("missing_reviewer");
    if (reviewedAt.trim().length === 0) issues.push("missing_reviewed_at");
    else if (hasInvalidReviewedAt(row)) issues.push("invalid_reviewed_at");
    return issues.map((issue) => ({
        fixture_id: row.id,
        candidate_id: row.candidate_id,
        issue,
        reviewer,
        reviewed_at: reviewedAt,
    }));
});

const workflowCandidateReviewCoverageReviewIssueRemediation = (
    issue: WorkflowCandidateReviewCoverageReviewIssue,
): string => {
    switch (issue) {
        case "blocked_smoke_review":
            return "Replace smoke or example review markers with a real review decision.";
        case "invalid_review_status":
            return "Use accept, revise, reject, defer, or pending as the review status.";
        case "invalid_reviewed_at":
            return "Use an ISO reviewed-at timestamp.";
        case "missing_review_rationale":
            return "Add rationale text to this reviewed fixture.";
        case "missing_reviewed_at":
            return "Add reviewed-at metadata to this reviewed fixture.";
        case "missing_reviewer":
            return "Add reviewer metadata to this reviewed fixture.";
    }
};

const workflowCandidateReviewCoverageReviewIssueBlockingScope = (
    issue: WorkflowCandidateReviewCoverageReviewIssue,
): WorkflowCandidateReviewCoverageReviewIssueBlockingScope => {
    switch (issue) {
        case "blocked_smoke_review":
        case "invalid_review_status":
        case "missing_review_rationale":
            return "base_apply";
        case "invalid_reviewed_at":
        case "missing_reviewed_at":
        case "missing_reviewer":
            return "production_apply";
    }
};

const workflowCandidateReviewCoverageReviewIssueRows = (
    rows: readonly WorkflowCandidateTopicClassifierFixtureRow[],
): WorkflowCandidateReviewCoverageReviewIssueRow[] => rows.flatMap((row) => {
    const issues: WorkflowCandidateReviewCoverageReviewIssue[] = [];
    const isReviewed = fixtureReviewVerdict(row) !== undefined;
    if (!VALID_VERDICTS.has(row.review_status)) issues.push("invalid_review_status");
    if (isReviewed && (row.review_rationale ?? "").trim().length === 0) issues.push("missing_review_rationale");
    if (isReviewed && (row.review_reviewer ?? "").trim().length === 0) issues.push("missing_reviewer");
    if (isReviewed && (row.review_reviewed_at ?? "").trim().length === 0) issues.push("missing_reviewed_at");
    else if (isReviewed && hasInvalidReviewedAt(row)) issues.push("invalid_reviewed_at");
    if (isReviewed && fixtureRowHasSmokeMarker(row)) issues.push("blocked_smoke_review");
    return issues.map((issue) => ({
        fixture_id: row.id,
        candidate_id: row.candidate_id,
        issue,
        review_status: row.review_status,
        blocking_scope: workflowCandidateReviewCoverageReviewIssueBlockingScope(issue),
        remediation: workflowCandidateReviewCoverageReviewIssueRemediation(issue),
    }));
});

const workflowCandidateReviewCoverageReviewIssueCounts = (
    rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[],
): WorkflowCandidateReviewCoverageReviewIssueCount[] => {
    const counts = new Map<WorkflowCandidateReviewCoverageReviewIssue, number>();
    for (const row of rows) {
        counts.set(row.issue, (counts.get(row.issue) ?? 0) + 1);
    }
    return [...counts.entries()].map(([issue, count]) => ({ issue, count }));
};

const workflowCandidateReviewCoverageReviewIssueScopeCounts = (
    rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[],
): WorkflowCandidateReviewCoverageReviewIssueScopeCount[] => {
    const counts = new Map<WorkflowCandidateReviewCoverageReviewIssueBlockingScope, number>();
    for (const row of rows) {
        counts.set(row.blocking_scope, (counts.get(row.blocking_scope) ?? 0) + 1);
    }
    return [...counts.entries()].map(([blocking_scope, count]) => ({ blocking_scope, count }));
};

const workflowCandidateReviewCoverageReviewIssueScopeDistinctCounts = (
    rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[],
    getKey: (row: WorkflowCandidateReviewCoverageReviewIssueRow) => string,
): WorkflowCandidateReviewCoverageReviewIssueScopeCount[] => {
    const counts = new Map<WorkflowCandidateReviewCoverageReviewIssueBlockingScope, Set<string>>();
    for (const row of rows) {
        const existing = counts.get(row.blocking_scope);
        if (existing === undefined) counts.set(row.blocking_scope, new Set([getKey(row)]));
        else existing.add(getKey(row));
    }
    return [...counts.entries()].map(([blocking_scope, values]) => ({ blocking_scope, count: values.size }));
};

const workflowCandidateReviewCoverageReviewIssueScopeSummaries = (
    rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[],
): WorkflowCandidateReviewCoverageReviewIssueScopeSummary[] => {
    const summaries = new Map<WorkflowCandidateReviewCoverageReviewIssueBlockingScope, {
        issue_count: number;
        fixture_ids: Set<string>;
        candidate_ids: Set<string>;
    }>();
    for (const row of rows) {
        const existing = summaries.get(row.blocking_scope);
        if (existing === undefined) {
            summaries.set(row.blocking_scope, {
                issue_count: 1,
                fixture_ids: new Set([row.fixture_id]),
                candidate_ids: new Set([row.candidate_id]),
            });
        } else {
            existing.issue_count += 1;
            existing.fixture_ids.add(row.fixture_id);
            existing.candidate_ids.add(row.candidate_id);
        }
    }
    return [...summaries.entries()].map(([blocking_scope, summary]) => ({
        blocking_scope,
        issue_count: summary.issue_count,
        fixture_count: summary.fixture_ids.size,
        candidate_count: summary.candidate_ids.size,
    }));
};

const workflowCandidateReviewCoverageReviewIssueFixtureCount = (
    rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[],
): number => new Set(rows.map((row) => row.fixture_id)).size;

const workflowCandidateReviewCoverageReviewIssueCandidateCount = (
    rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[],
): number => new Set(rows.map((row) => row.candidate_id)).size;

const workflowCandidateReviewCoverageReviewIssueStatus = (
    rows: readonly WorkflowCandidateReviewCoverageReviewIssueRow[],
): WorkflowCandidateReviewCoverageReviewIssueStatus =>
    rows.length === 0 ? "review_repair_complete" : "needs_review_repair";

const workflowCandidateReviewCoverageReviewIssueNextAction = (
    status: WorkflowCandidateReviewCoverageReviewIssueStatus,
): string =>
    status === "review_repair_complete"
        ? "Review issue repairs are complete."
        : "Fix review issue rows before applying reviewed coverage facts.";

const workflowCandidateReviewCoveragePipelineStage = (input: {
    readonly reviewed_fixture_count: number;
    readonly apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly provenance_status: WorkflowCandidateReviewCoverageProvenanceStatus;
    readonly handoff_apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly production_can_apply: boolean;
}): WorkflowCandidateReviewCoveragePipelineStage => {
    if (input.reviewed_fixture_count === 0) return "needs_review_decisions";
    if (input.apply_guard !== "ready_to_apply") return "needs_review_repair";
    if (input.provenance_status === "missing_review_provenance") return "needs_review_provenance";
    if (input.production_can_apply) return "ready_for_production_apply";
    if (input.handoff_apply_guard === "missing_review_handoff") return "needs_review_handoff";
    return "needs_review_repair";
};

const workflowCandidateReviewCoveragePipelineNextAction = (
    stage: WorkflowCandidateReviewCoveragePipelineStage,
    reviewIssueNextAction: string,
    provenanceNextAction: string,
): string => {
    switch (stage) {
        case "needs_review_decisions":
            return "Set at least one fixture to accept, revise, reject, or defer and add a rationale.";
        case "needs_review_repair":
            return reviewIssueNextAction;
        case "needs_review_provenance":
            return provenanceNextAction;
        case "needs_review_handoff":
            return "Complete the review handoff artifacts before applying.";
        case "ready_for_production_apply":
            return "Run the production apply command after confirming the review pack is intentional.";
    }
};

const workflowCandidateReviewCoveragePipelineCommand = (
    stage: WorkflowCandidateReviewCoveragePipelineStage,
    commands: {
        readonly reviewIssueRepairCommand: string | undefined;
        readonly reviewProvenanceStampCommand: string | undefined;
        readonly productionApplyCommand: string | undefined;
    },
): string | undefined => {
    switch (stage) {
        case "needs_review_repair":
            return commands.reviewIssueRepairCommand;
        case "needs_review_provenance":
            return commands.reviewProvenanceStampCommand;
        case "ready_for_production_apply":
            return commands.productionApplyCommand;
        case "needs_review_decisions":
        case "needs_review_handoff":
            return undefined;
    }
};

const workflowCandidateReviewCoveragePipelineCommandKind = (
    stage: WorkflowCandidateReviewCoveragePipelineStage,
    command: string | undefined,
): WorkflowCandidateReviewCoveragePipelineCommandKind | undefined => {
    if (command === undefined) return undefined;
    switch (stage) {
        case "needs_review_repair":
            return "repair_review_issues";
        case "needs_review_provenance":
            return "stamp_review_provenance";
        case "ready_for_production_apply":
            return "apply_review_facts";
        case "needs_review_decisions":
        case "needs_review_handoff":
            return undefined;
    }
};

const workflowCandidateReviewCoverageHandoffMissingPaths = (input: {
    readonly reviewFactsPath?: string;
    readonly reviewWritePlanPath?: string;
    readonly reviewBriefPath?: string;
    readonly syncedReviewBriefPath?: string;
}): WorkflowCandidateReviewCoverageHandoffMissingPath[] => {
    const missing: WorkflowCandidateReviewCoverageHandoffMissingPath[] = [];
    if (input.reviewFactsPath === undefined) missing.push("review_facts_path");
    if (input.reviewWritePlanPath === undefined) missing.push("review_write_plan_path");
    if (input.reviewBriefPath === undefined) missing.push("review_brief_path");
    if (input.syncedReviewBriefPath === undefined) missing.push("synced_review_brief_path");
    return missing;
};

const workflowCandidateReviewCoverageProductionApplyCommand = (input: {
    readonly sourcePath: string;
    readonly sourceKind?: string;
    readonly reviewFactsPath?: string;
    readonly reviewWritePlanPath?: string;
    readonly reviewBriefPath?: string;
    readonly syncedReviewBriefPath?: string;
    readonly outputPath?: string;
}): string | undefined => {
    if (
        input.reviewFactsPath === undefined ||
        input.reviewWritePlanPath === undefined ||
        input.reviewBriefPath === undefined ||
        input.syncedReviewBriefPath === undefined
    ) return undefined;
    return [
        "bun src/cli/index.ts classifiers workflow-candidates",
        "--review-coverage",
        `--source-kind=${input.sourceKind ?? "hybrid_window_classifier_projection"}`,
        `--coverage-review-pack=${input.sourcePath}`,
        `--sync-coverage-review-brief=${input.syncedReviewBriefPath}`,
        `--coverage-review-brief=${input.reviewBriefPath}`,
        `--review-facts=${input.reviewFactsPath}`,
        `--review-write-plan=${input.reviewWritePlanPath}`,
        "--apply-review-facts",
        "--require-review-provenance",
        "--require-review-handoff",
        `--out=${input.outputPath ?? ".ax/experiments/workflow-candidate-review-coverage-post-apply.json"}`,
        "--json",
    ].join(" ");
};

const workflowCandidateReviewCoverageProvenanceStampCommand = (input: {
    readonly sourcePath: string;
    readonly sourceKind?: string;
    readonly reviewBriefPath?: string;
    readonly syncedReviewBriefPath?: string;
    readonly outputPath?: string;
}): string | undefined => {
    if (input.reviewBriefPath === undefined || input.syncedReviewBriefPath === undefined) return undefined;
    return [
        "bun src/cli/index.ts classifiers workflow-candidates",
        "--review-coverage",
        `--source-kind=${input.sourceKind ?? "hybrid_window_classifier_projection"}`,
        `--coverage-review-pack=${input.sourcePath}`,
        `--sync-coverage-review-brief=${input.syncedReviewBriefPath}`,
        "--review-provenance-reviewer=<reviewer>",
        "--review-provenance-reviewed-at=<reviewed-at-iso>",
        `--coverage-review-brief=${input.reviewBriefPath}`,
        `--out=${input.outputPath ?? ".ax/experiments/workflow-candidate-review-coverage-post-apply.json"}`,
        "--json",
    ].join(" ");
};

const defaultReviewBriefPathForReviewPack = (sourcePath: string): string => {
    if (sourcePath.endsWith(".jsonl")) return sourcePath.replace(/\.jsonl$/, ".md");
    return `${sourcePath}.md`;
};

const defaultReadinessOutputPathForReviewPack = (sourcePath: string): string => {
    if (sourcePath.endsWith(".jsonl")) return sourcePath.replace(/\.jsonl$/, ".json");
    return `${sourcePath}.json`;
};

const workflowCandidateReviewCoverageReviewIssueRepairCommand = (input: {
    readonly sourcePath: string;
    readonly sourceKind?: string;
    readonly reviewBriefPath?: string;
    readonly syncedReviewBriefPath?: string;
    readonly outputPath?: string;
}): string => {
    const reviewBriefPath = input.reviewBriefPath
        ?? input.syncedReviewBriefPath
        ?? defaultReviewBriefPathForReviewPack(input.sourcePath);
    const syncedReviewBriefPath = input.syncedReviewBriefPath ?? reviewBriefPath;
    return [
        "bun src/cli/index.ts classifiers workflow-candidates",
        "--review-coverage",
        `--source-kind=${input.sourceKind ?? "hybrid_window_classifier_projection"}`,
        `--coverage-review-pack=${input.sourcePath}`,
        `--sync-coverage-review-brief=${syncedReviewBriefPath}`,
        `--coverage-review-brief=${reviewBriefPath}`,
        `--out=${input.outputPath ?? defaultReadinessOutputPathForReviewPack(input.sourcePath)}`,
        "--json",
    ].join(" ");
};

export function buildWorkflowCandidateReviewCoverageApplySummary(input: {
    readonly rows: readonly WorkflowCandidateTopicClassifierFixtureRow[];
    readonly sourcePath: string;
    readonly projection: WorkflowCandidateTopicReviewGraphProjection;
    readonly writePlan: WorkflowCandidateTopicReviewGraphWritePlan;
    readonly applyRequested: boolean;
    readonly applied: boolean;
    readonly syncedFixtureCount?: number;
    readonly unknownFixtureCount?: number;
    readonly stampedReviewerCount?: number;
    readonly stampedReviewedAtCount?: number;
    readonly coverageRows?: readonly WorkflowCandidateReviewCoverageRow[];
    readonly requireReviewProvenance?: boolean;
    readonly requireReviewHandoff?: boolean;
    readonly reviewFactsPath?: string;
    readonly reviewWritePlanPath?: string;
    readonly reviewBriefPath?: string;
    readonly syncedReviewBriefPath?: string;
    readonly sourceKind?: string;
    readonly limit?: number;
    readonly outputPath?: string;
}): WorkflowCandidateReviewCoverageApplySummary {
    const reviewedRows = input.rows.filter((row) => fixtureReviewVerdict(row) !== undefined);
    const invalidRows = input.rows.filter((row) => !VALID_VERDICTS.has(row.review_status));
    const missingRationaleRows = reviewedRows.filter((row) => (row.review_rationale ?? "").trim().length === 0);
    const missingReviewerRows = reviewedRows.filter((row) => (row.review_reviewer ?? "").trim().length === 0);
    const missingReviewedAtRows = reviewedRows.filter((row) => (row.review_reviewed_at ?? "").trim().length === 0);
    const invalidReviewedAtRows = reviewedRows.filter(hasInvalidReviewedAt);
    const provenanceStatus: WorkflowCandidateReviewCoverageProvenanceStatus =
        missingReviewerRows.length === 0 && missingReviewedAtRows.length === 0 && invalidReviewedAtRows.length === 0
            ? "complete_review_provenance"
            : "missing_review_provenance";
    const provenanceNextAction = provenanceStatus === "complete_review_provenance"
        ? "Review provenance is complete."
        : "Add reviewer and reviewed-at metadata before applying if audit provenance is required.";
    const packCandidateIds = new Set(reviewedRows.map((row) => row.candidate_id));
    const knownCandidateIds = new Set((input.coverageRows ?? []).map((row) => row.candidate_id));
    const alreadyReviewedCandidateIds = new Set((input.coverageRows ?? [])
        .filter((row) => row.review_fact_count > 0)
        .map((row) => row.candidate_id));
    let newCandidateCount = 0;
    let existingCandidateCount = 0;
    let unknownCandidateCount = 0;
    for (const candidateId of packCandidateIds) {
        if (!knownCandidateIds.has(candidateId)) {
            unknownCandidateCount += 1;
        } else if (alreadyReviewedCandidateIds.has(candidateId)) {
            existingCandidateCount += 1;
        } else {
            newCandidateCount += 1;
        }
    }
    const coverageRows = input.coverageRows ?? [];
    const currentReviewedCandidateCount = coverageRows.filter((row) => row.review_fact_count > 0).length;
    const projectedReviewedCandidateCount = currentReviewedCandidateCount + newCandidateCount;
    const projectedUnreviewedCandidateCount = Math.max(0, coverageRows.length - projectedReviewedCandidateCount);
    const reviewHandoffMissingPaths = workflowCandidateReviewCoverageHandoffMissingPaths(input);
    const productionApplyCommand = workflowCandidateReviewCoverageProductionApplyCommand({
        sourcePath: input.sourcePath,
        ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
        ...(input.reviewFactsPath === undefined ? {} : { reviewFactsPath: input.reviewFactsPath }),
        ...(input.reviewWritePlanPath === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlanPath }),
        ...(input.reviewBriefPath === undefined ? {} : { reviewBriefPath: input.reviewBriefPath }),
        ...(input.syncedReviewBriefPath === undefined ? {} : { syncedReviewBriefPath: input.syncedReviewBriefPath }),
        ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
    });
    const reviewProvenanceStampCommand = workflowCandidateReviewCoverageProvenanceStampCommand({
        sourcePath: input.sourcePath,
        ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
        ...(input.reviewBriefPath === undefined ? {} : { reviewBriefPath: input.reviewBriefPath }),
        ...(input.syncedReviewBriefPath === undefined ? {} : { syncedReviewBriefPath: input.syncedReviewBriefPath }),
        ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
    });
    const smokeMarkerCount = reviewedRows.filter(fixtureRowHasSmokeMarker).length +
        (input.sourcePath.toLowerCase().includes("smoke") ? 1 : 0);
    const baseApplyGuard = invalidRows.length > 0
        ? "invalid_review_pack"
        : reviewedRows.length === 0
        ? "no_reviewed_fixtures"
        : missingRationaleRows.length > 0
            ? "missing_review_rationale"
        : smokeMarkerCount > 0
            ? "blocked_smoke_review"
            : "ready_to_apply";
    const strictApplyGuard: WorkflowCandidateReviewCoverageApplyGuard =
        baseApplyGuard === "ready_to_apply" && provenanceStatus === "missing_review_provenance"
            ? "missing_review_provenance"
            : baseApplyGuard;
    const handoffApplyGuard: WorkflowCandidateReviewCoverageApplyGuard =
        baseApplyGuard === "ready_to_apply" && reviewHandoffMissingPaths.length > 0
            ? "missing_review_handoff"
            : baseApplyGuard;
    const provenanceApplyGuard = input.requireReviewProvenance === true ? strictApplyGuard : baseApplyGuard;
    const applyGuard: WorkflowCandidateReviewCoverageApplyGuard =
        provenanceApplyGuard === "ready_to_apply" &&
        input.requireReviewHandoff === true &&
        reviewHandoffMissingPaths.length > 0
            ? "missing_review_handoff"
            : provenanceApplyGuard;
    const productionApplyGuard: WorkflowCandidateReviewCoverageApplyGuard =
        strictApplyGuard === "ready_to_apply" && reviewHandoffMissingPaths.length > 0
            ? "missing_review_handoff"
            : strictApplyGuard;
    const canApply = applyGuard === "ready_to_apply" && input.writePlan.statements.length > 0;
    const strictCanApply = strictApplyGuard === "ready_to_apply" && input.writePlan.statements.length > 0;
    const handoffCanApply = handoffApplyGuard === "ready_to_apply" && input.writePlan.statements.length > 0;
    const productionCanApply = productionApplyGuard === "ready_to_apply" && input.writePlan.statements.length > 0;
    const applyResult = input.applied
        ? "applied"
        : input.applyRequested
            ? "blocked"
            : "not_requested";
    const baseApplyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [];
    if (invalidRows.length > 0) baseApplyBlockers.push("invalid_review_pack");
    if (reviewedRows.length === 0) baseApplyBlockers.push("no_reviewed_fixtures");
    if (missingRationaleRows.length > 0) baseApplyBlockers.push("missing_review_rationale");
    if (smokeMarkerCount > 0) baseApplyBlockers.push("blocked_smoke_review");
    if (baseApplyGuard === "ready_to_apply" && input.writePlan.statements.length === 0) {
        baseApplyBlockers.push("empty_write_plan");
    }
    const handoffApplyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [...baseApplyBlockers];
    if (baseApplyGuard === "ready_to_apply" && reviewHandoffMissingPaths.length > 0) {
        handoffApplyBlockers.push("missing_review_handoff");
    }
    const strictApplyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [...baseApplyBlockers];
    if (baseApplyGuard === "ready_to_apply" && provenanceStatus === "missing_review_provenance") {
        strictApplyBlockers.push("missing_review_provenance");
    }
    if (
        strictApplyGuard === "ready_to_apply" &&
        input.writePlan.statements.length === 0 &&
        !strictApplyBlockers.includes("empty_write_plan")
    ) {
        strictApplyBlockers.push("empty_write_plan");
    }
    const productionApplyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [...strictApplyBlockers];
    if (baseApplyGuard === "ready_to_apply" && reviewHandoffMissingPaths.length > 0) {
        productionApplyBlockers.push("missing_review_handoff");
    }
    const applyBlockers: WorkflowCandidateReviewCoverageApplyBlocker[] = [
        ...(input.requireReviewProvenance === true ? strictApplyBlockers : baseApplyBlockers),
    ];
    if (
        provenanceApplyGuard === "ready_to_apply" &&
        input.requireReviewHandoff === true &&
        reviewHandoffMissingPaths.length > 0
    ) {
        applyBlockers.push("missing_review_handoff");
    }
    const buildApplyBlockerDetails = (
        blockers: readonly WorkflowCandidateReviewCoverageApplyBlocker[],
    ): WorkflowCandidateReviewCoverageApplyBlockerDetail[] => blockers.map((blocker) => {
        switch (blocker) {
            case "invalid_review_pack":
                return { blocker, count: invalidRows.length, remediation: workflowCandidateReviewCoverageBlockerRemediation(blocker) };
            case "no_reviewed_fixtures":
                return { blocker, count: input.rows.length, remediation: workflowCandidateReviewCoverageBlockerRemediation(blocker) };
            case "missing_review_rationale":
                return { blocker, count: missingRationaleRows.length, remediation: workflowCandidateReviewCoverageBlockerRemediation(blocker) };
            case "missing_review_provenance":
                return { blocker, count: missingReviewerRows.length + missingReviewedAtRows.length + invalidReviewedAtRows.length, remediation: workflowCandidateReviewCoverageBlockerRemediation(blocker) };
            case "missing_review_handoff":
                return { blocker, count: reviewHandoffMissingPaths.length, remediation: workflowCandidateReviewCoverageBlockerRemediation(blocker) };
            case "blocked_smoke_review":
                return { blocker, count: smokeMarkerCount, remediation: workflowCandidateReviewCoverageBlockerRemediation(blocker) };
            case "empty_write_plan":
                return { blocker, count: 1, remediation: workflowCandidateReviewCoverageBlockerRemediation(blocker) };
        }
    });
    const applyBlockerDetails = buildApplyBlockerDetails(applyBlockers);
    const handoffApplyBlockerDetails = buildApplyBlockerDetails(handoffApplyBlockers);
    const strictApplyBlockerDetails = buildApplyBlockerDetails(strictApplyBlockers);
    const productionApplyBlockerDetails = buildApplyBlockerDetails(productionApplyBlockers);
    const factIdByFixtureId = new Map<string, string>();
    for (const fact of input.projection.facts) {
        const fixtureId = fact.properties.fixture_id;
        if (typeof fixtureId === "string" && fixtureId.length > 0) {
            factIdByFixtureId.set(fixtureId, fact.id);
        }
    }
    const applyAuditRows: WorkflowCandidateReviewCoverageApplyAuditRow[] = reviewedRows.flatMap((row) => {
        const verdict = fixtureReviewVerdict(row);
        if (verdict === undefined) return [];
        return [{
            fixture_id: row.id,
            candidate_id: row.candidate_id,
            verdict,
            projected_fact_id: factIdByFixtureId.get(row.id) ?? null,
            reviewer: row.review_reviewer ?? "",
            reviewed_at: row.review_reviewed_at ?? "",
        }];
    });
    const provenanceIssueRows = workflowCandidateReviewCoverageProvenanceIssueRows(reviewedRows);
    const reviewIssueRows = workflowCandidateReviewCoverageReviewIssueRows(input.rows);
    const reviewIssueCounts = workflowCandidateReviewCoverageReviewIssueCounts(reviewIssueRows);
    const reviewIssueScopeCounts = workflowCandidateReviewCoverageReviewIssueScopeCounts(reviewIssueRows);
    const reviewIssueScopeFixtureCounts = workflowCandidateReviewCoverageReviewIssueScopeDistinctCounts(reviewIssueRows, (row) => row.fixture_id);
    const reviewIssueScopeCandidateCounts = workflowCandidateReviewCoverageReviewIssueScopeDistinctCounts(reviewIssueRows, (row) => row.candidate_id);
    const reviewIssueScopeSummaries = workflowCandidateReviewCoverageReviewIssueScopeSummaries(reviewIssueRows);
    const reviewIssueFixtureCount = workflowCandidateReviewCoverageReviewIssueFixtureCount(reviewIssueRows);
    const reviewIssueCandidateCount = workflowCandidateReviewCoverageReviewIssueCandidateCount(reviewIssueRows);
    const reviewIssueStatus = workflowCandidateReviewCoverageReviewIssueStatus(reviewIssueRows);
    const reviewIssueNextAction = workflowCandidateReviewCoverageReviewIssueNextAction(reviewIssueStatus);
    const reviewPipelineStage = workflowCandidateReviewCoveragePipelineStage({
        reviewed_fixture_count: reviewedRows.length,
        apply_guard: applyGuard,
        provenance_status: provenanceStatus,
        handoff_apply_guard: handoffApplyGuard,
        production_can_apply: productionCanApply,
    });
    const reviewPipelineNextAction = workflowCandidateReviewCoveragePipelineNextAction(
        reviewPipelineStage,
        reviewIssueNextAction,
        provenanceNextAction,
    );
    const reviewIssueRepairCommand = reviewIssueRows.length === 0
        ? undefined
        : workflowCandidateReviewCoverageReviewIssueRepairCommand({
            sourcePath: input.sourcePath,
            ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
            ...(input.reviewBriefPath === undefined ? {} : { reviewBriefPath: input.reviewBriefPath }),
            ...(input.syncedReviewBriefPath === undefined ? {} : { syncedReviewBriefPath: input.syncedReviewBriefPath }),
            ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
        });
    const reviewPipelineCommand = workflowCandidateReviewCoveragePipelineCommand(reviewPipelineStage, {
        reviewIssueRepairCommand,
        reviewProvenanceStampCommand,
        productionApplyCommand,
    });
    const reviewPipelineCommandKind = workflowCandidateReviewCoveragePipelineCommandKind(reviewPipelineStage, reviewPipelineCommand);
    return {
        schema: "ax.workflow_candidate_review_readiness.v1",
        source_path: input.sourcePath,
        ...(input.reviewFactsPath === undefined ? {} : { review_facts_path: input.reviewFactsPath }),
        ...(input.reviewWritePlanPath === undefined ? {} : { review_write_plan_path: input.reviewWritePlanPath }),
        ...(input.reviewBriefPath === undefined ? {} : { review_brief_path: input.reviewBriefPath }),
        ...(input.syncedReviewBriefPath === undefined ? {} : { synced_review_brief_path: input.syncedReviewBriefPath }),
        review_handoff_status: reviewHandoffMissingPaths.length === 0
            ? "complete_review_handoff"
            : "incomplete_review_handoff",
        review_handoff_missing_paths: reviewHandoffMissingPaths,
        handoff_apply_guard: handoffApplyGuard,
        handoff_can_apply: handoffCanApply,
        handoff_apply_blockers: handoffApplyBlockers,
        handoff_apply_blocker_details: handoffApplyBlockerDetails,
        apply_requested: input.applyRequested,
        applied: input.applied,
        apply_result: applyResult,
        applied_statement_count: input.applied ? input.writePlan.totals.statement_count : 0,
        reviewed_fixture_count: reviewedRows.length,
        pending_fixture_count: input.rows.length - reviewedRows.length,
        invalid_fixture_count: invalidRows.length,
        missing_rationale_count: missingRationaleRows.length,
        missing_reviewer_count: missingReviewerRows.length,
        missing_reviewed_at_count: missingReviewedAtRows.length,
        invalid_reviewed_at_count: invalidReviewedAtRows.length,
        provenance_status: provenanceStatus,
        provenance_next_action: provenanceNextAction,
        synced_fixture_count: input.syncedFixtureCount ?? 0,
        unknown_fixture_count: input.unknownFixtureCount ?? 0,
        stamped_reviewer_count: input.stampedReviewerCount ?? 0,
        stamped_reviewed_at_count: input.stampedReviewedAtCount ?? 0,
        pack_candidate_count: packCandidateIds.size,
        new_candidate_count: newCandidateCount,
        existing_candidate_count: existingCandidateCount,
        unknown_candidate_count: unknownCandidateCount,
        projected_reviewed_candidate_count: projectedReviewedCandidateCount,
        projected_unreviewed_candidate_count: projectedUnreviewedCandidateCount,
        smoke_marker_count: smokeMarkerCount,
        apply_guard: applyGuard,
        can_apply: canApply,
        apply_blockers: applyBlockers,
        apply_blocker_details: applyBlockerDetails,
        strict_apply_guard: strictApplyGuard,
        strict_can_apply: strictCanApply,
        strict_apply_blockers: strictApplyBlockers,
        strict_apply_blocker_details: strictApplyBlockerDetails,
        production_apply_guard: productionApplyGuard,
        production_can_apply: productionCanApply,
        production_apply_blockers: productionApplyBlockers,
        production_apply_blocker_details: productionApplyBlockerDetails,
        production_next_action: workflowCandidateReviewCoverageGuardNextAction(productionApplyGuard),
        ...(productionApplyCommand === undefined ? {} : { production_apply_command: productionApplyCommand }),
        ...(reviewProvenanceStampCommand === undefined ? {} : { review_provenance_stamp_command: reviewProvenanceStampCommand }),
        next_action: workflowCandidateReviewCoverageGuardNextAction(applyGuard),
        post_apply_recheck_command: workflowCandidateReviewCoverageRecheckCommand({
            ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
        }),
        reviewed_fixture_ids: reviewedRows.map((row) => row.id),
        projected_fact_ids: input.projection.facts.map((fact) => fact.id),
        apply_audit_rows: applyAuditRows,
        review_issue_rows: reviewIssueRows,
        review_issue_counts: reviewIssueCounts,
        review_issue_scope_counts: reviewIssueScopeCounts,
        review_issue_scope_fixture_counts: reviewIssueScopeFixtureCounts,
        review_issue_scope_candidate_counts: reviewIssueScopeCandidateCounts,
        review_issue_scope_summaries: reviewIssueScopeSummaries,
        review_issue_fixture_count: reviewIssueFixtureCount,
        review_issue_candidate_count: reviewIssueCandidateCount,
        review_issue_status: reviewIssueStatus,
        review_issue_next_action: reviewIssueNextAction,
        ...(reviewIssueRepairCommand === undefined ? {} : { review_issue_repair_command: reviewIssueRepairCommand }),
        review_pipeline_stage: reviewPipelineStage,
        review_pipeline_next_action: reviewPipelineNextAction,
        ...(reviewPipelineCommandKind === undefined ? {} : { review_pipeline_command_kind: reviewPipelineCommandKind }),
        ...(reviewPipelineCommand === undefined ? {} : { review_pipeline_command: reviewPipelineCommand }),
        provenance_issue_rows: provenanceIssueRows,
        projection_totals: input.projection.totals,
        write_plan_totals: input.writePlan.totals,
    };
}

export function buildWorkflowCandidateTopicReviewGraphWritePlan(
    projection: WorkflowCandidateTopicReviewGraphProjection,
): WorkflowCandidateTopicReviewGraphWritePlan {
    const sourceKind = "workflow_topic_candidate_review";
    const nodeStatements = projection.nodes.map((node) =>
        `UPSERT ${recordRef("classifier_graph_node", node.id)} CONTENT ${surrealObject([
            ["graph_id", surrealString(node.id)],
            ["kind", surrealString(node.kind)],
            ["label", surrealString(node.label)],
            ["properties_json", surrealJson(node.properties)],
            ["source_kind", surrealString(sourceKind)],
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
            ["source_kind", surrealString(sourceKind)],
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
            ["value_json", surrealJsonTextOption(fact.value)],
            ["evidence_edges_json", surrealJsonText(fact.evidence_edges)],
            ["properties_json", surrealJson(fact.properties)],
            ["source_kind", surrealString(sourceKind)],
            ["updated_at", "time::now()"],
        ])};`
    );
    const statements = [...nodeStatements, ...edgeStatements, ...factStatements];
    return {
        schema: "ax.workflow_topic_review_graph_write_plan.v1",
        source_projection_schema: projection.schema,
        topic: projection.topic,
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

export function buildWorkflowCandidateTopicHarnessGraphListReport(input: {
    readonly topic?: string;
    readonly facts: readonly WorkflowCandidateTopicHarnessGraphFactRow[];
    readonly edges: readonly WorkflowCandidateTopicHarnessGraphEdgeRow[];
}): WorkflowCandidateTopicHarnessGraphListReport {
    return {
        schema: "ax.workflow_topic_harness_graph_list.v1",
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        facts: input.facts,
        edges: input.edges,
        totals: {
            fact_count: input.facts.length,
            edge_count: input.edges.length,
            passed_count: input.facts.filter((fact) => fact.predicate === "passed").length,
            failed_count: input.facts.filter((fact) => fact.predicate === "failed").length,
        },
    };
}

export function buildWorkflowCandidateTopicReviewGraphListReport(input: {
    readonly topic?: string;
    readonly facts: readonly WorkflowCandidateTopicHarnessGraphFactRow[];
    readonly edges: readonly WorkflowCandidateTopicHarnessGraphEdgeRow[];
}): WorkflowCandidateTopicReviewGraphListReport {
    return {
        schema: "ax.workflow_topic_review_graph_list.v1",
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        facts: input.facts,
        edges: input.edges,
        totals: {
            fact_count: input.facts.length,
            edge_count: input.edges.length,
            rejected_count: input.facts.filter((fact) => fact.predicate === "reject").length,
            accepted_count: input.facts.filter((fact) => fact.predicate === "accept").length,
            deferred_count: input.facts.filter((fact) => fact.predicate === "defer").length,
            revised_count: input.facts.filter((fact) => fact.predicate === "revise").length,
        },
    };
}

export function renderWorkflowCandidateTopicHarnessGraphListText(
    report: WorkflowCandidateTopicHarnessGraphListReport,
): string {
    const lines = [
        "workflow topic harness graph facts",
        `topic: ${report.topic ?? "all"}`,
        `facts: ${report.totals.fact_count}`,
        `edges: ${report.totals.edge_count}`,
        `passed: ${report.totals.passed_count}`,
        `failed: ${report.totals.failed_count}`,
        "",
        "facts:",
    ];
    if (report.facts.length === 0) lines.push("  (none)");
    for (const fact of report.facts) {
        lines.push(
            `  - ${fact.predicate ?? "unknown"} ${fact.graph_id ?? "unknown-fact"}`,
            `    subject: ${fact.subject ?? "unknown-subject"}`,
            `    object: ${fact.object ?? "unknown-object"}`,
        );
    }
    return lines.join("\n");
}

export function buildWorkflowCandidateTopicTaskDrafts(
    report: WorkflowCandidateTopicReport,
    taskDir: string,
): { readonly summary: WorkflowCandidateTopicTaskSummary; readonly drafts: readonly WorkflowCandidateTaskDraft[] } {
    const drafts = topicAdjacentCandidates(report).map((candidate): WorkflowCandidateTaskDraft => {
        const recommendation = recommendWorkflowCandidatePromotionArtifact([candidate], report.candidates);
        const path = taskPathForCandidate(taskDir, candidate);
        return {
            path,
            content: renderWorkflowCandidateTaskMarkdown(candidate, report.candidates),
            task: {
                candidate_id: candidate.group_id,
                label: candidate.label,
                verdict: "pending",
                recommended_artifact: recommendation,
                path,
            },
        };
    });
    return {
        summary: {
            task_dir: taskDir,
            emitted_task_count: drafts.length,
            tasks: drafts.map((draft) => draft.task),
        },
        drafts,
    };
}

const classifierFixtureIdForExample = (
    report: WorkflowCandidateTopicReport,
    candidate: WorkflowCandidate,
    example: WorkflowCandidateExample,
): string => {
    const evidenceKey = [
        candidate.group_id,
        typeof example.result_id === "string" ? example.result_id : "",
        typeof example.turn === "string" ? example.turn : "",
        example.text_excerpt,
    ].join("|");
    return [
        "workflow-candidate-topic",
        safeKeyPart(report.topic.toLowerCase()) || "unknown-topic",
        safeKeyPart(candidate.label).slice(0, 64) || "candidate",
        shortHash(evidenceKey),
    ].join("/");
};

const classifierFixtureTextForExample = (example: WorkflowCandidateExample): string =>
    `USER:\n${example.text_excerpt.trim()}\n\nPREVIOUS_ASSISTANT:\n`;

const classifierFixtureNameForCandidate = (
    report: WorkflowCandidateTopicReport,
    candidate: WorkflowCandidate,
    index: number,
): string => [
    safeKeyPart(report.topic.toLowerCase()) || "unknown-topic",
    safeKeyPart(candidate.label).slice(0, 48) || "candidate",
    String(index + 1).padStart(2, "0"),
].join("-");

export function buildWorkflowCandidateTopicClassifierFixtureRows(
    report: WorkflowCandidateTopicReport,
): readonly WorkflowCandidateTopicClassifierFixtureRow[] {
    const rows: WorkflowCandidateTopicClassifierFixtureRow[] = [];
    const fixtureCandidates = topicAdjacentCandidates(report)
        .map((candidate) => ({
            candidate,
            recommendation: recommendWorkflowCandidatePromotionArtifact([candidate], report.candidates),
        }))
        .filter(({ recommendation }) => recommendation.primary === "classifier_fixture");

    for (const { candidate } of fixtureCandidates) {
        candidate.examples.forEach((example, index) => {
            const resultId = typeof example.result_id === "string" && example.result_id.length > 0
                ? example.result_id
                : undefined;
            const turn = typeof example.turn === "string" && example.turn.length > 0 ? example.turn : undefined;
            const confidence = typeof example.confidence === "number" ? example.confidence : undefined;
            rows.push({
                id: classifierFixtureIdForExample(report, candidate, example),
                suite: "workflow-candidate-topic",
                name: classifierFixtureNameForCandidate(report, candidate, index),
                label: String(candidate.classifier_label ?? "none"),
                target: String(candidate.target ?? "unknown"),
                text: classifierFixtureTextForExample(example),
                source_group: "workflow-candidate",
                review_status: "pending",
                topic: report.topic,
                candidate_id: candidate.group_id,
                candidate_label: candidate.label,
                proposed_action: candidate.proposed_action,
                candidate_support_count: candidate.support_count,
                candidate_evidence_count: candidate.evidence_count,
                candidate_score: candidate.score,
                ...(resultId === undefined ? {} : { result_id: resultId }),
                ...(turn === undefined ? {} : { turn }),
                ...(confidence === undefined ? {} : { confidence }),
            });
        });
    }
    return rows;
}

export function buildWorkflowCandidateTopicClassifierFixtureSummary(
    report: WorkflowCandidateTopicReport,
    path: string,
): WorkflowCandidateTopicClassifierFixtureSummary {
    const fixtureCandidates = topicAdjacentCandidates(report)
        .map((candidate) => ({
            candidate,
            recommendation: recommendWorkflowCandidatePromotionArtifact([candidate], report.candidates),
        }));
    const rows = buildWorkflowCandidateTopicClassifierFixtureRows(report);
    const candidateCount = fixtureCandidates.filter(({ recommendation }) =>
        recommendation.primary === "classifier_fixture"
    ).length;
    return {
        path,
        emitted_fixture_count: rows.length,
        candidate_count: candidateCount,
        skipped_candidate_count: Math.max(0, fixtureCandidates.length - candidateCount),
        fixtures: rows,
    };
}

export function buildWorkflowCandidateReviewCoverageFixtureRows(
    report: WorkflowCandidateReport,
): readonly WorkflowCandidateTopicClassifierFixtureRow[] {
    const rows: WorkflowCandidateTopicClassifierFixtureRow[] = [];
    for (const candidate of report.candidates) {
        if ((candidate.persisted_review_facts?.length ?? 0) > 0) continue;
        candidate.examples.forEach((example, index) => {
            const resultId = typeof example.result_id === "string" && example.result_id.length > 0
                ? example.result_id
                : undefined;
            const turn = typeof example.turn === "string" && example.turn.length > 0 ? example.turn : undefined;
            const confidence = typeof example.confidence === "number" ? example.confidence : undefined;
            rows.push({
                id: [
                    "workflow-candidate-review-coverage",
                    safeKeyPart(candidate.label).slice(0, 64) || "candidate",
                    graphKeyWithHash(`${candidate.group_id}:${String(example.result_id ?? example.turn ?? index)}`),
                ].join("/"),
                suite: "workflow-candidate-review-coverage",
                name: [
                    "coverage-gap",
                    safeKeyPart(candidate.label).slice(0, 48) || "candidate",
                    String(index + 1).padStart(2, "0"),
                ].join("-"),
                label: String(candidate.classifier_label ?? candidate.label),
                target: String(candidate.target ?? "unknown"),
                text: classifierFixtureTextForExample(example),
                source_group: "workflow-candidate",
                review_status: "pending",
                topic: "review-coverage",
                candidate_id: candidate.group_id,
                candidate_label: candidate.label,
                proposed_action: candidate.proposed_action,
                candidate_support_count: candidate.support_count,
                candidate_evidence_count: candidate.evidence_count,
                candidate_score: candidate.score,
                ...(resultId === undefined ? {} : { result_id: resultId }),
                ...(turn === undefined ? {} : { turn }),
                ...(confidence === undefined ? {} : { confidence }),
            });
        });
    }
    return rows;
}

export function buildWorkflowCandidateReviewCoverageFixtureSummary(
    report: WorkflowCandidateReport,
    path: string,
): WorkflowCandidateReviewCoverageFixtureSummary {
    const gapCandidates = report.candidates.filter((candidate) =>
        (candidate.persisted_review_facts?.length ?? 0) === 0 && candidate.examples.length > 0
    );
    const rows = buildWorkflowCandidateReviewCoverageFixtureRows(report);
    return {
        path,
        emitted_fixture_count: rows.length,
        candidate_count: gapCandidates.length,
        skipped_candidate_count: Math.max(0, report.candidates.length - gapCandidates.length),
        fixtures: rows,
    };
}

const renderClassifierFixtureRowsJsonl = (
    rows: readonly WorkflowCandidateTopicClassifierFixtureRow[],
): string => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");

const workflowCandidateHarnessProposalSig = (candidate: WorkflowCandidate, topic: string): string =>
    `${WORKFLOW_CANDIDATE_HARNESS_PROPOSAL_PREFIX}${Bun.hash([
        topic,
        candidate.label,
        candidate.group_id,
    ].join("|")).toString(16).slice(0, 16)}`;

const workflowCandidateHarnessProposalTitle = (candidate: WorkflowCandidate, topic: string): string =>
    topic.trim().length > 0
        ? `Require ${String(candidate.target ?? "workflow")} evidence for ${topic}`
        : `Harness check for ${candidate.label}`;

export function buildWorkflowCandidateHarnessProposalPlan(
    report: WorkflowCandidateTopicReport,
    existingSigs: ReadonlySet<string>,
    opts: {
        readonly dryRun?: boolean;
        readonly includeStatements?: boolean;
    } = {},
): { readonly summary: WorkflowCandidateHarnessProposalSummary; readonly statements: readonly string[] } {
    const proposals: WorkflowCandidateHarnessProposal[] = [];
    const statements: string[] = [];
    let skipped = 0;
    const harnessCandidates = topicAdjacentCandidates(report)
        .map((candidate) => ({
            candidate,
            recommendation: recommendWorkflowCandidatePromotionArtifact([candidate], report.candidates),
        }))
        .filter(({ recommendation }) => recommendation.primary === "harness_check");

    for (const { candidate, recommendation } of harnessCandidates) {
        const sig = workflowCandidateHarnessProposalSig(candidate, report.topic);
        const title = workflowCandidateHarnessProposalTitle(candidate, report.topic);
        const proposalKey = `harness_check__${safeKeyPart(title).slice(0, 60)}__${sig.slice(-12)}`;
        const proposalRef = recordRef("proposal", proposalKey);
        const existing = existingSigs.has(sig);
        const baseline = prettyPrint({
            source: "workflow_topic_report",
            topic: report.topic,
            candidate_id: candidate.group_id,
            recommendation,
            examples: candidate.examples,
        });
        const hypothesis = [
            recommendation.rationale,
            `Evidence-backed workflow candidate: ${candidate.label}.`,
            "The check should fail when the agent stops before producing applied classifier result evidence.",
        ].join(" ");

        if (existing) {
            statements.push(
                `UPDATE ${proposalRef} SET ${[
                    ["title", surrealString(title)],
                    ["hypothesis", surrealString(hypothesis)],
                    ["frequency", String(Math.max(1, candidate.support_count))],
                    ["confidence", surrealString(recommendation.confidence)],
                    ["updated_at", "time::now()"],
                ].map(([name, value]) => `${name} = ${value}`).join(", ")};`,
            );
        } else {
            statements.push(
                `CREATE ${proposalRef} CONTENT ${surrealObject([
                    ["form", surrealString("harness_check")],
                    ["title", surrealString(title)],
                    ["hypothesis", surrealString(hypothesis)],
                    ["dedupe_sig", surrealString(sig)],
                    ["frequency", String(Math.max(1, candidate.support_count))],
                    ["confidence", surrealString(recommendation.confidence)],
                    ["status", surrealString("open")],
                    ["baseline", surrealOptionString(baseline)],
                    ["updated_at", "time::now()"],
                ])};`,
            );
        }

        const candidateKey = safeKeyPart(candidate.group_id);
        const edgeKey = `${proposalKey}__${candidateKey}`;
        statements.push(
            `DELETE ${recordRef("cites_evidence", edgeKey)};`,
            `RELATE ${proposalRef}->cites_evidence:\`${edgeKey}\`->${recordRef("classifier_graph_node", candidate.group_id)} SET count = ${Math.max(1, candidate.support_count)}, kind = "workflow_candidate", ts = time::now();`,
        );
        proposals.push({
            candidate_id: candidate.group_id,
            proposal_id: `proposal:${proposalKey}`,
            dedupe_sig: sig,
            title,
            recommended_artifact: recommendation,
            status: "created_or_refreshed",
        });
    }

    for (const candidate of topicAdjacentCandidates(report)) {
        const recommendation = recommendWorkflowCandidatePromotionArtifact([candidate], report.candidates);
        if (recommendation.primary === "harness_check") continue;
        skipped += 1;
        proposals.push({
            candidate_id: candidate.group_id,
            proposal_id: "",
            dedupe_sig: "",
            title: candidate.label,
            recommended_artifact: recommendation,
            status: "skipped",
            reason: `recommended artifact is ${recommendation.primary}`,
        });
    }

    return {
        summary: {
            dry_run: opts.dryRun ?? false,
            emitted_proposal_count: proposals.filter((proposal) => proposal.status === "created_or_refreshed").length,
            skipped_proposal_count: skipped,
            statement_count: statements.length,
            ...(opts.includeStatements ? { statements } : {}),
            proposals,
            failures: [],
        },
        statements,
    };
}

export function renderWorkflowCandidateTopicEvidencePackMarkdown(report: WorkflowCandidateTopicReport): string {
    const adjacentCandidates = topicAdjacentCandidates(report);
    const harnessEvidence = buildWorkflowCandidateTopicHarnessEvidenceSummary(report);
    const helperExplanationsByCandidate = new Map<string, WorkflowCandidateTopicHelperExplanation[]>();
    for (const explanation of report.helper_explanations?.explanations ?? []) {
        helperExplanationsByCandidate.set(explanation.candidate_id, [
            ...(helperExplanationsByCandidate.get(explanation.candidate_id) ?? []),
            explanation,
        ]);
    }
    const lines = [
        `# Workflow Topic Evidence Pack: ${report.topic || "unknown-topic"}`,
        "",
        "## Query",
        "",
        `- Source kind: \`${report.source_kind}\``,
        `- Decision: \`${report.decision}\``,
        `- Proposal count: \`${report.totals.proposal_count}\``,
        `- Experiment count: \`${report.totals.experiment_count}\``,
        `- Ranked candidate count: \`${report.totals.ranked_candidate_count}\``,
        `- Adjacent unpromoted candidate count: \`${adjacentCandidates.length}\``,
        ...(report.adjacent_tasks ? [
            `- Adjacent task count: \`${report.adjacent_tasks.emitted_task_count}\``,
            `- Adjacent task dir: \`${report.adjacent_tasks.task_dir}\``,
        ] : []),
        ...(report.classifier_fixtures ? [
            `- Classifier fixture pack: \`${report.classifier_fixtures.path}\``,
            `- Classifier fixtures: \`${report.classifier_fixtures.emitted_fixture_count}\``,
            `- Classifier fixture candidates: \`${report.classifier_fixtures.candidate_count} emitted, ${report.classifier_fixtures.skipped_candidate_count} skipped\``,
        ] : []),
        ...(report.harness_proposals ? [
            `- Harness proposal count: \`${report.harness_proposals.emitted_proposal_count}\``,
            `- Harness proposal writes: \`${report.harness_proposals.dry_run ? "dry-run" : "executed"}\``,
        ] : []),
        ...(report.harness_checks ? [
            `- Harness checks: \`${report.harness_checks.passed_count} passed, ${report.harness_checks.failed_count} failed\``,
        ] : []),
        ...(report.persisted_harness_facts ? [
            `- Persisted harness facts: \`${report.persisted_harness_facts.totals.fact_count}\``,
            `- Persisted harness status: \`${report.persisted_harness_facts.totals.passed_count} passed, ${report.persisted_harness_facts.totals.failed_count} failed\``,
        ] : []),
        ...(report.persisted_review_facts ? [
            `- Persisted review facts: \`${report.persisted_review_facts.totals.fact_count}\``,
            `- Persisted review status: \`${report.persisted_review_facts.totals.rejected_count} rejected, ${report.persisted_review_facts.totals.accepted_count} accepted, ${report.persisted_review_facts.totals.deferred_count} deferred, ${report.persisted_review_facts.totals.revised_count} revised\``,
        ] : []),
        ...(report.helper_explanations ? [
            `- Helper explanations: \`${report.helper_explanations.totals.matched_example_count}\``,
            `- Helper matched candidates: \`${report.helper_explanations.totals.matched_candidate_count}\``,
        ] : []),
        `- Source turn count: \`${report.totals.source_turn_count}\``,
        "",
        "## Harness Gate Evidence",
        "",
        `- Gate: \`${harnessEvidence.gate_satisfied ? "satisfied" : "unsatisfied"}\``,
        `- Evidence source: \`${harnessEvidence.gate_evidence_source}\``,
        `- Computed checks: \`${harnessEvidence.computed_passed_count} passed, ${harnessEvidence.computed_failed_count} failed (${harnessEvidence.computed_check_count} checks)\``,
        `- Persisted facts: \`${harnessEvidence.persisted_passed_count} passed, ${harnessEvidence.persisted_failed_count} failed (${harnessEvidence.persisted_fact_count} facts)\``,
        "",
        "## Existing Proposal Coverage",
        "",
    ];
    if (report.proposals.proposals.length === 0) {
        lines.push("- No workflow-candidate proposals matched this topic.", "");
    }
    for (const proposal of report.proposals.proposals) {
        lines.push(
            `- Proposal: \`${proposal.dedupe_sig}\``,
            `  - Status: \`${proposal.status}\``,
            `  - Title: ${proposal.title}`,
            `  - Target: \`${proposal.target ?? "unknown"}${proposal.section ? `#${proposal.section}` : ""}\``,
            `  - Experiment: \`${proposal.experiment_status ?? "none"}${proposal.experiment_id ? ` (${proposal.experiment_id})` : ""}\``,
        );
        for (const evidence of proposal.evidence ?? []) {
            lines.push(`  - Covers: \`${evidence.candidate_label}\` (${evidence.examples.length} examples)`);
        }
    }
    lines.push(
        "",
        "## Adjacent Candidates To Review",
        "",
        "These ranked candidates matched the topic but are not cited by the matched workflow-candidate proposals.",
        "",
    );
    if (adjacentCandidates.length === 0) {
        lines.push("- No adjacent unpromoted candidates found.", "");
    }
    for (const candidate of adjacentCandidates) {
        const recommendation = recommendWorkflowCandidatePromotionArtifact([candidate], report.candidates);
        lines.push(
            `### ${candidate.label}`,
            "",
            `- Candidate id: \`${candidate.group_id}\``,
            `- Proposed action: \`${candidate.proposed_action}\``,
            `- Classifier: \`${String(candidate.classifier_key ?? "unknown")}\``,
            `- Target: \`${String(candidate.target ?? "unknown")}\``,
            `- Score: \`${candidate.score}\``,
            `- Support: \`${candidate.support_count}\``,
            `- Evidence facts: \`${candidate.evidence_count}\``,
            `- Average confidence: \`${candidate.average_confidence}\``,
            `- Recommended artifact: \`${recommendation.primary}\``,
            `- Alternatives: \`${recommendation.alternatives.join("`, `")}\``,
            `- Recommendation confidence: \`${recommendation.confidence}\``,
            `- Recommendation rationale: ${recommendation.rationale}`,
        );
        const helperExplanations = helperExplanationsByCandidate.get(candidate.group_id) ?? [];
        const noneHelperExplanations = helperExplanations.filter((explanation) => explanation.proposed_label === "none");
        if (noneHelperExplanations.length > 0) {
            const first = noneHelperExplanations[0];
            lines.push(
                "- Helper review hint: `review-as-noise`",
                `- Helper matched controls: \`${noneHelperExplanations.length}\``,
                `- Helper rationale: promoted \`none\` control \`${first.source_fixture_id}\` matched this candidate example`,
                "- Suggested reviewer verdict: `reject`",
            );
        }
        lines.push(
            "",
            "Review checklist:",
            "",
            "- Verdict: `pending`",
            "- Rationale: _pending_",
            "- Next artifact: _pending_",
            "",
            "Examples:",
            "",
        );
        for (const example of candidate.examples) {
            lines.push(
                `- Turn: \`${typeof example.turn === "string" ? example.turn : "unknown-turn"}\``,
                `  - Result: \`${String(example.result_id ?? "unknown-result")}\``,
                `  - Confidence: \`${typeof example.confidence === "number" ? example.confidence : "n/a"}\``,
                `  - Text: ${example.text_excerpt}`,
            );
        }
        lines.push("");
    }
    if (report.harness_checks && report.harness_checks.checks.length > 0) {
        lines.push("## Harness Checks", "");
        for (const check of report.harness_checks.checks) {
            lines.push(
                `### ${check.id}`,
                "",
                `- Status: \`${check.status}\``,
                `- Candidate: \`${check.label}\``,
                `- Expectation: ${check.expectation}`,
            );
            for (const ref of check.evidence_refs) lines.push(`- Evidence: \`${ref}\``);
            for (const failure of check.failures) lines.push(`- Failure: ${failure}`);
            lines.push("");
        }
    }
    if (report.persisted_harness_facts && report.persisted_harness_facts.facts.length > 0) {
        lines.push("## Persisted Harness Facts", "");
        for (const fact of report.persisted_harness_facts.facts) {
            lines.push(
                `### ${fact.graph_id ?? "unknown-fact"}`,
                "",
                `- Predicate: \`${fact.predicate ?? "unknown"}\``,
                `- Subject: \`${fact.subject ?? "unknown-subject"}\``,
                `- Object: \`${fact.object ?? "unknown-object"}\``,
            );
            const props = parseProperties(fact.properties_json);
            if (typeof props.candidate_id === "string" && props.candidate_id.length > 0) {
                lines.push(`- Candidate id: \`${props.candidate_id}\``);
            }
            if (typeof fact.value_json === "string" && fact.value_json.length > 0) {
                lines.push(`- Value: \`${fact.value_json}\``);
            }
            lines.push("");
        }
    }
    if (report.persisted_review_facts && report.persisted_review_facts.facts.length > 0) {
        lines.push("## Persisted Review Facts", "");
        for (const fact of report.persisted_review_facts.facts) {
            lines.push(
                `### ${fact.graph_id ?? "unknown-fact"}`,
                "",
                `- Predicate: \`${fact.predicate ?? "unknown"}\``,
                `- Subject: \`${fact.subject ?? "unknown-subject"}\``,
                `- Object: \`${fact.object ?? "unknown-object"}\``,
            );
            const props = parseProperties(fact.properties_json);
            if (typeof props.candidate_id === "string" && props.candidate_id.length > 0) {
                lines.push(`- Candidate id: \`${props.candidate_id}\``);
            }
            if (typeof props.rationale === "string" && props.rationale.length > 0) {
                lines.push(`- Rationale: ${props.rationale}`);
            }
            const helperSources = Array.isArray(props.helper_source_fixture_ids)
                ? props.helper_source_fixture_ids.filter((entry): entry is string => typeof entry === "string")
                : [];
            for (const source of helperSources) lines.push(`- Helper source fixture: \`${source}\``);
            if (typeof fact.value_json === "string" && fact.value_json.length > 0) {
                lines.push(`- Value: \`${fact.value_json}\``);
            }
            lines.push("");
        }
    }
    if (report.helper_explanations && report.helper_explanations.explanations.length > 0) {
        lines.push("## Promoted Helper Controls", "");
        for (const explanation of report.helper_explanations.explanations) {
            lines.push(
                `### ${explanation.source_fixture_id}`,
                "",
                `- Promoted fixture: \`${explanation.promoted_fixture_id ?? "unknown"}\``,
                `- Candidate: \`${explanation.candidate_label}\``,
                `- Candidate id: \`${explanation.candidate_id}\``,
                `- Proposed action: \`${explanation.proposed_action}\``,
                `- Status: \`${explanation.status ?? "unknown"}\``,
                `- Proposed helper label: \`${explanation.proposed_label ?? "unknown"}\``,
                `- Match score: \`${explanation.match_score}\``,
            );
            if (explanation.turn) lines.push(`- Turn: \`${explanation.turn}\``);
            if (explanation.result_id) lines.push(`- Result: \`${explanation.result_id}\``);
            for (const path of explanation.evidence_paths) lines.push(`- Evidence path: \`${path}\``);
            for (const neighbor of explanation.nearest_neighbors) {
                lines.push(`- Nearest reviewed fixture: \`${neighbor.fixture_id}\` sim=\`${neighbor.similarity ?? "unknown"}\``);
            }
            lines.push(`- Text: ${explanation.text_excerpt}`, "");
        }
    }
    if (report.failures.length > 0) {
        lines.push("## Failures", "");
        for (const failure of report.failures) lines.push(`- ${failure}`);
        lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

const actionReviewPrompt = (action: string): string => {
    switch (action) {
        case "add_verification_gate":
            return "Would an explicit verification gate prevent this pattern without blocking normal work?";
        case "add_context_guardrail":
            return "Would a context or artifact guardrail help the agent produce the requested result earlier?";
        case "record_guidance_or_environment_preference":
            return "Is this a durable user or environment preference worth recording as guidance?";
        case "record_approval_checkpoint":
            return "Is this approval pattern useful as a checkpoint signal, or is it just conversational noise?";
        default:
            return "Is this candidate specific, evidence-backed, and useful enough to promote?";
    }
};

export function renderWorkflowCandidateBriefMarkdown(report: WorkflowCandidateReport): string {
    const lines = [
        "# Workflow Candidate Review",
        "",
        "Review the classifier-backed candidates below and decide whether any should become an improvement proposal, task brief, guidance change, or harness check.",
        "",
        "Allowed verdicts: `accept`, `revise`, `reject`, `defer`.",
        "",
        "## Query",
        "",
        `- Source kind: \`${report.source_kind}\``,
        `- Decision: \`${report.decision}\``,
        `- Action filter: \`${report.query.action ?? "any"}\``,
        `- Classifier filter: \`${report.query.classifier ?? "any"}\``,
        `- Search: \`${report.query.search ?? "none"}\``,
        `- Task-like mode: \`${report.query.task_like}\``,
        `- Evidence facts: \`${report.totals.evidence_fact_count}\``,
        `- Considered evidence: \`${report.totals.considered_evidence_fact_count}\``,
        "",
    ];

    for (const [index, candidate] of report.candidates.entries()) {
        lines.push(
            `## Candidate ${index + 1}: ${candidate.label}`,
            "",
            `- Candidate id: \`${candidate.group_id}\``,
            `- Proposed action: \`${candidate.proposed_action}\``,
            `- Classifier: \`${String(candidate.classifier_key ?? "unknown")}\``,
            `- Target: \`${String(candidate.target ?? "unknown")}\``,
            `- Score: \`${candidate.score}\``,
            `- Support: \`${candidate.support_count}\``,
            `- Evidence facts: \`${candidate.evidence_count}\``,
            `- Average confidence: \`${candidate.average_confidence}\``,
            `- Task-like evidence: \`${candidate.task_like_count}\``,
            `- Persisted review facts: \`${candidate.persisted_review_facts?.length ?? 0}\``,
            `- Verdict: \`pending\``,
            "- Rationale: _pending_",
            "",
            "Review prompt:",
            "",
            `- ${actionReviewPrompt(candidate.proposed_action)}`,
            "",
            "Examples:",
            "",
        );
        for (const fact of candidate.persisted_review_facts ?? []) {
            lines.push(
                "- Persisted review:",
                `  - Predicate: \`${fact.predicate ?? "unknown"}\``,
                `  - Topic: \`${fact.topic ?? "unknown"}\``,
                `  - Rationale: ${fact.rationale ?? "_none_"}`,
            );
            for (const source of fact.helper_source_fixture_ids) {
                lines.push(`  - Helper source fixture: \`${source}\``);
            }
        }
        if ((candidate.persisted_review_facts?.length ?? 0) > 0) lines.push("");
        for (const example of candidate.examples) {
            lines.push(
                `- Turn: \`${typeof example.turn === "string" ? example.turn : "unknown-turn"}\``,
                `  - Result: \`${String(example.result_id ?? "unknown-result")}\``,
                `  - Confidence: \`${typeof example.confidence === "number" ? example.confidence : "n/a"}\``,
                `  - Task-like: \`${example.task_like ? "yes" : "no"}\``,
                `  - Text: ${example.text_excerpt}`,
            );
        }
        lines.push("");
    }

    if (report.failures.length > 0) {
        lines.push("## Failures", "");
        for (const failure of report.failures) lines.push(`- ${failure}`);
        lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
}

export const runClassifiersWorkflowCandidates = (input: WorkflowCandidateCommandInput) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (input.listHarnessFacts) {
            const topic = input.search?.trim();
            const topicWhere = topic && topic.length > 0
                ? `AND string::lowercase(properties_json) CONTAINS ${surrealString(topic.toLowerCase())}`
                : "";
            const result = yield* db.query<[
                WorkflowCandidateTopicHarnessGraphFactRow[],
                WorkflowCandidateTopicHarnessGraphEdgeRow[],
            ]>(`
                SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                FROM classifier_graph_fact
                WHERE kind = "workflow_topic_harness_check"
                  AND source_kind = "workflow_topic_harness_check"
                  ${topicWhere}
                ORDER BY updated_at DESC
                LIMIT ${Math.max(1, input.limit)};
                SELECT graph_id, kind, from_id, to_id, evidence_path, properties_json, type::string(updated_at) AS updated_at
                FROM classifier_graph_edge
                WHERE source_kind = "workflow_topic_harness_check"
                  ${topicWhere}
                ORDER BY updated_at DESC
                LIMIT ${Math.max(1, input.limit * 3)};
            `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            const report = buildWorkflowCandidateTopicHarnessGraphListReport({
                ...(topic === undefined ? {} : { topic }),
                facts: result?.[0] ?? [],
                edges: result?.[1] ?? [],
            });
            if (input.out) {
                mkdirSync(dirname(input.out), { recursive: true });
                writeFileSync(input.out, `${prettyPrint(report)}\n`, "utf8");
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateTopicHarnessGraphListText(report));
            return;
        }
        if (input.reviewCoverage) {
            const rows = yield* db.query<[WorkflowCandidateGroupRow[], WorkflowCandidateEvidenceRow[]]>(
                workflowCandidateSql,
                { sourceKind: input.sourceKind },
            ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            const reviewRows = yield* db.query<[WorkflowCandidateTopicHarnessGraphFactRow[]]>(`
                SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                FROM classifier_graph_fact
                WHERE kind = "workflow_topic_candidate_review"
                  AND source_kind = "workflow_topic_candidate_review"
                ORDER BY updated_at DESC
                LIMIT ${Math.max(1, input.limit * 50)};
            `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            const reviewFacts = reviewRows?.[0] ?? [];
            let report = buildWorkflowCandidateReviewCoverageReport({
                groupRows: rows[0] ?? [],
                evidenceRows: rows[1] ?? [],
                reviewFactRows: reviewFacts,
                sourceKind: input.sourceKind,
                limit: input.limit,
                ...(input.search === undefined ? {} : { search: input.search }),
            });
            if (input.coverageFixturePack) {
                const candidateReport = attachWorkflowCandidatePersistedReviewFacts(buildWorkflowCandidateReport({
                    groupRows: rows[0] ?? [],
                    evidenceRows: rows[1] ?? [],
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    examplesPerGroup: input.examples,
                    ...(input.search === undefined ? {} : { search: input.search }),
                    taskLike: input.taskLike,
                }), reviewFacts);
                const fixtureSummary = buildWorkflowCandidateReviewCoverageFixtureSummary(candidateReport, input.coverageFixturePack);
                mkdirSync(dirname(input.coverageFixturePack), { recursive: true });
                writeFileSync(input.coverageFixturePack, renderClassifierFixtureRowsJsonl(fixtureSummary.fixtures), "utf8");
                if (input.coverageReviewBrief) {
                    mkdirSync(dirname(input.coverageReviewBrief), { recursive: true });
                    writeFileSync(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(fixtureSummary.fixtures, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageFixturePack: input.coverageFixturePack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }), "utf8");
                }
                report = { ...report, fixture_pack: fixtureSummary };
            }
            if (input.coverageReviewPack) {
                let reviewedRows = parseWorkflowCandidateFixtureRowsJsonl(
                    readFileSync(input.coverageReviewPack, "utf8"),
                );
                let syncedFixtureCount = 0;
                let unknownFixtureCount = 0;
                let stampedReviewerCount = 0;
                let stampedReviewedAtCount = 0;
                if (input.syncCoverageReviewBrief) {
                    const syncResult = syncWorkflowCandidateFixtureRowsFromBriefWithSummary(
                        reviewedRows,
                        readFileSync(input.syncCoverageReviewBrief, "utf8"),
                    );
                    reviewedRows = syncResult.rows;
                    syncedFixtureCount = syncResult.synced_fixture_count;
                    unknownFixtureCount = syncResult.unknown_fixture_count;
                    writeFileSync(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows), "utf8");
                }
                if (input.reviewProvenanceReviewer !== undefined || input.reviewProvenanceReviewedAt !== undefined) {
                    const stampResult = stampWorkflowCandidateReviewProvenance(reviewedRows, {
                        ...(input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }),
                        ...(input.reviewProvenanceReviewedAt === undefined ? {} : { reviewedAt: input.reviewProvenanceReviewedAt }),
                    });
                    reviewedRows = stampResult.rows;
                    stampedReviewerCount = stampResult.stamped_reviewer_count;
                    stampedReviewedAtCount = stampResult.stamped_reviewed_at_count;
                    writeFileSync(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows), "utf8");
                }
                if (input.coverageReviewBrief) {
                    mkdirSync(dirname(input.coverageReviewBrief), { recursive: true });
                    writeFileSync(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(reviewedRows, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageReviewPack: input.coverageReviewPack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }), "utf8");
                }
                const reviewProjection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
                    rows: reviewedRows,
                    syncedFrom: input.coverageReviewPack,
                });
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts) {
                    mkdirSync(dirname(input.reviewFacts), { recursive: true });
                    writeFileSync(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`, "utf8");
                }
                if (input.reviewWritePlan) {
                    mkdirSync(dirname(input.reviewWritePlan), { recursive: true });
                    writeFileSync(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`, "utf8");
                }
                const pendingApplySummary = buildWorkflowCandidateReviewCoverageApplySummary({
                    rows: reviewedRows,
                    sourcePath: input.coverageReviewPack,
                    projection: reviewProjection,
                    writePlan: reviewWritePlan,
                    applyRequested: Boolean(input.applyReviewFacts),
                    applied: false,
                    syncedFixtureCount,
                    unknownFixtureCount,
                    stampedReviewerCount,
                    stampedReviewedAtCount,
                    ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                    ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                    ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                    ...(input.syncCoverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.syncCoverageReviewBrief }),
                    coverageRows: report.candidates,
                    ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                    ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                if (input.applyReviewFacts && pendingApplySummary.can_apply) {
                    yield* db.query(reviewWritePlan.statements.join("\n")).pipe(
                        catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                    );
                }
                const applied = Boolean(input.applyReviewFacts && pendingApplySummary.can_apply);
                let applySummary = pendingApplySummary;
                if (applied) {
                    const appliedSummary = buildWorkflowCandidateReviewCoverageApplySummary({
                        rows: reviewedRows,
                        sourcePath: input.coverageReviewPack,
                        projection: reviewProjection,
                        writePlan: reviewWritePlan,
                        applyRequested: true,
                        applied: true,
                        syncedFixtureCount,
                        unknownFixtureCount,
                        stampedReviewerCount,
                        stampedReviewedAtCount,
                        ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                        ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                        ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                        ...(input.syncCoverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.syncCoverageReviewBrief }),
                        coverageRows: report.candidates,
                        ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                        ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    });
                    const postRows = yield* db.query<[WorkflowCandidateGroupRow[], WorkflowCandidateEvidenceRow[]]>(
                        workflowCandidateSql,
                        { sourceKind: input.sourceKind },
                    ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                    const postReviewRows = yield* db.query<[WorkflowCandidateTopicHarnessGraphFactRow[]]>(`
                        SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                        FROM classifier_graph_fact
                        WHERE kind = "workflow_topic_candidate_review"
                          AND source_kind = "workflow_topic_candidate_review"
                        ORDER BY updated_at DESC
                        LIMIT ${Math.max(1, input.limit * 50)};
                    `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                    const postReport = buildWorkflowCandidateReviewCoverageReport({
                        groupRows: postRows[0] ?? [],
                        evidenceRows: postRows[1] ?? [],
                        reviewFactRows: postReviewRows?.[0] ?? [],
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        ...(input.search === undefined ? {} : { search: input.search }),
                    });
                    applySummary = {
                        ...appliedSummary,
                        post_apply_recheck: buildWorkflowCandidateReviewCoveragePostApplyRecheckSummary({
                            before: {
                                reviewedCandidateCount: report.totals.reviewed_candidate_count,
                                unreviewedCandidateCount: report.totals.unreviewed_candidate_count,
                                projectedReviewedCandidateCount: pendingApplySummary.projected_reviewed_candidate_count,
                                projectedUnreviewedCandidateCount: pendingApplySummary.projected_unreviewed_candidate_count,
                            },
                            after: {
                                reviewedCandidateCount: postReport.totals.reviewed_candidate_count,
                                unreviewedCandidateCount: postReport.totals.unreviewed_candidate_count,
                            },
                            command: appliedSummary.post_apply_recheck_command,
                        }),
                    };
                    report = postReport;
                }
                report = {
                    ...report,
                    coverage_review: applySummary,
                };
                if (input.applyReviewFacts && !pendingApplySummary.can_apply) process.exitCode = 1;
            }
            if (input.out) {
                mkdirSync(dirname(input.out), { recursive: true });
                writeFileSync(input.out, `${prettyPrint(report)}\n`, "utf8");
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateReviewCoverageText(report));
            return;
        }
        if (input.topicReport) {
            const topic = (input.search ?? "").trim();
            if (topic.length === 0) {
                const emptyCandidates = buildWorkflowCandidateReport({
                    groupRows: [],
                    evidenceRows: [],
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    examplesPerGroup: input.examples,
                    taskLike: input.taskLike,
                });
                const emptyProposals = buildWorkflowCandidateProposalListReport({
                    rows: [],
                    limit: input.limit,
                    status: input.proposalStatus ?? "all",
                    expandEvidence: true,
                });
                const report = buildWorkflowCandidateTopicReport({
                    sourceKind: input.sourceKind,
                    topic,
                    proposals: emptyProposals,
                    candidates: {
                        ...emptyCandidates,
                        failures: [...emptyCandidates.failures, "--search is required for --topic-report"],
                        decision: "needs_workflow_candidate_review",
                    },
                });
                console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateTopicReportText(report));
                process.exitCode = 1;
                return;
            }
            const status = input.proposalStatus ?? "all";
            const proposalRows = yield* db.query<[WorkflowCandidateProposalListRow[]]>(`
                SELECT
                    type::string(id) AS proposal_id,
                    dedupe_sig,
                    title,
                    form,
                    status,
                    confidence,
                    frequency,
                    (SELECT file_target FROM guidance_proposal WHERE proposal = $parent.id LIMIT 1)[0].file_target AS target,
                    (SELECT section FROM guidance_proposal WHERE proposal = $parent.id LIMIT 1)[0].section AS section,
                    type::string((SELECT id FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].id) AS experiment_id,
                    (SELECT status FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].status AS experiment_status,
                    (SELECT artifact_path FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].artifact_path AS artifact_path,
                    (SELECT task_path FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].task_path AS task_path,
                    type::string(updated_at) AS updated_at
                FROM proposal
                WHERE string::starts_with(dedupe_sig, ${surrealString(WORKFLOW_CANDIDATE_PROPOSAL_PREFIX)})
                    ${status === "all" ? "" : `AND status = ${surrealString(status)}`}
                    AND (string::lowercase(title) CONTAINS ${surrealString(topic.toLowerCase())} OR string::lowercase(hypothesis) CONTAINS ${surrealString(topic.toLowerCase())})
                ORDER BY updated_at DESC, frequency DESC
                LIMIT ${Math.max(1, input.limit)};
            `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            let proposalListRows: readonly WorkflowCandidateProposalListRow[] = proposalRows?.[0] ?? [];
            if (proposalListRows.length > 0) {
                const proposalRefs = proposalListRows
                    .map((row) => recordKeyPart(row.proposal_id, "proposal"))
                    .filter((key): key is string => key !== null)
                    .map((key) => recordRef("proposal", key));
                if (proposalRefs.length > 0) {
                    const edgeRows = yield* db.query<[WorkflowCandidateProposalEvidenceEdgeRow[]]>(`
                        SELECT type::string(in) AS proposal_id, type::string(out) AS candidate_ref
                        FROM cites_evidence
                        WHERE kind = "workflow_candidate" AND in IN [${proposalRefs.join(", ")}];
                    `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                    const edges = edgeRows?.[0] ?? [];
                    const candidateIds = [...new Set(edges
                        .map((edge) => recordKeyPart(edge.candidate_ref, "classifier_graph_node"))
                        .filter((id): id is string => id !== null))].sort();
                    if (candidateIds.length > 0) {
                        const evidenceRows = yield* db.query<[WorkflowCandidateGroupRow[], WorkflowCandidateEvidenceRow[]]>(`
                            SELECT graph_id, label, properties_json
                            FROM classifier_graph_node
                            WHERE kind = "classifier_candidate_group" AND graph_id IN [${candidateIds.map(surrealString).join(", ")}];
                            SELECT graph_id, subject, object, properties_json
                            FROM classifier_graph_fact
                            WHERE kind = "classifier_candidate_evidence" AND subject IN [${candidateIds.map(surrealString).join(", ")}]
                            ORDER BY graph_id;
                        `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                        proposalListRows = attachWorkflowCandidateProposalEvidence({
                            rows: proposalListRows,
                            edges,
                            candidateRows: evidenceRows?.[0] ?? [],
                            factRows: evidenceRows?.[1] ?? [],
                            examplesPerCandidate: input.examples,
                        });
                    }
                }
            }
            const proposalReport = buildWorkflowCandidateProposalListReport({
                rows: proposalListRows,
                limit: input.limit,
                status,
                expandEvidence: true,
                search: topic,
            });
            const candidateRows = yield* db.query<[WorkflowCandidateGroupRow[], WorkflowCandidateEvidenceRow[]]>(
                workflowCandidateSql,
                { sourceKind: input.sourceKind },
            ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            const candidateReport = buildWorkflowCandidateReport({
                groupRows: candidateRows[0] ?? [],
                evidenceRows: candidateRows[1] ?? [],
                sourceKind: input.sourceKind,
                limit: input.limit,
                examplesPerGroup: input.examples,
                ...(input.action === undefined ? {} : { action: input.action }),
                ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
                search: topic,
                taskLike: input.taskLike,
            });
            let topicReport = buildWorkflowCandidateTopicReport({
                sourceKind: input.sourceKind,
                topic,
                proposals: proposalReport,
                candidates: candidateReport,
            });
            if (input.includeHarnessFacts) {
                const topicWhere = `AND string::lowercase(properties_json) CONTAINS ${surrealString(topic.toLowerCase())}`;
                const persistedHarnessRows = yield* db.query<[
                    WorkflowCandidateTopicHarnessGraphFactRow[],
                    WorkflowCandidateTopicHarnessGraphEdgeRow[],
                ]>(`
                    SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                    FROM classifier_graph_fact
                    WHERE kind = "workflow_topic_harness_check"
                      AND source_kind = "workflow_topic_harness_check"
                      ${topicWhere}
                    ORDER BY updated_at DESC
                    LIMIT ${Math.max(1, input.limit)};
                    SELECT graph_id, kind, from_id, to_id, evidence_path, properties_json, type::string(updated_at) AS updated_at
                    FROM classifier_graph_edge
                    WHERE source_kind = "workflow_topic_harness_check"
                      ${topicWhere}
                    ORDER BY updated_at DESC
                    LIMIT ${Math.max(1, input.limit * 3)};
                `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                topicReport = withWorkflowCandidateTopicHarnessEvidence({
                    ...topicReport,
                    persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                        topic,
                        facts: persistedHarnessRows?.[0] ?? [],
                        edges: persistedHarnessRows?.[1] ?? [],
                    }),
                });
            }
            if (input.includeReviewFacts) {
                const topicWhere = `AND string::lowercase(properties_json) CONTAINS ${surrealString(topic.toLowerCase())}`;
                const persistedReviewRows = yield* db.query<[
                    WorkflowCandidateTopicHarnessGraphFactRow[],
                    WorkflowCandidateTopicHarnessGraphEdgeRow[],
                ]>(`
                    SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                    FROM classifier_graph_fact
                    WHERE kind = "workflow_topic_candidate_review"
                      AND source_kind = "workflow_topic_candidate_review"
                      ${topicWhere}
                    ORDER BY updated_at DESC
                    LIMIT ${Math.max(1, input.limit)};
                    SELECT graph_id, kind, from_id, to_id, evidence_path, properties_json, type::string(updated_at) AS updated_at
                    FROM classifier_graph_edge
                    WHERE source_kind = "workflow_topic_candidate_review"
                      ${topicWhere}
                    ORDER BY updated_at DESC
                    LIMIT ${Math.max(1, input.limit * 3)};
                `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                topicReport = {
                    ...topicReport,
                    persisted_review_facts: buildWorkflowCandidateTopicReviewGraphListReport({
                        topic,
                        facts: persistedReviewRows?.[0] ?? [],
                        edges: persistedReviewRows?.[1] ?? [],
                    }),
                };
            }
            if (input.includeHelperFacts) {
                const helperRows = yield* db.query<[
                    WorkflowCandidateEmbeddingHelperGraphFactRow[],
                    WorkflowCandidateEmbeddingHelperGraphEdgeRow[],
                ]>(`
                    SELECT graph_id, subject, predicate, object, value_json, evidence_edges_json, properties_json, type::string(updated_at) AS updated_at
                    FROM classifier_graph_fact
                    WHERE source_kind = "embedding_helper_review_projection"
                      AND kind = "embedding_helper_hard_negative_candidate"
                      AND predicate = "promoted_hard_negative_fixture"
                    ORDER BY updated_at DESC
                    LIMIT ${Math.max(1, input.limit * 5)};
                    SELECT graph_id, kind, from_id, to_id, evidence_path, properties_json, type::string(updated_at) AS updated_at
                    FROM classifier_graph_edge
                    WHERE source_kind = "embedding_helper_review_projection"
                      AND kind IN ["nearest_reviewed_fixture", "promoted_as_fixture"]
                    ORDER BY updated_at DESC
                    LIMIT ${Math.max(1, input.limit * 25)};
                `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                topicReport = {
                    ...topicReport,
                    helper_explanations: buildWorkflowCandidateTopicHelperExplanations({
                        report: topicReport,
                        facts: helperRows?.[0] ?? [],
                        edges: helperRows?.[1] ?? [],
                        fixtures: readWorkflowCandidateHelperFixtures(
                            join(process.cwd(), "packages", "ax-classifier-session-sections", "eval-fixtures", "chunks.jsonl"),
                        ),
                    }),
                };
            }
            if (input.syncBrief) {
                topicReport = syncWorkflowCandidateTopicReportFromBrief(
                    topicReport,
                    readFileSync(input.syncBrief, "utf8"),
                    input.syncBrief,
                );
            }
            if (input.emitAdjacentTasks) {
                const taskDir = input.taskDir ?? join(process.cwd(), ".ax", "tasks");
                const adjacentTasks = buildWorkflowCandidateTopicTaskDrafts(topicReport, taskDir);
                if (adjacentTasks.drafts.length > 0) mkdirSync(taskDir, { recursive: true });
                for (const draft of adjacentTasks.drafts) {
                    writeFileSync(draft.path, draft.content, "utf8");
                }
                topicReport = {
                    ...topicReport,
                    adjacent_tasks: adjacentTasks.summary,
                };
            }
            if (input.classifierFixturePack) {
                const summary = buildWorkflowCandidateTopicClassifierFixtureSummary(topicReport, input.classifierFixturePack);
                mkdirSync(dirname(input.classifierFixturePack), { recursive: true });
                writeFileSync(input.classifierFixturePack, renderClassifierFixtureRowsJsonl(summary.fixtures), "utf8");
                topicReport = {
                    ...topicReport,
                    classifier_fixtures: summary,
                };
            }
            if (input.promoteHarnessProposals) {
                const existingProposalRows = yield* db.query<[Array<{ dedupe_sig: string }>]>(
                    "SELECT dedupe_sig FROM proposal;",
                ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                const existingSigs = new Set((existingProposalRows?.[0] ?? []).map((row) => row.dedupe_sig));
                const plan = buildWorkflowCandidateHarnessProposalPlan(topicReport, existingSigs, {
                    dryRun: Boolean(input.proposalDryRun),
                    includeStatements: Boolean(input.proposalDryRun),
                });
                if (plan.statements.length > 0 && !input.proposalDryRun) {
                    yield* db.query(plan.statements.join("\n")).pipe(
                        catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                    );
                }
                topicReport = {
                    ...topicReport,
                    harness_proposals: plan.summary,
                };
            }
            if (input.out) {
                mkdirSync(dirname(input.out), { recursive: true });
                writeFileSync(input.out, `${prettyPrint(topicReport)}\n`, "utf8");
            }
            if (input.evidencePack) {
                mkdirSync(dirname(input.evidencePack), { recursive: true });
                writeFileSync(input.evidencePack, renderWorkflowCandidateTopicEvidencePackMarkdown(topicReport), "utf8");
            }
            if (input.reviewFacts || input.reviewWritePlan || input.applyReviewFacts) {
                const reviewProjection = buildWorkflowCandidateTopicReviewGraphProjection(topicReport);
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts) {
                    mkdirSync(dirname(input.reviewFacts), { recursive: true });
                    writeFileSync(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`, "utf8");
                }
                if (input.reviewWritePlan) {
                    mkdirSync(dirname(input.reviewWritePlan), { recursive: true });
                    writeFileSync(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`, "utf8");
                }
                if (input.applyReviewFacts && reviewWritePlan.statements.length > 0) {
                    yield* db.query(reviewWritePlan.statements.join("\n")).pipe(
                        catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                    );
                }
            }
            if (input.harnessFacts || input.harnessWritePlan || input.applyHarnessFacts) {
                const harnessProjection = buildWorkflowCandidateTopicHarnessGraphProjection(topicReport);
                const harnessWritePlan = buildWorkflowCandidateTopicHarnessGraphWritePlan(harnessProjection);
                if (input.harnessFacts) {
                    mkdirSync(dirname(input.harnessFacts), { recursive: true });
                    writeFileSync(input.harnessFacts, `${prettyPrint(harnessProjection)}\n`, "utf8");
                }
                if (input.harnessWritePlan) {
                    mkdirSync(dirname(input.harnessWritePlan), { recursive: true });
                    writeFileSync(input.harnessWritePlan, `${prettyPrint(harnessWritePlan)}\n`, "utf8");
                }
                if (input.applyHarnessFacts && harnessWritePlan.statements.length > 0) {
                    yield* db.query(harnessWritePlan.statements.join("\n")).pipe(
                        catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                    );
                }
            }
            console.log(input.json ? prettyPrint(topicReport) : renderWorkflowCandidateTopicReportText(topicReport));
            if (topicReport.decision !== "workflow_topic_evidence_found") process.exitCode = 1;
            if (input.requireHarnessChecks) {
                const harnessFailures = workflowCandidateTopicHarnessGateFailures(topicReport);
                if (harnessFailures.length > 0) {
                    for (const failure of harnessFailures) console.error(`harness gate failure: ${failure}`);
                    process.exitCode = 1;
                }
            }
            return;
        }
        if (input.listProposals) {
            const status = input.proposalStatus ?? "all";
            const where = [
                `string::starts_with(dedupe_sig, ${surrealString(WORKFLOW_CANDIDATE_PROPOSAL_PREFIX)})`,
                ...(status === "all" ? [] : [`status = ${surrealString(status)}`]),
                ...(input.search === undefined ? [] : [
                    `(string::lowercase(title) CONTAINS ${surrealString(input.search.toLowerCase())} OR string::lowercase(hypothesis) CONTAINS ${surrealString(input.search.toLowerCase())})`,
                ]),
            ];
            const proposalRows = yield* db.query<[WorkflowCandidateProposalListRow[]]>(`
                SELECT
                    type::string(id) AS proposal_id,
                    dedupe_sig,
                    title,
                    form,
                    status,
                    confidence,
                    frequency,
                    (SELECT file_target FROM guidance_proposal WHERE proposal = $parent.id LIMIT 1)[0].file_target AS target,
                    (SELECT section FROM guidance_proposal WHERE proposal = $parent.id LIMIT 1)[0].section AS section,
                    type::string((SELECT id FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].id) AS experiment_id,
                    (SELECT status FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].status AS experiment_status,
                    (SELECT artifact_path FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].artifact_path AS artifact_path,
                    (SELECT task_path FROM experiment WHERE proposal = $parent.id LIMIT 1)[0].task_path AS task_path,
                    type::string(updated_at) AS updated_at
                FROM proposal
                WHERE ${where.join(" AND ")}
                ORDER BY updated_at DESC, frequency DESC
                LIMIT ${Math.max(1, input.limit)};
            `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            let rows: readonly WorkflowCandidateProposalListRow[] = proposalRows?.[0] ?? [];
            if (input.expandEvidence && rows.length > 0) {
                const proposalKeys = rows
                    .map((row) => recordKeyPart(row.proposal_id, "proposal"))
                    .filter((key): key is string => key !== null);
                const proposalRefs = proposalKeys.map((key) => recordRef("proposal", key));
                if (proposalRefs.length > 0) {
                    const edgeRows = yield* db.query<[WorkflowCandidateProposalEvidenceEdgeRow[]]>(`
                        SELECT type::string(in) AS proposal_id, type::string(out) AS candidate_ref
                        FROM cites_evidence
                        WHERE kind = "workflow_candidate" AND in IN [${proposalRefs.join(", ")}];
                    `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                    const edges = edgeRows?.[0] ?? [];
                    const candidateIds = [...new Set(edges
                        .map((edge) => recordKeyPart(edge.candidate_ref, "classifier_graph_node"))
                        .filter((id): id is string => id !== null))].sort();
                    if (candidateIds.length > 0) {
                        const candidateRows = yield* db.query<[WorkflowCandidateGroupRow[], WorkflowCandidateEvidenceRow[]]>(`
                            SELECT graph_id, label, properties_json
                            FROM classifier_graph_node
                            WHERE kind = "classifier_candidate_group" AND graph_id IN [${candidateIds.map(surrealString).join(", ")}];
                            SELECT graph_id, subject, object, properties_json
                            FROM classifier_graph_fact
                            WHERE kind = "classifier_candidate_evidence" AND subject IN [${candidateIds.map(surrealString).join(", ")}]
                            ORDER BY graph_id;
                        `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                        rows = attachWorkflowCandidateProposalEvidence({
                            rows,
                            edges,
                            candidateRows: candidateRows?.[0] ?? [],
                            factRows: candidateRows?.[1] ?? [],
                            examplesPerCandidate: input.examples,
                        });
                    }
                }
            }
            const listReport = buildWorkflowCandidateProposalListReport({
                rows,
                limit: input.limit,
                status,
                expandEvidence: Boolean(input.expandEvidence),
                ...(input.search === undefined ? {} : { search: input.search }),
            });
            if (input.out) {
                mkdirSync(dirname(input.out), { recursive: true });
                writeFileSync(input.out, `${prettyPrint(listReport)}\n`, "utf8");
            }
            console.log(input.json ? prettyPrint(listReport) : renderWorkflowCandidateProposalListText(listReport));
            return;
        }
        const rows = yield* db.query<[WorkflowCandidateGroupRow[], WorkflowCandidateEvidenceRow[]]>(
            workflowCandidateSql,
            { sourceKind: input.sourceKind },
        ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
        let report = buildWorkflowCandidateReport({
            groupRows: rows[0] ?? [],
            evidenceRows: rows[1] ?? [],
            sourceKind: input.sourceKind,
            limit: input.limit,
            examplesPerGroup: input.examples,
            ...(input.action === undefined ? {} : { action: input.action }),
            ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
            ...(input.search === undefined ? {} : { search: input.search }),
            taskLike: input.taskLike,
        });
        if (input.includeReviewFacts && report.candidates.length > 0) {
            const candidateIds = report.candidates.map((candidate) => candidate.group_id);
            const persistedReviewRows = yield* db.query<[WorkflowCandidateTopicHarnessGraphFactRow[]]>(`
                SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                FROM classifier_graph_fact
                WHERE kind = "workflow_topic_candidate_review"
                  AND source_kind = "workflow_topic_candidate_review"
                  AND object IN [${candidateIds.map(surrealString).join(", ")}]
                ORDER BY updated_at DESC
                LIMIT ${Math.max(1, input.limit * 3)};
            `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            report = attachWorkflowCandidatePersistedReviewFacts(report, persistedReviewRows?.[0] ?? []);
        }
        if (input.syncBrief) {
            report = syncWorkflowCandidateReportFromBrief(
                report,
                readFileSync(input.syncBrief, "utf8"),
                input.syncBrief,
            );
        }
        if (input.promoteTasks || input.promoteProposals) {
            const taskDir = input.taskDir ?? join(process.cwd(), ".ax", "tasks");
            const promotion = buildWorkflowCandidateTaskDrafts(report, taskDir, input.promotionMode ?? "per-candidate");
            report = promotion.report;
            if (input.promoteTasks) {
                if (promotion.drafts.length > 0) mkdirSync(taskDir, { recursive: true });
                for (const draft of promotion.drafts) {
                    writeFileSync(draft.path, draft.content, "utf8");
                }
            }
        }
        if (input.promoteProposals) {
            const existingProposalRows = yield* db.query<[Array<{ dedupe_sig: string }>]>(
                "SELECT dedupe_sig FROM proposal;",
            ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            const existingSigs = new Set((existingProposalRows?.[0] ?? []).map((row) => row.dedupe_sig));
            const plan = buildWorkflowCandidateGuidanceProposalPlan(report, existingSigs, {
                ...(input.proposalTarget === undefined ? {} : { fileTarget: input.proposalTarget }),
                ...(input.proposalSection === undefined ? {} : { section: input.proposalSection }),
                dryRun: Boolean(input.proposalDryRun),
                includeStatements: Boolean(input.proposalDryRun),
            });
            if (plan.statements.length > 0 && !input.proposalDryRun) {
                yield* db.query(plan.statements.join("\n")).pipe(
                    catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                );
            }
            const promotion = report.promotion;
            if (promotion === undefined) {
                const failures = [...report.failures, "promotion required before proposal seeding"];
                report = {
                    ...report,
                    failures,
                    decision: "needs_workflow_candidate_review",
                };
            } else {
                const failures = [...report.failures, ...plan.summary.failures];
                report = {
                    ...report,
                    promotion: {
                        ...promotion,
                        proposals: plan.summary,
                    },
                    failures,
                    decision: failures.length === 0 ? "workflow_candidates_ranked" : "needs_workflow_candidate_review",
                };
            }
        }
        if (input.out) {
            mkdirSync(dirname(input.out), { recursive: true });
            writeFileSync(input.out, `${prettyPrint(report)}\n`, "utf8");
        }
        if (input.brief) {
            mkdirSync(dirname(input.brief), { recursive: true });
            writeFileSync(input.brief, renderWorkflowCandidateBriefMarkdown(report), "utf8");
        }
        console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateReportText(report));
        if (report.decision !== "workflow_candidates_ranked") process.exitCode = 1;
    });
