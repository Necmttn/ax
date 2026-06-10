/**
 * Tests for derive-claude-subagents.ts - focused on F7: repository inheritance
 * and backfill behaviour.
 *
 * These tests do NOT hit a real DB. They inject a mock SurrealClientShape
 * and verify the SQL/upsert calls are correct.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { RecordId } from "surrealdb";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { AxConfig, makeTestConfig } from "@ax/lib/config";
import { deriveClaudeSubagents } from "./derive-claude-subagents.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock SurrealClient layer. The `queryResponses` map lets callers
 * drive what each SELECT returns; unrecognised queries return [[]].
 * All calls are recorded in `calls` / `upserts`.
 */
function makeMockDb(queryResponses: Map<string, unknown[][]> = new Map()) {
    const tc = makeTestSurrealClient({
        // Find first matching key that the sql CONTAINS
        routes: [...queryResponses].map(([match, rows]) => ({ match, rows: rows as unknown[] })),
    });
    return { calls: tc.calls, upserts: tc.upserts, layer: tc.layer };
}

/**
 * Minimal AxConfig layer that provides a transcripts dir that doesn't exist
 * (so discover() returns [] immediately) plus dummy DB config.
 */
function makeEmptyTranscriptsConfig() {
    return Layer.effect(AxConfig, makeTestConfig({
        paths: {
            home: "/nonexistent",
            transcriptsDir: "/nonexistent-path-for-tests",
            skillDirs: [],
            commandDirs: [],
            codexDir: "/nonexistent-path-for-tests",
            piDir: "/nonexistent-path-for-tests",
            opencodeDir: "/nonexistent-path-for-tests",
            cursorUserDir: "/nonexistent-path-for-tests",
            dataDir: "/nonexistent",
            claudeUsageDir: "/nonexistent",
            repoListFile: "/nonexistent",
        },
        knobs: {
            claudeConcurrency: 4,
            codexConcurrency: 1,
            codexProgressEvery: 10,
            codexFlushEvery: 500,
            codexRawMaxBytes: 5 * 1024 * 1024,
            codexPayloadMaxBytes: 1200,
        },
    })).pipe(Layer.provide(BunFileSystem.layer));
}

/** Convenience: merge db+config layers and run the stage. */
async function runWith(
    dbLayer: Layer.Layer<SurrealClient>,
    configLayer: Layer.Layer<AxConfig> = makeEmptyTranscriptsConfig(),
) {
    return Effect.runPromise(
        deriveClaudeSubagents().pipe(
            // `extractFileWithSessionId` is now FileSystem-native; provide the
            // REAL Bun-backed FileSystem + Path against the existing tmp-dir
            // fixtures (not the in-memory mock) so this test exercises the
            // production read path unchanged.
            Effect.provide(
                Layer.mergeAll(dbLayer, configLayer, BunFileSystem.layer, BunPath.layer),
            ),
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

        // Backfill SELECT: find subagents with no repository, with parent data.
        // id and parent_repository must be RecordId instances (as the real DB driver
        // returns for record-typed fields) so the instanceof guards pass.
        responses.set('source = "claude-subagent" AND repository IS NONE', [[
            {
                id: new RecordId("session", "claude-subagent-abc"),
                parent_repository: new RecordId("repository", "my-repo"),
                parent_checkout: "checkout:abc123",
                parent_cwd: "/home/user/project",
            },
        ]]);

        const { calls, layer } = makeMockDb(responses);
        await runWith(layer);

        // Should have issued the backfill SELECT query
        const backfillSelect = calls.find(
            (c) =>
                c.sql.includes('source = "claude-subagent"') &&
                c.sql.includes("repository IS NONE"),
        );
        expect(backfillSelect).toBeDefined();

        // Should have issued an UPDATE for the found subagent
        const updateCall = calls.find(
            (c) =>
                c.sql.includes("claude-subagent-abc") &&
                (c.sql.includes("SET repository") || c.sql.includes("repository =")),
        );
        expect(updateCall).toBeDefined();

        // repository is now embedded as a record literal in SQL - not a binding
        if (updateCall) {
            expect(updateCall.sql).toContain("repository = repository:`my-repo`");
            expect(updateCall.bindings?.["repo"]).toBeUndefined();
            expect(updateCall.bindings?.["checkout"]).toBe("checkout:abc123");
            expect(updateCall.bindings?.["cwd"]).toBe("/home/user/project");
        }
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
                c.sql.includes("SET repository") &&
                c.sql.includes("claude-subagent"),
        );
        expect(updateCalls.length).toBe(0);
    });

    test("stats: repositoryBackfilled reflects count of backfilled rows", async () => {
        const responses = new Map<string, unknown[][]>();
        responses.set("SELECT name FROM skill", [[]]);
        // Two rows need backfill (RecordId instances as the real DB driver returns
        // for record-typed fields)
        responses.set('source = "claude-subagent" AND repository IS NONE', [[
            {
                id: new RecordId("session", "claude-subagent-aaa"),
                parent_repository: new RecordId("repository", "repo-x"),
                parent_checkout: null,
                parent_cwd: "/tmp/repo-x",
            },
            {
                id: new RecordId("session", "claude-subagent-bbb"),
                parent_repository: new RecordId("repository", "repo-y"),
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

// ---------------------------------------------------------------------------
// Helpers: real-filesystem fixture for manifest-discovery tests
// ---------------------------------------------------------------------------

/**
 * Temp directories created by the fixture tests – cleaned up in afterAll.
 */
const tmpDirs: string[] = [];

afterAll(async () => {
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Build a minimal discoverable fixture on disk:
 *
 *   <root>/
 *     -test-project/
 *       <parentSessionId>/
 *         subagents/
 *           agent-<agentId>.jsonl  ← first line triggers parseManifest
 *
 * Returns { root, parentSessionId, agentId, subagentSessionId, agentFile }.
 */
async function buildFixture(opts: {
    agentId: string;
    parentSessionId: string;
    /** Optional cwd written into the jsonl line so the extractor picks it up. */
    cwdInFile?: string;
}) {
    const root = await mkdtemp(join(tmpdir(), "ax-test-subagent-"));
    tmpDirs.push(root);

    const projectDir = "-test-project";
    const sessionDir = join(root, projectDir, opts.parentSessionId, "subagents");
    await mkdir(sessionDir, { recursive: true });

    const agentFile = join(sessionDir, `agent-${opts.agentId}.jsonl`);
    const firstLine: Record<string, string> = {
        agentId: opts.agentId,
        sessionId: opts.parentSessionId,
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
    };
    if (opts.cwdInFile) firstLine["cwd"] = opts.cwdInFile;

    // Write first line (gives parseManifest what it needs: agentId + sessionId)
    // and a second line so finish() produces a non-null session.
    const secondLine: Record<string, string> = {
        agentId: opts.agentId,
        sessionId: opts.parentSessionId,
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
    };
    await Bun.write(agentFile, JSON.stringify(firstLine) + "\n" + JSON.stringify(secondLine) + "\n");

    return {
        root,
        parentSessionId: opts.parentSessionId,
        agentId: opts.agentId,
        subagentSessionId: `claude-subagent-${opts.agentId}`,
        agentFile,
    };
}

/** Config layer that points transcriptsDir at a real temp root. */
function makeFixtureConfig(transcriptsDir: string) {
    return Layer.effect(AxConfig, makeTestConfig({
        paths: {
            home: "/nonexistent",
            transcriptsDir,
            skillDirs: [],
            commandDirs: [],
            codexDir: "/nonexistent",
            piDir: "/nonexistent",
            opencodeDir: "/nonexistent",
            cursorUserDir: "/nonexistent",
            dataDir: "/nonexistent",
            claudeUsageDir: "/nonexistent",
            repoListFile: "/nonexistent",
        },
        knobs: {
            claudeConcurrency: 4,
            codexConcurrency: 1,
            codexProgressEvery: 10,
            codexFlushEvery: 500,
            codexRawMaxBytes: 5 * 1024 * 1024,
            codexPayloadMaxBytes: 1200,
        },
    })).pipe(Layer.provide(BunFileSystem.layer));
}

// ---------------------------------------------------------------------------
// Tests: repository inheritance on new subagents (F7 – new-subagent path)
// ---------------------------------------------------------------------------

describe("repository inheritance on new subagents (F7)", () => {
    test("new subagent with no extractor-cwd inherits repository+checkout+cwd from parent", async () => {
        const fixture = await buildFixture({
            agentId: "test-agent-001",
            parentSessionId: "parent-ses-inherit-no-cwd",
            // no cwdInFile → extractor will produce session.cwd = null
        });

        const responses = new Map<string, unknown[][]>();
        responses.set("SELECT name FROM skill", [[]]);
        // Parent row has repository, checkout, cwd
        responses.set("parent-ses-inherit-no-cwd", [[
            {
                id: `session:⟨${fixture.parentSessionId}⟩`,
                repository: "repository:test-repo",
                checkout: "checkout:abc123",
                cwd: "/home/user/test-project",
            },
        ]]);
        // Backfill: no rows need repair
        responses.set('source = "claude-subagent" AND repository IS NONE', [[]]);

        const { upserts, layer } = makeMockDb(responses);
        const stats = await runWith(layer, makeFixtureConfig(fixture.root));

        // Stage should have discovered 1 subagent and written it
        expect(stats.discovered).toBe(1);
        expect(stats.written).toBe(1);
        expect(stats.missingParent).toBe(0);

        // repositoryInherited must be > 0 (parent had a repository value)
        expect(stats.repositoryInherited).toBeGreaterThan(0);

        // Verify the upsert payload for the subagent session
        const upsertCall = upserts.find(
            (c) => String(c.id).includes(fixture.subagentSessionId),
        );
        expect(upsertCall).toBeDefined();
        if (upsertCall) {
            expect(upsertCall.content["repository"]).toBe("repository:test-repo");
            expect(upsertCall.content["checkout"]).toBe("checkout:abc123");
            // cwd inherits from parent because extractor produced none
            expect(upsertCall.content["cwd"]).toBe("/home/user/test-project");
        }
    });

    test("new subagent with extractor-cwd keeps its own cwd but still inherits repository+checkout", async () => {
        const fixture = await buildFixture({
            agentId: "test-agent-002",
            parentSessionId: "parent-ses-inherit-with-cwd",
            cwdInFile: "/home/user/subagent-working-dir",
        });

        const responses = new Map<string, unknown[][]>();
        responses.set("SELECT name FROM skill", [[]]);
        // Parent row
        responses.set("parent-ses-inherit-with-cwd", [[
            {
                id: `session:⟨${fixture.parentSessionId}⟩`,
                repository: "repository:test-repo-2",
                checkout: "checkout:def456",
                cwd: "/home/user/parent-project",
            },
        ]]);
        responses.set('source = "claude-subagent" AND repository IS NONE', [[]]);

        const { upserts, layer } = makeMockDb(responses);
        const stats = await runWith(layer, makeFixtureConfig(fixture.root));

        expect(stats.discovered).toBe(1);
        expect(stats.written).toBe(1);

        const upsertCall = upserts.find(
            (c) => String(c.id).includes(fixture.subagentSessionId),
        );
        expect(upsertCall).toBeDefined();
        if (upsertCall) {
            // repository and checkout unconditionally inherited from parent
            expect(upsertCall.content["repository"]).toBe("repository:test-repo-2");
            expect(upsertCall.content["checkout"]).toBe("checkout:def456");
            // cwd must be the extractor-produced value, NOT the parent's cwd
            expect(upsertCall.content["cwd"]).toBe("/home/user/subagent-working-dir");
            expect(upsertCall.content["cwd"]).not.toBe("/home/user/parent-project");
        }
    });
});
