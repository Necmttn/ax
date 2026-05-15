export type PrSizeLabel = "small" | "medium" | "large";
export type ReviewPainLabel = "low" | "moderate" | "high" | "roasted";
export type DeliveryStatus =
    | "merged_to_main"
    | "merged_unverified"
    | "promoted_without_pr"
    | "closed_unmerged"
    | "open_pr"
    | "local_only";

export interface PrSizeInput {
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: number;
    readonly commitCount: number;
}

export interface ReviewPainInput {
    readonly approvals: number;
    readonly changesRequested: number;
    readonly comments: number;
    readonly criticalComments: number;
    readonly failedChecks: number;
    readonly unresolvedThreads: number;
}

export interface DeliveryStatusInput {
    readonly prState?: "open" | "closed" | "merged" | null;
    readonly reachedMain: boolean;
}

export interface ScoreResult<Label extends string> {
    readonly label: Label;
    readonly score: number;
    readonly reasons: readonly string[];
}

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));
const nonNegative = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;

function bucketScore(value: number, buckets: readonly (readonly [number, number])[]): number {
    for (const [limit, score] of buckets) {
        if (value <= limit) return score;
    }
    return buckets[buckets.length - 1]?.[1] ?? 0;
}

export function scorePrSize(input: PrSizeInput): ScoreResult<PrSizeLabel> {
    const additions = nonNegative(input.additions);
    const deletions = nonNegative(input.deletions);
    const changedFiles = nonNegative(input.changedFiles);
    const commitCount = nonNegative(input.commitCount);
    const lineDelta = additions + deletions;

    const score = clampScore(
        bucketScore(lineDelta, [
            [20, 8],
            [100, 22],
            [400, 42],
            [1_000, 64],
            [Number.POSITIVE_INFINITY, 82],
        ])
        + bucketScore(changedFiles, [
            [1, 0],
            [5, 8],
            [12, 16],
            [25, 26],
            [Number.POSITIVE_INFINITY, 34],
        ])
        + bucketScore(commitCount, [
            [1, 0],
            [3, 4],
            [8, 9],
            [15, 14],
            [Number.POSITIVE_INFINITY, 18],
        ]),
    );

    const reasons = [
        `${lineDelta} lines changed`,
        `${changedFiles} files changed`,
        `${commitCount} commits`,
    ];

    if (score >= 70) return { label: "large", score, reasons };
    if (score >= 35) return { label: "medium", score, reasons };
    return { label: "small", score, reasons };
}

export function scoreReviewPain(input: ReviewPainInput): ScoreResult<ReviewPainLabel> {
    const approvals = nonNegative(input.approvals);
    const changesRequested = nonNegative(input.changesRequested);
    const comments = nonNegative(input.comments);
    const criticalComments = nonNegative(input.criticalComments);
    const failedChecks = nonNegative(input.failedChecks);
    const unresolvedThreads = nonNegative(input.unresolvedThreads);

    const hardSignalScore =
        (changesRequested * 28)
        + (criticalComments * 24)
        + (failedChecks * 18)
        + (unresolvedThreads * 16);
    const softCommentScore = Math.min(60, comments * 3);
    const softenedCommentScore = Math.max(0, softCommentScore - Math.min(12, approvals * 4));
    const score = clampScore(hardSignalScore + softenedCommentScore);

    const reasons: string[] = [];
    if (changesRequested > 0) reasons.push(`${changesRequested} changes requested`);
    if (criticalComments > 0) reasons.push(`${criticalComments} critical comments`);
    if (failedChecks > 0) reasons.push(`${failedChecks} failed checks`);
    if (unresolvedThreads > 0) reasons.push(`${unresolvedThreads} unresolved threads`);
    if (comments > 0) reasons.push(`${comments} review comments`);
    if (approvals > 0) reasons.push(`${approvals} approvals`);
    if (reasons.length === 0) reasons.push("no review friction");

    if (score >= 80) return { label: "roasted", score, reasons };
    if (score >= 55) return { label: "high", score, reasons };
    if (score >= 25) return { label: "moderate", score, reasons };
    return { label: "low", score, reasons };
}

export function classifyDeliveryStatus(input: DeliveryStatusInput): DeliveryStatus {
    if (input.reachedMain) {
        return input.prState === "merged" ? "merged_to_main" : "promoted_without_pr";
    }
    if (input.prState === "merged") return "merged_unverified";
    if (input.prState === "closed") return "closed_unmerged";
    if (input.prState === "open") return "open_pr";
    return "local_only";
}
