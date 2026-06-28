import { describe, expect, test } from "bun:test";
import {
    COMMUNITY_PATTERN_TREE_URL,
    PATTERN_CATEGORIES,
    communityPatternCommitsUrl,
    communityPatternRawUrl,
    fetchCommunityPatterns,
    groupPatternsByCategory,
    patternAnchorId,
    validateCommunityPattern,
} from "./community-patterns";

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

const fakeFetch = (responses: Record<string, unknown | Response>): typeof fetch =>
    (async (input: RequestInfo | URL) => {
        const url = String(input);
        const response = responses[url];
        if (response === undefined) return new Response("missing", { status: 404 });
        return response instanceof Response ? response : jsonResponse(response);
    }) as typeof fetch;

const failurePath = "community/patterns/failure-mode/edit-loop-thrash.json";
const workflowPath = "community/patterns/workflow/small-review-loops.json";

const failurePattern = {
    category: "failure-mode",
    name: "edit-loop-thrash",
    summary: "Keeps patching the same file without rereading the surrounding code.",
    evidence: { sessions: 3, confidence: 0.82, last_reinforced: "2026-06-20", trend: "rising" },
    links: [
        { rel: "recovered-by", ref: "workflow/small-review-loops" },
        { rel: "conflicts-with", ref: "debugging/guess-and-patch" },
    ],
};

const workflowPattern = {
    category: "workflow",
    name: "small-review-loops",
    summary: "Review the diff in small increments before expanding scope.",
    evidence: { sessions: 5, confidence: 0.9, trend: "stable" },
};

describe("community pattern validation", () => {
    test("validates a category/name path and linkable evidence", () => {
        const out = validateCommunityPattern(failurePattern, failurePath);

        expect(out.key).toBe("failure-mode/edit-loop-thrash");
        expect(out.links?.[0]).toEqual({ rel: "recovered-by", ref: "workflow/small-review-loops" });
        expect(out.evidence.trend).toBe("rising");
    });

    test("rejects mismatched paths, bad confidence, and malformed link refs", () => {
        expect(() => validateCommunityPattern(failurePattern, workflowPath)).toThrow(/category must match/);
        expect(() => validateCommunityPattern({
            ...failurePattern,
            evidence: { sessions: 3, confidence: 2 },
        }, failurePath)).toThrow(/confidence/);
        expect(() => validateCommunityPattern({
            ...failurePattern,
            links: [{ rel: "caused-by", ref: "workflow/small-review-loops" }],
        }, failurePath)).toThrow(/pattern.link/);
        expect(() => validateCommunityPattern({
            ...failurePattern,
            links: [{ rel: "recovered-by", ref: "workflow" }],
        }, failurePath)).toThrow(/pattern.link.ref/);
    });
});

describe("fetchCommunityPatterns", () => {
    test("lists registry JSON files, fetches raw patterns, and attaches commit authors", async () => {
        const fetcher = fakeFetch({
            [COMMUNITY_PATTERN_TREE_URL]: {
                tree: [
                    { path: "community/patterns/README.md", type: "blob" },
                    { path: failurePath, type: "blob" },
                    { path: workflowPath, type: "blob" },
                ],
            },
            [communityPatternRawUrl(failurePath)]: failurePattern,
            [communityPatternRawUrl(workflowPath)]: workflowPattern,
            [communityPatternCommitsUrl(failurePath)]: [{ author: { login: "alice" } }],
            [communityPatternCommitsUrl(workflowPath)]: [{ author: { login: "bob" } }],
        });

        const out = await fetchCommunityPatterns({ fetch: fetcher });

        expect(out.patterns.map((p) => p.key)).toEqual([
            "failure-mode/edit-loop-thrash",
            "workflow/small-review-loops",
        ]);
        expect(out.patterns[0]?.author).toEqual({ login: "alice" });
        expect(out.patterns[1]?.author).toEqual({ login: "bob" });
        expect(out.dropped).toEqual([]);
    });

    test("keeps valid rows and reports invalid community files as dropped", async () => {
        const fetcher = fakeFetch({
            [COMMUNITY_PATTERN_TREE_URL]: {
                tree: [
                    { path: failurePath, type: "blob" },
                    { path: workflowPath, type: "blob" },
                ],
            },
            [communityPatternRawUrl(failurePath)]: failurePattern,
            [communityPatternRawUrl(workflowPath)]: { ...workflowPattern, evidence: { sessions: "many", confidence: 0.9 } },
            [communityPatternCommitsUrl(failurePath)]: [{ author: { login: "alice" } }],
            [communityPatternCommitsUrl(workflowPath)]: [{ author: { login: "bob" } }],
        });

        const out = await fetchCommunityPatterns({ fetch: fetcher });

        expect(out.patterns.map((p) => p.key)).toEqual(["failure-mode/edit-loop-thrash"]);
        expect(out.dropped).toEqual([{ path: workflowPath, reason: "invalid pattern.evidence.sessions" }]);
    });
});

describe("pattern grouping and anchors", () => {
    test("returns every closed category with counts", () => {
        const groups = groupPatternsByCategory([
            validateCommunityPattern(failurePattern, failurePath),
        ]);

        expect(groups).toHaveLength(PATTERN_CATEGORIES.length);
        expect(groups.find((g) => g.category === "failure-mode")?.count).toBe(1);
        expect(groups.find((g) => g.category === "workflow")?.count).toBe(0);
    });

    test("turns category/name refs into stable in-page anchors", () => {
        expect(patternAnchorId("failure-mode/edit-loop-thrash")).toBe("pattern-failure-mode-edit-loop-thrash");
    });
});
