// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { cmdClassifiersEval } from "../classifiers-eval.ts";
import { cmdClassifiersList } from "../classifiers-list.ts";
import {
    runClassifiersLifecycle,
    runClassifiersPackageOperations,
    runClassifiersPackagesOperations,
} from "../classifiers-package-operations.ts";
import {
    runClassifiersWorkflowCandidates,
    type WorkflowCandidateGuidancePendingReviewCommandStatus,
    type WorkflowCandidateGuidancePendingReviewDecisionStatus,
    type WorkflowCandidateGuidancePendingReviewProgressStatus,
    type WorkflowCandidateGuidancePendingReviewRecommendedRoute,
    type WorkflowCandidateGuidancePendingReviewTaskStatus,
    type WorkflowCandidatePromotionMode,
    type WorkflowCandidateProposalStatusFilter,
    type WorkflowCandidateTaskLikeMode,
} from "../classifiers-workflow-candidates.ts";
import { ClassifierPackageServiceLive } from "../../classifiers/package-service.ts";
import {
    LabelMiningService,
    LabelMiningServiceLive,
    renderGraphProjectionText,
    renderSelfImproveText,
} from "../../classifiers/label-mining-service.ts";
import { fetchClassifierExplain } from "../../dashboard/classifier-explain.ts";
import {
    renderClassifierExplainJson,
    renderClassifierExplainMarkdown,
} from "../classifiers-explain-format.ts";
import { prettyPrint } from "@ax/lib/json";
import { catchDbErrorAndExit, wantsJsonFlag } from "../output.ts";
import type { RuntimeManifest } from "./manifest.ts";
import {
    boolArg,
    jsonFlag,
    optionValue,
    positiveLimit,
    stringArg,
} from "./shared.ts";

const classifiersEvalCommand = Command.make(
    "eval",
    {
        path: Flag.string("path").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ path, json }) =>
        cmdClassifiersEval([...stringArg("path", optionValue(path)), ...boolArg("json", json)]),
).pipe(Command.withDescription("Run classifier golden fixture evaluations"));

const classifiersListCommand = Command.make(
    "list",
    {
        json: jsonFlag,
    },
    ({ json }) => cmdClassifiersList(boolArg("json", json)),
).pipe(Command.withDescription("List registered classifiers and fixture coverage"));

interface ClassifiersExplainInput {
    readonly turnId: string;
    readonly json: boolean;
}

const cmdClassifiersExplain = (input: ClassifiersExplainInput) =>
    Effect.gen(function* () {
        // The old missing-<turn-id> guard is gone: `turn-id` is a required
        // Argument.string, so the Effect CLI parser rejects the bare
        // invocation before this handler runs.
        const turnId = input.turnId;
        const useJson = wantsJsonFlag(input.json);
        const payload = yield* fetchClassifierExplain(turnId).pipe(
            catchDbErrorAndExit("axctl classifiers explain"),
        );

        if (payload.turn === null) {
            process.stderr.write(`turn ${turnId} not found\n`);
            process.exit(1);
        }

        console.log(useJson ? renderClassifierExplainJson(payload) : renderClassifierExplainMarkdown(payload));
    });

const classifiersExplainCommand = Command.make(
    "explain",
    {
        turnId: Argument.string("turn-id"),
        json: jsonFlag,
    },
    ({ turnId, json }) => cmdClassifiersExplain({ turnId, json }),
).pipe(Command.withDescription("Explain classifier results attached to a turn"));

const classifiersPackageOperationsCommand = Command.make(
    "package-operations",
    {
        allowExpensive: Flag.boolean("allow-expensive").pipe(Flag.withDefault(false)),
        applyWritePlan: Flag.boolean("apply-write-plan").pipe(Flag.withDefault(false)),
        all: Flag.boolean("all").pipe(Flag.withDefault(false)),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        execute: Flag.boolean("execute").pipe(Flag.withDefault(false)),
        facts: Flag.boolean("facts").pipe(Flag.withDefault(false)),
        graphHealth: Flag.boolean("graph-health").pipe(Flag.withDefault(false)),
        graphMode: Flag.choice("graph-mode", ["summary", "guarded", "changed-artifacts", "evidence", "lifecycle", "embedding-helper", "boundary-replay"] as const).pipe(Flag.withDefault("summary")),
        history: Flag.boolean("history").pipe(Flag.withDefault(false)),
        manifest: Flag.string("manifest").pipe(Flag.withDefault("packages/ax-classifier-session-sections/ax.classifier.json")),
        operation: Flag.string("operation").pipe(Flag.optional),
        artifact: Flag.string("artifact").pipe(Flag.optional),
        sourceKind: Flag.string("source-kind").pipe(Flag.optional),
        factKind: Flag.string("fact-kind").pipe(Flag.optional),
        status: Flag.string("status").pipe(Flag.optional),
        sourceFixture: Flag.string("source-fixture").pipe(Flag.optional),
        proposedLabel: Flag.string("proposed-label").pipe(Flag.optional),
        threshold: Flag.string("threshold").pipe(Flag.optional),
        minSeedCount: Flag.integer("min-seed-count").pipe(Flag.optional),
        minPositiveRecall: Flag.float("min-positive-recall").pipe(Flag.optional),
        minCallReduction: Flag.float("min-call-reduction").pipe(Flag.optional),
        minNearestSimilarity: Flag.float("min-nearest-similarity").pipe(Flag.optional),
        nearestFixture: Flag.string("nearest-fixture").pipe(Flag.optional),
        predicate: Flag.string("predicate").pipe(Flag.optional),
        subject: Flag.string("subject").pipe(Flag.optional),
        valueContains: Flag.string("value-contains").pipe(Flag.optional),
        valueEquals: Flag.string("value").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        preflight: Flag.boolean("preflight").pipe(Flag.withDefault(false)),
        root: Flag.string("root").pipe(Flag.optional),
        workflowStatus: Flag.string("workflow-status").pipe(Flag.optional),
        writePlan: Flag.boolean("write-plan").pipe(Flag.withDefault(false)),
        querySuggestionRouting: Flag.boolean("query-suggestion-routing").pipe(Flag.withDefault(false)),
        boundaryReplaySummary: Flag.boolean("boundary-replay-summary").pipe(Flag.withDefault(false)),
        qualityStatus: Flag.boolean("quality-status").pipe(Flag.withDefault(false)),
        sourceReport: Flag.string("source-report").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ allowExpensive, applyWritePlan, all, dryRun, execute, facts, graphHealth, graphMode, history, manifest, operation, artifact, sourceKind, factKind, status, sourceFixture, proposedLabel, threshold, minSeedCount, minPositiveRecall, minCallReduction, minNearestSimilarity, nearestFixture, predicate, subject, valueContains, valueEquals, out, preflight, root, workflowStatus, writePlan, querySuggestionRouting, boundaryReplaySummary, qualityStatus, sourceReport, json }) => {
        const operationId = optionValue(operation);
        const artifactPath = optionValue(artifact);
        const sourceKindName = optionValue(sourceKind);
        const factKindName = optionValue(factKind);
        const statusName = optionValue(status);
        const sourceFixtureId = optionValue(sourceFixture);
        const proposedLabelName = optionValue(proposedLabel);
        const thresholdName = optionValue(threshold);
        const minSeedCountValue = optionValue(minSeedCount);
        const minPositiveRecallValue = optionValue(minPositiveRecall);
        const minCallReductionValue = optionValue(minCallReduction);
        const minNearestSimilarityValue = optionValue(minNearestSimilarity);
        const nearestFixtureId = optionValue(nearestFixture);
        const predicateName = optionValue(predicate);
        const subjectName = optionValue(subject);
        const valueContainsText = optionValue(valueContains);
        const valueEqualsText = optionValue(valueEquals);
        const outPath = optionValue(out);
        const rootPath = optionValue(root);
        const workflowStatusPath = optionValue(workflowStatus);
        const sourceReportPath = optionValue(sourceReport);
        if (all) {
            return runClassifiersPackagesOperations({
                ...(rootPath === undefined ? {} : { root: rootPath }),
                ...(outPath === undefined ? {} : { out: outPath }),
                json,
            }).pipe(Effect.provide(ClassifierPackageServiceLive));
        }
        return runClassifiersPackageOperations({
            manifestPath: manifest,
            ...(operationId === undefined ? {} : { operationId }),
            ...(outPath === undefined ? {} : { out: outPath }),
            allowExpensive,
            applyWritePlan,
            dryRun,
            execute,
            facts,
            graphHealth,
            ...(boundaryReplaySummary && graphMode === "summary" ? {} : { graphMode }),
            querySuggestionRouting,
            boundaryReplaySummary,
            qualityStatus,
            ...(sourceReportPath === undefined ? {} : { sourceReportPath }),
            history,
            ...(artifactPath === undefined ? {} : { artifact: artifactPath }),
            ...(sourceKindName === undefined ? {} : { sourceKind: sourceKindName }),
            ...(factKindName === undefined ? {} : { factKind: factKindName }),
            ...(statusName === undefined ? {} : { status: statusName }),
            ...(sourceFixtureId === undefined ? {} : { sourceFixture: sourceFixtureId }),
            ...(proposedLabelName === undefined ? {} : { proposedLabel: proposedLabelName }),
            ...(thresholdName === undefined ? {} : { threshold: thresholdName }),
            ...(minSeedCountValue === undefined ? {} : { minSeedCount: minSeedCountValue }),
            ...(minPositiveRecallValue === undefined ? {} : { minPositiveRecall: minPositiveRecallValue }),
            ...(minCallReductionValue === undefined ? {} : { minCallReduction: minCallReductionValue }),
            ...(minNearestSimilarityValue === undefined ? {} : { minNearestSimilarity: minNearestSimilarityValue }),
            ...(nearestFixtureId === undefined ? {} : { nearestFixture: nearestFixtureId }),
            ...(predicateName === undefined ? {} : { predicate: predicateName }),
            ...(subjectName === undefined ? {} : { subject: subjectName }),
            ...(valueContainsText === undefined ? {} : { valueContains: valueContainsText }),
            ...(valueEqualsText === undefined ? {} : { valueEquals: valueEqualsText }),
            preflight,
            ...(rootPath === undefined ? {} : { root: rootPath }),
            ...(workflowStatusPath === undefined ? {} : { workflowStatusPath }),
            writePlan,
            json,
        }).pipe(Effect.provide(ClassifierPackageServiceLive));
    },
).pipe(Command.withDescription("Inspect operations declared by a classifier package manifest"));

const classifiersGraphCommand = Command.make(
    "graph",
    {
        mode: Flag.choice("mode", ["summary", "guarded", "changed-artifacts", "evidence", "lifecycle", "embedding-helper", "boundary-replay"] as const).pipe(Flag.withDefault("summary")),
        operation: Flag.string("operation").pipe(Flag.optional),
        artifact: Flag.string("artifact").pipe(Flag.optional),
        sourceKind: Flag.string("source-kind").pipe(Flag.optional),
        factKind: Flag.string("fact-kind").pipe(Flag.optional),
        status: Flag.string("status").pipe(Flag.optional),
        sourceFixture: Flag.string("source-fixture").pipe(Flag.optional),
        proposedLabel: Flag.string("proposed-label").pipe(Flag.optional),
        threshold: Flag.string("threshold").pipe(Flag.optional),
        minSeedCount: Flag.integer("min-seed-count").pipe(Flag.optional),
        minPositiveRecall: Flag.float("min-positive-recall").pipe(Flag.optional),
        minCallReduction: Flag.float("min-call-reduction").pipe(Flag.optional),
        minNearestSimilarity: Flag.float("min-nearest-similarity").pipe(Flag.optional),
        nearestFixture: Flag.string("nearest-fixture").pipe(Flag.optional),
        predicate: Flag.string("predicate").pipe(Flag.optional),
        subject: Flag.string("subject").pipe(Flag.optional),
        valueContains: Flag.string("value-contains").pipe(Flag.optional),
        valueEquals: Flag.string("value").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        querySuggestionRouting: Flag.boolean("query-suggestion-routing").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ mode, operation, artifact, sourceKind, factKind, status, sourceFixture, proposedLabel, threshold, minSeedCount, minPositiveRecall, minCallReduction, minNearestSimilarity, nearestFixture, predicate, subject, valueContains, valueEquals, out, querySuggestionRouting, json }) => {
        const operationId = optionValue(operation);
        const artifactPath = optionValue(artifact);
        const sourceKindName = optionValue(sourceKind);
        const factKindName = optionValue(factKind);
        const statusName = optionValue(status);
        const sourceFixtureId = optionValue(sourceFixture);
        const proposedLabelName = optionValue(proposedLabel);
        const thresholdName = optionValue(threshold);
        const minSeedCountValue = optionValue(minSeedCount);
        const minPositiveRecallValue = optionValue(minPositiveRecall);
        const minCallReductionValue = optionValue(minCallReduction);
        const minNearestSimilarityValue = optionValue(minNearestSimilarity);
        const nearestFixtureId = optionValue(nearestFixture);
        const predicateName = optionValue(predicate);
        const subjectName = optionValue(subject);
        const valueContainsText = optionValue(valueContains);
        const valueEqualsText = optionValue(valueEquals);
        const outPath = optionValue(out);
        return runClassifiersPackageOperations({
            manifestPath: "packages/ax-classifier-session-sections/ax.classifier.json",
            graphHealth: true,
            graphMode: mode,
            querySuggestionRouting,
            ...(operationId === undefined ? {} : { operationId }),
            ...(artifactPath === undefined ? {} : { artifact: artifactPath }),
            ...(sourceKindName === undefined ? {} : { sourceKind: sourceKindName }),
            ...(factKindName === undefined ? {} : { factKind: factKindName }),
            ...(statusName === undefined ? {} : { status: statusName }),
            ...(sourceFixtureId === undefined ? {} : { sourceFixture: sourceFixtureId }),
            ...(proposedLabelName === undefined ? {} : { proposedLabel: proposedLabelName }),
            ...(thresholdName === undefined ? {} : { threshold: thresholdName }),
            ...(minSeedCountValue === undefined ? {} : { minSeedCount: minSeedCountValue }),
            ...(minPositiveRecallValue === undefined ? {} : { minPositiveRecall: minPositiveRecallValue }),
            ...(minCallReductionValue === undefined ? {} : { minCallReduction: minCallReductionValue }),
            ...(minNearestSimilarityValue === undefined ? {} : { minNearestSimilarity: minNearestSimilarityValue }),
            ...(nearestFixtureId === undefined ? {} : { nearestFixture: nearestFixtureId }),
            ...(predicateName === undefined ? {} : { predicate: predicateName }),
            ...(subjectName === undefined ? {} : { subject: subjectName }),
            ...(valueContainsText === undefined ? {} : { valueContains: valueContainsText }),
            ...(valueEqualsText === undefined ? {} : { valueEquals: valueEqualsText }),
            ...(outPath === undefined ? {} : { out: outPath }),
            json,
        }).pipe(Effect.provide(ClassifierPackageServiceLive));
    },
).pipe(Command.withDescription("Query persisted classifier lifecycle graph health"));

const parseRouteInputValues = (value: Option.Option<string>): Readonly<Record<string, string>> | undefined => {
    const text = optionValue(value);
    if (text === undefined || text.trim().length === 0) {
        return undefined;
    }
    return Object.fromEntries(
        text.split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .map((entry) => {
                const separator = entry.indexOf("=");
                return separator === -1
                    ? [entry, ""]
                    : [entry.slice(0, separator), entry.slice(separator + 1)];
            }),
    );
};

const classifiersLifecycleCommand = Command.make(
    "lifecycle",
    {
        root: Flag.string("root").pipe(Flag.optional),
        workflowStatus: Flag.string("workflow-status").pipe(Flag.optional),
        routingSummary: Flag.boolean("routing-summary").pipe(Flag.withDefault(false)),
        routeInputs: Flag.string("route-inputs").pipe(Flag.optional),
        routeExecutionPlan: Flag.boolean("route-execution-plan").pipe(Flag.withDefault(false)),
        executeRoute: Flag.boolean("execute-route").pipe(Flag.withDefault(false)),
        inspectRouteExecution: Flag.string("inspect-route-execution").pipe(Flag.optional),
        graphMode: Flag.choice("graph-mode", ["summary", "guarded", "changed-artifacts", "evidence", "lifecycle", "embedding-helper", "boundary-replay"] as const).pipe(Flag.optional),
        predicate: Flag.string("predicate").pipe(Flag.optional),
        subject: Flag.string("subject").pipe(Flag.optional),
        valueContains: Flag.string("value-contains").pipe(Flag.optional),
        valueEquals: Flag.string("value").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ root, workflowStatus, routingSummary, routeInputs, routeExecutionPlan, executeRoute, inspectRouteExecution, graphMode, predicate, subject, valueContains, valueEquals, out, json }) => {
        const rootPath = optionValue(root);
        const workflowStatusPath = optionValue(workflowStatus);
        const routeInputValues = parseRouteInputValues(routeInputs);
        const inspectRouteExecutionPath = optionValue(inspectRouteExecution);
        const graphModeName = optionValue(graphMode);
        const predicateName = optionValue(predicate);
        const subjectName = optionValue(subject);
        const valueContainsText = optionValue(valueContains);
        const valueEqualsText = optionValue(valueEquals);
        const outPath = optionValue(out);
        return runClassifiersLifecycle({
            ...(rootPath === undefined ? {} : { root: rootPath }),
            ...(workflowStatusPath === undefined ? {} : { workflowStatusPath }),
            routingSummary,
            ...(routeInputValues === undefined ? {} : { routeInputValues }),
            routeExecutionPlan,
            executeRoute,
            ...(inspectRouteExecutionPath === undefined ? {} : { inspectRouteExecutionPath }),
            ...(graphModeName === undefined ? {} : { graphMode: graphModeName }),
            ...(predicateName === undefined ? {} : { predicate: predicateName }),
            ...(subjectName === undefined ? {} : { subject: subjectName }),
            ...(valueContainsText === undefined ? {} : { valueContains: valueContainsText }),
            ...(valueEqualsText === undefined ? {} : { valueEquals: valueEqualsText }),
            ...(outPath === undefined ? {} : { out: outPath }),
            json,
        }).pipe(Effect.provide(ClassifierPackageServiceLive));
    },
).pipe(Command.withDescription("Summarize classifier package readiness, graph health, and review blockers"));

const classifiersWorkflowCandidatesCommand = Command.make(
    "workflow-candidates",
    {
        sourceKind: Flag.string("source-kind").pipe(Flag.withDefault("transcript_classifier_projection")),
        action: Flag.string("action").pipe(Flag.optional),
        classifier: Flag.string("classifier").pipe(Flag.optional),
        search: Flag.string("search").pipe(Flag.optional),
        taskLike: Flag.choice("task-like", ["include", "exclude", "only"] as const).pipe(Flag.withDefault("include")),
        topicReport: Flag.boolean("topic-report").pipe(Flag.withDefault(false)),
        listProposals: Flag.boolean("list-proposals").pipe(Flag.withDefault(false)),
        listHarnessFacts: Flag.boolean("list-harness-facts").pipe(Flag.withDefault(false)),
        reviewCoverage: Flag.boolean("review-coverage").pipe(Flag.withDefault(false)),
        includeHarnessFacts: Flag.boolean("include-harness-facts").pipe(Flag.withDefault(false)),
        includeHelperFacts: Flag.boolean("include-helper-facts").pipe(Flag.withDefault(false)),
        includeReviewFacts: Flag.boolean("include-review-facts").pipe(Flag.withDefault(false)),
        guidanceDecision: Flag.boolean("guidance-decision").pipe(Flag.withDefault(false)),
        guidanceDecisionBatch: Flag.boolean("guidance-decision-batch").pipe(Flag.withDefault(false)),
        proposalStatus: Flag.choice("proposal-status", ["all", "open", "accepted", "rejected"] as const).pipe(Flag.withDefault("all")),
        expandEvidence: Flag.boolean("expand-evidence").pipe(Flag.withDefault(false)),
        evidencePack: Flag.string("evidence-pack").pipe(Flag.optional),
        classifierFixturePack: Flag.string("classifier-fixture-pack").pipe(Flag.optional),
        coverageFixturePack: Flag.string("coverage-fixture-pack").pipe(Flag.optional),
        coverageReviewPack: Flag.string("coverage-review-pack").pipe(Flag.optional),
        coverageReviewBrief: Flag.string("coverage-review-brief").pipe(Flag.optional),
        syncCoverageReviewBrief: Flag.string("sync-coverage-review-brief").pipe(Flag.optional),
        harnessFacts: Flag.string("harness-facts").pipe(Flag.optional),
        harnessWritePlan: Flag.string("harness-write-plan").pipe(Flag.optional),
        applyHarnessFacts: Flag.boolean("apply-harness-facts").pipe(Flag.withDefault(false)),
        reviewFacts: Flag.string("review-facts").pipe(Flag.optional),
        reviewWritePlan: Flag.string("review-write-plan").pipe(Flag.optional),
        applyReviewFacts: Flag.boolean("apply-review-facts").pipe(Flag.withDefault(false)),
        requireReviewProvenance: Flag.boolean("require-review-provenance").pipe(Flag.withDefault(false)),
        requireReviewHandoff: Flag.boolean("require-review-handoff").pipe(Flag.withDefault(false)),
        reviewProvenanceReviewer: Flag.string("review-provenance-reviewer").pipe(Flag.optional),
        reviewProvenanceReviewedAt: Flag.string("review-provenance-reviewed-at").pipe(Flag.optional),
        reviewPipelineLifecycle: Flag.boolean("review-pipeline-lifecycle").pipe(Flag.withDefault(false)),
        reviewPipelineVerifyOutputs: Flag.boolean("review-pipeline-verify-outputs").pipe(Flag.withDefault(false)),
        reviewPipelineReviewer: Flag.string("review-pipeline-reviewer").pipe(Flag.optional),
        reviewPipelineReviewedAt: Flag.string("review-pipeline-reviewed-at").pipe(Flag.optional),
        limit: positiveLimit(10),
        examples: Flag.integer("examples").pipe(Flag.withDefault(3)),
        out: Flag.string("out").pipe(Flag.optional),
        brief: Flag.string("brief").pipe(Flag.optional),
        syncBrief: Flag.string("sync-brief").pipe(Flag.optional),
        promoteTasks: Flag.boolean("promote-tasks").pipe(Flag.withDefault(false)),
        emitAdjacentTasks: Flag.boolean("emit-adjacent-tasks").pipe(Flag.withDefault(false)),
        emitPendingReviewTask: Flag.boolean("emit-pending-review-task").pipe(Flag.withDefault(false)),
        listPendingReviewTasks: Flag.boolean("list-pending-review-tasks").pipe(Flag.withDefault(false)),
        repairPendingReviewContext: Flag.boolean("repair-pending-review-context").pipe(Flag.withDefault(false)),
        repairTarget: Flag.string("repair-target").pipe(Flag.optional),
        repairedFixturePack: Flag.string("repaired-fixture-pack").pipe(Flag.optional),
        repairedReviewBrief: Flag.string("repaired-review-brief").pipe(Flag.optional),
        pendingReviewTaskPath: Flag.string("pending-review-task-path").pipe(Flag.optional),
        pendingReviewTaskStatus: Flag.choice("pending-review-task-status", [
            "ready_for_review",
            "review_decisions_ready",
            "review_decisions_need_repair",
            "missing_fixture_pack",
            "missing_review_brief",
            "missing_review_artifacts",
            "unknown_schema",
        ] as const).pipe(Flag.optional),
        pendingReviewDecisionStatus: Flag.choice("pending-review-decision-status", [
            "unknown",
            "needs_review_decisions",
            "reviewed_missing_rationale",
            "invalid_review_status",
            "review_decisions_ready",
        ] as const).pipe(Flag.optional),
        pendingReviewCommandStatus: Flag.choice("pending-review-command-status", [
            "unavailable",
            "blocked_until_review_decisions",
            "blocked_until_review_repairs",
            "ready_to_execute",
        ] as const).pipe(Flag.optional),
        pendingReviewRoute: Flag.choice("pending-review-route", [
            "none",
            "repair_artifacts",
            "repair_review_decisions",
            "execute_review_command",
            "collect_review_decisions",
            "repair_task_schema",
            "inspect_task",
        ] as const).pipe(Flag.optional),
        pendingReviewProgressStatus: Flag.choice("pending-review-progress-status", [
            "unreadable",
            "needs_review",
            "partial_review",
            "complete_review",
            "needs_repair",
        ] as const).pipe(Flag.optional),
        promoteHarnessProposals: Flag.boolean("promote-harness-proposals").pipe(Flag.withDefault(false)),
        requireHarnessChecks: Flag.boolean("require-harness-checks").pipe(Flag.withDefault(false)),
        promoteProposals: Flag.boolean("promote-proposals").pipe(Flag.withDefault(false)),
        proposalDryRun: Flag.boolean("proposal-dry-run").pipe(Flag.withDefault(false)),
        promotionMode: Flag.choice("promotion-mode", ["per-candidate", "merge-evidence"] as const).pipe(Flag.withDefault("per-candidate")),
        taskDir: Flag.string("task-dir").pipe(Flag.optional),
        proposalTarget: Flag.string("proposal-target").pipe(Flag.optional),
        proposalSection: Flag.string("proposal-section").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ sourceKind, action, classifier, search, taskLike, topicReport, listProposals, listHarnessFacts, reviewCoverage, includeHarnessFacts, includeHelperFacts, includeReviewFacts, guidanceDecision, guidanceDecisionBatch, proposalStatus, expandEvidence, evidencePack, classifierFixturePack, coverageFixturePack, coverageReviewPack, coverageReviewBrief, syncCoverageReviewBrief, harnessFacts, harnessWritePlan, applyHarnessFacts, reviewFacts, reviewWritePlan, applyReviewFacts, requireReviewProvenance, requireReviewHandoff, reviewProvenanceReviewer, reviewProvenanceReviewedAt, reviewPipelineLifecycle, reviewPipelineVerifyOutputs, reviewPipelineReviewer, reviewPipelineReviewedAt, limit, examples, out, brief, syncBrief, promoteTasks, emitAdjacentTasks, emitPendingReviewTask, listPendingReviewTasks, repairPendingReviewContext, repairTarget, repairedFixturePack, repairedReviewBrief, pendingReviewTaskPath, pendingReviewTaskStatus, pendingReviewDecisionStatus, pendingReviewCommandStatus, pendingReviewRoute, pendingReviewProgressStatus, promoteHarnessProposals, requireHarnessChecks, promoteProposals, proposalDryRun, promotionMode, taskDir, proposalTarget, proposalSection, json }) => {
        const actionValue = optionValue(action);
        const classifierValue = optionValue(classifier);
        const searchValue = optionValue(search);
        const outPath = optionValue(out);
        const briefPath = optionValue(brief);
        const syncBriefPath = optionValue(syncBrief);
        const evidencePackPath = optionValue(evidencePack);
        const classifierFixturePackPath = optionValue(classifierFixturePack);
        const coverageFixturePackPath = optionValue(coverageFixturePack);
        const coverageReviewPackPath = optionValue(coverageReviewPack);
        const coverageReviewBriefPath = optionValue(coverageReviewBrief);
        const syncCoverageReviewBriefPath = optionValue(syncCoverageReviewBrief);
        const harnessFactsPath = optionValue(harnessFacts);
        const harnessWritePlanPath = optionValue(harnessWritePlan);
        const reviewFactsPath = optionValue(reviewFacts);
        const reviewWritePlanPath = optionValue(reviewWritePlan);
        const reviewProvenanceReviewerValue = optionValue(reviewProvenanceReviewer);
        const reviewProvenanceReviewedAtValue = optionValue(reviewProvenanceReviewedAt);
        const reviewPipelineReviewerValue = optionValue(reviewPipelineReviewer);
        const reviewPipelineReviewedAtValue = optionValue(reviewPipelineReviewedAt);
        const pendingReviewTaskPathValue = optionValue(pendingReviewTaskPath);
        const pendingReviewTaskStatusValue = optionValue(pendingReviewTaskStatus);
        const pendingReviewDecisionStatusValue = optionValue(pendingReviewDecisionStatus);
        const pendingReviewCommandStatusValue = optionValue(pendingReviewCommandStatus);
        const pendingReviewRouteValue = optionValue(pendingReviewRoute);
        const pendingReviewProgressStatusValue = optionValue(pendingReviewProgressStatus);
        const repairTargetValue = optionValue(repairTarget);
        const repairedFixturePackPath = optionValue(repairedFixturePack);
        const repairedReviewBriefPath = optionValue(repairedReviewBrief);
        const taskDirPath = optionValue(taskDir);
        const proposalTargetPath = optionValue(proposalTarget);
        const proposalSectionValue = optionValue(proposalSection);
        return runClassifiersWorkflowCandidates({
            sourceKind,
            limit,
            examples,
            ...(actionValue === undefined ? {} : { action: actionValue }),
            ...(classifierValue === undefined ? {} : { classifier: classifierValue }),
            ...(searchValue === undefined ? {} : { search: searchValue }),
            taskLike: taskLike as WorkflowCandidateTaskLikeMode,
            topicReport,
            listProposals,
            listHarnessFacts,
            reviewCoverage,
            includeHarnessFacts,
            includeHelperFacts,
            includeReviewFacts,
            guidanceDecision,
            guidanceDecisionBatch,
            proposalStatus: proposalStatus as WorkflowCandidateProposalStatusFilter,
            expandEvidence,
            ...(evidencePackPath === undefined ? {} : { evidencePack: evidencePackPath }),
            ...(classifierFixturePackPath === undefined ? {} : { classifierFixturePack: classifierFixturePackPath }),
            ...(coverageFixturePackPath === undefined ? {} : { coverageFixturePack: coverageFixturePackPath }),
            ...(coverageReviewPackPath === undefined ? {} : { coverageReviewPack: coverageReviewPackPath }),
            ...(coverageReviewBriefPath === undefined ? {} : { coverageReviewBrief: coverageReviewBriefPath }),
            ...(syncCoverageReviewBriefPath === undefined ? {} : { syncCoverageReviewBrief: syncCoverageReviewBriefPath }),
            ...(harnessFactsPath === undefined ? {} : { harnessFacts: harnessFactsPath }),
            ...(harnessWritePlanPath === undefined ? {} : { harnessWritePlan: harnessWritePlanPath }),
            applyHarnessFacts,
            ...(reviewFactsPath === undefined ? {} : { reviewFacts: reviewFactsPath }),
            ...(reviewWritePlanPath === undefined ? {} : { reviewWritePlan: reviewWritePlanPath }),
            applyReviewFacts,
            requireReviewProvenance,
            requireReviewHandoff,
            ...(reviewProvenanceReviewerValue === undefined ? {} : { reviewProvenanceReviewer: reviewProvenanceReviewerValue }),
            ...(reviewProvenanceReviewedAtValue === undefined ? {} : { reviewProvenanceReviewedAt: reviewProvenanceReviewedAtValue }),
            reviewPipelineLifecycle,
            reviewPipelineVerifyOutputs,
            ...(reviewPipelineReviewerValue === undefined ? {} : { reviewPipelineReviewer: reviewPipelineReviewerValue }),
            ...(reviewPipelineReviewedAtValue === undefined ? {} : { reviewPipelineReviewedAt: reviewPipelineReviewedAtValue }),
            ...(outPath === undefined ? {} : { out: outPath }),
            ...(briefPath === undefined ? {} : { brief: briefPath }),
            ...(syncBriefPath === undefined ? {} : { syncBrief: syncBriefPath }),
            promoteTasks,
            emitAdjacentTasks,
            emitPendingReviewTask,
            listPendingReviewTasks,
            repairPendingReviewContext,
            ...(repairTargetValue === undefined ? {} : { repairTarget: repairTargetValue }),
            ...(repairedFixturePackPath === undefined ? {} : { repairedFixturePack: repairedFixturePackPath }),
            ...(repairedReviewBriefPath === undefined ? {} : { repairedReviewBrief: repairedReviewBriefPath }),
            ...(pendingReviewTaskPathValue === undefined ? {} : { pendingReviewTaskPath: pendingReviewTaskPathValue }),
            ...(pendingReviewTaskStatusValue === undefined ? {} : { pendingReviewTaskStatus: pendingReviewTaskStatusValue as WorkflowCandidateGuidancePendingReviewTaskStatus }),
            ...(pendingReviewDecisionStatusValue === undefined ? {} : { pendingReviewDecisionStatus: pendingReviewDecisionStatusValue as WorkflowCandidateGuidancePendingReviewDecisionStatus }),
            ...(pendingReviewCommandStatusValue === undefined ? {} : { pendingReviewCommandStatus: pendingReviewCommandStatusValue as WorkflowCandidateGuidancePendingReviewCommandStatus }),
            ...(pendingReviewRouteValue === undefined ? {} : { pendingReviewRoute: pendingReviewRouteValue as WorkflowCandidateGuidancePendingReviewRecommendedRoute }),
            ...(pendingReviewProgressStatusValue === undefined ? {} : { pendingReviewProgressStatus: pendingReviewProgressStatusValue as WorkflowCandidateGuidancePendingReviewProgressStatus }),
            promoteHarnessProposals,
            requireHarnessChecks,
            promoteProposals,
            proposalDryRun,
            promotionMode: promotionMode as WorkflowCandidatePromotionMode,
            ...(taskDirPath === undefined ? {} : { taskDir: taskDirPath }),
            ...(proposalTargetPath === undefined ? {} : { proposalTarget: proposalTargetPath }),
            ...(proposalSectionValue === undefined ? {} : { proposalSection: proposalSectionValue }),
            json,
        });
    },
).pipe(Command.withDescription("Rank transcript-backed workflow candidates from classifier graph facts"));

const classifiersLabelMiningCommand = Command.make(
    "label-mining",
    {
        since: Flag.integer("since").pipe(Flag.withDefault(14)),
        limit: Flag.integer("limit").pipe(Flag.withDefault(500)),
        reviewLimit: Flag.integer("review-limit").pipe(Flag.withDefault(80)),
        out: Flag.string("out").pipe(Flag.optional),
        projectReviewed: Flag.boolean("project-reviewed").pipe(Flag.withDefault(false)),
        vectors: Flag.boolean("vectors").pipe(Flag.withDefault(false)),
        graphProjection: Flag.boolean("graph-projection").pipe(Flag.withDefault(false)),
        apply: Flag.boolean("apply").pipe(Flag.withDefault(false)),
        selfImproveQuery: Flag.boolean("self-improve-query").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ since, limit, reviewLimit, out, projectReviewed, vectors, graphProjection, apply, selfImproveQuery, json }) => {
        const outPath = optionValue(out);
        const runProjection = projectReviewed || vectors || graphProjection;
        return Effect.gen(function* () {
            const svc = yield* LabelMiningService;
            if (selfImproveQuery) {
                const result = yield* svc.selfImproveQuery(
                    outPath === undefined ? {} : { out: outPath },
                );
                if (json) console.log(prettyPrint(result));
                else console.log(renderSelfImproveText(result));
                return;
            }
            if (runProjection) {
                const report = yield* svc.projectReviewed({
                    apply,
                    ...(outPath === undefined ? {} : { out: outPath }),
                });
                if (json) console.log(prettyPrint(report));
                else console.log(renderGraphProjectionText(report));
                return;
            }
            const reportInput = { sinceDays: since, limit, reviewLimit };
            const report = outPath === undefined
                ? yield* svc.miningReport(reportInput)
                : yield* svc.writeMiningReport({ ...reportInput, out: outPath });
            if (json) console.log(prettyPrint(report));
            else {
                console.log(
                    `transcript label mining - candidates ${report.candidate_count}, review rows ${report.review_rows.length}, families ${report.review_diversity.label_family_count}`,
                );
            }
        }).pipe(
            Effect.provide(LabelMiningServiceLive),
            Effect.catchTag("LabelMiningReportWriteError", (e) =>
                Effect.promise(async () => {
                    process.stderr.write(
                        `axctl classifiers label-mining: write error - ${e.message} (${e.path})\n`,
                    );
                    process.exit(1);
                }),
            ),
            catchDbErrorAndExit("axctl classifiers label-mining"),
        );
    },
).pipe(
    Command.withDescription(
        "Mine transcript label candidates, project reviewed labels to the graph, and query reviewed/advisory/rejected separation",
    ),
);

export const classifiersCommand = Command.make("classifiers").pipe(
    Command.withDescription("Develop and evaluate ax classifiers"),
    Command.withSubcommands([
        classifiersListCommand,
        classifiersEvalCommand,
        classifiersExplainCommand,
        classifiersGraphCommand,
        classifiersLifecycleCommand,
        classifiersPackageOperationsCommand,
        classifiersWorkflowCandidatesCommand,
        classifiersLabelMiningCommand,
    ]),
);

export const classifiersPackageOperationsNeedsDb = (args: ReadonlyArray<string>): boolean =>
    args[0] === "classifiers" &&
    args[1] === "package-operations" &&
    (
        args.includes("--apply-write-plan") ||
        args.includes("--graph-health") ||
        args.includes("--boundary-replay-summary")
    );

// The classifiers family owns its sub-routing (issue #241): dispatch reads
// this db-conditional declaration via resolveRuntime instead of hard-coding
// subcommand names. effect-cli.test.ts enforces this table is exhaustive
// against classifiersCommand's registered subcommands in both directions.
export const classifiersRuntime: RuntimeManifest = {
    classifiers: {
        kind: "db-conditional",
        fallback: "db",
        subcommands: {
            list: "none",
            eval: "none",
            explain: "db",
            graph: "db",
            lifecycle: "db",
            "package-operations": (args) =>
                classifiersPackageOperationsNeedsDb(args) ? "db" : "none",
            "workflow-candidates": "db",
            "label-mining": "db",
        },
    },
};
