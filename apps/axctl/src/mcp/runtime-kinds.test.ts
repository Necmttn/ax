/**
 * MCP process coverage that never provides the `full` runtime (`AppLayer` +
 * both read seams, `mcp/runtime.ts`) - only the narrow kinds each tool
 * actually declares.
 *
 * This starts the real stdio command and calls at least one tool per narrow
 * runtime kind: `"cache"` (recall, plus session_metrics / sessions_churn /
 * cost_images), `"judgment"` (roles), and `"cache-judgment"` (skills_by_role -
 * the runtime behind skills_by_role / skills_roles, the one join surface that
 * spans both engines). Any call fails if server startup or tool dispatch
 * resolves `full` instead of the tool's declared kind.
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
                AX_DUCKDB_SNAPSHOT: fixture.snapshotPath,
                AX_SIDECAR_PATH: sidecarPath,
                ...(dylibPath === null ? {} : { AX_DUCKDB_DYLIB: dylibPath }),
                NO_COLOR: "1",
            },
            stderr: "pipe",
        });
        const client = new Client({ name: "runtime-kinds-test", version: "0.0.0" });

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
            // needs `full`.
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

            // The three tools below declare the narrow `cache` runtime, not
            // `full` (mcp/runtime.ts). On this runtime there is no `AppLayer`
            // at all, so a declaration that quietly widened to `full` would
            // surface here as a tool error, which an in-process test over the
            // query function alone could never show.
            const metrics = await client.callTool({ name: "session_metrics", arguments: {} });
            expect(metrics.isError).not.toBe(true);
            expect(Array.isArray(bodyOf(metrics))).toBe(true);

            const churn = await client.callTool({ name: "sessions_churn", arguments: {} });
            expect(churn.isError).not.toBe(true);
            expect(bodyOf(churn)).toMatchObject({
                aggregates: expect.any(Array),
                hotSessions: expect.any(Array),
            });

            const images = await client.callTool({ name: "cost_images", arguments: {} });
            expect(images.isError).not.toBe(true);
            expect(bodyOf(images)).toMatchObject({
                rows: expect.any(Array),
                totals: expect.any(Object),
            });

            // `dispatches` declares the narrow `cache` runtime even though its
            // `candidates` branch reads ~/.ax/hooks/routing-table.json through
            // `loadEffectiveRoutingTable()`, which needs `FileSystem` - the
            // `cache` runtime carries the Bun platform layers for exactly this
            // (mcp/runtime.ts). The candidates call is the one that proves the
            // layer: without it the tool dispatch cannot even build its
            // effect. (The file read fails open to the built-in defaults when
            // no routing table exists.)
            const dispatches = await client.callTool({ name: "dispatches", arguments: {} });
            expect(dispatches.isError).not.toBe(true);
            expect(bodyOf(dispatches)).toMatchObject({
                rows: expect.any(Array),
                total_dispatches: expect.any(Number),
            });

            const candidates = await client.callTool({
                name: "dispatches",
                arguments: { candidates: true },
            });
            expect(candidates.isError).not.toBe(true);
            expect(bodyOf(candidates)).toMatchObject({
                candidates: expect.any(Array),
                total_est_savings_usd: expect.any(Number),
            });
        } finally {
            await client.close().catch(() => undefined);
        }
    }, 60_000);
});
