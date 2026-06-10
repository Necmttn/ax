import type { ReviewPainInput } from "./delivery.ts";

export type ReviewerKind = "human" | "bot" | "ai_reviewer" | "unknown";
export type PullRequestState = "open" | "closed" | "merged" | "unknown";
export type ReviewSeverity = "info" | "warning" | "critical";
export type ReviewCategory = "general" | "test_gap" | "security" | "correctness" | "style";

export interface NormalizedPullRequest {
    readonly number: number | null;
    readonly title: string | null;
    readonly state: PullRequestState;
    readonly baseBranch: string | null;
    readonly headBranch: string | null;
    readonly headSha: string | null;
    readonly mergeSha: string | null;
    readonly author: string | null;
    readonly url: string | null;
    readonly openedAt: string | null;
    readonly closedAt: string | null;
    readonly mergedAt: string | null;
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: number;
    readonly commitCount: number;
    readonly labels: readonly string[];
    readonly raw: unknown;
}

export interface NormalizedReviewEvent {
    readonly reviewer: string | null;
    readonly reviewerKind: ReviewerKind;
    readonly state: string | null;
    readonly bodyExcerpt: string;
    readonly severity: ReviewSeverity;
    readonly category: ReviewCategory;
    readonly unresolved: false;
    readonly ts: string | null;
    readonly raw: unknown;
}

export interface NormalizedCheckRun {
    readonly name: string | null;
    readonly status: string | null;
    readonly conclusion: string | null;
    readonly url: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly raw: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number {
    const numberValue = finiteNumberOrNull(value);
    return numberValue === null ? 0 : Math.max(0, numberValue);
}

function labelsFromRaw(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];

    return value.flatMap((label) => {
        if (typeof label === "string" && label.length > 0) return [label];

        const name = stringOrNull(asRecord(label).name);
        return name === null ? [] : [name];
    });
}

function normalizePullRequestState(rawState: unknown, mergedAt: string | null): PullRequestState {
    if (mergedAt !== null) return "merged";

    const state = stringOrNull(rawState)?.toLowerCase();
    // "merged" is included to handle gh CLI uppercase "MERGED" (after toLowerCase)
    if (state === "open" || state === "closed" || state === "merged") return state;
    return "unknown";
}

function reviewText(raw: Record<string, unknown>): string {
    return stringOrNull(raw.body) ?? "";
}

export function classifyReviewerKind(login: string | null | undefined, type: string | null | undefined): ReviewerKind {
    const normalizedLogin = login?.trim().toLowerCase() ?? "";
    const normalizedType = type?.trim().toLowerCase() ?? "";

    if (normalizedLogin.length === 0 && normalizedType.length === 0) return "unknown";

    if (
        /(?:^|[-_])(code)?rabbit(?:ai)?(?:$|[-_\[])/.test(normalizedLogin)
        || /copilot/.test(normalizedLogin)
        || /sourcery/.test(normalizedLogin)
        || /deepsource/.test(normalizedLogin)
        || /(?:^|[-_])ai[-_]?review/.test(normalizedLogin)
    ) {
        return "ai_reviewer";
    }

    if (normalizedType === "bot" || /\[bot]$/.test(normalizedLogin) || /bot$/.test(normalizedLogin)) return "bot";
    if (normalizedType === "user" || normalizedLogin.length > 0) return "human";
    return "unknown";
}

export function normalizePullRequest(raw: unknown): NormalizedPullRequest {
    const pr = asRecord(raw);
    // REST: pr.base.ref / pr.head.ref; gh CLI: pr.baseRefName / pr.headRefName
    const base = asRecord(pr.base);
    const head = asRecord(pr.head);
    // REST: pr.user.login; gh CLI: pr.author.login
    const user = asRecord(pr.user);
    const ghAuthor = asRecord(pr.author);
    // REST: pr.merge_commit_sha; gh CLI: pr.mergeCommit.oid
    const mergeCommit = asRecord(pr.mergeCommit);
    // REST: pr.merged_at; gh CLI: pr.mergedAt
    const mergedAt = stringOrNull(pr.merged_at) ?? stringOrNull(pr.mergedAt);

    // REST: pr.commits is a number; gh CLI: pr.commits is an array - use length
    const rawCommits = pr.commits;
    const commitCount = Array.isArray(rawCommits) ? rawCommits.length : nonNegativeNumber(rawCommits);

    return {
        number: finiteNumberOrNull(pr.number),
        title: stringOrNull(pr.title),
        state: normalizePullRequestState(pr.state, mergedAt),
        baseBranch: stringOrNull(base.ref) ?? stringOrNull(pr.baseRefName),
        headBranch: stringOrNull(head.ref) ?? stringOrNull(pr.headRefName),
        headSha: stringOrNull(head.sha) ?? stringOrNull(pr.headRefOid),
        mergeSha: stringOrNull(pr.merge_commit_sha) ?? stringOrNull(mergeCommit.oid),
        author: stringOrNull(user.login) ?? stringOrNull(ghAuthor.login),
        url: stringOrNull(pr.html_url) ?? stringOrNull(pr.url),
        openedAt: stringOrNull(pr.created_at) ?? stringOrNull(pr.createdAt),
        closedAt: stringOrNull(pr.closed_at) ?? stringOrNull(pr.closedAt),
        mergedAt,
        additions: nonNegativeNumber(pr.additions),
        deletions: nonNegativeNumber(pr.deletions),
        // REST: pr.changed_files; gh CLI: pr.changedFiles
        changedFiles: nonNegativeNumber(finiteNumberOrNull(pr.changed_files) ?? pr.changedFiles),
        commitCount,
        labels: labelsFromRaw(pr.labels),
        raw,
    };
}

function classifyReviewCategory(state: string | null, body: string): ReviewCategory {
    const haystack = `${state ?? ""}\n${body}`.toLowerCase();

    if (/security|vulnerab|exploit|secret|injection|xss|csrf/.test(haystack)) return "security";
    if (/\btests?\b|coverage|regression test/.test(haystack)) return "test_gap";
    if (/\brace\b|bug|incorrect|correctness|regression|deadlock/.test(haystack)) return "correctness";
    if (/style|format|lint|naming|prettier/.test(haystack)) return "style";
    return "general";
}

function classifyReviewSeverity(state: string | null, body: string): ReviewSeverity {
    const haystack = `${state ?? ""}\n${body}`.toLowerCase();

    if (state === "CHANGES_REQUESTED" || /\brace\b|security|vulnerab|exploit/.test(haystack)) return "critical";
    if (/bug|correctness|test|coverage|style|lint/.test(haystack)) return "warning";
    return "info";
}

export function normalizeReviewEvent(raw: unknown): NormalizedReviewEvent {
    const review = asRecord(raw);
    // REST: review.user.login / review.user.type; gh CLI: review.author.login / review.author.type
    const user = asRecord(review.user);
    const ghAuthor = asRecord(review.author);
    const reviewer = stringOrNull(user.login) ?? stringOrNull(ghAuthor.login);
    const reviewerType = stringOrNull(user.type) ?? stringOrNull(ghAuthor.type);
    const state = stringOrNull(review.state)?.toUpperCase() ?? null;
    const body = reviewText(review);

    return {
        reviewer,
        reviewerKind: classifyReviewerKind(reviewer, reviewerType),
        state,
        bodyExcerpt: body.slice(0, 500),
        severity: classifyReviewSeverity(state, body),
        category: classifyReviewCategory(state, body),
        unresolved: false,
        // REST: review.submitted_at; gh CLI: review.submittedAt
        ts: stringOrNull(review.submitted_at) ?? stringOrNull(review.submittedAt) ?? stringOrNull(review.created_at) ?? stringOrNull(review.updated_at),
        raw,
    };
}

export function normalizeCheckRun(raw: unknown): NormalizedCheckRun {
    const check = asRecord(raw);
    const typename = stringOrNull(check.__typename);

    if (typename === "StatusContext") {
        return {
            name: stringOrNull(check.context),
            // StatusContext has no status field; infer COMPLETED when state is present
            status: stringOrNull(check.status) ?? (check.state ? "COMPLETED" : null),
            conclusion: stringOrNull(check.state),
            url: stringOrNull(check.targetUrl),
            startedAt: null,
            completedAt: null,
            raw,
        };
    }

    // Default: treat as CheckRun (typename === "CheckRun" or unknown)
    return {
        name: stringOrNull(check.name),
        status: stringOrNull(check.status),
        conclusion: stringOrNull(check.conclusion),
        url: stringOrNull(check.detailsUrl),
        startedAt: stringOrNull(check.startedAt),
        completedAt: stringOrNull(check.completedAt),
        raw,
    };
}

/** Conclusions that indicate a check run did not pass. */
const FAILED_CONCLUSIONS = new Set([
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "STARTUP_FAILURE",
    "ACTION_REQUIRED",
]);

/**
 * Aggregate review and CI signal from gh CLI output into a ReviewPainInput.
 *
 * @param reviews - gh `reviews` array; each entry has state, author, body, etc.
 * @param statusCheckRollup - gh `statusCheckRollup` array; entries may be
 *   CheckRun or StatusContext __typename variants.
 */
export function aggregateReviewPain(reviews: unknown, statusCheckRollup: unknown): ReviewPainInput {
    const reviewList = Array.isArray(reviews) ? reviews : [];
    const checkList = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];

    let approvals = 0;
    let changesRequested = 0;
    let comments = 0;
    let criticalComments = 0;

    for (const review of reviewList) {
        const normalized = normalizeReviewEvent(review);
        const state = normalized.state;

        if (state === "APPROVED") approvals++;
        else if (state === "CHANGES_REQUESTED") changesRequested++;
        else if (state === "COMMENTED") comments++;

        if (normalized.severity === "critical") criticalComments++;
    }

    let failedChecks = 0;
    for (const check of checkList) {
        const normalized = normalizeCheckRun(check);
        if (normalized.conclusion !== null && FAILED_CONCLUSIONS.has(normalized.conclusion)) {
            failedChecks++;
        }
    }

    // unresolvedThreads is 0 for v0 - gh pr list does not expose resolved-thread state
    return {
        approvals,
        changesRequested,
        comments,
        criticalComments,
        failedChecks,
        unresolvedThreads: 0,
    };
}
