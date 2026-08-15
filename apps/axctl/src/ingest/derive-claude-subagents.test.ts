import { describe, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { AxConfig, makeTestConfig } from "@ax/lib/config";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveClaudeSubagents, subagentsStage } from "./derive-claude-subagents.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("Claude subagents", { requireFts: true });

const configLayer = (transcriptsDir: string) => Layer.effect(AxConfig, makeTestConfig({
    paths: {
        home: transcriptsDir,
        transcriptsDir,
        skillDirs: [],
        commandDirs: [],
        codexDir: join(transcriptsDir, "codex"),
        piDir: join(transcriptsDir, "pi"),
        opencodeDir: join(transcriptsDir, "opencode"),
        cursorUserDir: join(transcriptsDir, "cursor"),
        dataDir: join(transcriptsDir, "data"),
        claudeUsageDir: join(transcriptsDir, "usage"),
        repoListFile: join(transcriptsDir, "repos"),
    },
    knobs: {
        claudeConcurrency: 4,
        codexConcurrency: 1,
        codexProgressEvery: 10,
        codexFlushEvery: 500,
        codexRawMaxBytes: 5 * 1024 * 1024,
        codexPayloadMaxBytes: 1200,
    },
}));

const writeSubagent = async (root: string, input: {
    parent: string;
    agent: string;
    cwd?: string;
    model?: string;
    meta?: Record<string, string>;
}) => {
    const dir = join(root, "project-a", input.parent, "subagents");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `agent-${input.agent}.jsonl`);
    const first = {
        type: "user",
        agentId: input.agent,
        sessionId: input.parent,
        timestamp: "2026-06-17T10:00:00.000Z",
        cwd: input.cwd,
        message: { role: "user", content: "Inspect the code" },
    };
    const last = {
        type: "assistant",
        agentId: input.agent,
        sessionId: input.parent,
        timestamp: "2026-06-17T10:01:00.000Z",
        cwd: input.cwd,
        message: { role: "assistant", content: [{ type: "text", text: "Done" }], model: input.model },
    };
    await Bun.write(path, `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`);
    if (input.meta) await Bun.write(path.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(input.meta));
    return { path, child: `claude-subagent-${input.agent}` };
};

describe("deriveClaudeSubagents on real DuckDB", () => {
    dtest("backfills repository data for an existing child", async () => {
        const transcriptsDir = tempDir("ax-subagent-empty-");
        let stats: unknown;
        let child: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-subagent-backfill-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session", {
                    id: "parent", source: "claude", repository: "repo", checkout: "checkout", cwd: "/repo",
                });
                yield* write.put("session", { id: "child", source: "claude-subagent" });
                yield* write.put("spawned", {
                    id: "spawn", in_id: "parent", out_id: "child", ts: new Date(), tool: "Agent",
                });
                stats = yield* deriveClaudeSubagents(write).pipe(
                    Effect.provide(configLayer(transcriptsDir)),
                    Effect.provide(FixturePlatform),
                );
                child = (yield* write.rows(Schema.Struct({
                    repository: Schema.String,
                    checkout: Schema.String,
                    cwd: Schema.String,
                }), "SELECT repository, checkout, cwd FROM session WHERE id = ?", ["child"]))[0];
            }),
        ));
        expect(stats).toMatchObject({ discovered: 0, repositoryBackfilled: 1, repositoryInherited: 0 });
        expect(child).toEqual({ repository: "repo", checkout: "checkout", cwd: "/repo" });
    });

    dtest("writes a child with inherited repository data and dispatch metadata", async () => {
        const transcriptsDir = tempDir("ax-subagent-files-");
        const fixture = await writeSubagent(transcriptsDir, {
            parent: "parent",
            agent: "agent-1",
            model: "claude-sonnet-4-6",
            meta: {
                agentType: "design-curator",
                description: "Check accessibility",
                name: "critic-a11y",
                toolUseId: "toolu_1",
            },
        });
        let stats: unknown;
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-subagent-write-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session", {
                    id: "parent", source: "claude", repository: "repo", checkout: "checkout", cwd: "/parent",
                });
                stats = yield* deriveClaudeSubagents(write).pipe(
                    Effect.provide(configLayer(transcriptsDir)),
                    Effect.provide(FixturePlatform),
                );
                row = (yield* write.rows(Schema.Struct({
                    source: Schema.String,
                    repository: Schema.String,
                    checkout: Schema.String,
                    cwd: Schema.String,
                    model: Schema.String,
                    agent_type: Schema.String,
                    description: Schema.String,
                    agent_name: Schema.String,
                    tool_use_id: Schema.String,
                }), `SELECT s.source, s.repository, s.checkout, s.cwd, s.model,
                    sp.agent_type, sp.description, sp.agent_name, sp.tool_use_id
                    FROM session s JOIN spawned sp ON sp.out_id = s.id WHERE s.id = ?`, [fixture.child]))[0];
            }),
        ));
        expect(stats).toMatchObject({ discovered: 1, written: 1, missingParent: 0, repositoryInherited: 1 });
        expect(row).toEqual({
            source: "claude-subagent",
            repository: "repo",
            checkout: "checkout",
            cwd: "/parent",
            model: "claude-sonnet-4-6",
            agent_type: "design-curator",
            description: "Check accessibility",
            agent_name: "critic-a11y",
            tool_use_id: "toolu_1",
        });
    });

    dtest("keeps extractor cwd and skips an unchanged file", async () => {
        const transcriptsDir = tempDir("ax-subagent-cwd-");
        const fixture = await writeSubagent(transcriptsDir, { parent: "parent", agent: "agent-2", cwd: "/child" });
        let second: unknown;
        let cwd = "";
        await runWithPlatform(publishCacheFixture(tempDir("ax-subagent-skip-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "parent", source: "claude", repository: "repo", cwd: "/parent" });
                yield* deriveClaudeSubagents(write).pipe(
                    Effect.provide(configLayer(transcriptsDir)),
                    Effect.provide(FixturePlatform),
                );
                second = yield* deriveClaudeSubagents(write).pipe(
                    Effect.provide(configLayer(transcriptsDir)),
                    Effect.provide(FixturePlatform),
                );
                cwd = (yield* write.rows(Schema.Struct({ cwd: Schema.String }),
                    "SELECT cwd FROM session WHERE id = ?", [fixture.child]))[0]!.cwd;
            }),
        ));
        expect(second).toMatchObject({ discovered: 1, written: 0, skippedUnchanged: 1 });
        expect(cwd).toBe("/child");
    });
});

describe("subagentsStage", () => {
    dtest("keeps the required dependencies", () => {
        expect(subagentsStage.meta.deps).toEqual(["claude", "codex"]);
    });
});
