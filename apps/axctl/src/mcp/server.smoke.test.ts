/**
 * Smoke test: the MCP server speaks MCP over an in-memory transport, exposes
 * the `recall` tool via tools/list, and the result-wrapping helpers + registry
 * are well-formed. No seeded DB required - tools/list never touches SurrealDB,
 * and we assert the registry/envelope shape directly.
 */
import { describe, expect, it } from "bun:test";
import { ManagedRuntime } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppLayer } from "@ax/lib/layers";
import { buildServer, wrapToolError, wrapToolResult } from "./server.ts";
import { axMcpTools } from "./tools.ts";

describe("axMcpTools registry", () => {
    it("contains a well-formed recall descriptor", () => {
        const recall = axMcpTools.find((t) => t.name === "recall");
        expect(recall).toBeDefined();
        expect(typeof recall!.description).toBe("string");
        expect(recall!.description.length).toBeGreaterThan(0);
        expect(typeof recall!.run).toBe("function");
        // inputSchema is a zod raw shape - q must be present.
        expect(recall!.inputSchema).toHaveProperty("q");
    });
});

describe("result wrapping", () => {
    it("wraps a raw result as a text content envelope", () => {
        const wrapped = wrapToolResult({ hello: "world" });
        expect(wrapped.content).toEqual([
            { type: "text", text: JSON.stringify({ hello: "world" }, null, 2) },
        ]);
        expect(wrapped.isError).toBeUndefined();
    });

    it("wraps a thrown error as an isError envelope", () => {
        const wrapped = wrapToolError(new Error("boom"));
        expect(wrapped.isError).toBe(true);
        expect(wrapped.content).toEqual([{ type: "text", text: "boom" }]);
    });

    it("stringifies non-Error throwables", () => {
        const wrapped = wrapToolError("nope");
        expect(wrapped.isError).toBe(true);
        expect(wrapped.content[0]).toEqual({ type: "text", text: "nope" });
    });
});

describe("MCP server over in-memory transport", () => {
    it("lists the recall tool via tools/list", async () => {
        const runtime = ManagedRuntime.make(AppLayer);
        const server = buildServer(runtime);
        const client = new Client({ name: "smoke-test", version: "0.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        try {
            await Promise.all([
                server.connect(serverTransport),
                client.connect(clientTransport),
            ]);

            const { tools } = await client.listTools();
            const recall = tools.find((t) => t.name === "recall");
            expect(recall).toBeDefined();
            expect(recall!.description).toContain("recall");
            // The zod shape was converted to a JSON schema with a `q` property.
            expect(recall!.inputSchema).toBeDefined();
            const props = (recall!.inputSchema as { properties?: Record<string, unknown> }).properties;
            expect(props).toHaveProperty("q");
        } finally {
            await client.close().catch(() => undefined);
            await server.close().catch(() => undefined);
            await runtime.dispose().catch(() => undefined);
        }
    });
});
