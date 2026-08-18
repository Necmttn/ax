/**
 * Session Detail, read from the published DuckDB snapshot.
 *
 * The Surreal version validated the session id against a regex before splicing
 * it into statement TEXT, and returned an all-empty payload when validation
 * failed. Neither survives: the id is a bound parameter now (see the header of
 * `queries/session-detail-cache.ts`), so a malformed id is simply an id that
 * matches no row - which is what `overview: null` already meant, and what every
 * caller already branches on.
 */
import { Effect } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import {
    sessionAgentDelegationsCacheQuery,
    sessionChildrenCacheQuery,
    sessionOverviewCacheQuery,
    sessionParentCacheQuery,
    sessionTokenUsageCacheQuery,
    sessionToolCallsCacheQuery,
    sessionTopSkillsCacheQuery,
} from "../queries/session-detail-cache.ts";
import { runCacheQuery, runCacheSingleQuery } from "@ax/lib/duckdb/query";
import type { SessionDetailPayload } from "@ax/lib/shared/dashboard-types";

export const fetchSessionDetail = (
    sessionId: string,
): Effect.Effect<SessionDetailPayload, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const params = { sessionId };

        const [overview, top_skills, tool_calls, children, parent, agent_delegations, token_usage] =
            yield* Effect.all([
                runCacheSingleQuery(sessionOverviewCacheQuery, params),
                runCacheQuery(sessionTopSkillsCacheQuery, params),
                runCacheQuery(sessionToolCallsCacheQuery, params),
                runCacheQuery(sessionChildrenCacheQuery, params),
                runCacheSingleQuery(sessionParentCacheQuery, params),
                runCacheQuery(sessionAgentDelegationsCacheQuery, params),
                runCacheSingleQuery(sessionTokenUsageCacheQuery, params),
            ]);

        return {
            overview,
            top_skills,
            tool_calls,
            children,
            parent,
            agent_delegations,
            token_usage,
        };
    });
