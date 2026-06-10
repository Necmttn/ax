import { describe, expect, test } from "bun:test";
import {
    aggregateReviewPain,
    classifyReviewerKind,
    normalizePullRequest,
    normalizeCheckRun,
    normalizeReviewEvent,
} from "./github-pr.ts";

describe("normalizePullRequest", () => {
    test("maps GitHub REST API PR fields into the stable payload", () => {
        const raw = {
            number: 42,
            title: "Ship graph explorer",
            state: "closed",
            html_url: "https://github.com/Necmttn/ax/pull/42",
            user: { login: "necmttn" },
            base: { ref: "main" },
            head: { ref: "feat/graph-explorer", sha: "abc123" },
            merge_commit_sha: "def456",
            created_at: "2026-05-01T10:00:00Z",
            closed_at: "2026-05-02T10:00:00Z",
            merged_at: "2026-05-02T09:30:00Z",
            additions: 120,
            deletions: 15,
            changed_files: 6,
            commits: 3,
            labels: [{ name: "enhancement" }, { name: "graph" }],
        };

        expect(normalizePullRequest(raw)).toEqual({
            number: 42,
            title: "Ship graph explorer",
            state: "merged",
            baseBranch: "main",
            headBranch: "feat/graph-explorer",
            headSha: "abc123",
            mergeSha: "def456",
            author: "necmttn",
            url: "https://github.com/Necmttn/ax/pull/42",
            openedAt: "2026-05-01T10:00:00Z",
            closedAt: "2026-05-02T10:00:00Z",
            mergedAt: "2026-05-02T09:30:00Z",
            additions: 120,
            deletions: 15,
            changedFiles: 6,
            commitCount: 3,
            labels: ["enhancement", "graph"],
            raw,
        });
    });

    test("maps gh CLI camelCase fields (MERGED state, commits as array)", () => {
        const raw = {
            number: 99,
            title: "feat: ingest PR data",
            state: "MERGED",
            url: "https://github.com/Necmttn/ax/pull/99",
            author: { login: "necmttn" },
            baseRefName: "main",
            headRefName: "feat/pr-ingest",
            headRefOid: "sha-head-oid",
            mergeCommit: { oid: "sha-merge-oid" },
            createdAt: "2026-06-01T08:00:00Z",
            closedAt: "2026-06-02T08:00:00Z",
            mergedAt: "2026-06-02T07:45:00Z",
            additions: 200,
            deletions: 30,
            changedFiles: 10,
            // gh --json commits returns an array, not a count
            commits: [
                { oid: "c1" },
                { oid: "c2" },
                { oid: "c3" },
                { oid: "c4" },
            ],
            labels: [{ name: "ingest" }],
        };

        expect(normalizePullRequest(raw)).toEqual({
            number: 99,
            title: "feat: ingest PR data",
            state: "merged",
            baseBranch: "main",
            headBranch: "feat/pr-ingest",
            headSha: "sha-head-oid",
            mergeSha: "sha-merge-oid",
            author: "necmttn",
            url: "https://github.com/Necmttn/ax/pull/99",
            openedAt: "2026-06-01T08:00:00Z",
            closedAt: "2026-06-02T08:00:00Z",
            mergedAt: "2026-06-02T07:45:00Z",
            additions: 200,
            deletions: 30,
            changedFiles: 10,
            commitCount: 4,
            labels: ["ingest"],
            raw,
        });
    });

    test("gh CLI OPEN state without mergedAt maps to open", () => {
        const raw = {
            number: 5,
            title: "WIP",
            state: "OPEN",
            url: "https://github.com/Necmttn/ax/pull/5",
            author: { login: "necmttn" },
            baseRefName: "main",
            headRefName: "wip/branch",
            headRefOid: "sha-wip",
            createdAt: "2026-06-09T10:00:00Z",
            additions: 5,
            deletions: 0,
            changedFiles: 1,
            commits: [],
            labels: [],
        };

        const result = normalizePullRequest(raw);
        expect(result.state).toBe("open");
        expect(result.commitCount).toBe(0);
    });
});

describe("normalizeReviewEvent", () => {
    test("classifies AI requested-change reviews with critical test-gap signals", () => {
        const raw = {
            user: { login: "coderabbitai", type: "Bot" },
            state: "CHANGES_REQUESTED",
            body: "There is a race in the cache update and no test covers it.",
            submitted_at: "2026-05-03T12:00:00Z",
        };

        expect(normalizeReviewEvent(raw)).toEqual({
            reviewer: "coderabbitai",
            reviewerKind: "ai_reviewer",
            state: "CHANGES_REQUESTED",
            bodyExcerpt: "There is a race in the cache update and no test covers it.",
            severity: "critical",
            category: "test_gap",
            unresolved: false,
            ts: "2026-05-03T12:00:00Z",
            raw,
        });
    });

    test("prioritizes security category over test-gap terms", () => {
        const raw = {
            user: { login: "sourcery-ai", type: "Bot" },
            state: "COMMENTED",
            body: "Security regression: missing tests for token injection.",
            submitted_at: "2026-05-04T12:00:00Z",
        };

        const event = normalizeReviewEvent(raw);

        expect(event.category).toBe("security");
        expect(event.severity).toBe("critical");
    });

    test("reads gh CLI author field as fallback for reviewer identity", () => {
        const raw = {
            author: { login: "coderabbitai", type: "Bot" },
            state: "CHANGES_REQUESTED",
            body: "Please add tests.",
            submittedAt: "2026-06-01T10:00:00Z",
        };

        const event = normalizeReviewEvent(raw);
        expect(event.reviewer).toBe("coderabbitai");
        expect(event.reviewerKind).toBe("ai_reviewer");
        expect(event.ts).toBe("2026-06-01T10:00:00Z");
    });
});

describe("classifyReviewerKind", () => {
    test("classifies human, bot, AI reviewer, and unknown reviewer identities", () => {
        expect(classifyReviewerKind("necmttn", "User")).toBe("human");
        expect(classifyReviewerKind("renovate[bot]", "Bot")).toBe("bot");
        expect(classifyReviewerKind("github-copilot[bot]", "Bot")).toBe("ai_reviewer");
        expect(classifyReviewerKind(null, null)).toBe("unknown");
    });
});

describe("normalizeCheckRun", () => {
    test("maps a CheckRun entry", () => {
        const raw = {
            __typename: "CheckRun",
            name: "build",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://ci.example.com/runs/1",
            startedAt: "2026-01-01T00:00:00Z",
            completedAt: "2026-01-01T00:05:00Z",
        };

        expect(normalizeCheckRun(raw)).toEqual({
            name: "build",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            url: "https://ci.example.com/runs/1",
            startedAt: "2026-01-01T00:00:00Z",
            completedAt: "2026-01-01T00:05:00Z",
            raw,
        });
    });

    test("maps a failed CheckRun entry", () => {
        const raw = {
            __typename: "CheckRun",
            name: "tests",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://ci.example.com/runs/2",
            startedAt: "2026-01-02T00:00:00Z",
            completedAt: "2026-01-02T00:03:00Z",
        };

        const result = normalizeCheckRun(raw);
        expect(result.conclusion).toBe("FAILURE");
        expect(result.name).toBe("tests");
    });

    test("maps a StatusContext entry", () => {
        const raw = {
            __typename: "StatusContext",
            context: "ci/circleci",
            state: "SUCCESS",
            targetUrl: "https://circleci.com/build/123",
        };

        expect(normalizeCheckRun(raw)).toEqual({
            name: "ci/circleci",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            url: "https://circleci.com/build/123",
            startedAt: null,
            completedAt: null,
            raw,
        });
    });

    test("maps a failed StatusContext entry", () => {
        const raw = {
            __typename: "StatusContext",
            context: "ci/circleci",
            state: "FAILURE",
            targetUrl: "https://circleci.com/build/124",
        };

        const result = normalizeCheckRun(raw);
        expect(result.conclusion).toBe("FAILURE");
        expect(result.name).toBe("ci/circleci");
        expect(result.status).toBe("COMPLETED");
    });

    test("handles unknown typename as CheckRun-style", () => {
        const raw = { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://..." };
        const result = normalizeCheckRun(raw);
        expect(result.name).toBe("lint");
        expect(result.conclusion).toBe("SUCCESS");
    });

    test("is defensive against non-object input", () => {
        const result = normalizeCheckRun(null);
        expect(result.name).toBeNull();
        expect(result.conclusion).toBeNull();
    });
});

describe("aggregateReviewPain", () => {
    test("counts approvals, changesRequested, comments from gh review states", () => {
        const reviews = [
            { author: { login: "necmttn" }, state: "APPROVED", body: "" },
            { author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "" },
            { author: { login: "alice" }, state: "COMMENTED", body: "" },
        ];

        const result = aggregateReviewPain(reviews, []);
        expect(result.approvals).toBe(1);
        expect(result.changesRequested).toBe(1);
        expect(result.comments).toBe(1);
        // CHANGES_REQUESTED severity is always "critical"
        expect(result.criticalComments).toBe(1);
        expect(result.failedChecks).toBe(0);
        expect(result.unresolvedThreads).toBe(0);
    });

    test("counts critical comments from reviews with critical severity", () => {
        const reviews = [
            { author: { login: "coderabbitai" }, state: "CHANGES_REQUESTED", body: "security vulnerability found" },
            { author: { login: "necmttn" }, state: "APPROVED", body: "" },
            { author: { login: "alice" }, state: "COMMENTED", body: "there is a race condition here" },
        ];

        const result = aggregateReviewPain(reviews, []);
        // 1 CHANGES_REQUESTED (always critical) + 1 COMMENTED with "race" (critical)
        expect(result.criticalComments).toBe(2);
        expect(result.changesRequested).toBe(1);
        expect(result.approvals).toBe(1);
        expect(result.comments).toBe(1);
    });

    test("counts failedChecks from statusCheckRollup", () => {
        const checks = [
            { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://..." },
            { __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://..." },
            { __typename: "StatusContext", context: "ci/circleci", state: "ERROR", targetUrl: "https://..." },
            { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://..." },
        ];

        const result = aggregateReviewPain([], checks);
        expect(result.failedChecks).toBe(3);
    });

    test("returns all zeros for empty arrays", () => {
        const result = aggregateReviewPain([], []);
        expect(result).toEqual({
            approvals: 0,
            changesRequested: 0,
            comments: 0,
            criticalComments: 0,
            failedChecks: 0,
            unresolvedThreads: 0,
        });
    });

    test("returns all zeros for non-array inputs", () => {
        const result = aggregateReviewPain(null, undefined);
        expect(result).toEqual({
            approvals: 0,
            changesRequested: 0,
            comments: 0,
            criticalComments: 0,
            failedChecks: 0,
            unresolvedThreads: 0,
        });
    });

    test("unresolvedThreads is always 0 (v0 limitation)", () => {
        const reviews = [
            { author: { login: "alice" }, state: "CHANGES_REQUESTED", body: "needs work" },
        ];
        const result = aggregateReviewPain(reviews, []);
        expect(result.unresolvedThreads).toBe(0);
    });
});
