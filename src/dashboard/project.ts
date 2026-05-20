import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    projectOverviewQuery,
    projectTopSkillsQuery,
    projectTopFailuresQuery,
    projectRecentSessionsQuery,
    projectEpisodesQuery,
} from "../queries/project.ts";
import type {
    ProjectEpisode,
    ProjectFailure,
    ProjectPagePayload,
    ProjectRecentSession,
    ProjectTopSkill,
} from "../lib/shared/dashboard-types.ts";
import { runQuery, runSingleQuery } from "../lib/shared/graph-query.ts";

export const fetchProject = (
    project: string,
): Effect.Effect<ProjectPagePayload | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const params = { project };

        const [overview, top_skills_raw, failures_raw, recent_sessions_raw, top_episodes_raw] =
            yield* Effect.all([
                runSingleQuery(projectOverviewQuery, params),
                runQuery(projectTopSkillsQuery, params),
                runQuery(projectTopFailuresQuery, params),
                runQuery(projectRecentSessionsQuery, params),
                runQuery(projectEpisodesQuery, params),
            ]);

        if (!overview) return null;

        const top_skills: ProjectTopSkill[] = top_skills_raw.filter(
            (x): x is ProjectTopSkill => x !== null,
        );
        const failures: ProjectFailure[] = failures_raw.filter(
            (x): x is ProjectFailure => x !== null,
        );
        const recent_sessions: ProjectRecentSession[] = recent_sessions_raw.filter(
            (x): x is ProjectRecentSession => x !== null,
        );
        const top_episodes: ProjectEpisode[] = top_episodes_raw.filter(
            (x): x is ProjectEpisode => x !== null,
        );

        return {
            project,
            session_count: overview.session_count,
            first_session_at: overview.first_session_at,
            last_session_at: overview.last_session_at,
            sources: overview.sources,
            top_skills,
            failures,
            recent_sessions,
            top_episodes,
        };
    });
