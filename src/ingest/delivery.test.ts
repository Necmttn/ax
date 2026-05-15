import { describe, expect, test } from "bun:test";
import { classifyDeliveryStatus, scorePrSize, scoreReviewPain } from "./delivery.ts";

describe("scorePrSize", () => {
    test("classifies a tiny PR as small", () => {
        const result = scorePrSize({
            additions: 8,
            deletions: 2,
            changedFiles: 1,
            commitCount: 1,
        });

        expect(result.label).toBe("small");
        expect(result.score).toBeLessThan(35);
        expect(result.reasons).toContain("10 lines changed");
    });

    test("classifies a broad PR as large with a high score", () => {
        const result = scorePrSize({
            additions: 1_200,
            deletions: 450,
            changedFiles: 28,
            commitCount: 12,
        });

        expect(result.label).toBe("large");
        expect(result.score).toBeGreaterThanOrEqual(80);
    });
});

describe("scoreReviewPain", () => {
    test("classifies no review friction as low", () => {
        const result = scoreReviewPain({
            approvals: 0,
            changesRequested: 0,
            comments: 0,
            criticalComments: 0,
            failedChecks: 0,
            unresolvedThreads: 0,
        });

        expect(result.label).toBe("low");
        expect(result.score).toBe(0);
        expect(result.reasons).toContain("no review friction");
    });

    test("classifies one requested change as moderate", () => {
        const result = scoreReviewPain({
            approvals: 0,
            changesRequested: 1,
            comments: 0,
            criticalComments: 0,
            failedChecks: 0,
            unresolvedThreads: 0,
        });

        expect(result.label).toBe("moderate");
        expect(result.score).toBeGreaterThanOrEqual(25);
    });

    test("keeps requested changes moderate even with approvals", () => {
        const result = scoreReviewPain({
            approvals: 3,
            changesRequested: 1,
            comments: 0,
            criticalComments: 0,
            failedChecks: 0,
            unresolvedThreads: 0,
        });

        expect(result.label).toBe("moderate");
        expect(result.score).toBeGreaterThanOrEqual(25);
    });

    test("classifies comment-only review volume as moderate or high", () => {
        const moderate = scoreReviewPain({
            approvals: 0,
            changesRequested: 0,
            comments: 10,
            criticalComments: 0,
            failedChecks: 0,
            unresolvedThreads: 0,
        });
        const high = scoreReviewPain({
            approvals: 0,
            changesRequested: 0,
            comments: 20,
            criticalComments: 0,
            failedChecks: 0,
            unresolvedThreads: 0,
        });

        expect(moderate.label).toBe("moderate");
        expect(high.label).toBe("high");
    });

    test("classifies requested changes, critical comments, failed checks, and unresolved threads as roasted", () => {
        const result = scoreReviewPain({
            approvals: 0,
            changesRequested: 1,
            comments: 5,
            criticalComments: 1,
            failedChecks: 2,
            unresolvedThreads: 1,
        });

        expect(result.label).toBe("roasted");
        expect(result.score).toBeGreaterThanOrEqual(80);
        expect(result.reasons).toContain("1 changes requested");
        expect(result.reasons).toContain("1 critical comments");
        expect(result.reasons).toContain("2 failed checks");
        expect(result.reasons).toContain("1 unresolved threads");
    });
});

describe("classifyDeliveryStatus", () => {
    test("classifies a merged PR that reached main", () => {
        expect(classifyDeliveryStatus({ prState: "merged", reachedMain: true })).toBe("merged_to_main");
    });

    test("classifies promotion to main without a PR", () => {
        expect(classifyDeliveryStatus({ reachedMain: true })).toBe("promoted_without_pr");
    });

    test("classifies a closed unmerged PR", () => {
        expect(classifyDeliveryStatus({ prState: "closed", reachedMain: false })).toBe("closed_unmerged");
    });

    test("classifies an open PR that has not reached main", () => {
        expect(classifyDeliveryStatus({ prState: "open", reachedMain: false })).toBe("open_pr");
    });

    test("classifies work without a PR or promotion as local only", () => {
        expect(classifyDeliveryStatus({ reachedMain: false })).toBe("local_only");
    });
});
