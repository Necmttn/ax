/**
 * Handlers for the sessions group of the Insights Surface Contract.
 * Thin delegations to the existing fetch* effects; parity notes:
 *   - sessionCompare validates that at least 2 ids are provided (400 parity
 *     with the legacy decodeFail path),
 *   - sessionInspect and sessionTimeline map /not found/i errors to 404
 *     NotFoundError (legacy errorStatus: notFoundStatus parity),
 *   - everything else is fetch* + the 500 InternalError mapping.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AxApi, BadRequestError, InternalError, NotFoundError } from "@ax/lib/shared/api-contract";
import { extractSessionTimeline, SessionTimelineServiceLayer } from "../../timeline/service.ts";
import { fetchEnrichedSession } from "../../queries/enriched-session.ts";
import { fetchSessionCanvas, fetchSessionOrchestration } from "../session-canvas.ts";
import { fetchSessionCompare } from "../session-compare.ts";
import { fetchSessionInsights } from "../session-insights.ts";
import { fetchSessionInspect } from "../session-inspect.ts";
import { fetchRunEvidence } from "../../queries/run-evidence.ts";
import { fetchSessionSummary } from "../session-summary.ts";
import { fetchSessionChildren, fetchSessionsList } from "../sessions-list.ts";
import { internal, orInternal } from "./common.ts";

/**
 * Shared not-found-or-internal mapper for inspect and timeline endpoints.
 * Legacy parity: any Error whose message matches /not found/i → 404; else 500.
 */
const notFoundOrInternal = (err: unknown): NotFoundError | InternalError =>
    err instanceof Error && /not found/i.test(err.message)
        ? new NotFoundError({ error: err.message })
        : internal(err);

export const SessionsGroupLive = HttpApiBuilder.group(AxApi, "sessions", (handlers) =>
    handlers
        .handle("sessionCanvas", ({ query }) =>
            orInternal(fetchSessionCanvas(
                query.limit === undefined ? {} : { limit: query.limit },
            )))
        .handle("sessionSummary", ({ query }) =>
            orInternal(fetchSessionSummary(query.id)))
        .handle("sessionOrchestration", ({ query }) =>
            orInternal(fetchSessionOrchestration(query.id)))
        .handle("sessionsList", ({ query }) =>
            orInternal(fetchSessionsList({
                offset: query.offset ?? 0,
                limit: query.limit ?? 200,
                ...(query.source ? { source: query.source } : {}),
                ...(query.project ? { project: query.project } : {}),
            })))
        .handle("sessionCompare", ({ query }) => {
            const ids = query.ids
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            if (ids.length < 2) {
                return Effect.fail(
                    new BadRequestError({ error: "need at least 2 session ids (ids=a,b)" }),
                );
            }
            return orInternal(fetchSessionCompare(ids, { includeTurns: query.turns === "1" }));
        })
        .handle("sessionChildren", ({ params, query }) =>
            orInternal(fetchSessionChildren(params.id, { limit: query.limit ?? 500 })))
        .handle("sessionInsights", ({ params }) =>
            orInternal(fetchSessionInsights(params.id)))
        .handle("sessionInspect", ({ params, query }) =>
            fetchSessionInspect(params.id, {
                turnOffset: query.turn_offset ?? 0,
                turnLimit: query.turn_limit ?? 100,
            }).pipe(Effect.mapError(notFoundOrInternal)))
        .handle("sessionTimeline", ({ params }) =>
            extractSessionTimeline(params.id).pipe(
                Effect.provide(SessionTimelineServiceLayer),
                Effect.mapError(notFoundOrInternal),
            ))
        .handle("sessionEvidence", ({ params }) =>
            orInternal(fetchRunEvidence({ sessionId: params.id })))
        .handle("sessionDetail", ({ params }) =>
            // The Enriched Session facade is the single home for assembling a
            // session read model. This route fetches strictly LESS than the CLI:
            // the bare Session Detail base (`base: "detail"`), no metrics, no
            // insights - so the HTTP response shape stays the bare
            // SessionDetailPayload and the query count is exactly one, as before.
            orInternal(
                fetchEnrichedSession({ sessionId: params.id, base: { kind: "detail" } }).pipe(
                    Effect.map((enriched) => enriched.detail!),
                ),
            )));
