/**
 * Tests for the new commit + skill sources in `fetchRecall`.
 *
 * Uses the same mock-DB pattern as `derive-claude-subagents.test.ts`.
 * No real DB connection required.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "../lib/db.ts";
import {
    RECALL_COMMITS_SQL,
    RECALL_SKILLS_SQL,
    RECALL_COMMITS_COUNT_SQL,
    RECALL_SKILLS_COUNT_SQL,
} from "../queries/recall.ts";
import { fetchRecall } from "./recall.ts";

// ---------------------------------------------------------------------------
// Mock DB helper (mirrors derive-claude-subagents.test.ts pattern)
// ---------------------------------------------------------------------------

type MockCall = {
    kind: "query";
    sql: string;
    bindings?: Record<string, unknown>;
};

function makeMockDb(queryResponses: Map<string, unknown[][]> = new Map()) {
    const calls: MockCall[] = [];

    const impl = {
        query: <T extends unknown[] = unknown[]>(
            sql: string,
            bindings?: Record<string, unknown>,
        ) => {
            const call: MockCall = bindings !== undefined
                ? { kind: "query", sql, bindings }
                : { kind: "query", sql };
            calls.push(call);
            for (const [pattern, response] of queryResponses) {
                if (sql.includes(pattern)) {
                    return Effect.succeed(response as T);
                }
            }
            return Effect.succeed([[]] as unknown as T);
        },
        upsert: () => Effect.succeed(undefined),
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: undefined as unknown as import("surrealdb").Surreal,
    };

    const layer = Layer.succeed(SurrealClient, impl);
    return { calls, layer };
}

// ---------------------------------------------------------------------------
// SQL shape tests (unit - no DB mock needed)
// ---------------------------------------------------------------------------

describe("RECALL_COMMITS_SQL", () => {
    test("contains BM25 @1@ predicate on message", () => {
        const sql = RECALL_COMMITS_SQL("");
        expect(sql).toMatch(/message @1@ \$q/);
    });

    test("without scope clause: no WHERE repository filter (field in SELECT is fine)", () => {
        const sql = RECALL_COMMITS_SQL("");
        // 'repository' appears in SELECT but there should be no AND repository = ... clause
        expect(sql).not.toContain("AND repository");
    });

    test("with scope clause: injects the clause verbatim", () => {
        const clause = "AND repository = $repository";
        const sql = RECALL_COMMITS_SQL(clause);
        expect(sql).toContain(clause);
    });

    test("has LIMIT $limit but no $offset (independent pagination)", () => {
        const sql = RECALL_COMMITS_SQL("");
        expect(sql).toMatch(/LIMIT \$limit/);
        expect(sql).not.toMatch(/\$offset/);
    });

    test("count SQL has no $limit", () => {
        const sql = RECALL_COMMITS_COUNT_SQL("");
        expect(sql).toMatch(/count\(\) AS total/);
        expect(sql).not.toMatch(/\$limit/);
    });
});

describe("RECALL_SKILLS_SQL", () => {
    test("references both name and description predicates", () => {
        expect(RECALL_SKILLS_SQL).toMatch(/name @1@ \$q/);
        expect(RECALL_SKILLS_SQL).toMatch(/description @2@ \$q/);
    });

    test("uses math::max to combine scores", () => {
        expect(RECALL_SKILLS_SQL).toMatch(/math::max/);
        expect(RECALL_SKILLS_SQL).toMatch(/search::score\(1\)/);
        expect(RECALL_SKILLS_SQL).toMatch(/search::score\(2\)/);
    });

    test("count SQL contains both predicates", () => {
        expect(RECALL_SKILLS_COUNT_SQL).toMatch(/name @1@ \$q/);
        expect(RECALL_SKILLS_COUNT_SQL).toMatch(/description @2@ \$q/);
        expect(RECALL_SKILLS_COUNT_SQL).not.toMatch(/\$limit/);
    });
});

// ---------------------------------------------------------------------------
// fetchRecall integration (mock DB)
// ---------------------------------------------------------------------------

describe("fetchRecall - commit source", () => {
    test("issues commit query with scope=here clause", async () => {
        const commitRow = {
            id: "commit:abc",
            sha: "abc12345",
            repo: "github.com/foo/bar",
            repository: "repository:foo__bar",
            ts: "2026-05-01T00:00:00Z",
            snippet: "fix <mark>auth</mark> token",
            score: 1.5,
        };

        const responses = new Map<string, unknown[][]>([
            // Count query (more specific substring matched first in mock)
            ["count() AS total", [[{ total: 1 }]]],
            // Page query: runQuery destructures [rows] from result, so rows = [commitRow]
            ["message @1@ $q", [[commitRow]]],
        ]);

        const { calls, layer } = makeMockDb(responses);

        const result = await Effect.runPromise(
            fetchRecall({
                q: "auth",
                sources: ["commit"],
                scope: { kind: "here", repositoryKey: "foo__bar" },
            }).pipe(Effect.provide(layer)),
        );

        expect(result.commits).toHaveLength(1);
        expect(result.commits[0]!.sha).toBe("abc12345");
        expect(result.commits[0]!.repo).toBe("github.com/foo/bar");
        expect(result.commits[0]!.snippet).toBe("fix <mark>auth</mark> token");

        // Verify scope clause was embedded as a record literal - NOT a binding
        const commitCall = calls.find((c) => c.sql.includes("message @1@ $q"));
        expect(commitCall).toBeDefined();
        expect(commitCall!.sql).toContain("AND repository = repository:`foo__bar`");
        expect(commitCall!.bindings?.["repository"]).toBeUndefined();

        // hits/skills should be empty (source not requested)
        expect(result.hits).toHaveLength(0);
        expect(result.skills).toHaveLength(0);

        // total_count must equal commits count when only commit source requested (R5)
        expect(result.total_count).toBe(result.total_counts.commit);
    });

    test("issues commit query without scope clause when scope=all", async () => {
        const { calls, layer } = makeMockDb();

        await Effect.runPromise(
            fetchRecall({
                q: "fix",
                sources: ["commit"],
                scope: { kind: "all" },
            }).pipe(Effect.provide(layer)),
        );

        const commitCall = calls.find((c) => c.sql.includes("message @1@ $q"));
        expect(commitCall).toBeDefined();
        expect(commitCall!.sql).not.toContain("AND repository");
    });

    test("total_counts.commit reflects count query result", async () => {
        // The commits page query SQL contains "message @1@ $q" AND "LIMIT $limit".
        // The count SQL contains "message @1@ $q" AND "count() AS total".
        // We distinguish them by the "count() AS total" substring.
        const responses = new Map<string, unknown[][]>([
            // Count query matches first (more specific)
            ["count() AS total", [[{ total: 42 }]]],
            // Page query
            ["message @1@ $q", [[]]],
        ]);
        const { layer } = makeMockDb(responses);

        const result = await Effect.runPromise(
            fetchRecall({
                q: "deploy",
                sources: ["commit"],
            }).pipe(Effect.provide(layer)),
        );

        expect(result.total_counts.commit).toBe(42);
        expect(result.total_counts.turn).toBe(0);
        expect(result.total_counts.skill).toBe(0);
        // total_count must be the sum across all requested sources (R5)
        expect(result.total_count).toBe(42);
    });
});

describe("fetchRecall - skill source", () => {
    test("returns skill hits and does not apply repository scope", async () => {
        const skillRow = {
            id: "skill:retro",
            name: "retro",
            description: "Retrospective analysis skill",
            snippet: "<mark>retro</mark>spective",
            score: 2.1,
        };

        const responses = new Map<string, unknown[][]>([
            ["name @1@ $q", [[skillRow], [{ total: 1 }]]],
        ]);
        const { calls, layer } = makeMockDb(responses);

        const result = await Effect.runPromise(
            fetchRecall({
                q: "retro",
                sources: ["skill"],
                scope: { kind: "here", repositoryKey: "foo__bar" },
            }).pipe(Effect.provide(layer)),
        );

        expect(result.skills).toHaveLength(1);
        expect(result.skills[0]!.name).toBe("retro");
        expect(result.skills[0]!.skill_id).toBe("skill:retro");

        // Skills are global - scope should NOT appear in skill query
        const skillCall = calls.find((c) => c.sql.includes("name @1@ $q"));
        expect(skillCall).toBeDefined();
        expect(skillCall!.sql).not.toContain("repository");
    });
});

describe("fetchRecall - multi-source", () => {
    test("returns turns + commits + skills when all three requested", async () => {
        const responses = new Map<string, unknown[][]>([
            // count queries are most specific
            ["count() AS total", [[{ total: 1 }]]],
            // Commit page query
            ["message @1@ $q", [[{ id: "commit:x", sha: "deadbeef", repo: "r", repository: null, ts: null, snippet: "deploy fix", score: 1 }]]],
            // Skill page query
            ["name @1@ $q", [[{ id: "skill:s", name: "deploy", description: null, snippet: "deploy", score: 1 }]]],
        ]);
        const { layer } = makeMockDb(responses);

        const result = await Effect.runPromise(
            fetchRecall({
                q: "deploy",
                sources: ["turn", "commit", "skill"],
                scope: { kind: "all" },
            }).pipe(Effect.provide(layer)),
        );

        // turns may be empty (no turn rows in mock) but commits + skills populated
        expect(result.commits).toHaveLength(1);
        expect(result.skills).toHaveLength(1);
        expect(result.total_counts.commit).toBe(1);
        expect(result.total_counts.skill).toBe(1);
    });

    test("sources=turn,commit: total_count = turns + commits (R5)", async () => {
        const responses = new Map<string, unknown[][]>([
            // count() AS total matches both turn count and commit count queries
            ["count() AS total", [[{ total: 3 }]]],
            // Commit page query returns 2 commits
            ["message @1@ $q", [[
                { id: "commit:a", sha: "aaa", repo: "r", repository: null, ts: null, snippet: "s1", score: 1 },
                { id: "commit:b", sha: "bbb", repo: "r", repository: null, ts: null, snippet: "s2", score: 1 },
            ]]],
        ]);
        const { layer } = makeMockDb(responses);

        const result = await Effect.runPromise(
            fetchRecall({
                q: "thing",
                sources: ["turn", "commit"],
            }).pipe(Effect.provide(layer)),
        );

        // turn count = 3 (from mock), commit count = 3 (same mock), no skill
        // total_count must be sum of all requested sources
        expect(result.total_count).toBe(result.total_counts.turn + result.total_counts.commit + result.total_counts.skill);
        expect(result.total_counts.skill).toBe(0);
        expect(result.commits).toHaveLength(2);
    });

    test("defaults to turn-only when sources not specified (back-compat)", async () => {
        const { calls, layer } = makeMockDb();

        await Effect.runPromise(
            fetchRecall({ q: "test" }).pipe(Effect.provide(layer)),
        );

        const hasCommitQuery = calls.some((c) => c.sql.includes("message @1@ $q"));
        const hasSkillQuery = calls.some((c) => c.sql.includes("name @1@ $q"));
        expect(hasCommitQuery).toBe(false);
        expect(hasSkillQuery).toBe(false);
    });

    test("empty query returns zero hits for all sources", async () => {
        const { layer } = makeMockDb();

        const result = await Effect.runPromise(
            fetchRecall({
                q: "   ",
                sources: ["turn", "commit", "skill"],
            }).pipe(Effect.provide(layer)),
        );

        expect(result.hits).toHaveLength(0);
        expect(result.commits).toHaveLength(0);
        expect(result.skills).toHaveLength(0);
        expect(result.total_count).toBe(0);
        expect(result.total_counts).toEqual({ turn: 0, commit: 0, skill: 0 });
    });
});
