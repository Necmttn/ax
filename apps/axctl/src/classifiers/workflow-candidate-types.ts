import type { ClassifierReviewPipelineInputValues, ClassifierReviewPipelineLifecycleReport, ClassifierReviewPipelineOutputVerifier } from "./review-pipeline-service.ts";
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
    readonly guidanceDecision?: boolean;
    readonly guidanceDecisionBatch?: boolean;
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
    readonly reviewPipelineLifecycle?: boolean;
    readonly reviewPipelineVerifyOutputs?: boolean;
    readonly reviewPipelineReviewer?: string;
    readonly reviewPipelineReviewedAt?: string;
    readonly out?: string;
    readonly brief?: string;
    readonly syncBrief?: string;
    readonly promoteTasks?: boolean;
    readonly emitAdjacentTasks?: boolean;
    readonly emitPendingReviewTask?: boolean;
    readonly listPendingReviewTasks?: boolean;
    readonly repairPendingReviewContext?: boolean;
    readonly repairTarget?: string;
    readonly repairedFixturePack?: string;
    readonly repairedReviewBrief?: string;
    readonly pendingReviewTaskPath?: string;
    readonly pendingReviewTaskStatus?: WorkflowCandidateGuidancePendingReviewTaskStatus;
    readonly pendingReviewDecisionStatus?: WorkflowCandidateGuidancePendingReviewDecisionStatus;
    readonly pendingReviewCommandStatus?: WorkflowCandidateGuidancePendingReviewCommandStatus;
    readonly pendingReviewRoute?: WorkflowCandidateGuidancePendingReviewRecommendedRoute;
    readonly pendingReviewProgressStatus?: WorkflowCandidateGuidancePendingReviewProgressStatus;
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
    readonly prefix: string;
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
    readonly guidance_decision?: WorkflowCandidateTopicGuidanceDecisionReport;
    readonly helper_explanations?: WorkflowCandidateTopicHelperExplanationReport;
}

export type WorkflowCandidateTopicGuidanceDecision =
    | "guidance_promotion_ready"
    | "guidance_promotion_not_warranted"
    | "needs_passing_harness_evidence"
    | "needs_human_review";

export interface WorkflowCandidateTopicGuidanceCandidateDecision {
    readonly candidate_id: string;
    readonly label: string;
    readonly recommended_artifact: WorkflowCandidatePromotionArtifact;
    readonly has_review_acceptance: boolean;
    readonly has_accepted_harness_proposal: boolean;
    readonly has_passing_harness_evidence: boolean;
    readonly has_guidance_proposal: boolean;
    readonly decision: WorkflowCandidateTopicGuidanceDecision;
    readonly rationale: string;
}

export interface WorkflowCandidateTopicAcceptedClassifierFixtureCandidate {
    readonly candidate_id: string;
    readonly label: string;
    readonly recommended_artifact: "classifier_fixture";
    readonly decision: "guidance_promotion_not_warranted";
    readonly next_action: string;
}

export interface WorkflowCandidateTopicGuidanceDecisionReport {
    readonly schema: "ax.workflow_topic_guidance_decision.v1";
    readonly topic: string;
    readonly decision: WorkflowCandidateTopicGuidanceDecision;
    readonly next_action: string;
    readonly candidates: readonly WorkflowCandidateTopicGuidanceCandidateDecision[];
    readonly accepted_classifier_fixture_candidates: readonly WorkflowCandidateTopicAcceptedClassifierFixtureCandidate[];
    readonly totals: {
        readonly candidate_count: number;
        readonly guidance_ready_count: number;
        readonly guidance_not_warranted_count: number;
        readonly needs_passing_harness_evidence_count: number;
        readonly needs_human_review_count: number;
        readonly accepted_classifier_fixture_candidate_count: number;
        readonly accepted_harness_proposal_count: number;
        readonly scaffolded_harness_experiment_count: number;
        readonly passing_harness_evidence_count: number;
        readonly guidance_proposal_count: number;
    };
}

export interface WorkflowCandidateGuidancePendingReviewCandidate {
    readonly candidate_id: string;
    readonly label: string;
    readonly proposed_action: string;
    readonly recommended_artifact: WorkflowCandidatePromotionArtifact;
    readonly recommendation_confidence: WorkflowCandidatePromotionRecommendation["confidence"];
    readonly support_count: number;
    readonly evidence_count: number;
    readonly score: number;
    readonly decision: "needs_human_review";
    readonly next_action: string;
}

export interface WorkflowCandidateGuidancePendingReviewHandoffSummary {
    readonly schema: "ax.workflow_topic_guidance_pending_review_handoff.v1";
    readonly fixture_pack_path: string;
    readonly review_brief_path?: string;
    readonly review_facts_path?: string;
    readonly review_write_plan_path?: string;
    readonly emitted_fixture_count: number;
    readonly reviewed_fixture_count: number;
    readonly pending_fixture_count: number;
    readonly review_handoff_status: WorkflowCandidateReviewCoverageHandoffStatus;
    readonly handoff_apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly handoff_can_apply: boolean;
    readonly production_apply_guard: WorkflowCandidateReviewCoverageApplyGuard;
    readonly production_can_apply: boolean;
    readonly review_issue_status: WorkflowCandidateReviewCoverageReviewIssueStatus;
    readonly review_issue_next_action: string;
    readonly review_pipeline_stage: WorkflowCandidateReviewCoveragePipelineStage;
    readonly review_pipeline_next_action: string;
    readonly review_pipeline_command_status: WorkflowCandidateReviewCoveragePipelineCommandStatus;
    readonly review_pipeline_command_can_execute: boolean;
    readonly review_pipeline_command_kind?: WorkflowCandidateReviewCoveragePipelineCommandKind;
    readonly review_pipeline_command?: string;
    readonly review_pipeline_lifecycle?: ClassifierReviewPipelineLifecycleReport;
    readonly next_action: string;
}

export const workflowCandidateGuidancePendingReviewTaskSchema = "ax.workflow_candidate_pending_review_task.v1" as const;

export interface WorkflowCandidateGuidancePendingReviewTaskSummary {
    readonly schema: typeof workflowCandidateGuidancePendingReviewTaskSchema;
    readonly task_dir: string;
    readonly emitted_task_count: number;
    readonly path?: string;
    readonly candidate_count: number;
    readonly fixture_count: number;
    readonly review_brief_path?: string;
    readonly fixture_pack_path: string;
    readonly source_kind?: string;
    readonly output_path?: string;
    readonly review_facts_path?: string;
    readonly review_write_plan_path?: string;
    readonly review_pipeline_stage: WorkflowCandidateReviewCoveragePipelineStage;
    readonly next_action: string;
}

export interface WorkflowCandidateGuidancePendingReviewTaskParsed {
    readonly schema?: string;
    readonly fixture_pack_path?: string;
    readonly review_brief_path?: string;
    readonly source_kind?: string;
    readonly output_path?: string;
    readonly review_facts_path?: string;
    readonly review_write_plan_path?: string;
    readonly review_pipeline_stage?: string;
    readonly candidate_ids: readonly string[];
}

export type WorkflowCandidateGuidancePendingReviewTaskArtifactStatus = "present" | "missing" | "unknown";
export type WorkflowCandidateGuidancePendingReviewTaskStatus =
    | "ready_for_review"
    | "review_decisions_ready"
    | "review_decisions_need_repair"
    | "missing_fixture_pack"
    | "missing_review_brief"
    | "missing_review_artifacts"
    | "unknown_schema";
export type WorkflowCandidateGuidancePendingReviewDecisionStatus =
    | "unknown"
    | "needs_review_decisions"
    | "reviewed_missing_rationale"
    | "invalid_review_status"
    | "review_decisions_ready";
export type WorkflowCandidateGuidancePendingReviewProgressStatus =
    | "unreadable"
    | "needs_review"
    | "partial_review"
    | "complete_review"
    | "needs_repair";
export type WorkflowCandidateGuidancePendingReviewContextStatus =
    | "unreadable"
    | "complete"
    | "needs_repair";
export type WorkflowCandidateGuidancePendingReviewContextIssue =
    | "truncated_user_text"
    | "missing_previous_assistant_context"
    | "unknown_target";
export type WorkflowCandidateGuidancePendingReviewCommandStatus =
    | "unavailable"
    | "blocked_until_review_decisions"
    | "blocked_until_review_repairs"
    | "ready_to_execute";
export type WorkflowCandidateGuidancePendingReviewRecommendedRoute =
    | "none"
    | "repair_artifacts"
    | "repair_review_decisions"
    | "execute_review_command"
    | "collect_review_decisions"
    | "repair_task_schema"
    | "inspect_task";
export type WorkflowCandidateGuidancePendingReviewQueueStatus =
    | "no_tasks"
    | "needs_artifact_repair"
    | "needs_review_repair"
    | "ready_to_execute"
    | "waiting_for_review_decisions"
    | "needs_schema_repair";

export interface WorkflowCandidateGuidancePendingReviewRouteCounts {
    readonly none: number;
    readonly repair_artifacts: number;
    readonly repair_review_decisions: number;
    readonly execute_review_command: number;
    readonly collect_review_decisions: number;
    readonly repair_task_schema: number;
    readonly inspect_task: number;
}
export type MutableWorkflowCandidateGuidancePendingReviewRouteCounts = {
    -readonly [K in keyof WorkflowCandidateGuidancePendingReviewRouteCounts]: WorkflowCandidateGuidancePendingReviewRouteCounts[K];
};

export interface WorkflowCandidateGuidancePendingReviewProgressStatusCounts {
    readonly unreadable: number;
    readonly needs_review: number;
    readonly partial_review: number;
    readonly complete_review: number;
    readonly needs_repair: number;
}
export type MutableWorkflowCandidateGuidancePendingReviewProgressStatusCounts = {
    -readonly [K in keyof WorkflowCandidateGuidancePendingReviewProgressStatusCounts]: WorkflowCandidateGuidancePendingReviewProgressStatusCounts[K];
};

export interface WorkflowCandidateGuidancePendingReviewTaskListFilters {
    readonly path?: string;
    readonly status?: WorkflowCandidateGuidancePendingReviewTaskStatus;
    readonly review_decision_status?: WorkflowCandidateGuidancePendingReviewDecisionStatus;
    readonly review_command_status?: WorkflowCandidateGuidancePendingReviewCommandStatus;
    readonly route?: WorkflowCandidateGuidancePendingReviewRecommendedRoute;
    readonly review_progress_status?: WorkflowCandidateGuidancePendingReviewProgressStatus;
}

export interface WorkflowCandidateGuidancePendingReviewTaskListItem {
    readonly path: string;
    readonly schema?: string;
    readonly status: WorkflowCandidateGuidancePendingReviewTaskStatus;
    readonly fixture_pack_path?: string;
    readonly fixture_pack_status: WorkflowCandidateGuidancePendingReviewTaskArtifactStatus;
    readonly review_brief_path?: string;
    readonly review_brief_status: WorkflowCandidateGuidancePendingReviewTaskArtifactStatus;
    readonly review_pipeline_stage?: string;
    readonly candidate_ids: readonly string[];
    readonly candidate_count: number;
    readonly fixture_count?: number;
    readonly synced_fixture_count?: number;
    readonly reviewed_fixture_count?: number;
    readonly pending_fixture_count?: number;
    readonly invalid_fixture_count?: number;
    readonly missing_rationale_count?: number;
    readonly review_context_status: WorkflowCandidateGuidancePendingReviewContextStatus;
    readonly review_context_issue_count: number;
    readonly review_context_issues: readonly WorkflowCandidateGuidancePendingReviewContextIssue[];
    readonly review_decision_status: WorkflowCandidateGuidancePendingReviewDecisionStatus;
    readonly review_progress_status: WorkflowCandidateGuidancePendingReviewProgressStatus;
    readonly review_decision_next_action: string;
    readonly review_sync_command?: readonly string[];
    readonly review_sync_command_status: WorkflowCandidateGuidancePendingReviewCommandStatus;
    readonly review_sync_command_can_execute: boolean;
    readonly review_sync_command_effect: "updates_review_pack_and_writes_report";
    readonly review_inspect_command?: readonly string[];
    readonly review_inspect_command_status: WorkflowCandidateGuidancePendingReviewCommandStatus;
    readonly review_inspect_command_can_execute: boolean;
    readonly review_inspect_command_effect: "updates_review_pack_and_writes_review_artifacts";
    readonly route: WorkflowCandidateGuidancePendingReviewRecommendedRoute;
}

export interface WorkflowCandidateGuidancePendingReviewTaskListReport {
    readonly schema: "ax.workflow_candidate_pending_review_task_list.v1";
    readonly task_dir: string;
    readonly filters?: WorkflowCandidateGuidancePendingReviewTaskListFilters;
    readonly queue_status: WorkflowCandidateGuidancePendingReviewQueueStatus;
    readonly recommended_task_path?: string;
    readonly recommended_task_status?: WorkflowCandidateGuidancePendingReviewTaskStatus;
    readonly recommended_task_review_decision_status?: WorkflowCandidateGuidancePendingReviewDecisionStatus;
    readonly recommended_task_review_command_status?: WorkflowCandidateGuidancePendingReviewCommandStatus;
    readonly recommended_task_route?: WorkflowCandidateGuidancePendingReviewRecommendedRoute;
    readonly recommended_task_can_execute_command?: boolean;
    readonly recommended_task_fixture_pack_path?: string;
    readonly recommended_task_fixture_pack_status?: WorkflowCandidateGuidancePendingReviewTaskArtifactStatus;
    readonly recommended_task_review_brief_path?: string;
    readonly recommended_task_review_brief_status?: WorkflowCandidateGuidancePendingReviewTaskArtifactStatus;
    readonly recommended_task_fixture_count?: number;
    readonly recommended_task_reviewed_fixture_count?: number;
    readonly recommended_task_pending_fixture_count?: number;
    readonly recommended_task_invalid_fixture_count?: number;
    readonly recommended_task_missing_rationale_count?: number;
    readonly recommended_task_review_context_status?: WorkflowCandidateGuidancePendingReviewContextStatus;
    readonly recommended_task_review_context_issue_count?: number;
    readonly recommended_task_review_context_issues?: readonly WorkflowCandidateGuidancePendingReviewContextIssue[];
    readonly recommended_task_review_progress_status?: WorkflowCandidateGuidancePendingReviewProgressStatus;
    readonly recommended_task_candidate_ids?: readonly string[];
    readonly recommended_task_next_action?: string;
    readonly recommended_task_review_sync_command?: readonly string[];
    readonly recommended_task_review_sync_command_status?: WorkflowCandidateGuidancePendingReviewCommandStatus;
    readonly recommended_task_review_sync_command_can_execute?: boolean;
    readonly recommended_task_review_inspect_command?: readonly string[];
    readonly recommended_task_review_inspect_command_status?: WorkflowCandidateGuidancePendingReviewCommandStatus;
    readonly recommended_task_review_inspect_command_can_execute?: boolean;
    readonly task_count: number;
    readonly ready_for_review_count: number;
    readonly review_decisions_ready_count: number;
    readonly review_decisions_need_repair_count: number;
    readonly review_sync_command_ready_count: number;
    readonly review_inspect_command_ready_count: number;
    readonly review_command_blocked_count: number;
    readonly route_counts: WorkflowCandidateGuidancePendingReviewRouteCounts;
    readonly review_progress_status_counts: WorkflowCandidateGuidancePendingReviewProgressStatusCounts;
    readonly missing_artifact_count: number;
    readonly unknown_schema_count: number;
    readonly tasks: readonly WorkflowCandidateGuidancePendingReviewTaskListItem[];
    readonly next_action: string;
}

export type WorkflowCandidateGuidancePendingReviewContextRepairStatus =
    | "fully_repaired"
    | "partially_repaired"
    | "unrepaired"
    | "unchanged";

export interface WorkflowCandidateGuidancePendingReviewContextRepairTurnContext {
    readonly turn_id: string;
    readonly user_text?: string | null;
    readonly previous_assistant_text?: string | null;
    readonly target?: string | null;
}

export interface WorkflowCandidateGuidancePendingReviewContextRepairRow {
    readonly fixture_id: string;
    readonly turn_id?: string;
    readonly status: WorkflowCandidateGuidancePendingReviewContextRepairStatus;
    readonly before_issues: readonly WorkflowCandidateGuidancePendingReviewContextIssue[];
    readonly repaired_issues: readonly WorkflowCandidateGuidancePendingReviewContextIssue[];
    readonly remaining_issues: readonly WorkflowCandidateGuidancePendingReviewContextIssue[];
    readonly repaired_fixture: WorkflowCandidateTopicClassifierFixtureRow;
}

export interface WorkflowCandidateGuidancePendingReviewTargetResolutionRow {
    readonly fixture_id: string;
    readonly candidate_id: string;
    readonly candidate_label: string;
    readonly proposed_action: string;
    readonly current_target: string;
    readonly suggested_review_action: "set_target_or_defer";
}

export interface WorkflowCandidateGuidancePendingReviewContextRepairReport {
    readonly schema: "ax.workflow_candidate_pending_review_context_repair.v1";
    readonly fixture_pack_path: string;
    readonly review_brief_path?: string;
    readonly fixture_count: number;
    readonly repaired_fixture_count: number;
    readonly fully_repaired_fixture_count: number;
    readonly partially_repaired_fixture_count: number;
    readonly unrepaired_fixture_count: number;
    readonly unchanged_fixture_count: number;
    readonly before_issue_count: number;
    readonly after_issue_count: number;
    readonly repaired_issue_count: number;
    readonly remaining_issue_count: number;
    readonly target_resolution_required_count: number;
    readonly target_resolution_rows: readonly WorkflowCandidateGuidancePendingReviewTargetResolutionRow[];
    readonly target_resolution_next_action: string;
    readonly rows: readonly WorkflowCandidateGuidancePendingReviewContextRepairRow[];
    readonly repaired_jsonl: string;
    readonly repaired_review_brief_markdown: string;
    readonly next_action: string;
}

export interface WorkflowCandidateTopicGuidanceDecisionBatchReport {
    readonly schema: "ax.workflow_topic_guidance_decision_batch.v1";
    readonly source_kind: string;
    readonly query: {
        readonly limit: number;
        readonly search?: string;
    };
    readonly decisions: readonly WorkflowCandidateTopicGuidanceDecisionReport[];
    readonly pending_review_candidates: readonly WorkflowCandidateGuidancePendingReviewCandidate[];
    readonly accepted_classifier_fixture_pack?: WorkflowCandidateTopicClassifierFixtureSummary;
    readonly pending_review_fixture_pack?: WorkflowCandidateReviewCoverageFixtureSummary;
    readonly pending_review_handoff?: WorkflowCandidateGuidancePendingReviewHandoffSummary;
    readonly pending_review_task?: WorkflowCandidateGuidancePendingReviewTaskSummary;
    readonly totals: {
        readonly topic_count: number;
        readonly candidate_count: number;
        readonly pending_review_candidate_count: number;
        readonly guidance_pending_review_count: number;
        readonly harness_pending_review_count: number;
        readonly classifier_fixture_pending_review_count: number;
        readonly review_pending_review_count: number;
        readonly guidance_ready_count: number;
        readonly guidance_not_warranted_count: number;
        readonly needs_passing_harness_evidence_count: number;
        readonly needs_human_review_count: number;
        readonly accepted_classifier_fixture_candidate_count: number;
        readonly accepted_harness_proposal_count: number;
        readonly scaffolded_harness_experiment_count: number;
        readonly passing_harness_evidence_count: number;
        readonly guidance_proposal_count: number;
    };
    readonly next_action: string;
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

export type WorkflowCandidateReviewCoveragePipelineRequiredInput =
    | "reviewer"
    | "reviewed_at";

export type WorkflowCandidateReviewCoveragePipelineInputValueKind =
    | "nonempty_string"
    | "iso_datetime";

export type WorkflowCandidateReviewCoveragePipelineCommandStatus =
    | "unavailable"
    | "requires_inputs"
    | "ready_to_execute";

export type WorkflowCandidateReviewCoveragePipelineCommandBlocker =
    | "missing_pipeline_command"
    | "missing_pipeline_inputs";

export interface WorkflowCandidateReviewCoveragePipelineCommandBlockerDetail {
    readonly blocker: WorkflowCandidateReviewCoveragePipelineCommandBlocker;
    readonly count: number;
    readonly remediation: string;
}

export type WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactKind =
    | "readiness_report"
    | "review_brief"
    | "review_facts"
    | "review_write_plan";

export interface WorkflowCandidateReviewCoveragePipelineCommandOutputArtifact {
    readonly kind: WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactKind;
    readonly path: string;
    readonly argv_flag: string;
    readonly argv_index: number;
    readonly argv_value_prefix: string;
    readonly required_for_handoff: boolean;
}

export type WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheck =
    "file_exists_after_execution";

export type WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckStatus =
    "pending_execution";

export type WorkflowCandidateReviewCoveragePipelineCommandOutputCheckStatus =
    | "no_output_artifacts"
    | "pending_execution";

export interface WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckRow {
    readonly kind: WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactKind;
    readonly path: string;
    readonly argv_index: number;
    readonly check: WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheck;
    readonly status: WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckStatus;
    readonly required_for_command_success: boolean;
}

export interface WorkflowCandidateReviewCoveragePipelineInputBinding {
    readonly input: WorkflowCandidateReviewCoveragePipelineRequiredInput;
    readonly argv_flag: string;
    readonly argv_index: number;
    readonly argv_value_prefix: string;
    readonly placeholder: string;
    readonly value_kind: WorkflowCandidateReviewCoveragePipelineInputValueKind;
}

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
    readonly production_apply_command_argv?: readonly string[];
    readonly production_apply_command?: string;
    readonly review_provenance_stamp_command_argv?: readonly string[];
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
    readonly review_issue_repair_command_argv?: readonly string[];
    readonly review_issue_repair_command?: string;
    readonly review_pipeline_stage: WorkflowCandidateReviewCoveragePipelineStage;
    readonly review_pipeline_next_action: string;
    readonly review_pipeline_command_status: WorkflowCandidateReviewCoveragePipelineCommandStatus;
    readonly review_pipeline_command_can_execute: boolean;
    readonly review_pipeline_command_next_action: string;
    readonly review_pipeline_command_blockers: readonly WorkflowCandidateReviewCoveragePipelineCommandBlocker[];
    readonly review_pipeline_command_blocker_details: readonly WorkflowCandidateReviewCoveragePipelineCommandBlockerDetail[];
    readonly review_pipeline_command_kind?: WorkflowCandidateReviewCoveragePipelineCommandKind;
    readonly review_pipeline_command_output_artifacts: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifact[];
    readonly review_pipeline_command_output_artifact_checks: readonly WorkflowCandidateReviewCoveragePipelineCommandOutputArtifactCheckRow[];
    readonly review_pipeline_command_output_check_status: WorkflowCandidateReviewCoveragePipelineCommandOutputCheckStatus;
    readonly review_pipeline_command_output_check_next_action: string;
    readonly review_pipeline_required_inputs: readonly WorkflowCandidateReviewCoveragePipelineRequiredInput[];
    readonly review_pipeline_input_bindings: readonly WorkflowCandidateReviewCoveragePipelineInputBinding[];
    readonly review_pipeline_command_argv?: readonly string[];
    readonly review_pipeline_command?: string;
    readonly review_pipeline_lifecycle?: ClassifierReviewPipelineLifecycleReport;
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
    readonly commandMode?: WorkflowCandidateReviewCoverageBriefCommandMode;
}

export type WorkflowCandidateReviewCoverageBriefCommandMode =
    | "review_coverage"
    | "guidance_decision_batch";

export interface WorkflowCandidateTopicClassifierFixtureRow {
    readonly id: string;
    readonly suite: "workflow-candidate-topic" | "workflow-candidate-review-coverage";
    readonly name: string;
    readonly label: string;
    readonly target: string;
    readonly text: string;
    readonly source_group: "workflow-candidate";
    readonly review_status: "pending" | "accept" | "accepted" | "revise" | "reject" | "defer";
    readonly review_notes?: string;
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
    readonly target?: string;
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

export interface WorkflowCandidateReviewPipelineLifecycleOptions {
    readonly values?: ClassifierReviewPipelineInputValues;
    readonly verifier?: ClassifierReviewPipelineOutputVerifier;
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

export interface WorkflowCandidateTaskDraft {
    readonly path: string;
    readonly content: string;
    readonly task: WorkflowCandidatePromotionTask;
}

export interface WorkflowCandidateProposalPlan {
    readonly summary: WorkflowCandidateProposalPromotionSummary;
    readonly statements: readonly string[];
}

export interface CandidateBuildInput {
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

export interface WorkflowCandidatePendingReviewTurnRow {
    readonly id: string;
    readonly session_id?: string | null;
    readonly seq?: number | null;
    readonly role?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
}
