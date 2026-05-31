import { describe, expect, test } from "bun:test";
import {
    CLASSIFIER_PACKAGE_SCHEMA,
    findClassifierPackageOperation,
    isClassifierPackageManifest,
    listClassifierPackageOperations,
    loadClassifierPackageManifest,
    requireClassifierPackageOperation,
} from "./package-manifest.ts";

describe("classifier package manifest", () => {
    test("loads the example manifest", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-verification-event/ax.classifier.json");

        expect(manifest.schema).toBe(CLASSIFIER_PACKAGE_SCHEMA);
        expect(manifest.key).toBe("verification-event");
        expect(manifest.labels).toContain("verification_request");
    });

    test("loads the direction-event package manifest", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-direction-event/ax.classifier.json");

        expect(manifest.schema).toBe(CLASSIFIER_PACKAGE_SCHEMA);
        expect(manifest.key).toBe("direction-event");
        expect(manifest.package).toBe("@ax-classifier/direction-event");
        expect(manifest.targets).toContain("tooling_preference");
    });

    test("loads the session-sections local model package manifest", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        expect(manifest.schema).toBe(CLASSIFIER_PACKAGE_SCHEMA);
        expect(manifest.key).toBe("session-section-chunks");
        expect(manifest.kind).toBe("local_model");
        expect(manifest.labels).toContain("verification_request");
        expect(manifest.targets).toContain("section_candidate");
        expect(manifest.assets?.some((asset) => asset.kind === "model" && asset.optional)).toBe(true);
        expect(manifest.operations?.some((operation) => operation.id === "blind-review-refresh")).toBe(true);
        expect(manifest.operations?.find((operation) => operation.id === "blind-review-refresh")?.kind).toBe("review");
        expect(manifest.operations?.find((operation) => operation.id === "blind-review-refresh")?.outputs).toContain(".ax/experiments/blind-workflow-status-current.json");
        expect(manifest.operations?.find((operation) => operation.id === "setfit-train-eval")?.kind).toBe("train");
        expect(manifest.operations?.find((operation) => operation.id === "setfit-fixture-eval")?.kind).toBe("eval");
        expect(manifest.operations?.find((operation) => operation.id === "hybrid-window-candidate-projection")?.command).toContain("classifiers:hybrid-window-candidate-projection");
        expect(manifest.operations?.find((operation) => operation.id === "hybrid-window-candidate-apply")?.kind).toBe("publish");
        expect(manifest.operations?.find((operation) => operation.id === "hybrid-window-workflow-candidate-report")?.command).toContain("--source-kind=hybrid_window_classifier_projection");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-candidate-source-compare")?.command).toContain("classifiers:workflow-candidate-compare");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-candidate-combined-report")?.command).toContain("classifiers:workflow-candidate-combined");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-candidate-proposal-pack")?.kind).toBe("review");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-candidate-proposal-review")?.command).toContain("classifiers:workflow-candidate-proposal-review");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-candidate-proposal-promote-drafts")?.command).toContain("classifiers:workflow-candidate-proposal-promote");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-candidate-proposal-ready-smoke")?.command).toContain("classifiers:workflow-candidate-proposal-promote-smoke");
        expect(manifest.operations?.find((operation) => operation.id === "embedding-helper-fixture-metadata")?.command).toContain("classifiers:fixture-metadata");
        expect(manifest.operations?.find((operation) => operation.id === "embedding-helper-fixture-split-audit")?.kind).toBe("eval");
        expect(manifest.operations?.find((operation) => operation.id === "embedding-helper-fixture-setfit-robustness")?.command).toContain("classifiers:setfit-robustness");
        expect(manifest.operations?.find((operation) => operation.id === "embedding-helper-fixture-failure-analysis")?.command).toContain("classifiers:failure-analysis");
        expect(manifest.operations?.find((operation) => operation.id === "embedding-helper-boundary-miss-review")?.command).toContain("classifiers:boundary-miss-review");
        expect(manifest.operations?.find((operation) => operation.id === "embedding-helper-boundary-miss-review-sync")?.command).toContain("--mode=sync");
        expect(manifest.operations?.find((operation) => operation.id === "graph-health-summary")?.kind).toBe("status");
        expect(manifest.operations?.find((operation) => operation.id === "graph-health-guarded")?.command).toContain("--graph-mode=guarded");
        expect(manifest.operations?.find((operation) => operation.id === "classifier-lifecycle-status")?.outputs).toContain(".ax/experiments/classifiers-lifecycle-current.json");
        expect(manifest.operations?.find((operation) => operation.id === "focused-batch-eval")?.command).toContain("--mode=evaluate");
        expect(manifest.operations?.find((operation) => operation.id === "focused-batch-suggestion-draft")?.command).toContain("--mode=draft-suggestions");
        expect(manifest.operations?.find((operation) => operation.id === "focused-batch-promote-draft")?.command).toContain("--mode=promote-draft");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-review")?.kind).toBe("review");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-review-sync")?.command).toContain("--mode sync");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-append")?.outputs).toContain(".ax/experiments/chunks-with-workflow-fixtures-current.jsonl");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-metadata")?.command).toContain("classifiers:fixture-metadata");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-split-audit")?.kind).toBe("eval");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-setfit-robustness")?.command).toContain("classifiers:setfit-robustness");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-failure-analysis")?.command).toContain("classifiers:failure-analysis");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-none-safety-pregate")?.command).toContain("classifiers:none-safety-pregate");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-none-safety-window-replay")?.command).toContain("classifiers:none-safety-window-replay");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-hybrid-robustness")?.command).toContain("classifiers:hybrid-robustness");
        expect(manifest.operations?.find((operation) => operation.id === "workflow-fixture-hybrid-graph-usefulness")?.command).toContain("classifiers:hybrid-graph-usefulness");
    });

    test("lists and resolves classifier package operations", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-session-sections/ax.classifier.json");

        const operations = listClassifierPackageOperations(manifest);
        const refresh = findClassifierPackageOperation(manifest, "blind-review-refresh");
        const postReview = requireClassifierPackageOperation(manifest, "blind-post-review");
        const train = requireClassifierPackageOperation(manifest, "setfit-train-eval");
        const hybridWindowProjection = requireClassifierPackageOperation(manifest, "hybrid-window-candidate-projection");
        const hybridWindowApply = requireClassifierPackageOperation(manifest, "hybrid-window-candidate-apply");
        const hybridWindowWorkflowReport = requireClassifierPackageOperation(manifest, "hybrid-window-workflow-candidate-report");
        const workflowCandidateCompare = requireClassifierPackageOperation(manifest, "workflow-candidate-source-compare");
        const workflowCandidateCombined = requireClassifierPackageOperation(manifest, "workflow-candidate-combined-report");
        const workflowCandidateProposalPack = requireClassifierPackageOperation(manifest, "workflow-candidate-proposal-pack");
        const workflowCandidateProposalReview = requireClassifierPackageOperation(manifest, "workflow-candidate-proposal-review");
        const workflowCandidateProposalPromote = requireClassifierPackageOperation(manifest, "workflow-candidate-proposal-promote-drafts");
        const workflowCandidateProposalReadySmoke = requireClassifierPackageOperation(manifest, "workflow-candidate-proposal-ready-smoke");
        const embeddingHelperMetadata = requireClassifierPackageOperation(manifest, "embedding-helper-fixture-metadata");
        const embeddingHelperSplitAudit = requireClassifierPackageOperation(manifest, "embedding-helper-fixture-split-audit");
        const embeddingHelperSetFitRobustness = requireClassifierPackageOperation(manifest, "embedding-helper-fixture-setfit-robustness");
        const embeddingHelperFailureAnalysis = requireClassifierPackageOperation(manifest, "embedding-helper-fixture-failure-analysis");
        const embeddingHelperBoundaryReview = requireClassifierPackageOperation(manifest, "embedding-helper-boundary-miss-review");
        const embeddingHelperBoundaryReviewSync = requireClassifierPackageOperation(manifest, "embedding-helper-boundary-miss-review-sync");
        const graphHealth = requireClassifierPackageOperation(manifest, "graph-health-changed-artifacts");
        const lifecycle = requireClassifierPackageOperation(manifest, "classifier-lifecycle-status");
        const batchEval = requireClassifierPackageOperation(manifest, "focused-batch-eval");
        const batchDraft = requireClassifierPackageOperation(manifest, "focused-batch-suggestion-draft");
        const batchPromote = requireClassifierPackageOperation(manifest, "focused-batch-promote-draft");
        const workflowReview = requireClassifierPackageOperation(manifest, "workflow-fixture-review");
        const workflowReviewSync = requireClassifierPackageOperation(manifest, "workflow-fixture-review-sync");
        const workflowAppend = requireClassifierPackageOperation(manifest, "workflow-fixture-append");
        const workflowMetadata = requireClassifierPackageOperation(manifest, "workflow-fixture-metadata");
        const workflowSplitAudit = requireClassifierPackageOperation(manifest, "workflow-fixture-split-audit");
        const workflowSetFitRobustness = requireClassifierPackageOperation(manifest, "workflow-fixture-setfit-robustness");
        const workflowFailureAnalysis = requireClassifierPackageOperation(manifest, "workflow-fixture-failure-analysis");
        const workflowNoneSafetyPreGate = requireClassifierPackageOperation(manifest, "workflow-fixture-none-safety-pregate");
        const workflowNoneSafetyWindowReplay = requireClassifierPackageOperation(manifest, "workflow-fixture-none-safety-window-replay");
        const workflowHybridRobustness = requireClassifierPackageOperation(manifest, "workflow-fixture-hybrid-robustness");
        const workflowHybridGraphUsefulness = requireClassifierPackageOperation(manifest, "workflow-fixture-hybrid-graph-usefulness");

        expect(operations.map((operation) => operation.id)).toContain("blind-workflow-status");
        expect(refresh?.command).toBe("bun run classifiers:blind-review-refresh");
        expect(postReview.outputs).toContain(".ax/experiments/blind-post-review-runner-current.json");
        expect(train.outputs).toContain(".ax/experiments/setfit-session-sections-e3-coarse.json");
        expect(hybridWindowProjection.inputs).toContain(".ax/experiments/hybrid-gate-e4.json");
        expect(hybridWindowProjection.outputs).toContain(".ax/experiments/hybrid-window-candidate-graph-projection-current.json");
        expect(hybridWindowApply.inputs).toContain(".ax/experiments/hybrid-window-candidate-graph-write-plan-current.json");
        expect(hybridWindowWorkflowReport.outputs).toContain(".ax/experiments/workflow-candidate-report-hybrid-window-current.json");
        expect(workflowCandidateCompare.inputs).toContain(".ax/experiments/workflow-candidate-report-hybrid-window-current.json");
        expect(workflowCandidateCombined.outputs).toContain(".ax/experiments/workflow-candidate-combined-current.json");
        expect(workflowCandidateProposalPack.outputs).toContain(".ax/tasks/workflow-candidate-proposals");
        expect(workflowCandidateProposalReview.inputs).toContain(".ax/tasks/workflow-candidate-proposals");
        expect(workflowCandidateProposalReview.outputs).toContain(".ax/experiments/workflow-candidate-proposal-review-current.json");
        expect(workflowCandidateProposalReview.outputs).toContain(".ax/experiments/workflow-candidate-proposal-review-current.md");
        expect(workflowCandidateProposalPromote.inputs).toContain(".ax/experiments/workflow-candidate-proposal-review-current.json");
        expect(workflowCandidateProposalPromote.outputs).toContain(".ax/tasks/workflow-candidate-promotion-drafts");
        expect(workflowCandidateProposalReadySmoke.inputs).toEqual([]);
        expect(workflowCandidateProposalReadySmoke.outputs).toContain(".ax/experiments/workflow-candidate-proposal-ready-smoke-drafts");
        expect(embeddingHelperMetadata.outputs).toContain(".ax/experiments/chunks-with-embedding-helper-fixture-metadata-current.jsonl");
        expect(embeddingHelperSplitAudit.command).toContain("--group-field=pair_group");
        expect(embeddingHelperSetFitRobustness.outputs).toContain(".ax/experiments/setfit-robustness-embedding-helper-fixtures-current.json");
        expect(embeddingHelperFailureAnalysis.outputs).toContain(".ax/experiments/setfit-failure-analysis-embedding-helper-fixtures-current.json");
        expect(embeddingHelperBoundaryReview.outputs).toContain(".ax/experiments/boundary-miss-review-current.md");
        expect(embeddingHelperBoundaryReviewSync.inputs).toContain(".ax/experiments/boundary-miss-review-current.md");
        expect(graphHealth.outputs).toContain(".ax/experiments/classifier-package-execution-graph-health-changed-current.json");
        expect(lifecycle.command).toContain("classifiers lifecycle");
        expect(batchEval.outputs).toContain(".ax/experiments/blind-review-batch-current-eval-report.json");
        expect(batchDraft.outputs).toContain(".ax/experiments/blind-review-batch-current-suggestion-draft-report.json");
        expect(batchPromote.outputs).toContain(".ax/experiments/blind-review-batch-current-promotion-report.json");
        expect(workflowReview.outputs).toContain(".ax/experiments/workflow-fixture-review-current-report.json");
        expect(workflowReviewSync.inputs).toContain(".ax/experiments/workflow-fixture-review-current-reviewed.md");
        expect(workflowAppend.command).toContain("classifiers:fixture-append");
        expect(workflowMetadata.outputs).toContain(".ax/experiments/chunks-with-workflow-fixture-metadata-current.jsonl");
        expect(workflowSplitAudit.command).toContain("--group-field=pair_group");
        expect(workflowSetFitRobustness.outputs).toContain(".ax/experiments/setfit-robustness-workflow-fixtures-current.json");
        expect(workflowFailureAnalysis.outputs).toContain(".ax/experiments/setfit-failure-analysis-workflow-fixtures-current.json");
        expect(workflowNoneSafetyPreGate.outputs).toContain(".ax/experiments/none-safety-pregate-workflow-fixtures-current.json");
        expect(workflowNoneSafetyWindowReplay.inputs).toContain(".ax/experiments/model-windows-none-safety-current.jsonl");
        expect(workflowHybridRobustness.outputs).toContain(".ax/experiments/hybrid-robustness-workflow-fixtures-current.json");
        expect(workflowHybridGraphUsefulness.inputs).toContain(".ax/experiments/hybrid-robustness-workflow-fixtures-current.json");
        expect(workflowHybridGraphUsefulness.outputs).toContain(".ax/experiments/hybrid-graph-usefulness-workflow-fixtures-current.json");
    });

    test("requires classifier package operation by id", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-verification-event/ax.classifier.json");

        expect(listClassifierPackageOperations(manifest)).toEqual([]);
        expect(findClassifierPackageOperation(manifest, "missing")).toBeUndefined();
        expect(() => requireClassifierPackageOperation(manifest, "missing")).toThrow("classifier package verification-event does not declare operation: missing");
    });

    test("rejects incomplete manifest shapes", () => {
        expect(isClassifierPackageManifest({ schema: CLASSIFIER_PACKAGE_SCHEMA })).toBe(false);
    });

    test("rejects unsupported classifier kind and input values", () => {
        expect(isClassifierPackageManifest({
            schema: CLASSIFIER_PACKAGE_SCHEMA,
            key: "bad-kind",
            version: "0.1.0",
            package: "@ax-classifier/bad-kind",
            entrypoint: "./src/index.ts",
            kind: "embedding",
            input: "event_window",
            description: "invalid kind",
            labels: ["direction"],
            targets: ["tooling_preference"],
        })).toBe(false);

        expect(isClassifierPackageManifest({
            schema: CLASSIFIER_PACKAGE_SCHEMA,
            key: "bad-input",
            version: "0.1.0",
            package: "@ax-classifier/bad-input",
            entrypoint: "./src/index.ts",
            kind: "heuristic",
            input: "event",
            description: "invalid input",
            labels: ["direction"],
            targets: ["tooling_preference"],
        })).toBe(false);
    });

    test("rejects malformed assets", () => {
        expect(isClassifierPackageManifest({
            schema: CLASSIFIER_PACKAGE_SCHEMA,
            key: "bad-asset",
            version: "0.1.0",
            package: "@ax-classifier/bad-asset",
            entrypoint: "./src/index.ts",
            kind: "local_model",
            input: "event_window",
            description: "invalid asset",
            labels: ["direction"],
            targets: ["tooling_preference"],
            assets: [{ id: "model", kind: "blob" }],
        })).toBe(false);

        expect(isClassifierPackageManifest({
            schema: CLASSIFIER_PACKAGE_SCHEMA,
            key: "missing-asset-location",
            version: "0.1.0",
            package: "@ax-classifier/missing-asset-location",
            entrypoint: "./src/index.ts",
            kind: "local_model",
            input: "event_window",
            description: "invalid asset",
            labels: ["direction"],
            targets: ["tooling_preference"],
            assets: [{ id: "model", kind: "model" }],
        })).toBe(false);
    });

    test("rejects malformed operations", () => {
        expect(isClassifierPackageManifest({
            schema: CLASSIFIER_PACKAGE_SCHEMA,
            key: "bad-operation",
            version: "0.1.0",
            package: "@ax-classifier/bad-operation",
            entrypoint: "./src/index.ts",
            kind: "local_model",
            input: "event_window",
            description: "invalid operation",
            labels: ["direction"],
            targets: ["tooling_preference"],
            operations: [{ id: "refresh", command: "bun run refresh" }],
        })).toBe(false);

        expect(isClassifierPackageManifest({
            schema: CLASSIFIER_PACKAGE_SCHEMA,
            key: "bad-operation-outputs",
            version: "0.1.0",
            package: "@ax-classifier/bad-operation-outputs",
            entrypoint: "./src/index.ts",
            kind: "local_model",
            input: "event_window",
            description: "invalid operation outputs",
            labels: ["direction"],
            targets: ["tooling_preference"],
            operations: [{ id: "refresh", kind: "review", description: "refresh artifacts", command: "bun run refresh", outputs: [1] }],
        })).toBe(false);

        expect(isClassifierPackageManifest({
            schema: CLASSIFIER_PACKAGE_SCHEMA,
            key: "bad-operation-kind",
            version: "0.1.0",
            package: "@ax-classifier/bad-operation-kind",
            entrypoint: "./src/index.ts",
            kind: "local_model",
            input: "event_window",
            description: "invalid operation kind",
            labels: ["direction"],
            targets: ["tooling_preference"],
            operations: [{ id: "refresh", kind: "hydrate", description: "refresh artifacts", command: "bun run refresh" }],
        })).toBe(false);
    });
});
