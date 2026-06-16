/**
 * MCP result-envelope helpers.
 *
 * Lives in its own module so BOTH the transport (`server.ts`) and the tool
 * factory (`tools.ts`) can import it without a server<->tools import cycle.
 *
 * IMPORTANT: stdio MCP servers communicate JSON-RPC over stdout. These helpers
 * produce the JSON-RPC RESPONSE body (returned to the SDK), never a stdout log.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wrap a raw tool result in the MCP content envelope. Centralised so every
 * registered tool gets identical serialisation: JSON pretty-printed into a
 * single text block.
 */
export const wrapToolResult = (result: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
});

/**
 * Wrap a thrown error as an MCP error result. The message is surfaced as text
 * (this is the JSON-RPC response body, not a stdout log).
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
