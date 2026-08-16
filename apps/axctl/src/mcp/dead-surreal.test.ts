/**
 * MCP process coverage with SurrealDB deliberately unreachable.
 *
 * This starts the real stdio command and calls one tool per non-legacy
 * runtime kind: `"cache"` (recall), `"judgment"` (roles), and
 * `"cache-judgment"` (skills_by_role - the runtime behind skills_by_role /
 * skills_roles, the one join surface that spans both engines). Any call fails
 * if server startup or tool dispatch resolves the legacy `AppLayer` union.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { Judgment, JudgmentLayer, type JudgmentService } from "@ax/lib/sqlite";
import { roleRowId } from "@ax/lib/stable-id";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";

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
        // A tagged skill, for the cache-judgment tool below. skills_by_role
        // resolves the name and invocation count from the cache; the tag
        // itself lives in the sidecar (seeded via seedSidecar).
        yield* write.put("skill", {
            id: "skill:tdd",
            name: "tdd",
            scope: "user",
            dir_path: "/tmp/skills/tdd",
            content_hash: "hash-tdd",
        });
    });

/** Seed the sidecar this test's spawned MCP process will open via
 *  `AX_SIDECAR_PATH`, in THIS process - mirrors role-queries.test.ts's
 *  fixture, which is the only other place this cross-engine join is tested. */
const seedSidecar = (sidecarPath: string) =>
    Effect.gen(function* () {
        const judgment: JudgmentService = yield* Judgment;
        yield* judgment.putMany("role", [
            { id: roleRowId("verification"), name: "verification", weight: 2 },
        ]);
        yield* judgment.putMany("plays_role", [
            {
                id: "pr-tdd-verification",
                in_id: "skill:tdd",
                out_id: roleRowId("verification"),
                source: "user",
                confidence: 0.9,
                rationale: "the whole point of it",
                weight: null,
            },
        ]);
    }).pipe(
        Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })),
        Effect.scoped,
    ) as Effect.Effect<void, unknown>;

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
        await Effect.runPromise(seedSidecar(sidecarPath));
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
            expect(bodyOf(roles)).toEqual({
                rows: [{ name: "verification", weight: 2, skill_count: 1 }],
                next: expect.any(Array),
            });

            // The "cache-judgment" runtime (skills_by_role / skills_roles):
            // the tag lives in the sidecar (Judgment), the skill's name and
            // invocation count live in the cache (CacheRead) - neither half
            // is `AppLayer`, so this must also succeed with SurrealDB dead.
            const skillsByRole = await client.callTool({
                name: "skills_by_role",
                arguments: { role: "verification" },
            });
            expect(skillsByRole.isError).not.toBe(true);
            const skillsByRoleBody = bodyOf(skillsByRole) as {
                rows: ReadonlyArray<{ skill_id: string; skill_name: string; source: string }>;
                found: boolean;
            };
            expect(skillsByRoleBody.found).toBe(true);
            expect(skillsByRoleBody.rows).toEqual([
                expect.objectContaining({ skill_id: "skill:tdd", skill_name: "tdd", source: "user" }),
            ]);
        } finally {
            await client.close().catch(() => undefined);
        }
    }, 60_000);
});
