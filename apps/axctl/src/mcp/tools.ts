/**
 * MCP tool registry.
 *
 * Each entry is a self-contained descriptor: an MCP-facing name + description +
 * zod input shape, plus a `run` that maps the validated args onto an ax Effect
 * query and resolves it on the long-lived runtime. `server.ts` iterates this
 * array and wraps every result in the MCP content envelope, so adding a tool
 * (Task 3) means only appending a descriptor here - no transport changes.
 *
 * Boundary convention: zod for input validation at the MCP edge (the SDK speaks
 * zod natively); Effect Schema / Effect stays internal to the query functions.
 */
import { z, type ZodRawShape } from "zod";
import type { ManagedRuntime, Layer } from "effect";
import type { AppLayer } from "@ax/lib/layers";
import {
    fetchRecall,
    type RecallParams,
    type RecallSource,
} from "../dashboard/recall.ts";

/**
 * The long-lived MCP runtime, built from `AppLayer` (SurrealClient + config +
 * trace transport). The service/error params are derived from the layer so they
 * stay in sync if `AppLayer` changes.
 */
export type AxRuntime = ManagedRuntime.ManagedRuntime<
    Layer.Success<typeof AppLayer>,
    Layer.Error<typeof AppLayer>
>;

/**
 * A single MCP tool descriptor. `inputSchema` is a zod raw shape (the SDK's
 * `registerTool` accepts this directly and derives the JSON schema + arg type).
 * `run` receives the validated args and the runtime; it returns a raw JSON-able
 * value, which `server.ts` serialises into the MCP text content envelope.
 */
export interface AxMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ZodRawShape;
    readonly run: (args: Record<string, unknown>, rt: AxRuntime) => Promise<unknown>;
}

const RECALL_SOURCES = ["turn", "commit", "skill"] as const;

const recallTool: AxMcpTool = {
    name: "recall",
    description:
        "Full-text recall across the ax graph: search turns (conversation excerpts), git commits, and skills. Returns scored hits with source, excerpt, and provenance.",
    inputSchema: {
        q: z.string().describe("Search query (required). Matched against turn text, commit messages, and skill metadata."),
        limit: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe("Max hits to return (default 50, max 200)."),
        sources: z
            .array(z.enum(RECALL_SOURCES))
            .optional()
            .describe('Which sources to search. Defaults to ["turn"]. Any of "turn", "commit", "skill".'),
    },
    run: async (args, rt) => {
        const q = String(args.q ?? "").trim();
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const sources = Array.isArray(args.sources)
            ? (args.sources.filter((s): s is RecallSource =>
                  RECALL_SOURCES.includes(s as RecallSource),
              ))
            : undefined;
        // No scope param in v0: omit it so fetchRecall defaults to unscoped
        // (all repositories). Real repo-scoping needs the git resolver, which
        // is unfit for a long-lived server - revisit later.

        // Build params conditionally - exactOptionalPropertyTypes forbids
        // assigning `undefined` to optional props.
        const params: RecallParams = { q };
        if (typeof limit === "number") (params as { limit?: number }).limit = limit;
        if (sources && sources.length > 0) {
            (params as { sources?: ReadonlyArray<RecallSource> }).sources = sources;
        }

        const response = await rt.runPromise(fetchRecall(params));
        return response;
    },
};

/** All registered MCP tools. Task 3 appends more descriptors here. */
export const axMcpTools: ReadonlyArray<AxMcpTool> = [recallTool];
