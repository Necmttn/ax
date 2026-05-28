/**
 * Tests for derive-claude-subagents.ts - focused on F7: repository inheritance
 * and backfill behaviour.
 *
 * These tests do NOT hit a real DB. They inject a mock SurrealClientShape
 * and verify the SQL/upsert calls are correct.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient } from "../lib/db.ts";
import { AxConfig } from "../lib/config.ts";
import { deriveClaudeSubagents } from "./derive-claude-subagents.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Call =
    | { kind: "query"; sql: string }
    | { kind: "upsert"; id: string; content: Record<string, unknown> };

/**
 * Build a mock SurrealClient layer. The `queryResponses` map lets callers
 * drive what each SELECT returns; unrecognised queries return [[]].
 * All calls are recorded in `calls`.
 */
function makeMockDb(queryResponses: Map<string, unknown[][]> = new Map()) {
    const calls: Call[] = [];

    const impl = {
        query: <T extends unknown[] = unknown[]>(sql: string) => {
            calls.push({ kind: "query", sql });
            // Find first matching key that the sql CONTAINS
            for (const [pattern, response] of queryResponses) {
                if (sql.includes(pattern)) {
                    return Effect.succeed(response as T);
                }
            }
            return Effect.succeed([[]] as unknown as T);
        },
        upsert: (id: RecordId, content: Record<string, unknown>) => {
            calls.push({ kind: "upsert", id: String(id), content });
            return Effect.succeed(undefined);
        },
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: undefined as unknown as import("surrealdb").Surreal,
    };

    const layer = Layer.succeed(SurrealClient, impl);
    return { calls, layer };
}

/**
 * Minimal AxConfig layer that provides a transcripts dir that doesn't exist
 * (so discover() returns [] immediately) plus dummy DB config.
 */
function makeEmptyTranscriptsConfig() {
    return Layer.succeed(AxConfig, {
        paths: {
            home: "/nonexistent",
            transcriptsDir: "/nonexistent-path-for-tests",
            skillDirs: [],
            commandDirs: [],
            codexDir: "/nonexistent-path-for-tests",
            dataDir: "/nonexistent",
            claudeUsageDir: "/nonexistent",
            repoListFile: "/nonexistent",
        },
        db: {
            url: "ws://127.0.0.1:8521",
            ns: "ax",
            db: "main",
            user: "root",
            pass: "root",
        },
        knobs: {
            claudeConcurrency: 4,
            codexConcurrency: 1,
            codexProgressEvery: 10,
            codexFlushEvery: 500,
            codexRawMaxBytes: 5 * 1024 * 1024,
            codexPayloadMaxBytes: 1200,
        },
    } as import("../lib/config.ts").AxConfigShape);
}

/** Convenience: merge db+config layers and run the stage. */
async function runWith(
    dbLayer: Layer.Layer<SurrealClient>,
    configLayer: Layer.Layer<AxConfig> = makeEmptyTranscriptsConfig(),
) {
    return Effect.runPromise(
        deriveClaudeSubagents().pipe(
            Effect.provide(Layer.merge(dbLayer, configLayer)),
        ),
    );
}

// ---------------------------------------------------------------------------
// Tests: repository backfill (F7)
// ---------------------------------------------------------------------------

describe("repository backfill (F7)", () => {
    test("backfill: existing subagent with repository=NONE gets parent's repository copied", async () => {
        const responses = new Map<string, unknown[][]>();

        // Skill catalog query
        responses.set("SELECT name FROM skill", [[{ name: "test-skill" }]]);

        // Backfill SELECT: find subagents with no repository, with parent data
        responses.set('source = "claude-subagent" AND repository IS NONE', [[
            {
                id: "session:⟨claude-subagent-abc⟩",
                parent_repository: "repository:my-repo",
                parent_checkout: "checkout:abc123",
                parent_cwd: "/home/user/project",
            },
        ]]);

        const { calls, layer } = makeMockDb(responses);
        await runWith(layer);

        // Should have issued the backfill SELECT query
        const backfillSelect = calls.find(
            (c) =>
                c.kind === "query" &&
                c.sql.includes('source = "claude-subagent"') &&
                c.sql.includes("repository IS NONE"),
        );
        expect(backfillSelect).toBeDefined();

        // Should have issued an UPDATE for the found subagent
        const updateCall = calls.find(
            (c) =>
                c.kind === "query" &&
                c.sql.includes("claude-subagent-abc") &&
                (c.sql.includes("SET repository") || c.sql.includes("repository =")),
        );
        expect(updateCall).toBeDefined();
    });

    test("backfill idempotent: when no subagents have missing repository, no UPDATE issued", async () => {
        const responses = new Map<string, unknown[][]>();
        responses.set("SELECT name FROM skill", [[]]);
        // Backfill query returns empty - no subagents need repair
        responses.set('source = "claude-subagent" AND repository IS NONE', [[]]);

        const { calls, layer } = makeMockDb(responses);
        await runWith(layer);

        // No UPDATE query for backfill
        const updateCalls = calls.filter(
            (c) =>
                c.kind === "query" &&
                c.sql.includes("SET repository") &&
                c.sql.includes("claude-subagent"),
        );
        expect(updateCalls.length).toBe(0);
    });

    test("stats: repositoryBackfilled reflects count of backfilled rows", async () => {
        const responses = new Map<string, unknown[][]>();
        responses.set("SELECT name FROM skill", [[]]);
        // Two rows need backfill
        responses.set('source = "claude-subagent" AND repository IS NONE', [[
            {
                id: "session:⟨claude-subagent-aaa⟩",
                parent_repository: "repository:repo-x",
                parent_checkout: null,
                parent_cwd: "/tmp/repo-x",
            },
            {
                id: "session:⟨claude-subagent-bbb⟩",
                parent_repository: "repository:repo-y",
                parent_checkout: "checkout:def456",
                parent_cwd: "/tmp/repo-y",
            },
        ]]);

        const { layer } = makeMockDb(responses);
        const stats = await runWith(layer);

        expect(stats.repositoryBackfilled).toBe(2);
    });

    test("stats: repositoryInherited is 0 when no new subagents are discovered", async () => {
        const responses = new Map<string, unknown[][]>();
        responses.set("SELECT name FROM skill", [[]]);
        responses.set('source = "claude-subagent" AND repository IS NONE', [[]]);

        const { layer } = makeMockDb(responses);
        const stats = await runWith(layer);

        expect(stats.repositoryInherited).toBe(0);
    });
});
