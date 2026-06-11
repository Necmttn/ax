import { Effect } from "effect";
import { extractSessionTimeline, SessionTimelineServiceLayer } from "../../../timeline/service.ts";
import { fetchSessionCanvas, fetchSessionOrchestration } from "../../session-canvas.ts";
import { fetchSessionCompare } from "../../session-compare.ts";
import { fetchSessionDetail } from "../../session-detail.ts";
import { fetchSessionInsights } from "../../session-insights.ts";
import { fetchSessionInspect } from "../../session-inspect.ts";
import { fetchSessionSummary } from "../../session-summary.ts";
import { fetchSessionChildren, fetchSessionsList, type SessionsListOpts } from "../../sessions-list.ts";
import { csvParam, numberParam, optionalNumberParam } from "../params.ts";
import {
    decodeFail,
    decodeOk,
    jsonRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

/** Legacy 404 mapping for inspect/timeline: TranscriptNotFoundError et al. */
const notFoundStatus = (err: unknown): number =>
    err instanceof Error && /not found/i.test(err.message) ? 404 : 500;

const legacyGetRoute = <P, A>(
    def: Omit<Parameters<typeof jsonRoute<P, A>>[0], "method" | "fallthroughOnMethodMismatch">,
): AnyRoute =>
    jsonRoute({
        ...def,
        method: "GET",
        fallthroughOnMethodMismatch: true,
    });

export const decodeSessionsListParams = ({ url }: RouteInput): Decoded<SessionsListOpts> => {
    const source = url.searchParams.get("source") ?? undefined;
    const project = url.searchParams.get("project") ?? undefined;
    return decodeOk({
        offset: numberParam(url, "offset", 0),
        limit: numberParam(url, "limit", 200),
        ...(source ? { source } : {}),
        ...(project ? { project } : {}),
    });
};

export interface CompareParams {
    readonly ids: ReadonlyArray<string>;
    readonly includeTurns: boolean;
}

export const decodeCompareParams = ({ url }: RouteInput): Decoded<CompareParams> => {
    const ids = csvParam(url, "ids");
    if (ids.length < 2) return decodeFail("need at least 2 session ids (ids=a,b)", 400);
    return decodeOk({ ids, includeTurns: url.searchParams.get("turns") === "1" });
};

export interface InspectParams {
    readonly id: string;
    readonly turnOffset: number;
    readonly turnLimit: number;
}

export const decodeInspectParams = ({ url, path }: RouteInput): Decoded<InspectParams> => {
    const id = path.id ?? "";
    if (!id) return decodeFail("missing session id", 400);
    return decodeOk({
        id,
        turnOffset: numberParam(url, "turn_offset", 0),
        turnLimit: numberParam(url, "turn_limit", 100),
    });
};

const requiredSessionId = ({ path }: RouteInput): Decoded<string> => {
    const id = path.id ?? "";
    return id ? decodeOk(id) : decodeFail("missing session id", 400);
};

const requiredQueryId = ({ url }: RouteInput): Decoded<string> => {
    const id = url.searchParams.get("id");
    return id ? decodeOk(id) : decodeFail("missing id", 400);
};

export const sessionRoutes: ReadonlyArray<AnyRoute> = [
    legacyGetRoute({
        path: "/api/session-canvas",
        decode: ({ url }) => {
            const limit = optionalNumberParam(url, "limit");
            return decodeOk(limit === undefined ? {} : { limit });
        },
        handler: (params) => fetchSessionCanvas(params),
    }),
    legacyGetRoute({
        path: "/api/session-summary",
        decode: requiredQueryId,
        handler: (id) => fetchSessionSummary(id),
    }),
    legacyGetRoute({
        path: "/api/session-orchestration",
        decode: requiredQueryId,
        handler: (id) => fetchSessionOrchestration(id),
    }),
    legacyGetRoute({
        path: "/api/sessions",
        decode: decodeSessionsListParams,
        handler: (opts) => fetchSessionsList(opts),
    }),
    // Static before param routes: compare must precede every /api/sessions/:id+ route.
    legacyGetRoute({
        path: "/api/sessions/compare",
        decode: decodeCompareParams,
        handler: ({ ids, includeTurns }) => fetchSessionCompare(ids, { includeTurns }),
    }),
    legacyGetRoute({
        path: "/api/sessions/:id+/children",
        decode: (input) => {
            const id = requiredSessionId(input);
            if (!id.ok) return id;
            return decodeOk({ id: id.value, limit: numberParam(input.url, "limit", 500) });
        },
        handler: ({ id, limit }) => fetchSessionChildren(id, { limit }),
    }),
    legacyGetRoute({
        path: "/api/sessions/:id+/insights",
        decode: requiredSessionId,
        handler: (id) => fetchSessionInsights(id),
    }),
    legacyGetRoute({
        path: "/api/sessions/:id+/inspect",
        decode: decodeInspectParams,
        handler: ({ id, turnOffset, turnLimit }) => fetchSessionInspect(id, { turnOffset, turnLimit }),
        errorStatus: notFoundStatus,
    }),
    legacyGetRoute({
        path: "/api/sessions/:id+/timeline",
        decode: requiredSessionId,
        handler: (id) => extractSessionTimeline(id).pipe(Effect.provide(SessionTimelineServiceLayer)),
        errorStatus: notFoundStatus,
    }),
    // Catch-all LAST within the family.
    legacyGetRoute({
        path: "/api/sessions/:id+",
        decode: requiredSessionId,
        handler: (id) => fetchSessionDetail(id),
    }),
];
