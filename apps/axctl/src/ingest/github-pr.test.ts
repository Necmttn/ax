import { describe, expect, test } from "bun:test";
import { classifyReviewerKind, normalizePullRequest, normalizeReviewEvent } from "./github-pr.ts";

describe("normalizePullRequest", () => {
    test("maps GitHub PR fields into the stable payload", () => {
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
});

describe("classifyReviewerKind", () => {
    test("classifies human, bot, AI reviewer, and unknown reviewer identities", () => {
        expect(classifyReviewerKind("necmttn", "User")).toBe("human");
        expect(classifyReviewerKind("renovate[bot]", "Bot")).toBe("bot");
        expect(classifyReviewerKind("github-copilot[bot]", "Bot")).toBe("ai_reviewer");
        expect(classifyReviewerKind(null, null)).toBe("unknown");
    });
});
