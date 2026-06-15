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
import { fetchCostModels } from "../../queries/cost-analytics.ts";
import { fetchContextBudget } from "../../queries/context-budget.ts";
import { fetchEpisodeTimeline } from "../episode-timeline.ts";
import { fetchProject } from "../project.ts";
import { emptyRecallResponse, fetchRecall, type RecallParams } from "../recall.ts";
import { fetchSkillGraph } from "../skill-graph.ts";
import { fetchToolFailureDetail, fetchToolFailures } from "../tool-failures.ts";
import { fetchWorkflow } from "../workflow.ts";
import { sanitizeWrappedProfile } from "../wrapped.ts";
import { fetchWrappedCached } from "../wrapped-cache.ts";
import { fetchWrappedCards, sanitizeWrappedCards } from "../wrapped-cards.ts";
import { renderWrappedGenerateBrief } from "../wrapped-generate-brief.ts";
import { asJsonValue, orInternal } from "./common.ts";

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
        // Agent-authored cards merge onto the cached mechanical profile.
        // The cards read is uncached on purpose: `ax wrapped publish` runs in
        // a separate process and can't drop the daemon's in-memory TTL cache.
        .handle("wrapped", () =>
            orInternal(
                Effect.all([fetchWrappedCached(), fetchWrappedCards()]).pipe(
                    // asJsonValue: card rows are raw query rows - see common.ts.
                    Effect.map(([profile, cards]) => asJsonValue({ ...profile, cards })),
                ),
            ))
        .handle("wrappedPublicPreview", () =>
            orInternal(
                Effect.all([fetchWrappedCached(), fetchWrappedCards()]).pipe(
                    Effect.map(([profile, cards]) =>
                        asJsonValue({
                            ...sanitizeWrappedProfile(profile),
                            cards: sanitizeWrappedCards(cards),
                        })),
                ),
            ))
        .handle("wrappedGenerateBrief", () =>
            Effect.sync(() => ({
                brief: renderWrappedGenerateBrief({ date: new Date().toISOString().slice(0, 10) }),
            })))
        .handle("costModels", () =>
            orInternal(fetchCostModels({ sinceDays: 365 }).pipe(Effect.map(asJsonValue))))
        .handle("contextBudget", () =>
            orInternal(fetchContextBudget().pipe(Effect.map(asJsonValue))))
        .handle("workflow", () => orInternal(fetchWorkflow()))
        .handle("toolFailures", () => orInternal(fetchToolFailures()))
        .handle("toolFailureDetail", ({ params }) => orInternal(fetchToolFailureDetail(params.label))));
