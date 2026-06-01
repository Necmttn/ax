import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    RECALL_COUNT_SQL,
    RECALL_COMMITS_COUNT_SQL,
    RECALL_SKILLS_COUNT_SQL,
    RECALL_SESSIONS_FOR_SKILL_SQL,
    recallTurnsQuery,
    recallCommitsQuery,
    recallSkillsQuery,
} from "../queries/recall.ts";
import type {
    RecallHit,
    RecallCommitHit,
    RecallSkillHit,
    RecallResponse,
} from "@ax/lib/shared/dashboard-types";
import { clampPagination, type PaginationConfig } from "@ax/lib/shared/pagination";
import { isRecord, recordIdString } from "@ax/lib/shared/row-fields";
import { runQuery } from "@ax/lib/shared/graph-query";
import { recordLiteral } from "@ax/lib/ids";

const RECALL_PAGINATION: PaginationConfig = { defaultLimit: 50, maxLimit: 200 };

export type RecallSource = "turn" | "commit" | "skill";

export type RecallScope =
    | {
        readonly kind: "here";
        /**
         * Bare repository key (suitable for `recordLiteral("repository", key)`).
         * E.g. `remote__github_com_foo_bar__<hash>` - NOT the full record id string.
         */
        readonly repositoryKey: string;
      }
    | { readonly kind: "all" }
    | null;

export interface RecallParams {
    readonly q: string;
    readonly project?: string | null;
    readonly skill?: string | null;
    readonly since?: string | null;
    readonly offset?: number;
    readonly limit?: number;
    /** Which sources to search. Defaults to ["turn"] for back-compat. */
    readonly sources?: ReadonlyArray<RecallSource>;
    /** Repository scope. null / omitted = all. */
    readonly scope?: RecallScope;
}

const EMPTY_RESPONSE = (
    q: string,
    offset: number,
    limit: number,
): RecallResponse => ({
    q,
    hits: [],
    commits: [],
    skills: [],
    truncated: false,
    total_count: 0,
    total_counts: { turn: 0, commit: 0, skill: 0 },
    window: { offset, limit },
});

export const fetchRecall = (
    params: RecallParams,
): Effect.Effect<RecallResponse, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const q = params.q.trim().toLowerCase();
        const { offset, limit } = clampPagination(
            { offset: params.offset, limit: params.limit },
            RECALL_PAGINATION,
        );

        const sources: ReadonlyArray<RecallSource> =
            params.sources && params.sources.length > 0
                ? params.sources
                : ["turn"];

        if (!q) {
            return EMPTY_RESPONSE(params.q, offset, limit);
        }

        // ---------------------------------------------------------------------------
        // Turn source
        // ---------------------------------------------------------------------------

        const fetchTurns = (): Effect.Effect<
            { hits: RecallHit[]; total_count: number },
            DbError,
            SurrealClient
        > =>
            Effect.gen(function* () {
                // Optional skill filter: materialise sessions first.
                let sessionFilterClause = "";
                if (params.skill && params.skill.trim()) {
                    const skillRows = yield* db.query<[Array<Record<string, unknown>>]>(
                        RECALL_SESSIONS_FOR_SKILL_SQL,
                        { skill: params.skill.trim() },
                    );
                    const ids: string[] = [];
                    const sessions = skillRows?.[0]?.[0]?.sessions;
                    if (Array.isArray(sessions)) {
                        for (const v of sessions) {
                            const id = recordIdString(v);
                            if (id) ids.push(id);
                        }
                    }
                    if (ids.length === 0) {
                        return { hits: [], total_count: 0 };
                    }
                    sessionFilterClause = `AND session IN [${ids.join(", ")}]`;
                }

                // Repository scope filter on turns: filter by session.repository.
                // Record-typed fields require record literals, not bindings.
                if (params.scope?.kind === "here") {
                    const repoClause = `AND session.repository = ${recordLiteral("repository", params.scope.repositoryKey)}`;
                    sessionFilterClause = sessionFilterClause
                        ? `${sessionFilterClause} ${repoClause}`
                        : repoClause;
                }

                const baseBindings: Record<string, unknown> = {
                    q,
                    project: params.project?.trim() || null,
                    since: params.since?.trim() || null,
                };

                const [mapped, countRows] = yield* Effect.all(
                    [
                        runQuery(recallTurnsQuery, {
                            q,
                            project: baseBindings.project as string | null,
                            since: baseBindings.since as string | null,
                            offset,
                            limit,
                            sessionFilterClause,
                        }),
                        db.query<[Array<Record<string, unknown>>]>(
                            RECALL_COUNT_SQL(sessionFilterClause),
                            baseBindings,
                        ),
                    ],
                    { concurrency: "unbounded" },
                );

                const hits: RecallHit[] = mapped.filter(
                    (h): h is RecallHit => h !== null,
                );

                const countRow = countRows?.[0]?.[0];
                const totalFromCount = isRecord(countRow)
                    ? Number(countRow.total ?? 0)
                    : 0;
                const total_count = Math.max(
                    Number.isFinite(totalFromCount) ? Math.trunc(totalFromCount) : 0,
                    hits.length + offset,
                );

                return { hits, total_count };
            });

        // ---------------------------------------------------------------------------
        // Commit source
        // ---------------------------------------------------------------------------

        const fetchCommits = (): Effect.Effect<
            { commits: RecallCommitHit[]; total_count: number },
            DbError,
            SurrealClient
        > =>
            Effect.gen(function* () {
                // Record-typed fields require record literals, not bindings, for correct comparison.
                const scopeClause = params.scope?.kind === "here"
                    ? `AND repository = ${recordLiteral("repository", params.scope.repositoryKey)}`
                    : "";

                const [mapped, countRows] = yield* Effect.all(
                    [
                        runQuery(recallCommitsQuery, {
                            q,
                            limit,
                            scopeClause,
                            repository: null,
                        }),
                        db.query<[Array<Record<string, unknown>>]>(
                            RECALL_COMMITS_COUNT_SQL(scopeClause),
                            { q, limit },
                        ),
                    ],
                    { concurrency: "unbounded" },
                );

                const commits: RecallCommitHit[] = mapped.filter(
                    (h): h is RecallCommitHit => h !== null,
                );

                const countRow = countRows?.[0]?.[0];
                const totalFromCount = isRecord(countRow)
                    ? Number(countRow.total ?? 0)
                    : 0;
                const total_count = Math.max(
                    Number.isFinite(totalFromCount) ? Math.trunc(totalFromCount) : 0,
                    commits.length,
                );

                return { commits, total_count };
            });

        // ---------------------------------------------------------------------------
        // Skill source
        // ---------------------------------------------------------------------------

        const fetchSkills = (): Effect.Effect<
            { skills: RecallSkillHit[]; total_count: number },
            DbError,
            SurrealClient
        > =>
            Effect.gen(function* () {
                const [mapped, countRows] = yield* Effect.all(
                    [
                        runQuery(recallSkillsQuery, { q, limit }),
                        db.query<[Array<Record<string, unknown>>]>(
                            RECALL_SKILLS_COUNT_SQL,
                            { q },
                        ),
                    ],
                    { concurrency: "unbounded" },
                );

                const skills: RecallSkillHit[] = mapped.filter(
                    (h): h is RecallSkillHit => h !== null,
                );

                const countRow = countRows?.[0]?.[0];
                const totalFromCount = isRecord(countRow)
                    ? Number(countRow.total ?? 0)
                    : 0;
                const total_count = Math.max(
                    Number.isFinite(totalFromCount) ? Math.trunc(totalFromCount) : 0,
                    skills.length,
                );

                return { skills, total_count };
            });

        // ---------------------------------------------------------------------------
        // Fan-out: run requested sources in parallel
        // ---------------------------------------------------------------------------

        const wantTurn = sources.includes("turn");
        const wantCommit = sources.includes("commit");
        const wantSkill = sources.includes("skill");

        const [turnsResult, commitsResult, skillsResult] = yield* Effect.all(
            [
                wantTurn
                    ? fetchTurns()
                    : Effect.succeed({ hits: [] as RecallHit[], total_count: 0 }),
                wantCommit
                    ? fetchCommits()
                    : Effect.succeed({ commits: [] as RecallCommitHit[], total_count: 0 }),
                wantSkill
                    ? fetchSkills()
                    : Effect.succeed({ skills: [] as RecallSkillHit[], total_count: 0 }),
            ],
            { concurrency: "unbounded" },
        );

        const totalCounts = {
            turn: turnsResult.total_count,
            commit: commitsResult.total_count,
            skill: skillsResult.total_count,
        };
        const total_count = totalCounts.turn + totalCounts.commit + totalCounts.skill;

        // truncated: turns have more pages OR commit/skill result set hit the limit cap
        const turnsTruncated = offset + turnsResult.hits.length < totalCounts.turn;
        const commitsTruncated = wantCommit && commitsResult.commits.length === limit;
        const skillsTruncated = wantSkill && skillsResult.skills.length === limit;
        const truncated = turnsTruncated || commitsTruncated || skillsTruncated;

        return {
            q: params.q,
            hits: turnsResult.hits,
            commits: commitsResult.commits,
            skills: skillsResult.skills,
            truncated,
            total_count,
            total_counts: totalCounts,
            window: { offset, limit },
        };
    });
