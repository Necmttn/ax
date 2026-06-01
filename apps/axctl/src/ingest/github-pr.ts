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
    if (state === "open" || state === "closed") return state;
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
    const base = asRecord(pr.base);
    const head = asRecord(pr.head);
    const author = asRecord(pr.user);
    const mergedAt = stringOrNull(pr.merged_at);

    return {
        number: finiteNumberOrNull(pr.number),
        title: stringOrNull(pr.title),
        state: normalizePullRequestState(pr.state, mergedAt),
        baseBranch: stringOrNull(base.ref),
        headBranch: stringOrNull(head.ref),
        headSha: stringOrNull(head.sha),
        mergeSha: stringOrNull(pr.merge_commit_sha),
        author: stringOrNull(author.login),
        url: stringOrNull(pr.html_url) ?? stringOrNull(pr.url),
        openedAt: stringOrNull(pr.created_at),
        closedAt: stringOrNull(pr.closed_at),
        mergedAt,
        additions: nonNegativeNumber(pr.additions),
        deletions: nonNegativeNumber(pr.deletions),
        changedFiles: nonNegativeNumber(pr.changed_files),
        commitCount: nonNegativeNumber(pr.commits),
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
    const user = asRecord(review.user);
    const reviewer = stringOrNull(user.login);
    const reviewerType = stringOrNull(user.type);
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
        ts: stringOrNull(review.submitted_at) ?? stringOrNull(review.created_at) ?? stringOrNull(review.updated_at),
        raw,
    };
}
