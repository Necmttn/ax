/**
 * enriched-session.ts - the single named home for "show one session with
 * metrics + insights".
 *
 * Before this facade, every surface that wanted a session's read model
 * orchestrated the dashboard / metrics / insights layers itself: the CLI
 * `ax sessions show` handler assembled `fetchSessionView` + `fetchSession-
 * DurabilityDetail`; the HTTP `/api/sessions/:id` route called the bare
 * `fetchSessionDetail`. The Enriched Session is that assembled value -
 * session detail (as a full Session View or the bare detail), plus optional
 * durability metrics, plus optional Session Insights - produced by ONE facade
 * so every surface reads the same shape.
 *
 * PERFORMANCE GUARD: `ax sessions` has a history of hang regressions from
 * turn-scans. The facade adds no queries. The `base` option selects exactly
 * one base fetcher (view OR bare detail); metrics/insights run only when their
 * flag is set, otherwise they resolve to `null` with no query. Each caller
 * therefore issues exactly the queries it issued before adopting the facade.
 */

import { Effect } from "effect";
import type { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type {
    SessionDetailPayload,
    SessionInsightsPayload,
    SessionViewPayload,
} from "@ax/lib/shared/dashboard-types";
import { fetchSessionDetail } from "../dashboard/session-detail.ts";
import { fetchSessionInsights } from "../dashboard/session-insights.ts";
import {
    fetchSessionView,
    type FetchSessionViewOptions,
} from "../dashboard/session-view.ts";
import {
    fetchSessionDurabilityDetail,
    type SessionDurabilityDetail,
} from "../metrics/reverted-commits.ts";

/**
 * How the base session-detail facts are fetched. The two surfaces fetch
 * different amounts today; the discriminant makes that explicit instead of
 * leaving it implicit in each call site.
 *
 * - `view`: the richer Session View (base detail + child expansion + by-role
 *   grouping + compactions). Used by `ax sessions show`.
 * - `detail`: the bare Session Detail payload, no expansion / by-role /
 *   compactions. Used by the HTTP `/api/sessions/:id` route, which fetches
 *   strictly less.
 */
export type EnrichedSessionBase =
    | ({ readonly kind: "view" } & Omit<FetchSessionViewOptions, "sessionId">)
    | { readonly kind: "detail" };

export interface EnrichedSessionOptions {
    readonly sessionId: string;
    /** Which base fetcher to use (view vs bare detail). */
    readonly base: EnrichedSessionBase;
    /** Fetch the durability drill-down (#176). Off by default. */
    readonly includeMetrics?: boolean;
    /** Fetch model-derived Session Insights. Off by default. */
    readonly includeInsights?: boolean;
}

/**
 * The assembled Enriched Session read model. Exactly one of `view` / `detail`
 * is populated, matching the requested `base`. `metrics` / `insights` are
 * `null` when their include flag was not set (no query issued).
 */
export interface EnrichedSession {
    /** Populated when `base.kind === "view"`. */
    readonly view: SessionViewPayload | null;
    /** Populated when `base.kind === "detail"`. */
    readonly detail: SessionDetailPayload | null;
    /** Durability drill-down, or `null` when `includeMetrics` was not set. */
    readonly metrics: SessionDurabilityDetail | null;
    /** Session Insights, or `null` when `includeInsights` was not set. */
    readonly insights: SessionInsightsPayload | null;
}

/**
 * Injectable fetchers - lets tests assert which fetchers run for a given
 * options matrix without a live SurrealDB. Production uses the real fetchers.
 */
export interface EnrichedSessionFetchers {
    readonly fetchView: typeof fetchSessionView;
    readonly fetchDetail: typeof fetchSessionDetail;
    readonly fetchMetrics: typeof fetchSessionDurabilityDetail;
    readonly fetchInsights: typeof fetchSessionInsights;
}

const defaultFetchers: EnrichedSessionFetchers = {
    fetchView: fetchSessionView,
    fetchDetail: fetchSessionDetail,
    fetchMetrics: fetchSessionDurabilityDetail,
    fetchInsights: fetchSessionInsights,
};

/**
 * Assemble the Enriched Session for one session id. Composes the existing
 * fetchers; rewrites none of them. The base fetch and the two optional
 * enrichments are independent, so they run concurrently.
 */
export const fetchEnrichedSession: (
    opts: EnrichedSessionOptions,
    fetchers?: EnrichedSessionFetchers,
) => Effect.Effect<EnrichedSession, DbError, SurrealClient> = Effect.fn(
    "queries.fetchEnrichedSession",
)(function* (opts, fetchers = defaultFetchers) {
    const baseEffect: Effect.Effect<
        { view: SessionViewPayload | null; detail: SessionDetailPayload | null },
        DbError,
        SurrealClient
    > = opts.base.kind === "view"
        ? fetchers
            .fetchView({
                sessionId: opts.sessionId,
                expand: opts.base.expand,
                expandAll: opts.base.expandAll,
                ...(opts.base.byRole === undefined ? {} : { byRole: opts.base.byRole }),
            })
            .pipe(Effect.map((view) => ({ view, detail: null })))
        : fetchers
            .fetchDetail(opts.sessionId)
            .pipe(Effect.map((detail) => ({ view: null, detail })));

    const metricsEffect = opts.includeMetrics === true
        ? fetchers.fetchMetrics(opts.sessionId)
        : Effect.succeed(null);

    const insightsEffect = opts.includeInsights === true
        ? fetchers.fetchInsights(opts.sessionId)
        : Effect.succeed(null);

    const [base, metrics, insights] = yield* Effect.all(
        [baseEffect, metricsEffect, insightsEffect],
        { concurrency: 3 },
    );

    return {
        view: base.view,
        detail: base.detail,
        metrics,
        insights,
    };
});
