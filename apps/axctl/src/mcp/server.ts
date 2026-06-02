/**
 * MCP server (stdio transport).
 *
 * Mirrors `dashboard/server.ts`: a long-lived process that builds its OWN
 * `ManagedRuntime` (NOT the CLI's `withDb` path) and keeps it alive for the
 * duration. The CLI `mcp` command escapes Effect via `Effect.sync(() =>
 * serveMcp([]))`, exactly like `serve`.
 *
 * Responsibilities here: transport + runtime lifecycle + result wrapping.
 * The per-tool registry + arg mapping lives in `tools.ts`.
 *
 * IMPORTANT: stdio MCP servers communicate JSON-RPC over stdout. Any log MUST
 * go to stderr (`console.error`) - a stray stdout write corrupts the stream.
 */
import { ManagedRuntime } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AppLayer } from "@ax/lib/layers";
import { AX_VERSION } from "../cli/version.ts";
import { axMcpTools, type AxRuntime } from "./tools.ts";

/**
 * Wrap a raw tool result in the MCP content envelope. Centralised so every
 * registered tool (and future Task-3 tools) gets identical serialisation: JSON
 * pretty-printed into a single text block.
 */
export const wrapToolResult = (result: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
});

/**
 * Wrap a thrown error as an MCP error result. The message is surfaced as text
 * (stderr-safe - this is the JSON-RPC response body, not a stdout log).
 */
export const wrapToolError = (err: unknown): CallToolResult => ({
    isError: true,
    content: [
        {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
        },
    ],
});

/**
 * Build the MCP server and register every tool from `axMcpTools`. Each tool's
 * `run` is invoked with the validated args + the shared runtime; success flows
 * through `wrapToolResult`, failures through `wrapToolError`.
 */
export const buildServer = (rt: AxRuntime): McpServer => {
    const server = new McpServer({ name: "ax", version: AX_VERSION });

    // `registerTool`'s generic infers a callback type from the zod inputSchema.
    // Driving that inference from a `ZodRawShape` (the registry's erased shape
    // type) hits TS2589 (excessively deep). We register the tools through a
    // permissive local alias - the shape is still validated by the SDK at
    // runtime; we only opt out of the compile-time arg inference.
    const register = server.registerTool.bind(server) as (
        name: string,
        config: { description?: string; inputSchema?: unknown },
        cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
    ) => unknown;

    for (const tool of axMcpTools) {
        register(
            tool.name,
            {
                description: tool.description,
                inputSchema: tool.inputSchema,
            },
            async (args: Record<string, unknown>): Promise<CallToolResult> => {
                try {
                    const result = await tool.run(args, rt);
                    return wrapToolResult(result);
                } catch (err) {
                    console.error(`[ax mcp] tool "${tool.name}" failed:`, err);
                    return wrapToolError(err);
                }
            },
        );
    }

    return server;
};

/**
 * Run the MCP server over stdio until the process is signalled. Builds one
 * long-lived runtime, connects the stdio transport, and disposes the runtime
 * cleanly on SIGINT/SIGTERM (mirrors the dashboard server shutdown).
 *
 * `args` is accepted to mirror `serveDashboard(args)`; unused for now.
 */
export async function serveMcp(_args: ReadonlyArray<string>): Promise<void> {
    const runtime = ManagedRuntime.make(AppLayer);

    const server = buildServer(runtime);
    const transport = new StdioServerTransport();

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        await server.close().catch(() => undefined);
        await runtime.dispose().catch(() => undefined);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.kill(process.pid, signal);
    };
    const onSigint = (): void => void shutdown("SIGINT");
    const onSigterm = (): void => void shutdown("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    try {
        await server.connect(transport);
    } catch (err) {
        await runtime.dispose().catch(() => undefined);
        throw err;
    }

    console.error(
        `[ax mcp] stdio server ready (ax ${AX_VERSION}) - ${axMcpTools.length} tool(s): ${axMcpTools.map((t) => t.name).join(", ")}`,
    );
}
