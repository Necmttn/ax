import { Effect } from "effect";
import { isGraphExplorerEnabled } from "../../capabilities.ts";
import { fetchEpisodeTimeline } from "../../episode-timeline.ts";
import { fetchGraphExplorer, type GraphExplorerParams } from "../../graph-explorer.ts";
import { fetchProject } from "../../project.ts";
import { emptyRecallResponse, fetchRecall, type RecallParams } from "../../recall.ts";
import { fetchSkillGraph, type SkillGraphParams } from "../../skill-graph.ts";
import { fetchToolFailureDetail, fetchToolFailures } from "../../tool-failures.ts";
import { fetchWorkflow } from "../../workflow.ts";
import { fetchWrapped, sanitizeWrappedProfile } from "../../wrapped.ts";
import { numberParam, optionalNumberParam } from "../params.ts";
import {
    decodeFail,
    decodeFailWith,
    decodeOk,
    errorMessage,
    jsonResponse,
    jsonRoute,
    rawRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

const legacyGetRoute = <P, A>(
    def: Omit<Parameters<typeof jsonRoute<P, A>>[0], "method" | "fallthroughOnMethodMismatch">,
): AnyRoute =>
    jsonRoute({
        ...def,
        method: "GET",
        fallthroughOnMethodMismatch: true,
    });

export const decodeRecallParams = ({ url }: RouteInput): Decoded<RecallParams> =>
    decodeOk({
        q: url.searchParams.get("q") ?? "",
        project: url.searchParams.get("project"),
        skill: url.searchParams.get("skill"),
        since: url.searchParams.get("since"),
        offset: numberParam(url, "offset", 0),
        limit: numberParam(url, "limit", 50),
    });

export const decodeSkillGraphParams = ({ url }: RouteInput): Decoded<SkillGraphParams> => {
    const minCount = optionalNumberParam(url, "minCount");
    const limit = optionalNumberParam(url, "limit");
    return decodeOk({
        ...(minCount === undefined ? {} : { minCount }),
        ...(limit === undefined ? {} : { limit }),
    });
};

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

const requiredPath = (
    path: Readonly<Record<string, string>>,
    key: string,
    missing: string,
): Decoded<string> => {
    const value = path[key] ?? "";
    return value ? decodeOk(value) : decodeFail(missing, 400);
};

export const insightRoutes: ReadonlyArray<AnyRoute> = [
    legacyGetRoute({
        path: "/api/episodes/:parentId+",
        decode: ({ path }) => requiredPath(path, "parentId", "missing parent id"),
        handler: (parentId) => fetchEpisodeTimeline(parentId),
    }),
    legacyGetRoute({
        path: "/api/graph-explorer",
        decode: (input) => decodeGraphExplorerParams(input),
        handler: (params) => fetchGraphExplorer(params),
    }),
    legacyGetRoute({
        path: "/api/skill-graph",
        decode: decodeSkillGraphParams,
        handler: (params) => fetchSkillGraph(params),
    }),
    rawRoute({
        // rawRoute (not jsonRoute) so the empty-q case answers before the
        // runner: building AppLayer eagerly opens SurrealClient and stalls
        // ~5s without a DB - same class as /api/version (issue #245).
        method: "GET",
        path: "/api/recall",
        fallthroughOnMethodMismatch: true,
        handler: async (input) => {
            const decoded = decodeRecallParams(input);
            if (!decoded.ok) return jsonResponse(decoded.body, decoded.status);
            const params = decoded.value;
            if (params.q.trim().length === 0) {
                return jsonResponse(
                    emptyRecallResponse(params.q, params.offset ?? 0, params.limit ?? 50),
                );
            }
            try {
                return jsonResponse(await input.runner(fetchRecall(params)));
            } catch (err) {
                return jsonResponse({ error: errorMessage(err) }, 500);
            }
        },
    }),
    legacyGetRoute({
        path: "/api/projects/:project+",
        decode: ({ path }) => requiredPath(path, "project", "missing project"),
        handler: (project) => fetchProject(project),
        respond: (payload) =>
            payload === null
                ? jsonResponse({ error: "project not found" }, 404)
                : jsonResponse(payload),
    }),
    legacyGetRoute({
        path: "/api/wrapped",
        decode: () => decodeOk(undefined),
        handler: () => fetchWrapped(),
    }),
    legacyGetRoute({
        path: "/api/wrapped/public-preview",
        decode: () => decodeOk(undefined),
        handler: () => fetchWrapped().pipe(Effect.map(sanitizeWrappedProfile)),
    }),
    legacyGetRoute({
        path: "/api/workflow",
        decode: () => decodeOk(undefined),
        handler: () => fetchWorkflow(),
    }),
    legacyGetRoute({
        path: "/api/tool-failures",
        decode: () => decodeOk(undefined),
        handler: () => fetchToolFailures(),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/tool-failures/:label+/detail",
        decode: ({ path }) => requiredPath(path, "label", "missing label"),
        handler: (label) => fetchToolFailureDetail(label),
    }),
];
