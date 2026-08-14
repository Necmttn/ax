import { Effect } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import {
    CommitHitRow,
    CountRow,
    SessionIdRow,
    SkillHitRow,
    TurnHitRow,
    commitCountQuery,
    commitPageQuery,
    sessionsForContentTypesQuery,
    sessionsForSkillQuery,
    skillCountQuery,
    skillPageQuery,
    truncate,
    turnCountQuery,
    turnPageQuery,
    type TurnFilters,
} from "../queries/recall.ts";
import type {
    RecallHit,
    RecallCommitHit,
    RecallSkillHit,
    RecallResponse,
} from "@ax/lib/shared/dashboard-types";
import { clampPagination, type PaginationConfig } from "@ax/lib/shared/pagination";

const RECALL_PAGINATION: PaginationConfig = { defaultLimit: 50, maxLimit: 200 };

export type RecallSource = "turn" | "commit" | "skill";

export type RecallScope =
    | {
        readonly kind: "here";
        /**
         * The repository's row id. In v2 this is a plain string bound as a
         * parameter - the Surreal version had to splice it into the SQL as a
         * record literal, because Surreal bindings could not carry record ids.
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
    /**
     * Restrict turns to sessions whose tool outputs include at least one of
     * these content-type categories. Prefiltered via the has_content edge
     * (deref-free: session is denormalized on the edge). null / omitted = all.
     */
    readonly types?: ReadonlyArray<string> | null;
}

/**
 * The source set `fetchRecall` searches when none is requested. Exported so the
 * CLI flag parser and the MCP zod handler use the same default when they build
 * the `next` links (`requestedSources`) instead of re-spelling `["turn"]`.
 */
export const RECALL_DEFAULT_SOURCES: ReadonlyArray<RecallSource> = ["turn"];

/**
 * Resolve the effective source set for a recall request: a non-empty requested
 * set, else {@link RECALL_DEFAULT_SOURCES}. This is the single semantic the
 * query, the CLI, and the MCP tool share - `fetchRecall` applies the same rule
 * internally for the actual fan-out.
 */
export const resolveRecallSources = (
    requested: ReadonlyArray<RecallSource> | null | undefined,
): ReadonlyArray<RecallSource> =>
    requested && requested.length > 0 ? requested : RECALL_DEFAULT_SOURCES;

/**
 * Default offset/limit the recall transports fill when a caller omits them.
 * `RECALL_DEFAULT_LIMIT` is derived from {@link RECALL_PAGINATION} so the
 * presence-default and the clamp default cannot drift.
 */
export const RECALL_DEFAULT_OFFSET = 0;
export const RECALL_DEFAULT_LIMIT = RECALL_PAGINATION.defaultLimit;

/** Whether a recall query is effectively empty (the no-DB fast path predicate). */
export const isEmptyRecallQuery = (q: string): boolean => q.trim().length === 0;

/**
 * The raw arguments a transport (CLI / HTTP / MCP) hands to recall, before the
 * shared semantics are applied. Every field is optional/nullable because each
 * transport carries a different subset (HTTP has no sources/scope, MCP no
 * scope); the genuine surface differences are documented in the contract test.
 */
export interface RecallQueryArgs {
    readonly q?: string | null;
    readonly project?: string | null;
    readonly skill?: string | null;
    readonly since?: string | null;
    readonly offset?: number | null;
    readonly limit?: number | null;
    readonly sources?: ReadonlyArray<RecallSource> | null;
    readonly scope?: RecallScope;
    readonly types?: ReadonlyArray<string> | null;
}

/**
 * The single home for recall argument semantics - the Query Input Contract seam
 * every transport delegates to (CONTEXT.md "Query Input Contract"). Pure: it
 * fills presence defaults only and leaves all downstream behaviour to
 * `fetchRecall`. Specifically it:
 *   - echoes RAW `q` (no trim/lowercase - `fetchRecall` lowercases internally
 *     only for matching and echoes `params.q` verbatim);
 *   - passes `sources` through UNRESOLVED (`fetchRecall` + `buildRecallNext`
 *     both call `resolveRecallSources`; pre-resolving would double-apply);
 *   - fills offset/limit PRESENCE defaults only - NO clamp (`fetchRecall` owns
 *     `clampPagination` with `RECALL_PAGINATION`, max 200);
 *   - passes project/skill/since/scope through (`fetchRecall` trims them).
 */
export const normalizeRecallParams = (args: RecallQueryArgs): RecallParams => ({
    q: args.q ?? "",
    project: args.project ?? null,
    skill: args.skill ?? null,
    since: args.since ?? null,
    offset: args.offset ?? RECALL_DEFAULT_OFFSET,
    limit: args.limit ?? RECALL_DEFAULT_LIMIT,
    ...(args.sources != null ? { sources: args.sources } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.types != null ? { types: args.types } : {}),
});

export const emptyRecallResponse = (
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
): Effect.Effect<RecallResponse, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const q = params.q.trim().toLowerCase();
        const { offset, limit } = clampPagination(
            { offset: params.offset, limit: params.limit },
            RECALL_PAGINATION,
        );

        const sources = resolveRecallSources(params.sources);

        if (!q) {
            return emptyRecallResponse(params.q, offset, limit);
        }

        /** `count(*)` comes back as a DuckDB BIGINT, i.e. a JS bigint. */
        const countOf = (clause: { readonly sql: string; readonly params: ReadonlyArray<unknown> }) =>
            Effect.map(
                cache.rows(CountRow, clause.sql, clause.params as ReadonlyArray<never>),
                (rows) => Number(rows[0]?.total ?? 0n),
            );

        /** Session ids a prefilter narrowed to. `null` means "no prefilter". */
        const sessionIdsFor = (
            clause: { readonly sql: string; readonly params: ReadonlyArray<unknown> } | null,
        ): Effect.Effect<ReadonlyArray<string> | null, CacheReadError, CacheRead> =>
            clause === null
                ? Effect.succeed(null)
                : Effect.map(
                      cache.rows(SessionIdRow, clause.sql, clause.params as ReadonlyArray<never>),
                      (rows) => rows.map((r) => r.session_id),
                  );

        // ---------------------------------------------------------------------
        // Turn source
        // ---------------------------------------------------------------------

        const fetchTurns = (): Effect.Effect<
            { hits: RecallHit[]; total_count: number },
            CacheReadError,
            CacheRead
        > =>
            Effect.gen(function* () {
                const skill = params.skill?.trim();
                const wantTypes = params.types && params.types.length > 0 ? params.types : null;

                // Two independent session prefilters. Each narrows the set; an
                // EMPTY result from either means no turn can match, so recall
                // short-circuits without running the (much more expensive) FTS
                // query at all.
                const [bySkill, byType] = yield* Effect.all(
                    [
                        sessionIdsFor(skill ? sessionsForSkillQuery(skill) : null),
                        sessionIdsFor(wantTypes ? sessionsForContentTypesQuery(wantTypes) : null),
                    ],
                    { concurrency: "unbounded" },
                );

                let sessionIds: ReadonlyArray<string> | null = null;
                for (const set of [bySkill, byType]) {
                    if (set === null) continue;
                    if (set.length === 0) return { hits: [], total_count: 0 };
                    sessionIds =
                        sessionIds === null ? set : sessionIds.filter((id) => set.includes(id));
                    if (sessionIds.length === 0) return { hits: [], total_count: 0 };
                }

                const filters: TurnFilters = {
                    q,
                    project: params.project?.trim() || null,
                    since: params.since?.trim() || null,
                    sessionIds,
                    repositoryId: params.scope?.kind === "here" ? params.scope.repositoryKey : null,
                };

                const page = turnPageQuery(filters, offset, limit);
                const [rows, totalFromCount] = yield* Effect.all(
                    [
                        cache.rows(TurnHitRow, page.sql, page.params),
                        countOf(turnCountQuery(filters)),
                    ],
                    { concurrency: "unbounded" },
                );

                const hits: RecallHit[] = rows.map((row) => ({
                    turn_id: row.turn_id,
                    session_id: row.session_id,
                    project: row.project,
                    source: row.source,
                    cwd: row.cwd,
                    role: row.role,
                    // The API contract carries timestamps as ISO strings. The
                    // seam decodes a TIMESTAMP column to a Date (UTC, ms grain),
                    // so this is the one place the two meet.
                    ts: row.ts.toISOString(),
                    snippet: truncate(row.text_excerpt ?? ""),
                }));

                // Defensive floor, carried over: a count-query hiccup must never
                // report fewer results than were actually paged back.
                return { hits, total_count: Math.max(totalFromCount, hits.length + offset) };
            });

        // ---------------------------------------------------------------------
        // Commit source
        // ---------------------------------------------------------------------

        const fetchCommits = (): Effect.Effect<
            { commits: RecallCommitHit[]; total_count: number },
            CacheReadError,
            CacheRead
        > =>
            Effect.gen(function* () {
                const repositoryId = params.scope?.kind === "here" ? params.scope.repositoryKey : null;
                const page = commitPageQuery(q, repositoryId, limit);

                const [rows, totalFromCount] = yield* Effect.all(
                    [
                        cache.rows(CommitHitRow, page.sql, page.params),
                        countOf(commitCountQuery(q, repositoryId)),
                    ],
                    { concurrency: "unbounded" },
                );

                const commits: RecallCommitHit[] = rows.map((row) => ({
                    commit_id: row.commit_id,
                    sha: row.sha,
                    repo: row.repo,
                    repository: row.repository,
                    ts: row.ts.toISOString(),
                    // No `search::highlight` equivalent in DuckDB: the snippet is
                    // the message itself, truncated - the same thing the turn
                    // source always did.
                    snippet: truncate(row.message ?? row.sha),
                    score: row.score,
                }));

                return { commits, total_count: Math.max(totalFromCount, commits.length) };
            });

        // ---------------------------------------------------------------------
        // Skill source
        // ---------------------------------------------------------------------

        const fetchSkills = (): Effect.Effect<
            { skills: RecallSkillHit[]; total_count: number },
            CacheReadError,
            CacheRead
        > =>
            Effect.gen(function* () {
                const page = skillPageQuery(q, limit);
                const [rows, totalFromCount] = yield* Effect.all(
                    [
                        cache.rows(SkillHitRow, page.sql, page.params),
                        countOf(skillCountQuery(q)),
                    ],
                    { concurrency: "unbounded" },
                );

                const skills: RecallSkillHit[] = rows.map((row) => ({
                    skill_id: row.skill_id,
                    name: row.name,
                    description: row.description,
                    snippet: truncate(row.description ?? row.name),
                    score: row.score,
                }));

                return { skills, total_count: Math.max(totalFromCount, skills.length) };
            });

        // ---------------------------------------------------------------------
        // Fan-out: run requested sources in parallel
        // ---------------------------------------------------------------------

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
