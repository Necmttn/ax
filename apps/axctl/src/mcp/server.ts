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
import { AppLayer } from "@ax/lib/layers";
import { AX_VERSION } from "../cli/version.ts";
import { axMcpTools, type AxRuntime } from "./tools.ts";

// Re-exported for callers (and the smoke test) that import the envelope helpers
// from the server module. They live in `./wrap.ts` to avoid a server<->tools
// import cycle, since the tool factory needs them too.
export { wrapToolResult, wrapToolError } from "./wrap.ts";

/**
 * Build the MCP server and register every tool from `axMcpTools`. Each tool
 * owns its own `register(server, rt)` closure (see `defineMcpTool`), which wires
 * the SDK callback through `wrapToolResult` / `wrapToolError`. Because the zod
 * shape stays a deferred generic inside the factory, there is no longer a
 * TS2589 cast here - registration is a plain typed call.
 */
export const buildServer = (rt: AxRuntime): McpServer => {
    const server = new McpServer({ name: "ax", version: AX_VERSION });
    for (const tool of axMcpTools) {
        tool.register(server, rt);
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
