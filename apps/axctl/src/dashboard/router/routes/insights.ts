/**
 * Insights family: only the env-gated graph-explorer experiment remains in
 * the legacy table (deliberately outside the Insights Surface Contract
 * until it graduates or dies - ADR-0013). Everything else in this family
 * is served by the contract router.
 */
import { isGraphExplorerEnabled } from "../../capabilities.ts";
import { fetchGraphExplorer, type GraphExplorerParams } from "../../graph-explorer.ts";
import { optionalNumberParam } from "../params.ts";
import {
    decodeFailWith,
    decodeOk,
    jsonRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

export const decodeGraphExplorerParams = (
    { url }: RouteInput,
    env: Record<string, string | undefined> = process.env,
): Decoded<GraphExplorerParams> => {
    if (!isGraphExplorerEnabled(env)) {
        return decodeFailWith({
            error: "graph_explorer_disabled",
            message: "Graph explorer is disabled. Set AX_ENABLE_GRAPH_EXPLORER=1 to enable this experimental endpoint.",
        }, 404);
    }

    const mode = url.searchParams.get("mode");
    const q = url.searchParams.get("q");
    const limit = optionalNumberParam(url, "limit");
    return decodeOk({
        ...(mode === null ? {} : { mode }),
        ...(q === null ? {} : { q }),
        ...(limit === undefined ? {} : { limit }),
    });
};

export const insightRoutes: ReadonlyArray<AnyRoute> = [
    jsonRoute({
        method: "GET",
        path: "/api/graph-explorer",
        fallthroughOnMethodMismatch: true,
        decode: (input) => decodeGraphExplorerParams(input),
        handler: (params) => fetchGraphExplorer(params),
    }),
];
