/**
 * Handlers for the insights group of the Insights Surface Contract.
 * Thin delegations to the existing fetch* effects; parity notes:
 *   - recall keeps the empty-q fast path (no DB touch, canned empty page),
 *   - project maps a null lookup to the 404 NotFoundError the legacy
 *     respond-override produced,
 *   - everything else is fetch* + the 500 InternalError mapping.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AxApi, NotFoundError } from "@ax/lib/shared/api-contract";
import { fetchEpisodeTimeline } from "../episode-timeline.ts";
import { fetchProject } from "../project.ts";
import { emptyRecallResponse, fetchRecall, type RecallParams } from "../recall.ts";
import { fetchSkillGraph } from "../skill-graph.ts";
import { fetchToolFailureDetail, fetchToolFailures } from "../tool-failures.ts";
import { fetchWorkflow } from "../workflow.ts";
import { sanitizeWrappedProfile } from "../wrapped.ts";
import { fetchWrappedCached } from "../wrapped-cache.ts";
import { orInternal } from "./common.ts";

export const InsightsGroupLive = HttpApiBuilder.group(AxApi, "insights", (handlers) =>
    handlers
        .handle("recall", ({ query }) => {
            const params: RecallParams = {
                q: query.q ?? "",
                project: query.project ?? null,
                skill: query.skill ?? null,
                since: query.since ?? null,
                offset: query.offset ?? 0,
                limit: query.limit ?? 50,
            };
            if (params.q.trim().length === 0) {
                return Effect.succeed(
                    emptyRecallResponse(params.q, params.offset ?? 0, params.limit ?? 50),
                );
            }
            return orInternal(fetchRecall(params));
        })
        .handle("episodeTimeline", ({ params }) => orInternal(fetchEpisodeTimeline(params.parentId)))
        .handle("skillGraph", ({ query }) =>
            orInternal(fetchSkillGraph({
                ...(query.minCount === undefined ? {} : { minCount: query.minCount }),
                ...(query.limit === undefined ? {} : { limit: query.limit }),
            })))
        .handle("project", ({ params }) =>
            orInternal(fetchProject(params.project)).pipe(
                Effect.flatMap((payload) =>
                    payload === null
                        ? Effect.fail(new NotFoundError({ error: "project not found" }))
                        : Effect.succeed(payload)
                ),
            ))
        .handle("wrapped", () => orInternal(fetchWrappedCached()))
        .handle("wrappedPublicPreview", () =>
            orInternal(fetchWrappedCached().pipe(Effect.map(sanitizeWrappedProfile))))
        .handle("workflow", () => orInternal(fetchWorkflow()))
        .handle("toolFailures", () => orInternal(fetchToolFailures()))
        .handle("toolFailureDetail", ({ params }) => orInternal(fetchToolFailureDetail(params.label))));
