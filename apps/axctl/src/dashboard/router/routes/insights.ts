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
    jsonResponse,
    jsonRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

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
    jsonRoute({
        method: "GET",
        path: "/api/episodes/:parentId+",
        decode: ({ path }) => requiredPath(path, "parentId", "missing parent id"),
        handler: (parentId) => fetchEpisodeTimeline(parentId),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/graph-explorer",
        decode: (input) => decodeGraphExplorerParams(input),
        handler: (params) => fetchGraphExplorer(params),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/skill-graph",
        decode: decodeSkillGraphParams,
        handler: (params) => fetchSkillGraph(params),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/recall",
        decode: decodeRecallParams,
        handler: (params) =>
            params.q.trim().length === 0
                ? Effect.succeed(
                    emptyRecallResponse(params.q, params.offset ?? 0, params.limit ?? 50),
                )
                : fetchRecall(params),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/projects/:project+",
        decode: ({ path }) => requiredPath(path, "project", "missing project"),
        handler: (project) => fetchProject(project),
        respond: (payload) =>
            payload === null
                ? jsonResponse({ error: "project not found" }, 404)
                : jsonResponse(payload),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/wrapped",
        decode: () => decodeOk(undefined),
        handler: () => fetchWrapped(),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/wrapped/public-preview",
        decode: () => decodeOk(undefined),
        handler: () => fetchWrapped().pipe(Effect.map(sanitizeWrappedProfile)),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/workflow",
        decode: () => decodeOk(undefined),
        handler: () => fetchWorkflow(),
    }),
    jsonRoute({
        method: "GET",
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
