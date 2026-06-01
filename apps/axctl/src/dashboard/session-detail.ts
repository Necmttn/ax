import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    sessionAgentDelegationsQuery,
    sessionChildrenQuery,
    sessionOverviewQuery,
    sessionParentQuery,
    sessionTokenUsageQuery,
    sessionToolCallsQuery,
    sessionTopSkillsQuery,
} from "../queries/session-detail.ts";
import type {
    SessionAgentDelegation,
    SessionDetailPayload,
    SessionLink,
    SessionOverview,
    SessionToolCall,
    SessionTopSkill,
} from "@ax/lib/shared/dashboard-types";
import { runQuery, runSingleQuery } from "@ax/lib/shared/graph-query";

// Accepts both real UUIDs ("019e0ad4-c977-...") and our synthetic prefixed
// ids ("claude-subagent-a41ef01d6ca8d521c"). Restrict the charset to the
// set SurrealDB uses for unquoted record ids so we don't accidentally
// interpolate something that needs escaping.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

export const fetchSessionDetail = (
    sessionId: string,
): Effect.Effect<SessionDetailPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        // Parse and validate so we can safely inline the record id. SurrealDB
        // binding via { sessionId: new RecordId(...) } silently produced empty
        // results, so we go direct - but only after UUID validation.
        const uuid = sessionId
            .replace(/^session:⟨/, "")
            .replace(/⟩$/, "")
            .replace(/^session:/, "");
        if (!SESSION_ID_RE.test(uuid)) {
            return {
                overview: null,
                top_skills: [],
                tool_calls: [],
                children: [],
                parent: null,
                agent_delegations: [],
                token_usage: null,
            };
        }
        const recordRef = `session:⟨${uuid}⟩`;
        const params = { recordRef };

        const [overview, top_skills_raw, tool_calls_raw, children_raw, parent_raw, agent_delegations_raw, token_usage] =
            yield* Effect.all([
                runSingleQuery(sessionOverviewQuery, params),
                runQuery(sessionTopSkillsQuery, params),
                runQuery(sessionToolCallsQuery, params),
                runQuery(sessionChildrenQuery, params),
                runSingleQuery(sessionParentQuery, params),
                runQuery(sessionAgentDelegationsQuery, params),
                runSingleQuery(sessionTokenUsageQuery, params),
            ]);

        const top_skills = top_skills_raw.filter((s): s is SessionTopSkill => s !== null);
        const tool_calls = tool_calls_raw.filter((t): t is SessionToolCall => t !== null);
        const children = children_raw.filter((l): l is SessionLink => l !== null);
        const parent = parent_raw as SessionLink | null;
        const agent_delegations = agent_delegations_raw.filter(
            (d): d is SessionAgentDelegation => d !== null,
        );

        return {
            overview: overview as SessionOverview | null,
            top_skills,
            tool_calls,
            children,
            parent,
            agent_delegations,
            token_usage: token_usage as SessionDetailPayload["token_usage"],
        };
    });
