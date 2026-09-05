import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("routability availability", { requireFts: true });
const CLI = Bun.fileURLToPath(new URL("./index.ts", import.meta.url));

// Damage one required input in an otherwise real, published production schema.
// Column renames leave the FTS inputs intact and make the real SQL binder fail.
const cases = [
    { name: "turns", sql: "ALTER TABLE turn RENAME COLUMN seq TO unavailable_seq" },
    { name: "tools", sql: "ALTER TABLE tool_call RENAME COLUMN command_norm TO unavailable_command_norm" },
    { name: "usage", sql: "ALTER TABLE turn_token_usage RENAME COLUMN estimated_cost_usd TO unavailable_cost" },
    { name: "models", sql: "ALTER TABLE agent_model RENAME COLUMN input_per_million_usd TO unavailable_price" },
    { name: "empty successful data", sql: null },
] as const;

describe("routability evidence through CLI and MCP", () => {
    for (const scenario of cases) {
        dtest(scenario.name, async () => {
            const dir = tempDir("ax-routability-availability-");
            const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    if (scenario.sql === null) return;
                    const table = scenario.sql.split(" ")[2]!;
                    const indexes = yield* write.rows(Schema.Struct({ index_name: Schema.String }),
                        "SELECT index_name FROM duckdb_indexes() WHERE table_name = ?", [table]);
                    for (const index of indexes) yield* write.exec(`DROP INDEX "${index.index_name}"`);
                    yield* write.exec(scenario.sql);
                })));
            const env = {
                ...process.env,
                AX_DUCKDB_SNAPSHOT: fixture.snapshotPath,
                AX_SIDECAR_PATH: `${dir}/judgment.sqlite`,
                AX_NO_AUTO_INGEST: "1",
                AX_JUDGMENT_MODEL: "regex",
                AX_PROGRESS: "off",
                NO_COLOR: "1",
                ...(dylibPath === null ? {} : { AX_DUCKDB_DYLIB: dylibPath }),
            };
            const cli = Bun.spawnSync(["bun", CLI, "cost", "routability", "--json"], {
                env, stdout: "pipe", stderr: "pipe", timeout: 30_000,
            });
            const transport = new StdioClientTransport({
                command: "bun", args: [CLI, "mcp"], env, stderr: "pipe",
            });
            const client = new Client({ name: "routability-availability-test", version: "0.0.0" });
            try {
                await client.connect(transport);
                const result = await client.callTool({ name: "cost_routability", arguments: {} });
                if (scenario.sql !== null) {
                    expect(cli.exitCode).not.toBe(0);
                    expect(cli.stderr.toString()).toContain("DuckDbQueryError");
                    expect(cli.stdout.toString()).not.toContain('"mainSpendUsd"');
                    expect(result.isError).toBe(true);
                    expect(JSON.stringify(result.content)).toContain("not found");
                } else {
                    expect(cli.exitCode).toBe(0);
                    expect(JSON.parse(cli.stdout.toString())).toMatchObject({ mainSpendUsd: 0 });
                    expect(result.isError).not.toBe(true);
                    const content = result.content as Array<{ type: string; text: string }>;
                    expect(JSON.parse(content[0]!.text)).toMatchObject({ mainSpendUsd: 0 });
                }
            } finally {
                await client.close();
            }
        }, 60_000);
    }
});
