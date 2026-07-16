import { Effect, FileSystem, Path, type PlatformError } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { prettyPrint } from "@ax/lib/json";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import { recordRef, surrealString } from "@ax/lib/shared/surql";
import { ClassifierReviewPipelineService, ClassifierReviewPipelineServiceLive, type ClassifierReviewPipelineInputValues, nodeFileOutputVerifier } from "../classifiers/review-pipeline-service.ts";
import { catchDbErrorAndExit } from "./output.ts";
import {
    workflowCandidateSql,
    WORKFLOW_CANDIDATE_PROPOSAL_PREFIXES,
    isObject,
    topicFromPropertiesJson,
    asString,
    syncWorkflowCandidateReportFromBrief,
    syncWorkflowCandidateTopicReportFromBrief,
    buildWorkflowCandidateGuidanceProposalPlan,
    buildWorkflowCandidateTaskDrafts,
    buildWorkflowCandidateReport,
    attachWorkflowCandidatePersistedReviewFacts,
    buildWorkflowCandidateReviewCoverageReport,
    renderWorkflowCandidateReviewCoverageText,
    renderWorkflowCandidateReportText,
    renderWorkflowCandidateProposalListText,
    attachWorkflowCandidateProposalEvidence,
    buildWorkflowCandidateProposalListReport,
    buildWorkflowCandidateTopicReport,
    renderWorkflowCandidateTopicReportText,
    withWorkflowCandidateTopicHarnessEvidence,
    buildWorkflowCandidateTopicGuidanceDecisionBatchReport,
    buildWorkflowCandidateGuidancePendingReviewTask,
    parseWorkflowCandidateGuidancePendingReviewTaskMarkdown,
    buildWorkflowCandidateGuidancePendingReviewContextRepairReport,
    renderWorkflowCandidateGuidancePendingReviewContextRepairText,
    workflowCandidateTurnContextRowSql,
    workflowCandidatePreviousAssistantSql,
    buildWorkflowCandidateGuidancePendingReviewTaskListReport,
    renderWorkflowCandidateGuidancePendingReviewTaskListText,
    buildWorkflowCandidateGuidancePendingReviewHandoffSummary,
    renderWorkflowCandidateTopicGuidanceDecisionBatchText,
    withWorkflowCandidateTopicGuidanceDecision,
    buildWorkflowCandidateTopicHelperExplanations,
    workflowCandidateTopicHarnessGateFailures,
    buildWorkflowCandidateTopicHarnessGraphProjection,
    buildWorkflowCandidateTopicHarnessGraphWritePlan,
    buildWorkflowCandidateTopicReviewGraphProjection,
    buildWorkflowCandidateReviewCoveragePostApplyRecheckSummary,
    parseWorkflowCandidateFixtureRowsJsonl,
    renderWorkflowCandidateReviewCoverageBriefMarkdown,
    syncWorkflowCandidateFixtureRowsFromBriefWithSummary,
    stampWorkflowCandidateReviewProvenance,
    buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures,
    buildWorkflowCandidateReviewCoverageApplySummary,
    buildWorkflowCandidateTopicReviewGraphWritePlan,
    buildWorkflowCandidateTopicHarnessGraphListReport,
    buildWorkflowCandidateTopicReviewGraphListReport,
    withWorkflowCandidateTopicPersistedReviewCandidates,
    renderWorkflowCandidateTopicHarnessGraphListText,
    buildWorkflowCandidateTopicTaskDrafts,
    buildWorkflowCandidateTopicClassifierFixtureSummary,
    buildWorkflowCandidateAcceptedClassifierFixtureSummary,
    buildWorkflowCandidateReviewCoverageFixtureSummary,
    renderClassifierFixtureRowsJsonl,
    buildWorkflowCandidateHarnessProposalPlan,
    renderWorkflowCandidateTopicEvidencePackMarkdown,
    renderWorkflowCandidateBriefMarkdown,
} from "../classifiers/workflow-candidate-helpers.ts";
import type {
    WorkflowCandidateGuidancePendingReviewTaskSummary,
    WorkflowCandidateCommandInput,
    WorkflowCandidateProposalListRow,
    WorkflowCandidateProposalEvidenceEdgeRow,
    WorkflowCandidateTopicReport,
    WorkflowCandidateTopicGuidanceDecisionReport,
    WorkflowCandidateGuidancePendingReviewHandoffSummary,
    WorkflowCandidateGuidancePendingReviewTaskListFilters,
    WorkflowCandidateGuidancePendingReviewTaskListReport,
    WorkflowCandidateGuidancePendingReviewContextRepairTurnContext,
    WorkflowCandidateTopicClassifierFixtureSummary,
    WorkflowCandidateReviewCoverageFixtureSummary,
    WorkflowCandidateReviewCoverageApplySummary,
    WorkflowCandidateTopicHarnessGraphFactRow,
    WorkflowCandidateTopicHarnessGraphEdgeRow,
    WorkflowCandidateEmbeddingHelperGraphFactRow,
    WorkflowCandidateEmbeddingHelperGraphEdgeRow,
    WorkflowCandidateHelperFixtureRow,
    WorkflowCandidateGroupRow,
    WorkflowCandidateEvidenceRow,
    WorkflowCandidateReviewCoverageReport,
    WorkflowCandidateReviewPipelineLifecycleOptions,
    WorkflowCandidatePendingReviewTurnRow,
} from "../classifiers/workflow-candidate-types.ts";
export * from "../classifiers/workflow-candidate-types.ts";
export * from "../classifiers/workflow-candidate-helpers.ts";
const loadWorkflowCandidatePendingReviewTurnContexts = (
    db: SurrealClientShape,
    turnIds: readonly string[],
): Effect.Effect<readonly WorkflowCandidateGuidancePendingReviewContextRepairTurnContext[], unknown> =>
    Effect.gen(function* () {
        const contexts: WorkflowCandidateGuidancePendingReviewContextRepairTurnContext[] = [];
        for (const turnId of [...new Set(turnIds)]) {
            const [turnRows] = yield* db.query<[WorkflowCandidatePendingReviewTurnRow[]]>(
                workflowCandidateTurnContextRowSql(turnId),
            );
            const turn = turnRows?.[0];
            if (turn === undefined) {
                contexts.push({ turn_id: turnId });
                continue;
            }
            let previousAssistantText: string | null | undefined;
            if (typeof turn.session_id === "string" && typeof turn.seq === "number") {
                const [previousRows] = yield* db.query<[WorkflowCandidatePendingReviewTurnRow[]]>(
                    workflowCandidatePreviousAssistantSql(turn.session_id, turn.seq),
                );
                previousAssistantText = previousRows?.[0]?.text ?? previousRows?.[0]?.text_excerpt;
            }
            contexts.push({
                turn_id: turnId,
                ...((turn.text ?? turn.text_excerpt) === undefined ? {} : { user_text: turn.text ?? turn.text_excerpt }),
                ...(previousAssistantText === undefined ? {} : { previous_assistant_text: previousAssistantText }),
            });
        }
        return contexts;
    });

const listMarkdownFiles = (
    dir: string,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Original: existsSync-guard then readdirSync; a missing dir -> [].
        const names = yield* fs.readDirectory(dir).pipe(orAbsent([] as readonly string[]));
        const candidates = names.map((name) => path.join(dir, name));
        const files: string[] = [];
        for (const candidate of candidates) {
            // Original used statSync(...).isFile() in a try/catch (any error ->
            // skip). fs.stat follows symlinks just as the bare statSync did.
            const info = yield* fs.stat(candidate).pipe(orAbsent<FileSystem.File.Info | null>(null));
            if (info !== null && info.type === "File" && candidate.endsWith(".md")) {
                files.push(candidate);
            }
        }
        return files.sort();
    });

export function loadWorkflowCandidateGuidancePendingReviewTaskListReport(
    taskDir: string,
    filters?: WorkflowCandidateGuidancePendingReviewTaskListFilters,
): Effect.Effect<
    WorkflowCandidateGuidancePendingReviewTaskListReport,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* listMarkdownFiles(taskDir);
        // Reads with no original tolerance (the file was just stat'd): propagate.
        const taskFiles: { path: string; content: string }[] = [];
        for (const path of paths) {
            taskFiles.push({ path, content: yield* fs.readFileString(path) });
        }

        // Pre-resolve the artifact paths that the pure builder would otherwise
        // probe/read synchronously, so the builder stays pure (and the test
        // sync-closure interface is preserved). Mirror the original tolerance:
        // existsSync (presence probe -> orAbsent(false)) and readFileSync inside
        // a try/catch (any error -> "unreadable", so a read miss simply omits the
        // path from the content map and the builder's closure throws -> caught).
        const referenced = new Set<string>();
        for (const file of taskFiles) {
            const parsed = parseWorkflowCandidateGuidancePendingReviewTaskMarkdown(file.content);
            if (parsed.fixture_pack_path !== undefined) referenced.add(parsed.fixture_pack_path);
            if (parsed.review_brief_path !== undefined) referenced.add(parsed.review_brief_path);
        }
        const present = new Set<string>();
        const contents = new Map<string, string>();
        for (const ref of referenced) {
            if (yield* fs.exists(ref).pipe(orAbsent(false))) present.add(ref);
            const content = yield* fs.readFileString(ref).pipe(orAbsent<string | null>(null));
            if (content !== null) contents.set(ref, content);
        }

        return buildWorkflowCandidateGuidancePendingReviewTaskListReport({
            taskDir,
            ...(filters === undefined ? {} : { filters }),
            taskFiles,
            pathExists: (p) => present.has(p),
            readFile: (p) => {
                const content = contents.get(p);
                if (content === undefined) throw new Error(`unreadable: ${p}`);
                return content;
            },
        });
    });
}

export function readWorkflowCandidateHelperFixtures(
    filePath: string,
): Effect.Effect<readonly WorkflowCandidateHelperFixtureRow[], PlatformError.PlatformError, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Read with no original tolerance (bare readFileSync): propagate.
        const raw = yield* fs.readFileString(filePath);
        const rows: WorkflowCandidateHelperFixtureRow[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const parsed = safeJsonParse<unknown>(line.trim());
            if (!isObject(parsed)) continue;
            const id = asString(parsed.id);
            const text = asString(parsed.text);
            if (id && text) rows.push({ id, text });
        }
        return rows;
    });
}

export const withWorkflowCandidateReviewPipelineLifecycle = (
    report: WorkflowCandidateReviewCoverageReport,
    options: WorkflowCandidateReviewPipelineLifecycleOptions = {},
): Effect.Effect<WorkflowCandidateReviewCoverageReport, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        if (report.coverage_review === undefined) return report;
        const coverageReview = yield* withWorkflowCandidateReviewCoverageApplySummaryLifecycle(report.coverage_review, options);
        return {
            ...report,
            coverage_review: {
                ...coverageReview,
            },
        };
    }).pipe(Effect.provide(ClassifierReviewPipelineServiceLive));

export const withWorkflowCandidateReviewCoverageApplySummaryLifecycle = (
    summary: WorkflowCandidateReviewCoverageApplySummary,
    options: WorkflowCandidateReviewPipelineLifecycleOptions = {},
): Effect.Effect<WorkflowCandidateReviewCoverageApplySummary, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const pipeline = yield* ClassifierReviewPipelineService;
        const lifecycle = yield* pipeline.commandLifecycle(summary, options);
        return {
            ...summary,
            review_pipeline_lifecycle: lifecycle,
        };
    }).pipe(Effect.provide(ClassifierReviewPipelineServiceLive));

export const runClassifiersWorkflowCandidates = (input: WorkflowCandidateCommandInput) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const taskDir = input.taskDir ?? ".ax/tasks";
        if (input.listPendingReviewTasks) {
            const filters: WorkflowCandidateGuidancePendingReviewTaskListFilters = {
                ...(input.pendingReviewTaskPath === undefined ? {} : { path: input.pendingReviewTaskPath }),
                ...(input.pendingReviewTaskStatus === undefined ? {} : { status: input.pendingReviewTaskStatus }),
                ...(input.pendingReviewDecisionStatus === undefined ? {} : { review_decision_status: input.pendingReviewDecisionStatus }),
                ...(input.pendingReviewCommandStatus === undefined ? {} : { review_command_status: input.pendingReviewCommandStatus }),
                ...(input.pendingReviewRoute === undefined ? {} : { route: input.pendingReviewRoute }),
                ...(input.pendingReviewProgressStatus === undefined ? {} : { review_progress_status: input.pendingReviewProgressStatus }),
            };
            const hasFilters = Object.keys(filters).length > 0;
            const report = yield* loadWorkflowCandidateGuidancePendingReviewTaskListReport(taskDir, hasFilters ? filters : undefined);
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateGuidancePendingReviewTaskListText(report));
            return;
        }
        if (input.repairPendingReviewContext) {
            const taskList = yield* loadWorkflowCandidateGuidancePendingReviewTaskListReport(taskDir, {
                ...(input.pendingReviewTaskPath === undefined ? { route: "repair_review_decisions" as const } : { path: input.pendingReviewTaskPath }),
            });
            const task = taskList.tasks[0];
            if (task?.fixture_pack_path === undefined) {
                console.log(input.json
                    ? prettyPrint({
                        schema: "ax.workflow_candidate_pending_review_context_repair.v1",
                        fixture_pack_path: "unknown",
                        fixture_count: 0,
                        repaired_fixture_count: 0,
                        fully_repaired_fixture_count: 0,
                        partially_repaired_fixture_count: 0,
                        unrepaired_fixture_count: 0,
                        unchanged_fixture_count: 0,
                        before_issue_count: 0,
                        after_issue_count: 0,
                        repaired_issue_count: 0,
                        remaining_issue_count: 0,
                        target_resolution_required_count: 0,
                        target_resolution_rows: [],
                        target_resolution_next_action: "No target resolution is required before human verdict collection.",
                        rows: [],
                        repaired_jsonl: "",
                        repaired_review_brief_markdown: "",
                        next_action: "No pending review task with repairable context was found.",
                    })
                    : "No pending review task with repairable context was found.\n");
                return;
            }
            const rows = parseWorkflowCandidateFixtureRowsJsonl(yield* fs.readFileString(task.fixture_pack_path));
            const turnIds = rows
                .map((row) => row.turn)
                .filter((turn): turn is string => typeof turn === "string" && turn.length > 0);
            const turnContexts = yield* loadWorkflowCandidatePendingReviewTurnContexts(db, turnIds);
            const report = buildWorkflowCandidateGuidancePendingReviewContextRepairReport({
                fixturePackPath: task.fixture_pack_path,
                ...(task.review_brief_path === undefined ? {} : { reviewBriefPath: task.review_brief_path }),
                rows,
                turnContexts,
                ...(input.repairTarget === undefined ? {} : { repairTarget: input.repairTarget }),
            });
            if (input.repairedFixturePack) {
                yield* fs.makeDirectory(path.dirname(input.repairedFixturePack), { recursive: true });
                yield* fs.writeFileString(input.repairedFixturePack, report.repaired_jsonl);
            }
            if (input.repairedReviewBrief) {
                yield* fs.makeDirectory(path.dirname(input.repairedReviewBrief), { recursive: true });
                yield* fs.writeFileString(input.repairedReviewBrief, report.repaired_review_brief_markdown);
            }
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateGuidancePendingReviewContextRepairText(report));
            return;
        }
        const loadTopicReport = (topic: string) =>
            Effect.gen(function* () {
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
                    WHERE (${WORKFLOW_CANDIDATE_PROPOSAL_PREFIXES.map((prefix) => `string::starts_with(dedupe_sig, ${surrealString(prefix)})`).join(" OR ")})
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
                topicReport = withWorkflowCandidateTopicPersistedReviewCandidates(topicReport);
                topicReport = withWorkflowCandidateTopicGuidanceDecision(topicReport);
                return topicReport;
            });

        if (input.guidanceDecisionBatch) {
            const topicRows = yield* db.query<[WorkflowCandidateTopicHarnessGraphFactRow[]]>(`
                SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                FROM classifier_graph_fact
                WHERE (kind = "workflow_topic_candidate_review" AND source_kind = "workflow_topic_candidate_review")
                   OR (kind = "workflow_topic_harness_check" AND source_kind = "workflow_topic_harness_check")
                ORDER BY updated_at DESC
                LIMIT ${Math.max(1, input.limit * 50)};
            `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            let reviewFactRows = (topicRows?.[0] ?? []).filter((row) =>
                row.graph_id?.startsWith("fact:workflow_topic_candidate_review__") ||
                row.subject?.startsWith("workflow_topic_candidate_review:")
            );
            const search = input.search?.trim().toLowerCase();
            const topics = [...new Set((topicRows?.[0] ?? [])
                .map((row) => topicFromPropertiesJson(row.properties_json))
                .filter((topic): topic is string => topic !== undefined)
                .filter((topic) => search === undefined || topic.toLowerCase().includes(search))
                .map((topic) => topic.toLowerCase()))]
                .sort()
                .slice(0, Math.max(1, input.limit));
            const reports: WorkflowCandidateTopicReport[] = [];
            for (const topic of topics) reports.push(yield* loadTopicReport(topic));
            const pendingRows = yield* db.query<[WorkflowCandidateGroupRow[], WorkflowCandidateEvidenceRow[]]>(
                workflowCandidateSql,
                { sourceKind: input.sourceKind },
            ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            let pendingCandidateReport = attachWorkflowCandidatePersistedReviewFacts(buildWorkflowCandidateReport({
                groupRows: pendingRows[0] ?? [],
                evidenceRows: pendingRows[1] ?? [],
                sourceKind: input.sourceKind,
                limit: input.limit,
                examplesPerGroup: input.examples,
                ...(input.action === undefined ? {} : { action: input.action }),
                ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
                ...(input.search === undefined ? {} : { search: input.search }),
                taskLike: input.taskLike,
            }), reviewFactRows);
            const coverageFixturePack = input.coverageFixturePack;
            const taskDir = input.taskDir ?? path.join(process.cwd(), ".ax", "tasks");
            const reviewPipelineValues: ClassifierReviewPipelineInputValues = {
                ...(input.reviewPipelineReviewer === undefined
                    ? input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }
                    : { reviewer: input.reviewPipelineReviewer }),
                ...(input.reviewPipelineReviewedAt === undefined
                    ? input.reviewProvenanceReviewedAt === undefined ? {} : { reviewed_at: input.reviewProvenanceReviewedAt }
                    : { reviewed_at: input.reviewPipelineReviewedAt }),
            };
            let pendingReviewFixturePack: WorkflowCandidateReviewCoverageFixtureSummary | undefined;
            let pendingReviewHandoff: WorkflowCandidateGuidancePendingReviewHandoffSummary | undefined;
            let pendingReviewTask: WorkflowCandidateGuidancePendingReviewTaskSummary | undefined;
            if (coverageFixturePack !== undefined) {
                pendingReviewFixturePack = buildWorkflowCandidateReviewCoverageFixtureSummary(pendingCandidateReport, coverageFixturePack);
                yield* fs.makeDirectory(path.dirname(coverageFixturePack), { recursive: true });
                yield* fs.writeFileString(coverageFixturePack, renderClassifierFixtureRowsJsonl(pendingReviewFixturePack.fixtures));
                const reviewProjection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
                    rows: pendingReviewFixturePack.fixtures,
                    syncedFrom: coverageFixturePack,
                });
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
                }
                if (input.coverageReviewBrief !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(pendingReviewFixturePack.fixtures, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageFixturePack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        commandMode: "guidance_decision_batch",
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                let applySummary = buildWorkflowCandidateReviewCoverageApplySummary({
                    rows: pendingReviewFixturePack.fixtures,
                    sourcePath: coverageFixturePack,
                    projection: reviewProjection,
                    writePlan: reviewWritePlan,
                    applyRequested: false,
                    applied: false,
                    syncedFixtureCount: 0,
                    unknownFixtureCount: 0,
                    stampedReviewerCount: 0,
                    stampedReviewedAtCount: 0,
                    ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                    ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                    ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                    ...(input.coverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.coverageReviewBrief }),
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    commandMode: "guidance_decision_batch",
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                if (input.reviewPipelineLifecycle) {
                    applySummary = yield* withWorkflowCandidateReviewCoverageApplySummaryLifecycle(applySummary, {
                        values: reviewPipelineValues,
                        ...(input.reviewPipelineVerifyOutputs ? { verifier: nodeFileOutputVerifier } : {}),
                    });
                }
                pendingReviewHandoff = buildWorkflowCandidateGuidancePendingReviewHandoffSummary({
                    fixturePack: pendingReviewFixturePack,
                    applySummary,
                });
            }
            if (input.coverageReviewPack !== undefined) {
                let reviewedRows = parseWorkflowCandidateFixtureRowsJsonl(
                    yield* fs.readFileString(input.coverageReviewPack),
                );
                let syncedFixtureCount = 0;
                let unknownFixtureCount = 0;
                let stampedReviewerCount = 0;
                let stampedReviewedAtCount = 0;
                if (input.syncCoverageReviewBrief !== undefined) {
                    const syncResult = syncWorkflowCandidateFixtureRowsFromBriefWithSummary(
                        reviewedRows,
                        yield* fs.readFileString(input.syncCoverageReviewBrief),
                    );
                    reviewedRows = syncResult.rows;
                    syncedFixtureCount = syncResult.synced_fixture_count;
                    unknownFixtureCount = syncResult.unknown_fixture_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.reviewProvenanceReviewer !== undefined || input.reviewProvenanceReviewedAt !== undefined) {
                    const stampResult = stampWorkflowCandidateReviewProvenance(reviewedRows, {
                        ...(input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }),
                        ...(input.reviewProvenanceReviewedAt === undefined ? {} : { reviewedAt: input.reviewProvenanceReviewedAt }),
                    });
                    reviewedRows = stampResult.rows;
                    stampedReviewerCount = stampResult.stamped_reviewer_count;
                    stampedReviewedAtCount = stampResult.stamped_reviewed_at_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.coverageReviewBrief !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(reviewedRows, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageReviewPack: input.coverageReviewPack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        commandMode: "guidance_decision_batch",
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                const reviewProjection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
                    rows: reviewedRows,
                    syncedFrom: input.coverageReviewPack,
                });
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
                }
                const reviewFixturePack = pendingReviewFixturePack ?? {
                    path: input.coverageReviewPack,
                    emitted_fixture_count: reviewedRows.length,
                    candidate_count: new Set(reviewedRows.map((row) => row.candidate_id)).size,
                    skipped_candidate_count: 0,
                    fixtures: reviewedRows,
                };
                pendingReviewFixturePack = reviewFixturePack;
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
                    ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                    ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    commandMode: "guidance_decision_batch",
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                let applySummary = pendingApplySummary;
                if (input.applyReviewFacts && pendingApplySummary.can_apply) {
                    yield* db.query(reviewWritePlan.statements.join("\n")).pipe(
                        catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                    );
                    applySummary = buildWorkflowCandidateReviewCoverageApplySummary({
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
                        ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                        ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        commandMode: "guidance_decision_batch",
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    });
                    const refreshedReviewRows = yield* db.query<[WorkflowCandidateTopicHarnessGraphFactRow[]]>(`
                        SELECT graph_id, subject, predicate, object, value_json, properties_json, type::string(updated_at) AS updated_at
                        FROM classifier_graph_fact
                        WHERE kind = "workflow_topic_candidate_review"
                          AND source_kind = "workflow_topic_candidate_review"
                        ORDER BY updated_at DESC
                        LIMIT ${Math.max(1, input.limit * 50)};
                    `).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                    reviewFactRows = refreshedReviewRows?.[0] ?? [];
                    pendingCandidateReport = attachWorkflowCandidatePersistedReviewFacts(buildWorkflowCandidateReport({
                        groupRows: pendingRows[0] ?? [],
                        evidenceRows: pendingRows[1] ?? [],
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        examplesPerGroup: input.examples,
                        ...(input.action === undefined ? {} : { action: input.action }),
                        ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
                        ...(input.search === undefined ? {} : { search: input.search }),
                        taskLike: input.taskLike,
                    }), reviewFactRows);
                }
                if (input.reviewPipelineLifecycle) {
                    applySummary = yield* withWorkflowCandidateReviewCoverageApplySummaryLifecycle(applySummary, {
                        values: reviewPipelineValues,
                        ...(input.reviewPipelineVerifyOutputs ? { verifier: nodeFileOutputVerifier } : {}),
                    });
                }
                pendingReviewHandoff = buildWorkflowCandidateGuidancePendingReviewHandoffSummary({
                    fixturePack: reviewFixturePack,
                    applySummary,
                });
                if (input.applyReviewFacts && !pendingApplySummary.can_apply) process.exitCode = 1;
            }
            if (input.emitPendingReviewTask && pendingReviewFixturePack !== undefined && pendingReviewHandoff !== undefined) {
                const task = buildWorkflowCandidateGuidancePendingReviewTask({
                    taskDir,
                    fixturePack: pendingReviewFixturePack,
                    handoff: pendingReviewHandoff,
                    sourceKind: input.sourceKind,
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                yield* fs.makeDirectory(path.dirname(task.summary.path!), { recursive: true });
                yield* fs.writeFileString(task.summary.path!, task.content);
                pendingReviewTask = task.summary;
            }
            let acceptedClassifierFixturePack: WorkflowCandidateTopicClassifierFixtureSummary | undefined;
            if (input.classifierFixturePack) {
                acceptedClassifierFixturePack = buildWorkflowCandidateAcceptedClassifierFixtureSummary(reports, input.classifierFixturePack);
                yield* fs.makeDirectory(path.dirname(input.classifierFixturePack), { recursive: true });
                yield* fs.writeFileString(input.classifierFixturePack, renderClassifierFixtureRowsJsonl(acceptedClassifierFixturePack.fixtures));
            }
            const batch = buildWorkflowCandidateTopicGuidanceDecisionBatchReport({
                sourceKind: input.sourceKind,
                limit: input.limit,
                ...(input.search === undefined ? {} : { search: input.search }),
                decisions: reports
                    .map((report) => report.guidance_decision)
                    .filter((decision): decision is WorkflowCandidateTopicGuidanceDecisionReport => decision !== undefined),
                pendingCandidateReport,
                ...(acceptedClassifierFixturePack === undefined ? {} : { acceptedClassifierFixturePack }),
                ...(pendingReviewFixturePack === undefined ? {} : { pendingReviewFixturePack }),
                ...(pendingReviewHandoff === undefined ? {} : { pendingReviewHandoff }),
                ...(pendingReviewTask === undefined ? {} : { pendingReviewTask }),
            });
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(batch)}\n`);
            }
            console.log(input.json ? prettyPrint(batch) : renderWorkflowCandidateTopicGuidanceDecisionBatchText(batch));
            return;
        }
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
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
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
                yield* fs.makeDirectory(path.dirname(input.coverageFixturePack), { recursive: true });
                yield* fs.writeFileString(input.coverageFixturePack, renderClassifierFixtureRowsJsonl(fixtureSummary.fixtures));
                if (input.coverageReviewBrief) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(fixtureSummary.fixtures, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageFixturePack: input.coverageFixturePack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                report = { ...report, fixture_pack: fixtureSummary };
            }
            if (input.coverageReviewPack) {
                let reviewedRows = parseWorkflowCandidateFixtureRowsJsonl(
                    yield* fs.readFileString(input.coverageReviewPack),
                );
                let syncedFixtureCount = 0;
                let unknownFixtureCount = 0;
                let stampedReviewerCount = 0;
                let stampedReviewedAtCount = 0;
                if (input.syncCoverageReviewBrief) {
                    const syncResult = syncWorkflowCandidateFixtureRowsFromBriefWithSummary(
                        reviewedRows,
                        yield* fs.readFileString(input.syncCoverageReviewBrief),
                    );
                    reviewedRows = syncResult.rows;
                    syncedFixtureCount = syncResult.synced_fixture_count;
                    unknownFixtureCount = syncResult.unknown_fixture_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.reviewProvenanceReviewer !== undefined || input.reviewProvenanceReviewedAt !== undefined) {
                    const stampResult = stampWorkflowCandidateReviewProvenance(reviewedRows, {
                        ...(input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }),
                        ...(input.reviewProvenanceReviewedAt === undefined ? {} : { reviewedAt: input.reviewProvenanceReviewedAt }),
                    });
                    reviewedRows = stampResult.rows;
                    stampedReviewerCount = stampResult.stamped_reviewer_count;
                    stampedReviewedAtCount = stampResult.stamped_reviewed_at_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.coverageReviewBrief) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(reviewedRows, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageReviewPack: input.coverageReviewPack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                const reviewProjection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
                    rows: reviewedRows,
                    syncedFrom: input.coverageReviewPack,
                });
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
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
            if (input.reviewPipelineLifecycle) {
                const values: ClassifierReviewPipelineInputValues = {
                    ...(input.reviewPipelineReviewer === undefined
                        ? input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }
                        : { reviewer: input.reviewPipelineReviewer }),
                    ...(input.reviewPipelineReviewedAt === undefined
                        ? input.reviewProvenanceReviewedAt === undefined ? {} : { reviewed_at: input.reviewProvenanceReviewedAt }
                        : { reviewed_at: input.reviewPipelineReviewedAt }),
                };
                report = yield* withWorkflowCandidateReviewPipelineLifecycle(report, {
                    values,
                    ...(input.reviewPipelineVerifyOutputs ? { verifier: nodeFileOutputVerifier } : {}),
                });
            }
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
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
                WHERE (${WORKFLOW_CANDIDATE_PROPOSAL_PREFIXES.map((prefix) => `string::starts_with(dedupe_sig, ${surrealString(prefix)})`).join(" OR ")})
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
                topicReport = withWorkflowCandidateTopicPersistedReviewCandidates(topicReport);
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
                const helperFixtures = yield* readWorkflowCandidateHelperFixtures(
                    path.join(process.cwd(), "packages", "ax-classifier-session-sections", "eval-fixtures", "chunks.jsonl"),
                );
                topicReport = {
                    ...topicReport,
                    helper_explanations: buildWorkflowCandidateTopicHelperExplanations({
                        report: topicReport,
                        facts: helperRows?.[0] ?? [],
                        edges: helperRows?.[1] ?? [],
                        fixtures: helperFixtures,
                    }),
                };
            }
            if (input.syncBrief) {
                topicReport = syncWorkflowCandidateTopicReportFromBrief(
                    topicReport,
                    yield* fs.readFileString(input.syncBrief),
                    input.syncBrief,
                );
            }
            if (input.emitAdjacentTasks) {
                const taskDir = input.taskDir ?? path.join(process.cwd(), ".ax", "tasks");
                const adjacentTasks = buildWorkflowCandidateTopicTaskDrafts(topicReport, taskDir);
                if (adjacentTasks.drafts.length > 0) yield* fs.makeDirectory(taskDir, { recursive: true });
                for (const draft of adjacentTasks.drafts) {
                    yield* fs.writeFileString(draft.path, draft.content);
                }
                topicReport = {
                    ...topicReport,
                    adjacent_tasks: adjacentTasks.summary,
                };
            }
            if (input.classifierFixturePack) {
                const summary = buildWorkflowCandidateTopicClassifierFixtureSummary(topicReport, input.classifierFixturePack);
                yield* fs.makeDirectory(path.dirname(input.classifierFixturePack), { recursive: true });
                yield* fs.writeFileString(input.classifierFixturePack, renderClassifierFixtureRowsJsonl(summary.fixtures));
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
            if (input.guidanceDecision) {
                topicReport = withWorkflowCandidateTopicGuidanceDecision(topicReport);
            }
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(topicReport)}\n`);
            }
            if (input.evidencePack) {
                yield* fs.makeDirectory(path.dirname(input.evidencePack), { recursive: true });
                yield* fs.writeFileString(input.evidencePack, renderWorkflowCandidateTopicEvidencePackMarkdown(topicReport));
            }
            if (input.reviewFacts || input.reviewWritePlan || input.applyReviewFacts) {
                const reviewProjection = buildWorkflowCandidateTopicReviewGraphProjection(topicReport);
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
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
                    yield* fs.makeDirectory(path.dirname(input.harnessFacts), { recursive: true });
                    yield* fs.writeFileString(input.harnessFacts, `${prettyPrint(harnessProjection)}\n`);
                }
                if (input.harnessWritePlan) {
                    yield* fs.makeDirectory(path.dirname(input.harnessWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.harnessWritePlan, `${prettyPrint(harnessWritePlan)}\n`);
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
                `(${WORKFLOW_CANDIDATE_PROPOSAL_PREFIXES.map((prefix) => `string::starts_with(dedupe_sig, ${surrealString(prefix)})`).join(" OR ")})`,
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
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(listReport)}\n`);
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
                yield* fs.readFileString(input.syncBrief),
                input.syncBrief,
            );
        }
        if (input.promoteTasks || input.promoteProposals) {
            const taskDir = input.taskDir ?? path.join(process.cwd(), ".ax", "tasks");
            const promotion = buildWorkflowCandidateTaskDrafts(report, taskDir, input.promotionMode ?? "per-candidate");
            report = promotion.report;
            if (input.promoteTasks) {
                if (promotion.drafts.length > 0) yield* fs.makeDirectory(taskDir, { recursive: true });
                for (const draft of promotion.drafts) {
                    yield* fs.writeFileString(draft.path, draft.content);
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
            yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
            yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
        }
        if (input.brief) {
            yield* fs.makeDirectory(path.dirname(input.brief), { recursive: true });
            yield* fs.writeFileString(input.brief, renderWorkflowCandidateBriefMarkdown(report));
        }
        console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateReportText(report));
        if (report.decision !== "workflow_candidates_ranked") process.exitCode = 1;
    });
