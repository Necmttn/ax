/**
 * MCP process coverage with SurrealDB deliberately unreachable.
 *
 * This starts the real stdio command. It first calls a cache-only tool and then
 * a judgment-only tool. Either call fails if server startup or tool dispatch
 * resolves the legacy `AppLayer` union.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ax mcp (no surreal)", {
    requireFts: true,
});

const CLI = new URL("../cli/index.ts", import.meta.url).pathname;
const DEAD_DB_URL = "ws://127.0.0.1:1/rpc";

const CORPUS = (write: CacheWriteService) =>
    Effect.gen(function* () {
        yield* write.put("session", {
            id: "mcp-session",
            source: "claude",
            project: "ax",
            cwd: "/w/ax",
        });
        yield* write.put("turn", {
            id: "mcp-turn",
            session: "mcp-session",
            seq: 1,
            ts: new Date("2026-08-15T10:00:00.000Z"),
            role: "user",
            text: "mcp cache layer works without surreal",
            text_excerpt: "mcp cache layer works without surreal",
            has_tool_use: false,
            has_error: false,
        });
    });

const bodyOf = (result: unknown): unknown => {
    if (typeof result !== "object" || result === null || !("content" in result) ||
        !Array.isArray(result.content)) {
        throw new Error("MCP result content was not an array");
    }
    const text = result.content.find((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null &&
        "type" in part && part.type === "text" &&
        "text" in part && typeof part.text === "string"
    );
    if (text === undefined) throw new Error("MCP result had no text content");
    return JSON.parse(text.text);
};

describe("MCP per-tool runtimes", () => {
    dtest("serves cache and judgment tools while SurrealDB is dead", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-mcp-nodb-"), dylibPath, CORPUS),
        );
        const sidecarPath = `${tempDir("ax-mcp-sidecar-")}/judgment.sqlite`;
        const transport = new StdioClientTransport({
            command: "bun",
            args: [CLI, "mcp"],
            cwd: process.cwd(),
            env: {
                ...process.env,
                AX_DB_URL: DEAD_DB_URL,
                AX_DUCKDB_SNAPSHOT: fixture.snapshotPath,
                AX_SIDECAR_PATH: sidecarPath,
                ...(dylibPath === null ? {} : { AX_DUCKDB_DYLIB: dylibPath }),
                NO_COLOR: "1",
            },
            stderr: "pipe",
        });
        const client = new Client({ name: "dead-surreal-test", version: "0.0.0" });

        try {
            await client.connect(transport);

            const recall = await client.callTool({ name: "recall", arguments: { q: "surreal" } });
            expect(recall.isError).not.toBe(true);
            const recallBody = bodyOf(recall) as { hits: ReadonlyArray<{ turn_id: string }> };
            expect(recallBody.hits.map((hit) => hit.turn_id)).toEqual(["mcp-turn"]);

            const roles = await client.callTool({ name: "roles", arguments: {} });
            expect(roles.isError).not.toBe(true);
            expect(bodyOf(roles)).toEqual({ rows: [], next: expect.any(Array) });
        } finally {
            await client.close().catch(() => undefined);
        }
    }, 60_000);
});
