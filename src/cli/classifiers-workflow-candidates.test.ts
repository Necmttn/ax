import { describe, expect, test } from "bun:test";
import {
    attachWorkflowCandidateProposalEvidence,
    buildWorkflowCandidateReport,
    buildWorkflowCandidateGuidanceProposalPlan,
    buildWorkflowCandidateProposalListReport,
    buildWorkflowCandidateHarnessProposalPlan,
    buildWorkflowCandidateTopicClassifierFixtureRows,
    buildWorkflowCandidateTopicClassifierFixtureSummary,
    buildWorkflowCandidateTopicHarnessGraphProjection,
    buildWorkflowCandidateTopicHarnessGraphListReport,
    buildWorkflowCandidateTopicHarnessGraphWritePlan,
    buildWorkflowCandidateTopicHarnessChecks,
    buildWorkflowCandidateTopicHarnessEvidenceSummary,
    buildWorkflowCandidateTopicHelperExplanations,
    buildWorkflowCandidateTopicReviewGraphProjection,
    buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures,
    buildWorkflowCandidateReviewCoverageApplySummary,
    buildWorkflowCandidateReviewCoveragePostApplyRecheckSummary,
    buildWorkflowCandidateTopicReviewGraphListReport,
    buildWorkflowCandidateTopicReviewGraphWritePlan,
    buildWorkflowCandidateTopicTaskDrafts,
    attachWorkflowCandidatePersistedReviewFacts,
    buildWorkflowCandidateReviewCoverageReport,
    buildWorkflowCandidateReviewCoverageFixtureSummary,
    buildWorkflowCandidateTopicReport,
    buildWorkflowCandidateTaskDrafts,
    isTaskLikeWorkflowText,
    parseWorkflowCandidateBriefReview,
    parseWorkflowCandidateFixtureRowsJsonl,
    recommendWorkflowCandidatePromotionArtifact,
    renderWorkflowCandidateBriefMarkdown,
    renderWorkflowCandidateReviewCoverageBriefMarkdown,
    stampWorkflowCandidateReviewProvenance,
    syncWorkflowCandidateFixtureRowsFromBrief,
    syncWorkflowCandidateFixtureRowsFromBriefWithSummary,
    renderWorkflowCandidateTopicEvidencePackMarkdown,
    renderMergedWorkflowCandidateTaskMarkdown,
    renderWorkflowCandidateProposalListText,
    renderWorkflowCandidateTaskMarkdown,
    renderWorkflowCandidateTopicReportText,
    renderWorkflowCandidateTopicHarnessGraphListText,
    renderWorkflowCandidateReportText,
    renderWorkflowCandidateReviewCoverageText,
    syncWorkflowCandidateReportFromBrief,
    syncWorkflowCandidateTopicReportFromBrief,
    topicAdjacentCandidates,
    workflowCandidateTopicHarnessGateFailures,
    workflowCandidateScore,
    type WorkflowCandidateEmbeddingHelperGraphEdgeRow,
    type WorkflowCandidateEmbeddingHelperGraphFactRow,
    type WorkflowCandidateEvidenceRow,
    type WorkflowCandidateHelperFixtureRow,
    type WorkflowCandidateProposalEvidenceEdgeRow,
    type WorkflowCandidateGroupRow,
} from "./classifiers-workflow-candidates.ts";

const properties = (value: unknown) => JSON.stringify(value);

const groups: WorkflowCandidateGroupRow[] = [
    {
        graph_id: "group:verify",
        label: "verification-event:verification_request:test_required",
        properties_json: properties({
            classifier_key: "verification-event",
            label: "verification_request",
            target: "test_required",
            proposed_action: "add_verification_gate",
            support_count: 3,
        }),
    },
    {
        graph_id: "group:correction",
        label: "reaction-event:correction:wrong_output",
        properties_json: properties({
            classifier_key: "reaction-event",
            label: "correction",
            target: "wrong_output",
            proposed_action: "add_context_guardrail",
            support_count: 1,
        }),
    },
];

const evidence: WorkflowCandidateEvidenceRow[] = [
    {
        graph_id: "fact:1",
        subject: "group:verify",
        properties_json: properties({
            result_id: "result:1",
            turn: "turn:1",
            confidence: 0.9,
            text_excerpt: "Can you run the tests before calling this done?",
        }),
    },
    {
        graph_id: "fact:2",
        subject: "group:verify",
        properties_json: properties({
            result_id: "result:2",
            turn: "turn:2",
            confidence: 0.8,
            text_excerpt: "You are implementing task TASK-123. Worktree: /tmp/demo",
        }),
    },
    {
        graph_id: "fact:3",
        subject: "group:correction",
        properties_json: properties({
            result_id: "result:3",
            turn: "turn:3",
            confidence: 0.76,
            text_excerpt: "That was the wrong file; use the previous agent action as context.",
        }),
    },
    {
        graph_id: "fact:4",
        subject: "group:correction",
        properties_json: properties({
            result_id: "result:4",
            turn: "turn:4",
            confidence: 0.88,
            text_excerpt: "Did you create the classifier? I want to see results applied to SurrealML.",
        }),
    },
];

describe("classifiers workflow-candidates", () => {
    test("detects task-like review wrapper text", () => {
        expect(isTaskLikeWorkflowText("You are implementing task ABC.")).toBe(true);
        expect(isTaskLikeWorkflowText("Please add a regression test for this fix.")).toBe(false);
    });

    test("renders promoted helper explanations inside topic evidence packs", () => {
        const helperFacts: WorkflowCandidateEmbeddingHelperGraphFactRow[] = [{
            graph_id: "fact:embedding-helper-maintenance",
            subject: "embedding_helper_hard_negative:session-section-chunks/none-maintenance-question",
            predicate: "promoted_hard_negative_fixture",
            object: "classifier_promoted_fixture:session-section-chunks/embedding-helper-hard-negative-session-section-chunks-none-maintenance-question",
            evidence_edges_json: properties(["edge:nearest-surreal-port"]),
            properties_json: properties({
                source_fixture_id: "session-section-chunks/none-maintenance-question",
                status: "accepted",
                proposed_label: "none",
                promoted_fixture_id: "session-section-chunks/embedding-helper-hard-negative-session-section-chunks-none-maintenance-question",
            }),
        }];
        const helperEdges: WorkflowCandidateEmbeddingHelperGraphEdgeRow[] = [{
            graph_id: "edge:nearest-surreal-port",
            kind: "nearest_reviewed_fixture",
            to_id: "classifier_evidence:session-section-chunks/tooling-local-surreal-port",
            evidence_path: ".ax/experiments/embedding-helper-review-current.json",
            properties_json: properties({ similarity: 0.688 }),
        }];
        const helperFixtures: WorkflowCandidateHelperFixtureRow[] = [{
            id: "session-section-chunks/none-maintenance-question",
            text: "USER:\nwhen was the last work around surrealML, do they maintain it?\n\nPREVIOUS_ASSISTANT:\nThe user is asking for current project research.",
        }];
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                label: "environment_or_preference_signal",
                properties_json: properties({
                    classifier_key: "hybrid-window",
                    label: "environment_or_preference_signal",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 50,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:maintenance-question",
                subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                properties_json: properties({
                    result_id: "event_window:maintenance-question",
                    turn: "turn:maintenance-question",
                    confidence: 0.71,
                    text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped? PREVIOUS_ASSISTANT: I would use Nix here, not Docker Compose.",
                }),
            }],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const baseReport = buildWorkflowCandidateTopicReport({
            sourceKind: "hybrid_window_classifier_projection",
            topic: "SurrealML",
            proposals,
            candidates,
        });
        const helperExplanations = buildWorkflowCandidateTopicHelperExplanations({
            report: baseReport,
            facts: helperFacts,
            edges: helperEdges,
            fixtures: helperFixtures,
            minTokenOverlap: 0.72,
        });
        const markdown = renderWorkflowCandidateTopicEvidencePackMarkdown({
            ...baseReport,
            helper_explanations: helperExplanations,
        });

        expect(helperExplanations.totals.matched_example_count).toBe(1);
        expect(markdown).toContain("- Helper explanations: `1`");
        expect(markdown).toContain("## Promoted Helper Controls");
        expect(markdown).toContain("### session-section-chunks/none-maintenance-question");
        expect(markdown).toContain("- Promoted fixture: `session-section-chunks/embedding-helper-hard-negative-session-section-chunks-none-maintenance-question`");
        expect(markdown).toContain("- Candidate: `environment_or_preference_signal`");
        expect(markdown).toContain("- Match score: `1`");
        expect(markdown).toContain("- Nearest reviewed fixture: `session-section-chunks/tooling-local-surreal-port` sim=`0.688`");
    });

    test("scores verification gates above low-weight approvals with equal support", () => {
        expect(workflowCandidateScore(5, 5, 0.8, "add_verification_gate", 0))
            .toBeGreaterThan(workflowCandidateScore(5, 5, 0.8, "record_approval_checkpoint", 0));
    });

    test("builds ranked report with task-like evidence included by default", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            taskLike: "include",
        });

        expect(report.decision).toBe("workflow_candidates_ranked");
        expect(report.totals.candidate_group_count).toBe(2);
        expect(report.totals.task_like_count).toBe(1);
        const verify = report.candidates.find((candidate) => candidate.group_id === "group:verify");
        expect(verify?.support_count).toBe(2);
        expect(verify?.raw_support_count).toBe(3);
        expect(verify?.examples).toHaveLength(2);
    });

    test("filters task-like evidence when requested", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 5,
            taskLike: "exclude",
        });

        const verify = report.candidates.find((candidate) => candidate.group_id === "group:verify");
        expect(verify?.support_count).toBe(1);
        expect(verify?.task_like_count).toBe(0);
        expect(report.totals.considered_evidence_fact_count).toBe(3);
    });

    test("filters by proposed action and classifier key", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            action: "add_context_guardrail",
            classifier: "reaction-event",
            taskLike: "include",
        });

        expect(report.candidates).toHaveLength(1);
        expect(report.candidates[0].label).toBe("reaction-event:correction:wrong_output");
        expect(report.query.action).toBe("add_context_guardrail");
        expect(report.query.classifier).toBe("reaction-event");
    });

    test("filters evidence examples by search text", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            action: "add_context_guardrail",
            search: "surrealml",
            taskLike: "exclude",
        });

        expect(report.candidates).toHaveLength(1);
        expect(report.candidates[0].label).toBe("reaction-event:correction:wrong_output");
        expect(report.candidates[0].support_count).toBe(1);
        expect(report.candidates[0].examples[0].text_excerpt).toContain("SurrealML");
        expect(report.query.search).toBe("surrealml");
        expect(report.totals.considered_evidence_fact_count).toBe(1);
    });

    test("search skips candidate groups with no matching evidence", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "surrealml",
            taskLike: "include",
        });

        expect(report.decision).toBe("workflow_candidates_ranked");
        expect(report.candidates.map((candidate) => candidate.group_id)).toEqual(["group:correction"]);
        expect(report.failures).toEqual([]);
    });

    test("renders reviewable text with examples", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 2,
            examplesPerGroup: 1,
            taskLike: "include",
        });
        const output = renderWorkflowCandidateReportText(report);

        expect(output).toContain("workflow candidate report");
        expect(output).toContain("decision: workflow_candidates_ranked");
        expect(output).toContain("verification-event:verification_request:test_required -> add_verification_gate");
        expect(output).toContain("example turn:1 conf=0.90");
    });

    test("renders markdown brief for candidate review", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 1,
            examplesPerGroup: 1,
            search: "surrealml",
            taskLike: "exclude",
        });
        const brief = renderWorkflowCandidateBriefMarkdown(report);

        expect(brief).toContain("# Workflow Candidate Review");
        expect(brief).toContain("Allowed verdicts: `accept`, `revise`, `reject`, `defer`.");
        expect(brief).toContain("## Candidate 1: reaction-event:correction:wrong_output");
        expect(brief).toContain("- Candidate id: `group:correction`");
        expect(brief).toContain("- Proposed action: `add_context_guardrail`");
        expect(brief).toContain("- Verdict: `pending`");
        expect(brief).toContain("- Turn: `turn:4`");
        expect(brief).toContain("SurrealML");
    });

    test("parses markdown brief verdicts by candidate id", () => {
        const brief = [
            "## Candidate 1: reaction-event:correction:wrong_output",
            "",
            "- Candidate id: `group:correction`",
            "- Verdict: `accept`",
            "- Rationale: Guard against prototype-only responses when the user asks for applied classifier results.",
            "",
            "## Candidate 2: verification-event:verification_request:test_required",
            "",
            "- Candidate id: `group:verify`",
            "- Verdict: `defer`",
            "- Rationale: _pending_",
            "",
        ].join("\n");

        expect(parseWorkflowCandidateBriefReview(brief)).toEqual({
            "group:correction": {
                verdict: "accept",
                rationale: "Guard against prototype-only responses when the user asks for applied classifier results.",
            },
            "group:verify": {
                verdict: "defer",
                rationale: "",
            },
        });
    });

    test("syncs markdown brief review state into report candidates", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        });
        const brief = renderWorkflowCandidateBriefMarkdown(report)
            .replace("- Verdict: `pending`", "- Verdict: `accept`")
            .replace("- Rationale: _pending_", "- Rationale: This candidate should become a guardrail task.");

        const synced = syncWorkflowCandidateReportFromBrief(report, brief, "brief.md");
        const accepted = synced.candidates.find((candidate) => candidate.review?.verdict === "accept");

        expect(synced.review).toEqual({
            synced_from: "brief.md",
            reviewed_candidate_count: 1,
            pending_candidate_count: 1,
            invalid_verdict_count: 0,
            missing_rationale_count: 0,
            unknown_candidate_count: 0,
        });
        expect(synced.decision).toBe("workflow_candidates_ranked");
        expect(accepted?.review?.rationale).toBe("This candidate should become a guardrail task.");
    });

    test("sync reports invalid verdict and missing rationale failures", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups.slice(1),
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        });
        const brief = renderWorkflowCandidateBriefMarkdown(report)
            .replace("- Verdict: `pending`", "- Verdict: `shipit`");

        const synced = syncWorkflowCandidateReportFromBrief(report, brief, "brief.md");

        expect(synced.review?.invalid_verdict_count).toBe(1);
        expect(synced.failures).toContain("review has invalid verdicts: 1");
        expect(synced.decision).toBe("needs_workflow_candidate_review");
    });

    test("builds task drafts only for accepted or revised reviewed candidates", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        });
        const brief = renderWorkflowCandidateBriefMarkdown(report)
            .replace("- Candidate id: `group:correction`\n- Proposed action", "- Candidate id: `group:correction`\n- Proposed action")
            .replace("- Verdict: `pending`", "- Verdict: `accept`")
            .replace("- Rationale: _pending_", "- Rationale: Promote this correction guardrail.");
        const synced = syncWorkflowCandidateReportFromBrief(report, brief, "brief.md");
        const result = buildWorkflowCandidateTaskDrafts(synced, ".ax/tasks-test");

        expect(result.report.promotion?.emitted_task_count).toBe(1);
        expect(result.report.promotion?.mode).toBe("per-candidate");
        expect(result.report.promotion?.skipped_candidate_count).toBe(1);
        expect(result.report.promotion?.blocked_candidate_count).toBe(0);
        expect(result.drafts).toHaveLength(1);
        expect(result.drafts[0].path).toContain("workflow-candidate-");
        expect(result.drafts[0].content).toContain("# ax workflow candidate task:");
        expect(result.drafts[0].content).toContain("Promote this correction guardrail.");
        expect(result.drafts[0].content).toContain("candidate-id:");
    });

    test("merge-evidence promotion emits one task for overlapping evidence", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: [
                groups[1],
                {
                    graph_id: "group:artifact",
                    label: "correction-event:correction:wrong_artifact",
                    properties_json: properties({
                        classifier_key: "correction-event",
                        label: "correction",
                        target: "wrong_artifact",
                        proposed_action: "add_context_guardrail",
                        support_count: 1,
                    }),
                },
            ],
            evidenceRows: [
                evidence[3],
                {
                    graph_id: "fact:5",
                    subject: "group:artifact",
                    properties_json: properties({
                        result_id: "result:5",
                        turn: "turn:4",
                        confidence: 0.86,
                        text_excerpt: "Did you create the classifier? I want to see results applied to SurrealML.",
                    }),
                },
            ],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "surrealml",
            taskLike: "exclude",
        });
        const brief = renderWorkflowCandidateBriefMarkdown(report)
            .replace("- Verdict: `pending`", "- Verdict: `accept`")
            .replace("- Rationale: _pending_", "- Rationale: Promote the prototype completeness guardrail.")
            .replace("- Verdict: `pending`", "- Verdict: `revise`")
            .replace("- Rationale: _pending_", "- Rationale: Merge the artifact framing into the accepted task.");
        const synced = syncWorkflowCandidateReportFromBrief(report, brief, "brief.md");
        const result = buildWorkflowCandidateTaskDrafts(synced, ".ax/tasks-test", "merge-evidence");

        expect(result.report.promotion?.mode).toBe("merge-evidence");
        expect(result.report.promotion?.emitted_task_count).toBe(1);
        expect(result.report.promotion?.tasks[0].candidate_ids).toHaveLength(2);
        expect(result.report.promotion?.tasks[0].recommended_artifact.primary).toBe("guidance");
        expect(result.report.promotion?.tasks[0].recommended_artifact.alternatives).toContain("harness_check");
        expect(result.report.promotion?.tasks[0].recommended_artifact.alternatives).toContain("classifier_fixture");
        expect(result.drafts).toHaveLength(1);
        expect(result.drafts[0].content).toContain("merged add_context_guardrail");
        expect(result.drafts[0].content).toContain("## Promotion Recommendation");
        expect(result.drafts[0].content).toContain("- Primary: `guidance`");
        expect(result.drafts[0].content).toContain("correction-event:correction:wrong_artifact");
        expect(result.drafts[0].content).toContain("result:5");
    });

    test("builds guidance proposal statements for guidance-recommended promotions", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: [
                groups[1],
                {
                    graph_id: "group:artifact",
                    label: "correction-event:correction:wrong_artifact",
                    properties_json: properties({
                        classifier_key: "correction-event",
                        label: "correction",
                        target: "wrong_artifact",
                        proposed_action: "add_context_guardrail",
                        support_count: 1,
                    }),
                },
            ],
            evidenceRows: [
                evidence[3],
                {
                    graph_id: "fact:5",
                    subject: "group:artifact",
                    properties_json: properties({
                        result_id: "result:5",
                        turn: "turn:4",
                        confidence: 0.86,
                        text_excerpt: "Did you create the classifier? I want to see results applied to SurrealML.",
                    }),
                },
            ],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "surrealml",
            taskLike: "exclude",
        });
        const synced = syncWorkflowCandidateReportFromBrief(
            report,
            renderWorkflowCandidateBriefMarkdown(report)
                .replace("- Verdict: `pending`", "- Verdict: `accept`")
                .replace("- Rationale: _pending_", "- Rationale: Promote the prototype completeness guardrail.")
                .replace("- Verdict: `pending`", "- Verdict: `revise`")
                .replace("- Rationale: _pending_", "- Rationale: Merge the artifact framing into the accepted task."),
            "brief.md",
        );
        const promoted = buildWorkflowCandidateTaskDrafts(synced, ".ax/tasks-test", "merge-evidence").report;
        const plan = buildWorkflowCandidateGuidanceProposalPlan(promoted, new Set(), {
            fileTarget: "AGENTS.md",
            section: "Workflow Candidate Guardrails",
        });

        expect(plan.summary.emitted_proposal_count).toBe(1);
        expect(plan.summary.skipped_proposal_count).toBe(0);
        expect(plan.summary.dry_run).toBe(false);
        expect(plan.summary.statement_count).toBe(plan.statements.length);
        expect(plan.summary.proposals[0].dedupe_sig).toStartWith("guidance__workflow_candidate__");
        expect(plan.summary.proposals[0].title).toBe("Require applied classifier results for surrealml");
        expect(plan.statements.join("\n")).toContain("CREATE proposal:");
        expect(plan.statements.join("\n")).toContain("UPSERT guidance_proposal:");
        expect(plan.statements.join("\n")).toContain("->cites_evidence:");
        expect(plan.statements.join("\n")).toContain("classifier_graph_node:");
    });

    test("guidance proposal dry-run includes planned statements without changing ids", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "surrealml",
            taskLike: "exclude",
        });
        const synced = syncWorkflowCandidateReportFromBrief(
            report,
            renderWorkflowCandidateBriefMarkdown(report)
                .replace("- Verdict: `pending`", "- Verdict: `accept`")
                .replace("- Rationale: _pending_", "- Rationale: Promote the prototype completeness guardrail."),
            "brief.md",
        );
        const promoted = buildWorkflowCandidateTaskDrafts(synced, ".ax/tasks-test", "merge-evidence").report;
        const dryRun = buildWorkflowCandidateGuidanceProposalPlan(promoted, new Set(), {
            dryRun: true,
            includeStatements: true,
        });

        expect(dryRun.summary.dry_run).toBe(true);
        expect(dryRun.summary.statement_count).toBe(dryRun.statements.length);
        expect(dryRun.summary.statements).toEqual(dryRun.statements);
        expect(dryRun.summary.proposals[0].status).toBe("created_or_refreshed");
        expect(dryRun.summary.proposals[0].dedupe_sig).toStartWith("guidance__workflow_candidate__");
    });

    test("renders compact proposal preview in text reports", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "surrealml",
            taskLike: "exclude",
        });
        const synced = syncWorkflowCandidateReportFromBrief(
            report,
            renderWorkflowCandidateBriefMarkdown(report)
                .replace("- Verdict: `pending`", "- Verdict: `accept`")
                .replace("- Rationale: _pending_", "- Rationale: Promote the prototype completeness guardrail."),
            "brief.md",
        );
        const promoted = buildWorkflowCandidateTaskDrafts(synced, ".ax/tasks-test", "merge-evidence").report;
        const plan = buildWorkflowCandidateGuidanceProposalPlan(promoted, new Set(), {
            dryRun: true,
            includeStatements: true,
            fileTarget: "AGENTS.md",
            section: "Workflow Candidate Guardrails",
        });
        const reportWithPreview = {
            ...promoted,
            promotion: {
                ...promoted.promotion!,
                proposals: plan.summary,
            },
        };

        const output = renderWorkflowCandidateReportText(reportWithPreview);

        expect(output).toContain("promotion proposal writes: dry-run");
        expect(output).toContain("proposal preview:");
        expect(output).toContain("would write guidance__workflow_candidate__");
        expect(output).toContain("proposal: proposal:");
        expect(output).toContain("target: AGENTS.md#Workflow Candidate Guardrails");
        expect(output).toContain("artifact: guidance confidence=medium alternatives=harness_check,classifier_fixture");
    });

    test("renders workflow-candidate proposal list reports", () => {
        const report = buildWorkflowCandidateProposalListReport({
            limit: 10,
            status: "all",
            search: "surrealml",
            rows: [{
                dedupe_sig: "guidance__workflow_candidate__abc",
                title: "Require applied classifier results for surrealml",
                form: "guidance",
                status: "accepted",
                confidence: "medium",
                frequency: 2,
                target: "AGENTS.md",
                section: "Workflow Candidate Guardrails",
                experiment_id: "experiment:abc",
                experiment_status: "scaffolded",
                artifact_path: "CLAUDE.md",
                task_path: ".ax/tasks/guidance__workflow_candidate__abc.md",
                updated_at: "2026-05-30T00:00:00Z",
            }],
        });

        expect(report.totals).toMatchObject({
            proposal_count: 1,
            accepted_count: 1,
            open_count: 0,
            rejected_count: 0,
            scaffolded_experiment_count: 1,
        });
        const output = renderWorkflowCandidateProposalListText(report);
        expect(output).toContain("workflow candidate proposals");
        expect(output).toContain("status: all");
        expect(output).toContain("search: surrealml");
        expect(output).toContain("guidance__workflow_candidate__abc");
        expect(output).toContain("target: AGENTS.md#Workflow Candidate Guardrails");
        expect(output).toContain("experiment: scaffolded (experiment:abc)");
    });

    test("attaches cited classifier evidence to proposal list reports", () => {
        const rows = [{
            proposal_id: "proposal:proposal-a",
            dedupe_sig: "guidance__workflow_candidate__abc",
            title: "Require applied classifier results for surrealml",
            form: "guidance",
            status: "accepted",
            confidence: "medium",
            frequency: 1,
        }];
        const edges: WorkflowCandidateProposalEvidenceEdgeRow[] = [{
            proposal_id: "proposal:proposal-a",
            candidate_ref: "classifier_graph_node:group:correction",
        }];
        const expandedRows = attachWorkflowCandidateProposalEvidence({
            rows,
            edges,
            candidateRows: [groups[1]],
            factRows: [evidence[3]],
            examplesPerCandidate: 1,
        });
        const report = buildWorkflowCandidateProposalListReport({
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            rows: expandedRows,
        });

        expect(report.query.expand_evidence).toBe(true);
        expect(report.totals.evidence_candidate_count).toBe(1);
        expect(report.totals.evidence_example_count).toBe(1);
        expect(report.proposals[0].evidence?.[0]).toMatchObject({
            candidate_id: "group:correction",
            candidate_label: "reaction-event:correction:wrong_output",
            target: "wrong_output",
            proposed_action: "add_context_guardrail",
        });
        const output = renderWorkflowCandidateProposalListText(report);
        expect(output).toContain("evidence candidates: 1, examples: 1");
        expect(output).toContain("reaction-event:correction:wrong_output");
        expect(output).toContain("id: group:correction");
        expect(output).toContain("Did you create the classifier? I want to see results applied to SurrealML.");
    });

    test("builds topic reports joining proposals and ranked classifier candidates", () => {
        const proposalRows = attachWorkflowCandidateProposalEvidence({
            rows: [{
                proposal_id: "proposal:proposal-a",
                dedupe_sig: "guidance__workflow_candidate__abc",
                title: "Require applied classifier results for surrealml",
                form: "guidance",
                status: "accepted",
                confidence: "medium",
                frequency: 1,
                experiment_id: "experiment:abc",
                experiment_status: "scaffolded",
            }],
            edges: [{
                proposal_id: "proposal:proposal-a",
                candidate_ref: "classifier_graph_node:group:correction",
            }],
            candidateRows: [groups[1]],
            factRows: [evidence[3]],
            examplesPerCandidate: 1,
        });
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: proposalRows,
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "surrealml",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "surrealml",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "surrealml",
            proposals,
            candidates,
        });

        expect(report.decision).toBe("workflow_topic_evidence_found");
        expect(report.totals).toMatchObject({
            proposal_count: 1,
            experiment_count: 1,
            proposal_evidence_candidate_count: 1,
            ranked_candidate_count: 1,
            candidate_evidence_fact_count: 1,
            source_turn_count: 1,
        });
        const output = renderWorkflowCandidateTopicReportText(report);
        expect(output).toContain("workflow topic evidence");
        expect(output).toContain("topic: surrealml");
        expect(output).toContain("proposals: 1");
        expect(output).toContain("ranked candidates: 1");
        expect(output).toContain("Require applied classifier results for surrealml");
        expect(output).toContain("reaction-event:correction:wrong_output");
    });

    test("renders topic evidence packs for adjacent unpromoted candidates", () => {
        const proposalRows = attachWorkflowCandidateProposalEvidence({
            rows: [{
                proposal_id: "proposal:proposal-a",
                dedupe_sig: "guidance__workflow_candidate__abc",
                title: "Require applied classifier results for surrealml",
                form: "guidance",
                status: "accepted",
                confidence: "medium",
                frequency: 1,
                target: "AGENTS.md",
                section: "Workflow Candidate Guardrails",
            }],
            edges: [{
                proposal_id: "proposal:proposal-a",
                candidate_ref: "classifier_graph_node:group:correction",
            }],
            candidateRows: [groups[1]],
            factRows: [evidence[3]],
            examplesPerCandidate: 1,
        });
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: proposalRows,
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "surrealml",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: [{
                graph_id: "fact:verify-surrealml",
                subject: "group:verify",
                properties_json: properties({
                    result_id: "result:verify-surrealml",
                    turn: "turn:verify-surrealml",
                    confidence: 0.83,
                    text_excerpt: "Please verify the SurrealML classifier output before calling this done.",
                }),
            }, evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "surrealml",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "surrealml",
            proposals,
            candidates,
        });

        expect(topicAdjacentCandidates(report).map((candidate) => candidate.group_id)).toEqual(["group:verify"]);
        const markdown = renderWorkflowCandidateTopicEvidencePackMarkdown(report);
        expect(markdown).toContain("# Workflow Topic Evidence Pack: surrealml");
        expect(markdown).toContain("Adjacent unpromoted candidate count: `1`");
        expect(markdown).toContain("## Harness Gate Evidence");
        expect(markdown).toContain("- Gate: `unsatisfied`");
        expect(markdown).toContain("- Evidence source: `none`");
        expect(markdown).toContain("- Computed checks: `0 passed, 1 failed (1 checks)`");
        expect(markdown).toContain("- Persisted facts: `0 passed, 0 failed (0 facts)`");
        expect(markdown).toContain("Covers: `reaction-event:correction:wrong_output`");
        expect(markdown).toContain("### verification-event:verification_request:test_required");
        expect(markdown).toContain("- Recommended artifact: `harness_check`");
        expect(markdown).toContain("- Verdict: `pending`");
    });

    test("renders helper review hints on matching adjacent candidates", () => {
        const helperFacts: WorkflowCandidateEmbeddingHelperGraphFactRow[] = [{
            graph_id: "fact:embedding-helper-maintenance",
            subject: "embedding_helper_hard_negative:session-section-chunks/none-maintenance-question",
            predicate: "promoted_hard_negative_fixture",
            object: "classifier_promoted_fixture:session-section-chunks/embedding-helper-hard-negative-session-section-chunks-none-maintenance-question",
            evidence_edges_json: properties(["edge:nearest-surreal-port"]),
            properties_json: properties({
                source_fixture_id: "session-section-chunks/none-maintenance-question",
                status: "accepted",
                proposed_label: "none",
                promoted_fixture_id: "session-section-chunks/embedding-helper-hard-negative-session-section-chunks-none-maintenance-question",
            }),
        }];
        const helperEdges: WorkflowCandidateEmbeddingHelperGraphEdgeRow[] = [{
            graph_id: "edge:nearest-surreal-port",
            kind: "nearest_reviewed_fixture",
            to_id: "classifier_evidence:session-section-chunks/tooling-local-surreal-port",
            evidence_path: ".ax/experiments/embedding-helper-review-current.json",
            properties_json: properties({ similarity: 0.688 }),
        }];
        const helperFixtures: WorkflowCandidateHelperFixtureRow[] = [{
            id: "session-section-chunks/none-maintenance-question",
            text: "USER:\nwhen was the last work around surrealML, do they maintain it?",
        }];
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                label: "environment_or_preference_signal",
                properties_json: properties({
                    classifier_key: "hybrid-window",
                    label: "environment_or_preference_signal",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 50,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:maintenance-question",
                subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                properties_json: properties({
                    turn: "turn:maintenance-question",
                    confidence: 0.71,
                    text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped?",
                }),
            }],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const baseReport = buildWorkflowCandidateTopicReport({
            sourceKind: "hybrid_window_classifier_projection",
            topic: "SurrealML",
            proposals,
            candidates,
        });
        const helperExplanations = buildWorkflowCandidateTopicHelperExplanations({
            report: baseReport,
            facts: helperFacts,
            edges: helperEdges,
            fixtures: helperFixtures,
            minTokenOverlap: 0.72,
        });
        const markdown = renderWorkflowCandidateTopicEvidencePackMarkdown({
            ...baseReport,
            helper_explanations: helperExplanations,
        });

        expect(markdown).toContain("- Helper review hint: `review-as-noise`");
        expect(markdown).toContain("- Helper matched controls: `1`");
        expect(markdown).toContain("- Helper rationale: promoted `none` control `session-section-chunks/none-maintenance-question` matched this candidate example");
        expect(markdown).toContain("- Suggested reviewer verdict: `reject`");
    });

    test("syncs reviewed helper-hinted evidence packs into topic reports", () => {
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                label: "environment_or_preference_signal",
                properties_json: properties({
                    classifier_key: "hybrid-window",
                    label: "environment_or_preference_signal",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 50,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:maintenance-question",
                subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                properties_json: properties({
                    turn: "turn:maintenance-question",
                    confidence: 0.71,
                    text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped?",
                }),
            }],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "hybrid_window_classifier_projection",
            topic: "SurrealML",
            proposals: buildWorkflowCandidateProposalListReport({
                rows: [{
                    proposal_id: "proposal:proposal-a",
                    dedupe_sig: "guidance__workflow_candidate__abc",
                    title: "Require applied classifier results for surrealml",
                    form: "guidance",
                    status: "accepted",
                    confidence: "medium",
                    frequency: 1,
                    target: "AGENTS.md",
                }],
                limit: 10,
                status: "accepted",
                expandEvidence: true,
                search: "SurrealML",
            }),
            candidates,
        });
        const reviewedPack = renderWorkflowCandidateTopicEvidencePackMarkdown(report)
            .replace("- Verdict: `pending`", "- Verdict: `reject`")
            .replace("- Rationale: _pending_", "- Rationale: Promoted helper control marks this as an information request, not a durable preference.");

        const synced = syncWorkflowCandidateTopicReportFromBrief(report, reviewedPack, "topic-pack.md");
        const reviewed = synced.candidates.candidates[0]?.review;

        expect(reviewed).toEqual({
            verdict: "reject",
            rationale: "Promoted helper control marks this as an information request, not a durable preference.",
        });
        expect(synced.candidates.review).toMatchObject({
            synced_from: "topic-pack.md",
            reviewed_candidate_count: 1,
            pending_candidate_count: 0,
        });
        expect(synced.decision).toBe("workflow_topic_evidence_found");
    });

    test("projects synced topic reviews into classifier graph facts", () => {
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                label: "environment_or_preference_signal",
                properties_json: properties({
                    classifier_key: "hybrid-window",
                    label: "environment_or_preference_signal",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 50,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:maintenance-question",
                subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                properties_json: properties({
                    turn: "turn:maintenance-question",
                    confidence: 0.71,
                    text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped?",
                }),
            }],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const baseReport = buildWorkflowCandidateTopicReport({
            sourceKind: "hybrid_window_classifier_projection",
            topic: "SurrealML",
            proposals: buildWorkflowCandidateProposalListReport({
                rows: [{
                    proposal_id: "proposal:proposal-a",
                    dedupe_sig: "guidance__workflow_candidate__abc",
                    title: "Require applied classifier results for surrealml",
                    form: "guidance",
                    status: "accepted",
                    confidence: "medium",
                    frequency: 1,
                    target: "AGENTS.md",
                }],
                limit: 10,
                status: "accepted",
                expandEvidence: true,
                search: "SurrealML",
            }),
            candidates,
        });
        const synced = syncWorkflowCandidateTopicReportFromBrief(
            {
                ...baseReport,
                helper_explanations: {
                    schema: "ax.workflow_candidate_topic_helper_explanations.v1",
                    min_token_overlap: 0.72,
                    explanations: [{
                        source_fixture_id: "session-section-chunks/none-maintenance-question",
                        promoted_fixture_id: "session-section-chunks/embedding-helper-hard-negative-session-section-chunks-none-maintenance-question",
                        fact_id: "fact:embedding-helper-maintenance",
                        status: "accepted",
                        proposed_label: "none",
                        candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                        candidate_label: "environment_or_preference_signal",
                        proposed_action: "record_guidance_or_environment_preference",
                        turn: "turn:maintenance-question",
                        match_score: 1,
                        text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped?",
                        nearest_neighbors: [],
                        evidence_paths: [".ax/experiments/embedding-helper-review-current.json"],
                    }],
                    totals: {
                        promoted_helper_fact_count: 1,
                        fixture_text_count: 1,
                        matched_example_count: 1,
                        matched_candidate_count: 1,
                    },
                },
            },
            [
                "- Candidate id: `classifier_candidate_group:hybrid-window/environment_or_preference_signal`",
                "- Verdict: `reject`",
                "- Rationale: Promoted helper control marks this as an information request, not a durable preference.",
            ].join("\n"),
            "topic-pack.md",
        );

        const projection = buildWorkflowCandidateTopicReviewGraphProjection(synced);
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        expect(projection.schema).toBe("ax.workflow_topic_review_graph_projection.v1");
        expect(projection.totals).toMatchObject({
            reviewed_candidate_count: 1,
            rejected_count: 1,
            node_count: 2,
            edge_count: 2,
            fact_count: 1,
        });
        expect(projection.facts[0]).toMatchObject({
            kind: "workflow_topic_candidate_review",
            predicate: "reject",
            object: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
        });
        expect(projection.facts[0].properties).toMatchObject({
            verdict: "reject",
            synced_from: "topic-pack.md",
            helper_fact_ids: ["fact:embedding-helper-maintenance"],
            helper_source_fixture_ids: ["session-section-chunks/none-maintenance-question"],
        });
        expect(writePlan.schema).toBe("ax.workflow_topic_review_graph_write_plan.v1");
        expect(writePlan.totals).toEqual({
            statement_count: 5,
            node_statement_count: 2,
            edge_statement_count: 2,
            fact_statement_count: 1,
        });
        expect(writePlan.statements.join("\n")).toContain("workflow_topic_candidate_review");
        expect(writePlan.statements.join("\n")).toContain("UPSERT classifier_graph_fact");
    });

    test("renders persisted topic review facts inside topic reports and packs", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                label: "environment_or_preference_signal",
                properties_json: properties({
                    classifier_key: "hybrid-window",
                    label: "environment_or_preference_signal",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 50,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:maintenance-question",
                subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                properties_json: properties({
                    turn: "turn:maintenance-question",
                    confidence: 0.71,
                    text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped?",
                }),
            }],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const persisted_review_facts = buildWorkflowCandidateTopicReviewGraphListReport({
            topic: "SurrealML",
            facts: [{
                graph_id: "fact:surrealml-review",
                subject: "workflow_topic_candidate_review:surrealml:environment",
                predicate: "reject",
                object: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                value_json: properties({ reviewed: true, verdict: "reject" }),
                properties_json: properties({
                    topic: "SurrealML",
                    candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                    rationale: "Promoted helper control marks this as an information request, not a durable preference.",
                    helper_source_fixture_ids: ["session-section-chunks/none-maintenance-question"],
                }),
            }],
            edges: [],
        });
        const report = {
            ...buildWorkflowCandidateTopicReport({
                sourceKind: "hybrid_window_classifier_projection",
                topic: "SurrealML",
                proposals,
                candidates,
            }),
            persisted_review_facts,
        };

        const text = renderWorkflowCandidateTopicReportText(report);
        const markdown = renderWorkflowCandidateTopicEvidencePackMarkdown(report);

        expect(persisted_review_facts.totals).toMatchObject({
            fact_count: 1,
            rejected_count: 1,
            accepted_count: 0,
        });
        expect(text).toContain("persisted review facts: 1");
        expect(text).toContain("persisted review status: 1 rejected, 0 accepted, 0 deferred, 0 revised");
        expect(markdown).toContain("- Persisted review facts: `1`");
        expect(markdown).toContain("## Persisted Review Facts");
        expect(markdown).toContain("- Predicate: `reject`");
        expect(markdown).toContain("- Candidate id: `classifier_candidate_group:hybrid-window/environment_or_preference_signal`");
        expect(markdown).toContain("- Helper source fixture: `session-section-chunks/none-maintenance-question`");
    });

    test("attaches persisted review facts to plain candidate reports without suppressing ranking", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                label: "environment_or_preference_signal",
                properties_json: properties({
                    classifier_key: "hybrid-window",
                    label: "environment_or_preference_signal",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 50,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:maintenance-question",
                subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                properties_json: properties({
                    result_id: "classifier_result:maintenance-question",
                    turn: "turn:maintenance-question",
                    confidence: 0.71,
                    text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped?",
                }),
            }],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });

        const withReviews = attachWorkflowCandidatePersistedReviewFacts(report, [{
            graph_id: "fact:surrealml-review",
            subject: "workflow_topic_candidate_review:surrealml:environment",
            predicate: "reject",
            object: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
            value_json: properties({ reviewed: true, verdict: "reject" }),
            properties_json: properties({
                topic: "surrealml",
                candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                rationale: "Promoted helper control marks this as an information request, not a durable preference.",
                helper_source_fixture_ids: ["session-section-chunks/none-maintenance-question"],
            }),
        }]);
        const text = renderWorkflowCandidateReportText(withReviews);
        const brief = renderWorkflowCandidateBriefMarkdown(withReviews);

        expect(withReviews.decision).toBe("workflow_candidates_ranked");
        expect(withReviews.candidates).toHaveLength(1);
        expect(withReviews.totals.persisted_review_fact_count).toBe(1);
        expect(withReviews.candidates[0]?.persisted_review_facts?.[0]).toMatchObject({
            predicate: "reject",
            topic: "surrealml",
            candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
            helper_source_fixture_ids: ["session-section-chunks/none-maintenance-question"],
        });
        expect(text).toContain("persisted review facts: 1");
        expect(text).toContain("persisted review: reject topic=surrealml");
        expect(brief).toContain("- Persisted review facts: `1`");
        expect(brief).toContain("- Persisted review:");
        expect(brief).toContain("  - Helper source fixture: `session-section-chunks/none-maintenance-question`");
    });

    test("summarizes persisted review coverage across candidate groups", () => {
        const report = buildWorkflowCandidateReviewCoverageReport({
            groupRows: [
                {
                    graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                    label: "environment_or_preference_signal",
                    properties_json: properties({
                        proposed_action: "record_guidance_or_environment_preference",
                        support_count: 50,
                    }),
                },
                {
                    graph_id: "classifier_candidate_group:hybrid-window/output_expectation",
                    label: "output_expectation",
                    properties_json: properties({
                        proposed_action: "record_guidance_or_environment_preference",
                        support_count: 8,
                    }),
                },
            ],
            evidenceRows: [
                {
                    graph_id: "fact:maintenance-question",
                    subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                    properties_json: properties({ text_excerpt: "surrealml maintenance question" }),
                },
                {
                    graph_id: "fact:output",
                    subject: "classifier_candidate_group:hybrid-window/output_expectation",
                    properties_json: properties({ text_excerpt: "show me the results" }),
                },
            ],
            reviewFactRows: [{
                graph_id: "fact:surrealml-review",
                subject: "workflow_topic_candidate_review:surrealml:environment",
                predicate: "reject",
                object: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                properties_json: properties({
                    topic: "surrealml",
                    helper_source_fixture_ids: ["session-section-chunks/none-maintenance-question"],
                }),
            }],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
        });
        const text = renderWorkflowCandidateReviewCoverageText(report);

        expect(report.decision).toBe("workflow_candidate_review_coverage_ready");
        expect(report.totals).toMatchObject({
            candidate_group_count: 2,
            reviewed_candidate_count: 1,
            unreviewed_candidate_count: 1,
            review_fact_count: 1,
            rejected_fact_count: 1,
            helper_source_fixture_count: 1,
        });
        expect(report.candidates[0]).toMatchObject({
            candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
            review_fact_count: 1,
            topics: ["surrealml"],
            helper_source_fixture_ids: ["session-section-chunks/none-maintenance-question"],
        });
        expect(text).toContain("reviewed/unreviewed: 1/1");
        expect(text).toContain("review status: 1 rejected, 0 accepted, 0 deferred, 0 revised");
        expect(text).toContain("helper fixtures: session-section-chunks/none-maintenance-question");
    });

    test("emits review fixtures for review coverage gaps", () => {
        const report = attachWorkflowCandidatePersistedReviewFacts(buildWorkflowCandidateReport({
            groupRows: [
                {
                    graph_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                    label: "environment_or_preference_signal",
                    properties_json: properties({
                        label: "environment_or_preference_signal",
                        proposed_action: "record_guidance_or_environment_preference",
                        support_count: 50,
                    }),
                },
                {
                    graph_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                    label: "verification_or_recovery_signal",
                    properties_json: properties({
                        label: "verification_or_recovery_signal",
                        proposed_action: "add_verification_gate",
                        support_count: 41,
                    }),
                },
            ],
            evidenceRows: [
                {
                    graph_id: "fact:maintenance-question",
                    subject: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                    properties_json: properties({
                        result_id: "classifier_result:maintenance-question",
                        turn: "turn:maintenance-question",
                        confidence: 0.71,
                        text_excerpt: "USER: when was the last work around surrealML ? do they actively maintain it or stopped?",
                    }),
                },
                {
                    graph_id: "fact:verification",
                    subject: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                    properties_json: properties({
                        result_id: "classifier_result:verification",
                        turn: "turn:verification",
                        confidence: 0.83,
                        text_excerpt: "continue and make sure the tests prove this does not regress",
                    }),
                },
            ],
            sourceKind: "hybrid_window_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        }), [{
            graph_id: "fact:surrealml-review",
            subject: "workflow_topic_candidate_review:surrealml:environment",
            predicate: "reject",
            object: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
            properties_json: properties({ topic: "surrealml" }),
        }]);

        const summary = buildWorkflowCandidateReviewCoverageFixtureSummary(
            report,
            ".ax/experiments/workflow-candidate-review-coverage-gaps.jsonl",
        );

        expect(summary).toMatchObject({
            emitted_fixture_count: 1,
            candidate_count: 1,
            skipped_candidate_count: 1,
        });
        expect(summary.fixtures[0]).toMatchObject({
            suite: "workflow-candidate-review-coverage",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            candidate_support_count: 1,
            candidate_evidence_count: 1,
            candidate_score: 1.1931,
            result_id: "classifier_result:verification",
            turn: "turn:verification",
            confidence: 0.83,
            review_status: "pending",
        });
        expect(summary.fixtures[0]?.id).toContain("workflow-candidate-review-coverage/verification_or_recovery_signal/");
        expect(summary.fixtures[0]?.text).toBe("USER:\ncontinue and make sure the tests prove this does not regress\n\nPREVIOUS_ASSISTANT:\n");
    });

    test("projects reviewed coverage-gap fixtures into review graph facts", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl([
            JSON.stringify({
                id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
                suite: "workflow-candidate-review-coverage",
                name: "coverage-gap-verification_or_recovery_signal-01",
                label: "verification_or_recovery_signal",
                target: "unknown",
                text: "USER:\ncontinue and make sure the tests prove this does not regress\n\nPREVIOUS_ASSISTANT:\n",
                source_group: "workflow-candidate",
                review_status: "accept",
                review_rationale: "This is useful verification/recovery behavior to preserve as review context.",
                review_reviewer: "reviewer@example.test",
                review_reviewed_at: "2026-05-31T10:00:00Z",
                topic: "review-coverage",
                candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                candidate_label: "verification_or_recovery_signal",
                proposed_action: "add_verification_gate",
                result_id: "classifier_result:verification",
                turn: "turn:verification",
                confidence: 0.83,
            }),
            JSON.stringify({
                id: "workflow-candidate-review-coverage/correction_or_rejection_signal/b",
                suite: "workflow-candidate-review-coverage",
                name: "coverage-gap-correction_or_rejection_signal-01",
                label: "correction_or_rejection_signal",
                target: "unknown",
                text: "USER:\nthis is not bad but I need another scenario\n\nPREVIOUS_ASSISTANT:\n",
                source_group: "workflow-candidate",
                review_status: "pending",
                topic: "review-coverage",
                candidate_id: "classifier_candidate_group:hybrid-window/correction_or_rejection_signal",
                candidate_label: "correction_or_rejection_signal",
                proposed_action: "add_context_guardrail",
                turn: "turn:correction",
                confidence: 0.61,
            }),
        ].join("\n"));

        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        expect(projection).toMatchObject({
            schema: "ax.workflow_topic_review_graph_projection.v1",
            source_report_schema: "ax.workflow_candidate_review_coverage_fixture_pack.v1",
            topic: "review-coverage",
            totals: {
                reviewed_candidate_count: 1,
                accepted_count: 1,
                rejected_count: 0,
                fact_count: 1,
            },
        });
        expect(projection.facts[0]).toMatchObject({
            kind: "workflow_topic_candidate_review",
            predicate: "accept",
            object: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            properties: {
                fixture_id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
                rationale: "This is useful verification/recovery behavior to preserve as review context.",
                reviewer: "reviewer@example.test",
                reviewed_at: "2026-05-31T10:00:00Z",
                synced_from: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            },
        });
        expect(writePlan.totals.fact_statement_count).toBe(1);
        expect(writePlan.statements.join("\n")).toContain("workflow_topic_candidate_review");
    });

    test("blocks smoke-marked coverage review packs from apply", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and make sure the tests prove this does not regress\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "accept",
            review_rationale: "Smoke review: useful verification or recovery behavior worth preserving as review context.",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            turn: "turn:verification",
        }));
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/reviewed-smoke.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-smoke.jsonl",
            projection,
            writePlan,
            applyRequested: true,
            applied: false,
        });

        expect(summary).toMatchObject({
            schema: "ax.workflow_candidate_review_readiness.v1",
            apply_requested: true,
            applied: false,
            apply_result: "blocked",
            applied_statement_count: 0,
            reviewed_fixture_count: 1,
            pending_fixture_count: 0,
            invalid_fixture_count: 0,
            missing_rationale_count: 0,
            smoke_marker_count: 2,
            apply_guard: "blocked_smoke_review",
            can_apply: false,
            apply_blockers: ["blocked_smoke_review"],
            apply_blocker_details: [{
                blocker: "blocked_smoke_review",
                count: 2,
                remediation: "Replace smoke or example review markers with real review decisions.",
            }],
            next_action: "Replace smoke or example review markers with real review decisions before applying.",
            reviewed_fixture_ids: ["workflow-candidate-review-coverage/verification_or_recovery_signal/a"],
        });
        expect(summary.projected_fact_ids).toHaveLength(1);
        expect(summary.projected_fact_ids[0]).toStartWith("fact:workflow_topic_candidate_review__review_coverage__");
        expect(summary.projection_totals.fact_count).toBe(1);
        expect(summary.write_plan_totals.fact_statement_count).toBe(1);
    });

    test("reports pending coverage review packs as not ready to apply", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and make sure the tests prove this does not regress\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "pending",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            turn: "turn:verification",
        }));
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/pending-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/pending-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: false,
            applied: false,
        });
        const text = renderWorkflowCandidateReviewCoverageText({
            schema: "ax.workflow_candidate_review_coverage.v1",
            source_kind: "hybrid_window_classifier_projection",
            query: { limit: 10 },
            candidates: [],
            totals: {
                candidate_group_count: 0,
                returned_candidate_count: 0,
                reviewed_candidate_count: 0,
                unreviewed_candidate_count: 0,
                review_fact_count: 0,
                rejected_fact_count: 0,
                accepted_fact_count: 0,
                deferred_fact_count: 0,
                revised_fact_count: 0,
                helper_source_fixture_count: 0,
            },
            coverage_review: summary,
            decision: "needs_workflow_candidate_reviews",
        });

        expect(summary).toMatchObject({
            schema: "ax.workflow_candidate_review_readiness.v1",
            apply_requested: false,
            applied: false,
            apply_result: "not_requested",
            applied_statement_count: 0,
            reviewed_fixture_count: 0,
            pending_fixture_count: 1,
            invalid_fixture_count: 0,
            missing_rationale_count: 0,
            missing_reviewer_count: 0,
            missing_reviewed_at_count: 0,
            smoke_marker_count: 0,
            apply_guard: "no_reviewed_fixtures",
            can_apply: false,
            apply_blockers: ["no_reviewed_fixtures"],
            apply_blocker_details: [{
                blocker: "no_reviewed_fixtures",
                count: 1,
                remediation: "Review at least one fixture and add a rationale before applying.",
            }],
            next_action: "Set at least one fixture to accept, revise, reject, or defer and add a rationale.",
            reviewed_fixture_ids: [],
            projected_fact_ids: [],
        });
        expect(text).toContain("coverage review schema: ax.workflow_candidate_review_readiness.v1");
        expect(text).toContain("coverage review can apply: no");
        expect(text).toContain("coverage review blockers: no_reviewed_fixtures");
        expect(text).toContain("coverage review blocker details: no_reviewed_fixtures=1");
        expect(text).toContain("coverage review blocker remediations: no_reviewed_fixtures: Review at least one fixture and add a rationale before applying.");
        expect(text).toContain("coverage review audit ids: fixtures=0 facts=0");
        expect(text).toContain("coverage review next action: Set at least one fixture to accept, revise, reject, or defer and add a rationale.");
        expect(summary.projection_totals.fact_count).toBe(0);
        expect(summary.write_plan_totals.statement_count).toBe(1);
    });

    test("reports reviewed coverage rows without rationale as not ready to apply", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and make sure the tests prove this does not regress\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "accept",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            turn: "turn:verification",
        }));
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: true,
            applied: false,
        });

        expect(summary).toMatchObject({
            schema: "ax.workflow_candidate_review_readiness.v1",
            apply_result: "blocked",
            applied_statement_count: 0,
            reviewed_fixture_count: 1,
            pending_fixture_count: 0,
            invalid_fixture_count: 0,
            missing_rationale_count: 1,
            apply_guard: "missing_review_rationale",
            can_apply: false,
            apply_blockers: ["missing_review_rationale"],
            apply_blocker_details: [{
                blocker: "missing_review_rationale",
                count: 1,
                remediation: "Add rationale text to each reviewed fixture.",
            }],
            next_action: "Add rationale text for every reviewed fixture.",
            reviewed_fixture_ids: ["workflow-candidate-review-coverage/verification_or_recovery_signal/a"],
        });
        expect(summary.projected_fact_ids).toHaveLength(1);
    });

    test("renders and syncs coverage review briefs back into fixture rows", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and make sure the tests prove this does not regress\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "pending",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            result_id: "classifier_result:verification",
            turn: "turn:verification",
            confidence: 0.83,
        }));
        const brief = renderWorkflowCandidateReviewCoverageBriefMarkdown(rows, {
            sourceKind: "hybrid_window_classifier_projection",
            coverageFixturePack: ".ax/experiments/review-coverage.jsonl",
            coverageReviewBrief: ".ax/experiments/review-coverage.md",
            outputPath: ".ax/experiments/review-coverage.json",
        });
        const reviewedBrief = brief
            .replace("- Review status: `pending`", "- Review status: `accept`")
            .replace("- Review rationale: _pending_", "- Review rationale: Useful recovery behavior worth preserving.")
            .replace("- Reviewer: _pending_", "- Reviewer: reviewer@example.test")
            .replace("- Reviewed at: _pending_", "- Reviewed at: 2026-05-31T10:00:00Z");

        const synced = syncWorkflowCandidateFixtureRowsFromBrief(rows, reviewedBrief);

        expect(brief).toContain("# Workflow Candidate Coverage Review");
        expect(brief).toContain("## Review Queue Summary");
        expect(brief).toContain("- Fixtures: `1`");
        expect(brief).toContain("- Candidate groups: `1`");
        expect(brief).toContain("- Pending fixtures: `1`");
        expect(brief).toContain("- Reviewed fixtures: `0`");
        expect(brief).toContain("- Accepted fixtures: `0`");
        expect(brief).toContain("- Revised fixtures: `0`");
        expect(brief).toContain("- Rejected fixtures: `0`");
        expect(brief).toContain("- Deferred fixtures: `0`");
        expect(brief).toContain("- Invalid fixtures: `0`");
        expect(brief).toContain("- Complete rationales: `0`");
        expect(brief).toContain("- Missing rationales: `0`");
        expect(brief).toContain("- Missing reviewers: `0`");
        expect(brief).toContain("- Missing reviewed-at timestamps: `0`");
        expect(brief).toContain("- Invalid reviewed-at timestamps: `0`");
        expect(brief).toContain("- Provenance status: `complete_review_provenance`");
        expect(brief).toContain("- Handoff status: `complete_review_handoff`");
        expect(brief).toContain("- Handoff missing paths: `none`");
        expect(brief).toContain("- Handoff apply guard: `no_reviewed_fixtures`");
        expect(brief).toContain("- Handoff blockers: `no_reviewed_fixtures`");
        expect(brief).toContain("- Handoff blocker remediations: no_reviewed_fixtures: Review at least one fixture and add a rationale before applying.");
        expect(brief).toContain("- Strict provenance apply guard: `no_reviewed_fixtures`");
        expect(brief).toContain("- Strict provenance blockers: `no_reviewed_fixtures`");
        expect(brief).toContain("- Strict provenance blocker remediations: no_reviewed_fixtures: Review at least one fixture and add a rationale before applying.");
        expect(brief).toContain("- Production apply guard: `no_reviewed_fixtures`");
        expect(brief).toContain("- Production blockers: `no_reviewed_fixtures`");
        expect(brief).toContain("- Production blocker remediations: no_reviewed_fixtures: Review at least one fixture and add a rationale before applying.");
        expect(brief).toContain("- Production next action: Set at least one fixture to accept, revise, reject, or defer and add a rationale.");
        expect(brief).toContain("- Smoke markers: `0`");
        expect(brief).toContain("- Apply guard: `no_reviewed_fixtures`");
        expect(brief).toContain("- Apply blockers: `no_reviewed_fixtures`");
        expect(brief).toContain("- Blocker remediations: no_reviewed_fixtures: Review at least one fixture and add a rationale before applying.");
        expect(brief).toContain("- Next action: Set at least one fixture to accept, revise, reject, or defer and add a rationale.");
        expect(brief).toContain("## Review Commands");
        expect(brief).toContain("--coverage-review-pack=.ax/experiments/review-coverage.jsonl");
        expect(brief).toContain("--sync-coverage-review-brief=.ax/experiments/review-coverage.md");
        expect(brief).toContain("--apply-review-facts");
        expect(brief).toContain("--require-review-provenance");
        expect(brief).toContain("--require-review-handoff");
        expect(brief).toContain("To inspect the review graph write before applying, run:");
        expect(brief).toContain("--review-facts=.ax/experiments/review-coverage-review-facts.json");
        expect(brief).toContain("--review-write-plan=.ax/experiments/review-coverage-review-write-plan.json");
        expect(brief).toContain("bun src/cli/index.ts classifiers workflow-candidates --review-coverage --source-kind=hybrid_window_classifier_projection --coverage-review-pack=.ax/experiments/review-coverage.jsonl --sync-coverage-review-brief=.ax/experiments/review-coverage.md --coverage-review-brief=.ax/experiments/review-coverage.md --review-facts=.ax/experiments/review-coverage-review-facts.json --review-write-plan=.ax/experiments/review-coverage-review-write-plan.json --apply-review-facts --require-review-provenance --require-review-handoff --out=.ax/experiments/review-coverage.json --json");
        expect(brief).toContain("To stamp provenance from a review service, run:");
        expect(brief).toContain("--review-provenance-reviewer=<reviewer>");
        expect(brief).toContain("--review-provenance-reviewed-at=<reviewed-at-iso>");
        expect(brief).toContain("After applying, re-run coverage to verify the gap closed:");
        expect(brief).toContain("bun src/cli/index.ts classifiers workflow-candidates --review-coverage --source-kind=hybrid_window_classifier_projection --limit=10 --out=.ax/experiments/review-coverage-post-apply.json --json");
        expect(brief).toContain("## Candidate Queue");
        expect(brief).toContain("verification_or_recovery_signal");
        expect(brief).toContain("- Fixture id: `workflow-candidate-review-coverage/verification_or_recovery_signal/a`");
        expect(brief).toContain("- Review impact: `new_candidate_review`");
        expect(brief).toContain("- Review status: `pending`");
        expect(brief).toContain("- Reviewer: _pending_");
        expect(brief).toContain("- Reviewed at: _pending_");
        expect(synced[0]).toMatchObject({
            review_status: "accept",
            review_rationale: "Useful recovery behavior worth preserving.",
            review_reviewer: "reviewer@example.test",
            review_reviewed_at: "2026-05-31T10:00:00Z",
        });
    });

    test("reports invalid and unknown coverage review brief sync entries", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and make sure the tests prove this does not regress\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "pending",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            result_id: "classifier_result:verification",
            turn: "turn:verification",
            confidence: 0.83,
        }));
        const brief = `${renderWorkflowCandidateReviewCoverageBriefMarkdown(rows)
            .replace("- Review status: `pending`", "- Review status: `maybe`")
            .replace("- Review rationale: _pending_", "- Review rationale: Invalid status should be reported.")}
## Fixture 99: unknown

- Fixture id: \`workflow-candidate-review-coverage/unknown/x\`
- Review status: \`accept\`
- Review rationale: Unknown row should be reported.
`;

        const syncResult = syncWorkflowCandidateFixtureRowsFromBriefWithSummary(rows, brief);
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows: syncResult.rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);
        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows: syncResult.rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: true,
            applied: false,
            syncedFixtureCount: syncResult.synced_fixture_count,
            unknownFixtureCount: syncResult.unknown_fixture_count,
            coverageRows: [{
                candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                label: "verification_or_recovery_signal",
                proposed_action: "add_verification_gate",
                support_count: 41,
                evidence_count: 41,
                review_fact_count: 0,
                topics: [],
                verdict_counts: { reject: 0, accept: 0, defer: 0, revise: 0, other: 0 },
                helper_source_fixture_ids: [],
            }],
        });

        expect(syncResult.synced_fixture_count).toBe(1);
        expect(syncResult.unknown_fixture_count).toBe(1);
        expect(syncResult.rows[0]).toMatchObject({
            review_status: "maybe",
            review_rationale: "Invalid status should be reported.",
        });
        expect(summary).toMatchObject({
            schema: "ax.workflow_candidate_review_readiness.v1",
            apply_result: "blocked",
            applied_statement_count: 0,
            reviewed_fixture_count: 0,
            pending_fixture_count: 1,
            invalid_fixture_count: 1,
            synced_fixture_count: 1,
            unknown_fixture_count: 1,
            missing_reviewer_count: 0,
            missing_reviewed_at_count: 0,
            pack_candidate_count: 0,
            new_candidate_count: 0,
            existing_candidate_count: 0,
            unknown_candidate_count: 0,
            projected_reviewed_candidate_count: 0,
            projected_unreviewed_candidate_count: 1,
            apply_guard: "invalid_review_pack",
            can_apply: false,
            apply_blockers: ["invalid_review_pack", "no_reviewed_fixtures"],
            apply_blocker_details: [
                {
                    blocker: "invalid_review_pack",
                    count: 1,
                    remediation: "Replace invalid review statuses with accept, revise, reject, defer, or pending.",
                },
                {
                    blocker: "no_reviewed_fixtures",
                    count: 1,
                    remediation: "Review at least one fixture and add a rationale before applying.",
                },
            ],
            next_action: "Fix invalid review statuses before syncing or applying.",
            reviewed_fixture_ids: [],
            projected_fact_ids: [],
        });
    });

    test("reports coverage review pack impact across new existing and unknown candidates", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl([
            JSON.stringify({
                id: "workflow-candidate-review-coverage/new/a",
                suite: "workflow-candidate-review-coverage",
                name: "coverage-gap-new-01",
                label: "verification_or_recovery_signal",
                target: "unknown",
                text: "USER:\ncontinue and test it\n\nPREVIOUS_ASSISTANT:\n",
                source_group: "workflow-candidate",
                review_status: "accept",
                review_rationale: "Useful verification behavior worth preserving.",
                topic: "review-coverage",
                candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                candidate_label: "verification_or_recovery_signal",
                proposed_action: "add_verification_gate",
                result_id: "classifier_result:verification",
                turn: "turn:verification",
                confidence: 0.83,
            }),
            JSON.stringify({
                id: "workflow-candidate-review-coverage/existing/a",
                suite: "workflow-candidate-review-coverage",
                name: "coverage-gap-existing-01",
                label: "environment_or_preference_signal",
                target: "unknown",
                text: "USER:\nuse uv for this Python package work\n\nPREVIOUS_ASSISTANT:\n",
                source_group: "workflow-candidate",
                review_status: "reject",
                review_rationale: "Already covered by the existing preference review.",
                topic: "review-coverage",
                candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                candidate_label: "environment_or_preference_signal",
                proposed_action: "record_guidance_or_environment_preference",
                result_id: "classifier_result:environment",
                turn: "turn:environment",
                confidence: 0.72,
            }),
            JSON.stringify({
                id: "workflow-candidate-review-coverage/unknown/a",
                suite: "workflow-candidate-review-coverage",
                name: "coverage-gap-unknown-01",
                label: "unknown_signal",
                target: "unknown",
                text: "USER:\nunknown candidate fixture\n\nPREVIOUS_ASSISTANT:\n",
                source_group: "workflow-candidate",
                review_status: "defer",
                review_rationale: "Needs a broader candidate query.",
                topic: "review-coverage",
                candidate_id: "classifier_candidate_group:hybrid-window/unknown_signal",
                candidate_label: "unknown_signal",
                proposed_action: "review_section_pattern",
                result_id: "classifier_result:unknown",
                turn: "turn:unknown",
                confidence: 0.61,
            }),
        ].join("\n"));
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);
        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: false,
            applied: false,
            reviewFactsPath: ".ax/experiments/reviewed-coverage-facts.json",
            reviewWritePlanPath: ".ax/experiments/reviewed-coverage-write-plan.json",
            reviewBriefPath: ".ax/experiments/reviewed-coverage.md",
            syncedReviewBriefPath: ".ax/experiments/reviewed-coverage-edited.md",
            coverageRows: [
                {
                    candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                    label: "verification_or_recovery_signal",
                    proposed_action: "add_verification_gate",
                    support_count: 41,
                    evidence_count: 41,
                    review_fact_count: 0,
                    topics: [],
                    verdict_counts: { reject: 0, accept: 0, defer: 0, revise: 0, other: 0 },
                    helper_source_fixture_ids: [],
                },
                {
                    candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                    label: "environment_or_preference_signal",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 50,
                    evidence_count: 50,
                    review_fact_count: 1,
                    topics: ["surrealml"],
                    verdict_counts: { reject: 1, accept: 0, defer: 0, revise: 0, other: 0 },
                    helper_source_fixture_ids: ["session-section-chunks/none-maintenance-question"],
                },
            ],
        });

        expect(summary).toMatchObject({
            schema: "ax.workflow_candidate_review_readiness.v1",
            apply_result: "not_requested",
            applied_statement_count: 0,
            reviewed_fixture_count: 3,
            missing_reviewer_count: 3,
            missing_reviewed_at_count: 3,
            provenance_status: "missing_review_provenance",
            provenance_next_action: "Add reviewer and reviewed-at metadata before applying if audit provenance is required.",
            pack_candidate_count: 3,
            new_candidate_count: 1,
            existing_candidate_count: 1,
            unknown_candidate_count: 1,
            projected_reviewed_candidate_count: 2,
            projected_unreviewed_candidate_count: 0,
            apply_guard: "ready_to_apply",
            can_apply: true,
            apply_blockers: [],
            apply_blocker_details: [],
            strict_apply_guard: "missing_review_provenance",
            strict_can_apply: false,
            strict_apply_blockers: ["missing_review_provenance"],
            strict_apply_blocker_details: [{
                blocker: "missing_review_provenance",
                count: 6,
                remediation: "Add reviewer and valid reviewed-at metadata or rerun without strict provenance.",
            }],
            production_apply_guard: "missing_review_provenance",
            production_can_apply: false,
            production_apply_blockers: ["missing_review_provenance"],
            production_apply_blocker_details: [{
                blocker: "missing_review_provenance",
                count: 6,
                remediation: "Add reviewer and valid reviewed-at metadata or rerun without strict provenance.",
            }],
            production_next_action: "Add reviewer and reviewed-at metadata, or rerun without strict provenance if legacy review packs are acceptable.",
            production_apply_command: "bun src/cli/index.ts classifiers workflow-candidates --review-coverage --source-kind=hybrid_window_classifier_projection --coverage-review-pack=.ax/experiments/reviewed-coverage-gaps.jsonl --sync-coverage-review-brief=.ax/experiments/reviewed-coverage-edited.md --coverage-review-brief=.ax/experiments/reviewed-coverage.md --review-facts=.ax/experiments/reviewed-coverage-facts.json --review-write-plan=.ax/experiments/reviewed-coverage-write-plan.json --apply-review-facts --require-review-provenance --require-review-handoff --out=.ax/experiments/workflow-candidate-review-coverage-post-apply.json --json",
            next_action: "Run the apply command after confirming the review pack is intentional.",
            reviewed_fixture_ids: [
                "workflow-candidate-review-coverage/new/a",
                "workflow-candidate-review-coverage/existing/a",
                "workflow-candidate-review-coverage/unknown/a",
            ],
            post_apply_recheck_command: "bun src/cli/index.ts classifiers workflow-candidates --review-coverage --source-kind=hybrid_window_classifier_projection --limit=10 --out=.ax/experiments/workflow-candidate-review-coverage-post-apply.json --json",
        });
        expect(summary.review_facts_path).toBe(".ax/experiments/reviewed-coverage-facts.json");
        expect(summary.review_write_plan_path).toBe(".ax/experiments/reviewed-coverage-write-plan.json");
        expect(summary.review_brief_path).toBe(".ax/experiments/reviewed-coverage.md");
        expect(summary.synced_review_brief_path).toBe(".ax/experiments/reviewed-coverage-edited.md");
        expect(summary.review_handoff_status).toBe("complete_review_handoff");
        expect(summary.review_handoff_missing_paths).toEqual([]);
        expect(summary.handoff_apply_guard).toBe("ready_to_apply");
        expect(summary.handoff_can_apply).toBe(true);
        expect(summary.handoff_apply_blockers).toEqual([]);
        expect(summary.handoff_apply_blocker_details).toEqual([]);
        const text = renderWorkflowCandidateReviewCoverageText({
            schema: "ax.workflow_candidate_review_coverage.v1",
            source_kind: "hybrid_window_classifier_projection",
            query: { limit: 10 },
            candidates: [],
            totals: {
                candidate_group_count: 0,
                returned_candidate_count: 0,
                reviewed_candidate_count: 0,
                unreviewed_candidate_count: 0,
                review_fact_count: 0,
                rejected_fact_count: 0,
                accepted_fact_count: 0,
                deferred_fact_count: 0,
                revised_fact_count: 0,
                helper_source_fixture_count: 0,
            },
            coverage_review: summary,
            decision: "needs_workflow_candidate_reviews",
        });
        expect(text).toContain("coverage review facts path: .ax/experiments/reviewed-coverage-facts.json");
        expect(text).toContain("coverage review write plan path: .ax/experiments/reviewed-coverage-write-plan.json");
        expect(text).toContain("coverage review brief path: .ax/experiments/reviewed-coverage.md");
        expect(text).toContain("coverage review synced brief path: .ax/experiments/reviewed-coverage-edited.md");
        expect(text).toContain("coverage review handoff status: complete_review_handoff");
        expect(text).toContain("coverage review handoff missing paths: none");
        expect(text).toContain("coverage review handoff apply guard: ready_to_apply");
        expect(text).toContain("coverage review handoff can apply: yes");
        expect(text).toContain("coverage review production apply guard: missing_review_provenance");
        expect(text).toContain("coverage review production can apply: no");
        expect(text).toContain("coverage review production next action: Add reviewer and reviewed-at metadata, or rerun without strict provenance if legacy review packs are acceptable.");
        expect(text).toContain("coverage review production apply command: bun src/cli/index.ts classifiers workflow-candidates --review-coverage --source-kind=hybrid_window_classifier_projection --coverage-review-pack=.ax/experiments/reviewed-coverage-gaps.jsonl --sync-coverage-review-brief=.ax/experiments/reviewed-coverage-edited.md --coverage-review-brief=.ax/experiments/reviewed-coverage.md --review-facts=.ax/experiments/reviewed-coverage-facts.json --review-write-plan=.ax/experiments/reviewed-coverage-write-plan.json --apply-review-facts --require-review-provenance --require-review-handoff --out=.ax/experiments/workflow-candidate-review-coverage-post-apply.json --json");
        const incompleteHandoff = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: false,
            applied: false,
        });
        expect(incompleteHandoff.review_handoff_status).toBe("incomplete_review_handoff");
        expect(incompleteHandoff.review_handoff_missing_paths).toEqual([
            "review_facts_path",
            "review_write_plan_path",
            "review_brief_path",
            "synced_review_brief_path",
        ]);
        expect(incompleteHandoff.handoff_apply_guard).toBe("missing_review_handoff");
        expect(incompleteHandoff.handoff_can_apply).toBe(false);
        expect(incompleteHandoff.handoff_apply_blockers).toEqual(["missing_review_handoff"]);
        expect(incompleteHandoff.handoff_apply_blocker_details).toEqual([{
            blocker: "missing_review_handoff",
            count: 4,
            remediation: "Run the review handoff command with review facts, write plan, rendered brief, and synced brief paths before applying.",
        }]);
        expect(incompleteHandoff.production_apply_guard).toBe("missing_review_provenance");
        expect(incompleteHandoff.production_can_apply).toBe(false);
        expect(incompleteHandoff.production_apply_blockers).toEqual([
            "missing_review_provenance",
            "missing_review_handoff",
        ]);
        expect(incompleteHandoff.production_apply_command).toBeUndefined();
        const requiredIncompleteHandoff = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: true,
            applied: false,
            requireReviewHandoff: true,
        });
        expect(requiredIncompleteHandoff.apply_guard).toBe("missing_review_handoff");
        expect(requiredIncompleteHandoff.can_apply).toBe(false);
        expect(requiredIncompleteHandoff.apply_blockers).toEqual(["missing_review_handoff"]);
        expect(requiredIncompleteHandoff.apply_blocker_details).toEqual([{
            blocker: "missing_review_handoff",
            count: 4,
            remediation: "Run the review handoff command with review facts, write plan, rendered brief, and synced brief paths before applying.",
        }]);
        expect(requiredIncompleteHandoff.next_action).toBe("Complete the review handoff artifacts before applying.");
        expect(summary.projected_fact_ids).toHaveLength(3);
        expect(summary.apply_audit_rows).toEqual([
            {
                fixture_id: "workflow-candidate-review-coverage/new/a",
                candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                verdict: "accept",
                projected_fact_id: summary.projected_fact_ids[0],
                reviewer: "",
                reviewed_at: "",
            },
            {
                fixture_id: "workflow-candidate-review-coverage/existing/a",
                candidate_id: "classifier_candidate_group:hybrid-window/environment_or_preference_signal",
                verdict: "reject",
                projected_fact_id: summary.projected_fact_ids[1],
                reviewer: "",
                reviewed_at: "",
            },
            {
                fixture_id: "workflow-candidate-review-coverage/unknown/a",
                candidate_id: "classifier_candidate_group:hybrid-window/unknown_signal",
                verdict: "defer",
                projected_fact_id: summary.projected_fact_ids[2],
                reviewer: "",
                reviewed_at: "",
            },
        ]);
    });

    test("blocks coverage review apply when strict provenance is required", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and verify the fix\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "accept",
            review_rationale: "Useful verification behavior worth preserving.",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            result_id: "classifier_result:verification",
            turn: "turn:verification",
            confidence: 0.83,
        }));
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: true,
            applied: false,
            requireReviewProvenance: true,
        });
        const text = renderWorkflowCandidateReviewCoverageText({
            schema: "ax.workflow_candidate_review_coverage.v1",
            source_kind: "hybrid_window_classifier_projection",
            query: { limit: 10 },
            candidates: [],
            totals: {
                candidate_group_count: 0,
                returned_candidate_count: 0,
                reviewed_candidate_count: 0,
                unreviewed_candidate_count: 0,
                review_fact_count: 0,
                rejected_fact_count: 0,
                accepted_fact_count: 0,
                deferred_fact_count: 0,
                revised_fact_count: 0,
                helper_source_fixture_count: 0,
            },
            coverage_review: summary,
            decision: "needs_workflow_candidate_reviews",
        });
        expect(summary).toMatchObject({
            apply_requested: true,
            apply_result: "blocked",
            apply_guard: "missing_review_provenance",
            can_apply: false,
            strict_apply_guard: "missing_review_provenance",
            strict_can_apply: false,
            missing_reviewer_count: 1,
            missing_reviewed_at_count: 1,
            invalid_reviewed_at_count: 0,
            provenance_status: "missing_review_provenance",
            apply_blockers: ["missing_review_provenance"],
            apply_blocker_details: [{
                blocker: "missing_review_provenance",
                count: 2,
                remediation: "Add reviewer and valid reviewed-at metadata or rerun without strict provenance.",
            }],
            strict_apply_blockers: ["missing_review_provenance"],
            strict_apply_blocker_details: [{
                blocker: "missing_review_provenance",
                count: 2,
                remediation: "Add reviewer and valid reviewed-at metadata or rerun without strict provenance.",
            }],
            next_action: "Add reviewer and reviewed-at metadata, or rerun without strict provenance if legacy review packs are acceptable.",
            provenance_issue_rows: [
                {
                    fixture_id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
                    candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                    issue: "missing_reviewer",
                    reviewer: "",
                    reviewed_at: "",
                },
                {
                    fixture_id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
                    candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                    issue: "missing_reviewed_at",
                    reviewer: "",
                    reviewed_at: "",
                },
            ],
        });
        expect(text).toContain("coverage review apply guard: missing_review_provenance");
        expect(text).toContain("coverage review can apply: no");
        expect(text).toContain("coverage review strict apply guard: missing_review_provenance");
        expect(text).toContain("coverage review strict can apply: no");
        expect(text).toContain("coverage review blockers: missing_review_provenance");
        expect(text).toContain("coverage review blocker remediations: missing_review_provenance: Add reviewer and valid reviewed-at metadata or rerun without strict provenance.");
        expect(text).toContain("coverage review strict blockers: missing_review_provenance");
        expect(text).toContain("coverage review strict blocker details: missing_review_provenance=2");
        expect(text).toContain("coverage review provenance issue rows: 2");
        expect(text).toContain("coverage review provenance issue: missing_reviewer fixture=workflow-candidate-review-coverage/verification_or_recovery_signal/a candidate=classifier_candidate_group:hybrid-window/verification_or_recovery_signal reviewed_at=none");
        expect(text).toContain("coverage review provenance issue: missing_reviewed_at fixture=workflow-candidate-review-coverage/verification_or_recovery_signal/a candidate=classifier_candidate_group:hybrid-window/verification_or_recovery_signal reviewed_at=none");
        expect(text).toContain("coverage review post-apply recheck: bun src/cli/index.ts classifiers workflow-candidates --review-coverage --source-kind=hybrid_window_classifier_projection --limit=10 --out=.ax/experiments/workflow-candidate-review-coverage-post-apply.json --json");
    });

    test("blocks strict provenance apply when reviewed-at is invalid", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and verify the fix\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "accept",
            review_rationale: "Useful verification behavior worth preserving.",
            review_reviewer: "reviewer@example.test",
            review_reviewed_at: "not-a-date",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            result_id: "classifier_result:verification",
            turn: "turn:verification",
            confidence: 0.83,
        }));
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: true,
            applied: false,
            requireReviewProvenance: true,
        });
        const brief = renderWorkflowCandidateReviewCoverageBriefMarkdown(rows, {
            sourceKind: "hybrid_window_classifier_projection",
            coverageReviewPack: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            coverageReviewBrief: ".ax/experiments/reviewed-coverage-gaps.md",
            outputPath: ".ax/experiments/reviewed-coverage-gaps.json",
        });

        expect(summary).toMatchObject({
            apply_result: "blocked",
            apply_guard: "missing_review_provenance",
            can_apply: false,
            strict_apply_guard: "missing_review_provenance",
            strict_can_apply: false,
            missing_reviewer_count: 0,
            missing_reviewed_at_count: 0,
            invalid_reviewed_at_count: 1,
            provenance_status: "missing_review_provenance",
            apply_blockers: ["missing_review_provenance"],
            apply_blocker_details: [{
                blocker: "missing_review_provenance",
                count: 1,
                remediation: "Add reviewer and valid reviewed-at metadata or rerun without strict provenance.",
            }],
            strict_apply_blockers: ["missing_review_provenance"],
            strict_apply_blocker_details: [{
                blocker: "missing_review_provenance",
                count: 1,
                remediation: "Add reviewer and valid reviewed-at metadata or rerun without strict provenance.",
            }],
            provenance_issue_rows: [{
                fixture_id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
                candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
                issue: "invalid_reviewed_at",
                reviewer: "reviewer@example.test",
                reviewed_at: "not-a-date",
            }],
        });
        expect(brief).toContain("## Provenance Issues");
        expect(brief).toContain("- `invalid_reviewed_at` fixture=`workflow-candidate-review-coverage/verification_or_recovery_signal/a` candidate=`classifier_candidate_group:hybrid-window/verification_or_recovery_signal` reviewed_at=`not-a-date`");
    });

    test("stamps explicit review provenance on reviewed coverage rows", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and verify the fix\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "accept",
            review_rationale: "Useful verification behavior worth preserving.",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            result_id: "classifier_result:verification",
            turn: "turn:verification",
            confidence: 0.83,
        }));
        const stamped = stampWorkflowCandidateReviewProvenance(rows, {
            reviewer: "reviewer@example.test",
            reviewedAt: "2026-05-31T10:00:00Z",
        });
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows: stamped.rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);
        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows: stamped.rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: false,
            applied: false,
            stampedReviewerCount: stamped.stamped_reviewer_count,
            stampedReviewedAtCount: stamped.stamped_reviewed_at_count,
            requireReviewProvenance: true,
        });
        const text = renderWorkflowCandidateReviewCoverageText({
            schema: "ax.workflow_candidate_review_coverage.v1",
            source_kind: "hybrid_window_classifier_projection",
            query: { limit: 10 },
            candidates: [],
            totals: {
                candidate_group_count: 0,
                returned_candidate_count: 0,
                reviewed_candidate_count: 0,
                unreviewed_candidate_count: 0,
                review_fact_count: 0,
                rejected_fact_count: 0,
                accepted_fact_count: 0,
                deferred_fact_count: 0,
                revised_fact_count: 0,
                helper_source_fixture_count: 0,
            },
            coverage_review: summary,
            decision: "needs_workflow_candidate_reviews",
        });

        expect(stamped).toMatchObject({
            stamped_reviewer_count: 1,
            stamped_reviewed_at_count: 1,
            rows: [{
                review_reviewer: "reviewer@example.test",
                review_reviewed_at: "2026-05-31T10:00:00Z",
            }],
        });
        expect(summary).toMatchObject({
            stamped_reviewer_count: 1,
            stamped_reviewed_at_count: 1,
            missing_reviewer_count: 0,
            missing_reviewed_at_count: 0,
            invalid_reviewed_at_count: 0,
            provenance_status: "complete_review_provenance",
            apply_guard: "ready_to_apply",
            can_apply: true,
            strict_apply_guard: "ready_to_apply",
            strict_can_apply: true,
            strict_apply_blockers: [],
            provenance_issue_rows: [],
        });
        expect(text).toContain("coverage review provenance stamp: reviewer=1 reviewed_at=1");
        expect(text).toContain("coverage review strict can apply: yes");
    });

    test("summarizes post-apply coverage recheck deltas", () => {
        const summary = buildWorkflowCandidateReviewCoveragePostApplyRecheckSummary({
            before: {
                reviewedCandidateCount: 1,
                unreviewedCandidateCount: 2,
                projectedReviewedCandidateCount: 2,
                projectedUnreviewedCandidateCount: 1,
            },
            after: {
                reviewedCandidateCount: 2,
                unreviewedCandidateCount: 1,
            },
            command: "bun src/cli/index.ts classifiers workflow-candidates --review-coverage --out=.ax/experiments/post.json --json",
        });

        expect(summary).toEqual({
            schema: "ax.workflow_candidate_review_coverage_recheck.v1",
            status: "gap_closed",
            before_reviewed_candidate_count: 1,
            before_unreviewed_candidate_count: 2,
            projected_reviewed_candidate_count: 2,
            projected_unreviewed_candidate_count: 1,
            after_reviewed_candidate_count: 2,
            after_unreviewed_candidate_count: 1,
            reviewed_candidate_delta: 1,
            unreviewed_candidate_delta: -1,
            projected_reviewed_delta: 0,
            projected_unreviewed_delta: 0,
            command: "bun src/cli/index.ts classifiers workflow-candidates --review-coverage --out=.ax/experiments/post.json --json",
        });
    });

    test("reports applied coverage review statement counts", () => {
        const rows = parseWorkflowCandidateFixtureRowsJsonl(JSON.stringify({
            id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            suite: "workflow-candidate-review-coverage",
            name: "coverage-gap-verification_or_recovery_signal-01",
            label: "verification_or_recovery_signal",
            target: "unknown",
            text: "USER:\ncontinue and verify the fix\n\nPREVIOUS_ASSISTANT:\n",
            source_group: "workflow-candidate",
            review_status: "accept",
            review_rationale: "Useful verification behavior worth preserving.",
            review_reviewer: "reviewer@example.test",
            review_reviewed_at: "2026-05-31T10:00:00Z",
            topic: "review-coverage",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            candidate_label: "verification_or_recovery_signal",
            proposed_action: "add_verification_gate",
            result_id: "classifier_result:verification",
            turn: "turn:verification",
            confidence: 0.83,
        }));
        const projection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
            rows,
            syncedFrom: ".ax/experiments/reviewed-coverage-gaps.jsonl",
        });
        const writePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(projection);

        const summary = buildWorkflowCandidateReviewCoverageApplySummary({
            rows,
            sourcePath: ".ax/experiments/reviewed-coverage-gaps.jsonl",
            projection,
            writePlan,
            applyRequested: true,
            applied: true,
        });
        const text = renderWorkflowCandidateReviewCoverageText({
            schema: "ax.workflow_candidate_review_coverage.v1",
            source_kind: "hybrid_window_classifier_projection",
            query: { limit: 10 },
            candidates: [],
            totals: {
                candidate_group_count: 0,
                returned_candidate_count: 0,
                reviewed_candidate_count: 0,
                unreviewed_candidate_count: 0,
                review_fact_count: 0,
                rejected_fact_count: 0,
                accepted_fact_count: 0,
                deferred_fact_count: 0,
                revised_fact_count: 0,
                helper_source_fixture_count: 0,
            },
            coverage_review: summary,
            decision: "needs_workflow_candidate_reviews",
        });

        expect(summary).toMatchObject({
            apply_requested: true,
            applied: true,
            apply_result: "applied",
            applied_statement_count: writePlan.totals.statement_count,
            apply_guard: "ready_to_apply",
            can_apply: true,
            missing_reviewer_count: 0,
            missing_reviewed_at_count: 0,
            provenance_status: "complete_review_provenance",
            provenance_next_action: "Review provenance is complete.",
        });
        expect(summary.apply_audit_rows).toEqual([{
            fixture_id: "workflow-candidate-review-coverage/verification_or_recovery_signal/a",
            candidate_id: "classifier_candidate_group:hybrid-window/verification_or_recovery_signal",
            verdict: "accept",
            projected_fact_id: summary.projected_fact_ids[0],
            reviewer: "reviewer@example.test",
            reviewed_at: "2026-05-31T10:00:00Z",
        }]);
        expect(text).toContain(`coverage review apply result: applied statements=${writePlan.totals.statement_count}`);
        expect(text).toContain("coverage review provenance: missing_reviewer=0 missing_reviewed_at=0");
        expect(text).toContain("coverage review provenance status: complete_review_provenance");
        expect(text).toContain("coverage review provenance next action: Review provenance is complete.");
        expect(text).toContain("coverage review audit rows: 1");
        expect(text).toContain(
            `coverage review audit row: accept fixture=workflow-candidate-review-coverage/verification_or_recovery_signal/a candidate=classifier_candidate_group:hybrid-window/verification_or_recovery_signal fact=${summary.projected_fact_ids[0]} reviewer=reviewer@example.test reviewed_at=2026-05-31T10:00:00Z`,
        );
    });

    test("renders persisted harness facts inside topic evidence packs", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = {
            ...buildWorkflowCandidateTopicReport({
                sourceKind: "transcript_classifier_projection",
                topic: "SurrealML",
                proposals,
                candidates,
            }),
            persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                topic: "SurrealML",
                facts: [{
                    graph_id: "fact:surrealml-harness",
                    subject: "workflow_topic_harness_check:surrealml:output-required",
                    predicate: "passed",
                    object: "classifier_candidate_group:verification",
                    value_json: properties({ passed: true }),
                    properties_json: properties({
                        topic: "SurrealML",
                        candidate_id: "classifier_candidate_group:verification",
                    }),
                }],
                edges: [],
            }),
        };

        const markdown = renderWorkflowCandidateTopicEvidencePackMarkdown(report);

        expect(markdown).toContain("- Persisted harness facts: `1`");
        expect(markdown).toContain("- Persisted harness status: `1 passed, 0 failed`");
        expect(markdown).toContain("- Gate: `satisfied`");
        expect(markdown).toContain("- Evidence source: `persisted`");
        expect(markdown).toContain("- Persisted facts: `1 passed, 0 failed (1 facts)`");
        expect(markdown).toContain("## Persisted Harness Facts");
        expect(markdown).toContain("### fact:surrealml-harness");
        expect(markdown).toContain("- Candidate id: `classifier_candidate_group:verification`");
    });

    test("builds classifier fixture review rows from adjacent topic candidates", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "group:direction",
                label: "direction-event:direction:output_expectation",
                properties_json: properties({
                    classifier_key: "direction-event",
                    label: "direction",
                    target: "output_expectation",
                    proposed_action: "record_guidance_or_environment_preference",
                    support_count: 1,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:direction-surrealml",
                subject: "group:direction",
                properties_json: properties({
                    result_id: "classifier_result:direction_event__0_1_0__event_window__surrealml",
                    turn: "turn:direction-surrealml",
                    confidence: 0.82,
                    text_excerpt: "I want to see the classifier results applied to SurrealML.",
                }),
            }],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "SurrealML",
            proposals,
            candidates,
        });

        const rows = buildWorkflowCandidateTopicClassifierFixtureRows(report);
        const summary = buildWorkflowCandidateTopicClassifierFixtureSummary(report, ".ax/fixtures/surrealml.jsonl");
        const text = renderWorkflowCandidateTopicReportText({ ...report, classifier_fixtures: summary });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            suite: "workflow-candidate-topic",
            label: "direction",
            target: "output_expectation",
            source_group: "workflow-candidate",
            review_status: "pending",
            topic: "SurrealML",
            candidate_id: "group:direction",
            proposed_action: "record_guidance_or_environment_preference",
            result_id: "classifier_result:direction_event__0_1_0__event_window__surrealml",
            turn: "turn:direction-surrealml",
            confidence: 0.82,
        });
        expect(rows[0].id).toContain("workflow-candidate-topic/surrealml/direction_event__direction__output_expectation/");
        expect(rows[0].text).toBe("USER:\nI want to see the classifier results applied to SurrealML.\n\nPREVIOUS_ASSISTANT:\n");
        expect(summary).toMatchObject({
            path: ".ax/fixtures/surrealml.jsonl",
            emitted_fixture_count: 1,
            candidate_count: 1,
            skipped_candidate_count: 0,
        });
        expect(text).toContain("classifier fixture pack: 1 fixtures");
        expect(text).toContain("classifier fixture path: .ax/fixtures/surrealml.jsonl");
    });

    test("builds task drafts for adjacent topic candidates only", () => {
        const proposalRows = attachWorkflowCandidateProposalEvidence({
            rows: [{
                proposal_id: "proposal:proposal-a",
                dedupe_sig: "guidance__workflow_candidate__abc",
                title: "Require applied classifier results for surrealml",
                form: "guidance",
                status: "accepted",
                confidence: "medium",
                frequency: 1,
            }],
            edges: [{
                proposal_id: "proposal:proposal-a",
                candidate_ref: "classifier_graph_node:group:correction",
            }],
            candidateRows: [groups[1]],
            factRows: [evidence[3]],
            examplesPerCandidate: 1,
        });
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: proposalRows,
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "surrealml",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: [{
                graph_id: "fact:verify-surrealml",
                subject: "group:verify",
                properties_json: properties({
                    result_id: "result:verify-surrealml",
                    turn: "turn:verify-surrealml",
                    confidence: 0.83,
                    text_excerpt: "Please verify the SurrealML classifier output before calling this done.",
                }),
            }, evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "surrealml",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "surrealml",
            proposals,
            candidates,
        });

        const { summary, drafts } = buildWorkflowCandidateTopicTaskDrafts(report, ".ax/tasks-test");

        expect(summary.emitted_task_count).toBe(1);
        expect(summary.tasks[0]).toMatchObject({
            candidate_id: "group:verify",
            label: "verification-event:verification_request:test_required",
            verdict: "pending",
            recommended_artifact: { primary: "harness_check" },
        });
        expect(drafts).toHaveLength(1);
        expect(drafts[0].path).toContain("workflow-candidate-verification-event-verification-request-test-required");
        expect(drafts[0].content).toContain("**Candidate:** `group:verify`");
        expect(drafts[0].content).toContain("- Primary: `harness_check`");
        expect(drafts[0].content).toContain("- Result: `result:verify-surrealml`");
    });

    test("builds harness-check proposal plans for adjacent harness candidates", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "surrealml",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[0]],
            evidenceRows: [{
                graph_id: "fact:verify-surrealml",
                subject: "group:verify",
                properties_json: properties({
                    result_id: "result:verify-surrealml",
                    turn: "turn:verify-surrealml",
                    confidence: 0.83,
                    text_excerpt: "Please verify the SurrealML classifier output before calling this done.",
                }),
            }],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "surrealml",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "surrealml",
            proposals,
            candidates,
        });

        const plan = buildWorkflowCandidateHarnessProposalPlan(report, new Set(), {
            dryRun: true,
            includeStatements: true,
        });

        expect(plan.summary.dry_run).toBe(true);
        expect(plan.summary.emitted_proposal_count).toBe(1);
        expect(plan.summary.proposals[0]).toMatchObject({
            candidate_id: "group:verify",
            recommended_artifact: { primary: "harness_check" },
            status: "created_or_refreshed",
        });
        expect(plan.summary.proposals[0].dedupe_sig).toStartWith("harness_check__workflow_candidate__");
        expect(plan.statements.join("\n")).toContain("harness_check");
        expect(plan.statements.join("\n")).toContain("->cites_evidence:");
        expect(plan.summary.statements).toEqual(plan.statements);
    });

    test("passes topic harness checks only with applied classifier result evidence", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "group:output-required",
                label: "verification-event:verification_request:output_required",
                properties_json: properties({
                    classifier_key: "verification-event",
                    label: "verification_request",
                    target: "output_required",
                    proposed_action: "add_verification_gate",
                    support_count: 2,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:surrealml-output-required",
                subject: "group:output-required",
                properties_json: properties({
                    result_id: "classifier_result:verification_event__0_1_0__event_window__38cbc794d9d58e54",
                    turn: "turn:surrealml-output-required",
                    confidence: 0.84,
                    text_excerpt: "Did you create classifier? I do not want just html, I want to see the results applied to SurrealML.",
                }),
            }],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "SurrealML",
            proposals,
            candidates,
        });

        const checks = buildWorkflowCandidateTopicHarnessChecks(report);

        expect(checks.failed_count).toBe(0);
        expect(checks.passed_count).toBe(1);
        expect(checks.checks[0]).toMatchObject({
            candidate_id: "group:output-required",
            status: "passed",
        });
        expect(checks.checks[0].evidence_refs).toContain("classifier_result:verification_event__0_1_0__event_window__38cbc794d9d58e54");
        expect(report.harness_checks?.passed_count).toBe(1);
        expect(report.harness_evidence).toMatchObject({
            gate_satisfied: true,
            gate_evidence_source: "computed",
            computed_check_count: 1,
            computed_passed_count: 1,
            persisted_fact_count: 0,
        });
        expect(renderWorkflowCandidateTopicReportText(report)).toContain("harness checks: 1 passed, 0 failed");
        expect(renderWorkflowCandidateTopicReportText(report)).toContain("harness gate: satisfied (computed)");
        expect(workflowCandidateTopicHarnessGateFailures(report)).toEqual([]);
    });

    test("fails topic harness checks when the evidence stops at html without classifier results", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "group:output-required",
                label: "verification-event:verification_request:output_required",
                properties_json: properties({
                    classifier_key: "verification-event",
                    label: "verification_request",
                    target: "output_required",
                    proposed_action: "add_verification_gate",
                    support_count: 1,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:html-only",
                subject: "group:output-required",
                properties_json: properties({
                    result_id: "result:html-only",
                    turn: "turn:html-only",
                    confidence: 0.8,
                    text_excerpt: "Open the html for me.",
                }),
            }],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "html",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "SurrealML",
            proposals,
            candidates,
        });

        const checks = buildWorkflowCandidateTopicHarnessChecks(report);

        expect(checks.passed_count).toBe(0);
        expect(checks.failed_count).toBe(1);
        expect(checks.checks[0].failures).toContain("missing applied classifier result evidence for topic");
        expect(workflowCandidateTopicHarnessGateFailures(report)).toEqual([
            "harness check group__output_required__applied_classifier_result_evidence failed: missing applied classifier result evidence for topic",
        ]);
    });

    test("topic harness gates fail when no executable checks are present", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "SurrealML",
            proposals,
            candidates,
        });

        expect(report.harness_checks).toBeUndefined();
        expect(report.harness_evidence).toMatchObject({
            gate_satisfied: false,
            gate_evidence_source: "none",
        });
        expect(workflowCandidateTopicHarnessGateFailures(report)).toEqual([
            "no passing topic harness checks were produced or persisted",
        ]);
    });

    test("topic harness gates pass with persisted passing harness facts and no executable checks", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = {
            ...buildWorkflowCandidateTopicReport({
                sourceKind: "transcript_classifier_projection",
                topic: "SurrealML",
                proposals,
                candidates,
            }),
            persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                topic: "SurrealML",
                facts: [{
                    graph_id: "fact:surrealml-harness",
                    subject: "workflow_topic_harness_check:surrealml:output-required",
                    predicate: "passed",
                    object: "group:verify",
                    value_json: properties({ passed: true }),
                    properties_json: properties({
                        topic: "SurrealML",
                        candidate_id: "group:verify",
                    }),
                }],
                edges: [],
            }),
        };

        expect(report.harness_checks).toBeUndefined();
        expect(buildWorkflowCandidateTopicHarnessEvidenceSummary(report)).toMatchObject({
            gate_satisfied: true,
            gate_evidence_source: "persisted",
            computed_check_count: 0,
            persisted_fact_count: 1,
            persisted_passed_count: 1,
        });
        expect(workflowCandidateTopicHarnessGateFailures(report)).toEqual([]);
    });

    test("topic harness gates fail with only persisted failed harness facts", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = {
            ...buildWorkflowCandidateTopicReport({
                sourceKind: "transcript_classifier_projection",
                topic: "SurrealML",
                proposals,
                candidates,
            }),
            persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                topic: "SurrealML",
                facts: [{
                    graph_id: "fact:surrealml-harness-failed",
                    subject: "workflow_topic_harness_check:surrealml:output-required",
                    predicate: "failed",
                    object: "group:verify",
                    value_json: properties({ passed: false }),
                    properties_json: properties({
                        topic: "SurrealML",
                        candidate_id: "group:verify",
                    }),
                }],
                edges: [],
            }),
        };

        expect(report.harness_checks).toBeUndefined();
        expect(buildWorkflowCandidateTopicHarnessEvidenceSummary(report)).toMatchObject({
            gate_satisfied: false,
            gate_evidence_source: "none",
            computed_check_count: 0,
            persisted_fact_count: 1,
            persisted_failed_count: 1,
        });
        expect(workflowCandidateTopicHarnessGateFailures(report)).toEqual([
            "no passing topic harness checks were produced or persisted",
        ]);
    });

    test("projects topic harness checks into classifier graph facts and write plans", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [{
                graph_id: "group:output-required",
                label: "verification-event:verification_request:output_required",
                properties_json: properties({
                    classifier_key: "verification-event",
                    label: "verification_request",
                    target: "output_required",
                    proposed_action: "add_verification_gate",
                    support_count: 2,
                }),
            }],
            evidenceRows: [{
                graph_id: "fact:surrealml-output-required",
                subject: "group:output-required",
                properties_json: properties({
                    result_id: "classifier_result:verification_event__0_1_0__event_window__38cbc794d9d58e54",
                    turn: "turn:surrealml-output-required",
                    confidence: 0.84,
                    text_excerpt: "Did you create classifier? I do not want just html, I want to see the results applied to SurrealML.",
                }),
            }],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 2,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = buildWorkflowCandidateTopicReport({
            sourceKind: "transcript_classifier_projection",
            topic: "SurrealML",
            proposals,
            candidates,
        });

        const projection = buildWorkflowCandidateTopicHarnessGraphProjection(report);
        const writePlan = buildWorkflowCandidateTopicHarnessGraphWritePlan(projection);

        expect(projection.schema).toBe("ax.workflow_topic_harness_graph_projection.v1");
        expect(projection.totals).toMatchObject({
            check_count: 1,
            passed_count: 1,
            failed_count: 0,
            node_count: 2,
            edge_count: 2,
            fact_count: 1,
        });
        expect(projection.facts[0]).toMatchObject({
            kind: "workflow_topic_harness_check",
            predicate: "passed",
            object: "group:output-required",
        });
        expect(projection.facts[0].properties.evidence_refs).toEqual([
            "classifier_result:verification_event__0_1_0__event_window__38cbc794d9d58e54",
            "turn:surrealml-output-required",
        ]);
        expect(writePlan.schema).toBe("ax.workflow_topic_harness_graph_write_plan.v1");
        expect(writePlan.totals).toEqual({
            statement_count: 5,
            node_statement_count: 2,
            edge_statement_count: 2,
            fact_statement_count: 1,
        });
        expect(writePlan.statements.join("\n")).toContain("UPSERT classifier_graph_fact");
        expect(writePlan.statements.join("\n")).toContain("workflow_topic_harness_check");
    });

    test("renders persisted topic harness graph fact lists", () => {
        const report = buildWorkflowCandidateTopicHarnessGraphListReport({
            topic: "SurrealML",
            facts: [{
                graph_id: "fact:surrealml-harness",
                subject: "workflow_topic_harness_check:surrealml:output-required",
                predicate: "passed",
                object: "classifier_candidate_group:verification",
                value_json: properties({ passed: true }),
                properties_json: properties({ topic: "SurrealML" }),
            }],
            edges: [{
                graph_id: "edge:surrealml-harness",
                kind: "harness_check_checks_candidate",
                from_id: "workflow_topic_harness_check:surrealml:output-required",
                to_id: "classifier_candidate_group:verification",
                evidence_path: "classifier_result:verification",
                properties_json: properties({ topic: "SurrealML" }),
            }],
        });

        expect(report.totals).toEqual({
            fact_count: 1,
            edge_count: 1,
            passed_count: 1,
            failed_count: 0,
        });
        const output = renderWorkflowCandidateTopicHarnessGraphListText(report);
        expect(output).toContain("workflow topic harness graph facts");
        expect(output).toContain("topic: SurrealML");
        expect(output).toContain("passed: 1");
        expect(output).toContain("fact:surrealml-harness");
    });

    test("renders persisted harness facts inside topic reports", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[1]],
            evidenceRows: [evidence[3]],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const persisted_harness_facts = buildWorkflowCandidateTopicHarnessGraphListReport({
            topic: "SurrealML",
            facts: [{
                graph_id: "fact:surrealml-harness",
                subject: "workflow_topic_harness_check:surrealml:output-required",
                predicate: "passed",
                object: "classifier_candidate_group:verification",
                value_json: properties({ passed: true }),
                properties_json: properties({ topic: "SurrealML" }),
            }],
            edges: [{
                graph_id: "edge:surrealml-harness",
                kind: "harness_check_checks_candidate",
                from_id: "workflow_topic_harness_check:surrealml:output-required",
                to_id: "classifier_candidate_group:verification",
                evidence_path: "classifier_result:verification",
                properties_json: properties({ topic: "SurrealML" }),
            }],
        });
        const report = {
            ...buildWorkflowCandidateTopicReport({
                sourceKind: "transcript_classifier_projection",
                topic: "SurrealML",
                proposals,
                candidates,
            }),
            persisted_harness_facts,
        };

        const output = renderWorkflowCandidateTopicReportText(report);

        expect(output).toContain("persisted harness facts: 1");
        expect(output).toContain("persisted harness edges: 1");
        expect(output).toContain("persisted harness status: 1 passed, 0 failed");
        expect(output).toContain("harness gate: satisfied (persisted)");
        expect(output).toContain("harness gate computed: 0 passed, 0 failed (0 checks)");
        expect(output).toContain("harness gate persisted: 1 passed, 0 failed (1 facts)");
        expect(output).toContain("fact:surrealml-harness");
    });

    test("persisted harness facts count as topic candidate coverage", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[0]],
            evidenceRows: [{
                graph_id: "fact:verify-surrealml",
                subject: "group:verify",
                properties_json: properties({
                    result_id: "classifier_result:verification_event__0_1_0__event_window__38cbc794d9d58e54",
                    turn: "turn:verify-surrealml",
                    confidence: 0.83,
                    text_excerpt: "Did you create classifier? I want to see the results applied to SurrealML.",
                }),
            }],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = {
            ...buildWorkflowCandidateTopicReport({
                sourceKind: "transcript_classifier_projection",
                topic: "SurrealML",
                proposals,
                candidates,
            }),
            persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                topic: "SurrealML",
                facts: [{
                    graph_id: "fact:surrealml-harness",
                    subject: "workflow_topic_harness_check:surrealml:output-required",
                    predicate: "passed",
                    object: "group:verify",
                    value_json: properties({ passed: true }),
                    properties_json: properties({
                        topic: "SurrealML",
                        candidate_id: "group:verify",
                    }),
                }],
                edges: [],
            }),
        };

        expect(topicAdjacentCandidates(report)).toEqual([]);
        const { summary, drafts } = buildWorkflowCandidateTopicTaskDrafts(report, ".ax/tasks-test");
        expect(summary.emitted_task_count).toBe(0);
        expect(drafts).toEqual([]);
        const plan = buildWorkflowCandidateHarnessProposalPlan(report, new Set(), { dryRun: true });
        expect(plan.summary.emitted_proposal_count).toBe(0);
    });

    test("failed persisted harness facts do not count as topic candidate coverage", () => {
        const proposals = buildWorkflowCandidateProposalListReport({
            rows: [],
            limit: 10,
            status: "accepted",
            expandEvidence: true,
            search: "SurrealML",
        });
        const candidates = buildWorkflowCandidateReport({
            groupRows: [groups[0]],
            evidenceRows: [{
                graph_id: "fact:verify-surrealml",
                subject: "group:verify",
                properties_json: properties({
                    result_id: "classifier_result:verification_event__0_1_0__event_window__38cbc794d9d58e54",
                    turn: "turn:verify-surrealml",
                    confidence: 0.83,
                    text_excerpt: "Did you create classifier? I want to see the results applied to SurrealML.",
                }),
            }],
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            search: "SurrealML",
            taskLike: "include",
        });
        const report = {
            ...buildWorkflowCandidateTopicReport({
                sourceKind: "transcript_classifier_projection",
                topic: "SurrealML",
                proposals,
                candidates,
            }),
            persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                topic: "SurrealML",
                facts: [{
                    graph_id: "fact:surrealml-harness-failed",
                    subject: "workflow_topic_harness_check:surrealml:output-required",
                    predicate: "failed",
                    object: "group:verify",
                    value_json: properties({ passed: false }),
                    properties_json: properties({
                        topic: "SurrealML",
                        candidate_id: "group:verify",
                    }),
                }],
                edges: [],
            }),
        };

        expect(topicAdjacentCandidates(report).map((candidate) => candidate.group_id)).toEqual(["group:verify"]);
        const { summary, drafts } = buildWorkflowCandidateTopicTaskDrafts(report, ".ax/tasks-test");
        expect(summary.emitted_task_count).toBe(1);
        expect(drafts).toHaveLength(1);
        const plan = buildWorkflowCandidateHarnessProposalPlan(report, new Set(), { dryRun: true });
        expect(plan.summary.emitted_proposal_count).toBe(1);
    });

    test("promotion blocks without synced review", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        });
        const result = buildWorkflowCandidateTaskDrafts(report, ".ax/tasks-test");

        expect(result.drafts).toHaveLength(0);
        expect(result.report.promotion?.failures).toContain("review sync required before promotion");
        expect(result.report.decision).toBe("needs_workflow_candidate_review");
    });

    test("renders promoted workflow candidate task markdown", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups.slice(1),
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        });
        const synced = syncWorkflowCandidateReportFromBrief(
            report,
            renderWorkflowCandidateBriefMarkdown(report)
                .replace("- Verdict: `pending`", "- Verdict: `revise`")
                .replace("- Rationale: _pending_", "- Rationale: Merge this with the accepted artifact guardrail."),
            "brief.md",
        );
        const markdown = renderWorkflowCandidateTaskMarkdown(synced.candidates[0], synced);

        expect(markdown).toContain("**Verdict:** `revise`");
        expect(markdown).toContain("**Proposed graph action:** `add_context_guardrail`");
        expect(markdown).toContain("Merge this with the accepted artifact guardrail.");
        expect(markdown).toContain("## Promotion Recommendation");
        expect(markdown).toContain("- Primary: `guidance`");
        expect(markdown).toContain("- Turn: `turn:3`");
        expect(markdown).toContain("- Result: `result:3`");
    });

    test("renders merged workflow candidate task markdown", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        });
        const synced = syncWorkflowCandidateReportFromBrief(
            report,
            renderWorkflowCandidateBriefMarkdown(report)
                .replace("- Verdict: `pending`", "- Verdict: `accept`")
                .replace("- Rationale: _pending_", "- Rationale: Use one merged task."),
            "brief.md",
        );
        const markdown = renderMergedWorkflowCandidateTaskMarkdown([synced.candidates[0], synced.candidates[1]], synced);

        expect(markdown).toContain("**Action:** draft merged candidate-backed improvement");
        expect(markdown).toContain("## Candidate Signals");
        expect(markdown).toContain("## Promotion Recommendation");
        expect(markdown).toContain(synced.candidates[0].group_id);
        expect(markdown).toContain(synced.candidates[1].group_id);
    });

    test("recommends harness checks for verification-gate candidates", () => {
        const report = buildWorkflowCandidateReport({
            groupRows: groups,
            evidenceRows: evidence,
            sourceKind: "transcript_classifier_projection",
            limit: 10,
            examplesPerGroup: 1,
            taskLike: "include",
        });

        const verify = report.candidates.find((candidate) => candidate.group_id === "group:verify");
        expect(verify).toBeDefined();
        expect(recommendWorkflowCandidatePromotionArtifact([verify!], report)).toMatchObject({
            primary: "harness_check",
            confidence: "high",
        });
    });
});
