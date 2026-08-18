/**
 * `--scope=here`, on the DuckDB cache: given what git says about `$PWD`, which
 * `repository` ROW does the cache hold for it?
 *
 * WHY A LOOKUP AND NOT A CONSTRUCTED ID. Surreal keyed the row by the
 * git-derived key (`repository:<repositoryKey>`), so a reader could build the id
 * from git alone and never touch the database for it. DuckDB row ids are
 * content-hashed by the writer (`packages/lib/src/stable-id.ts`), and the git
 * ingest port that mints them is wave 2 - so a reader that CONSTRUCTED an id
 * would be guessing at a recipe that does not exist yet, and would silently
 * scope to nothing the day the recipe changed. Looking the row up by the
 * identity columns the DDL already carries (`remote_url`, `initial_commit`,
 * `root_path`) is stable under any id recipe.
 *
 * The lookups are the same three inputs `chooseIdentity`
 * (`ingest/repository-identity.ts`) ranks, tried in the SAME order, so this
 * agrees with the identity the writer used - and so a stale `root_path` on some
 * other row can never outrank a remote-url match. (The remote term is two
 * statements, not one, because the stored spelling may be either the raw or the
 * normalized URL - see `repositoryLookupQueries`.) Separate statements rather
 * than one OR-ed statement with a ranking `CASE`, because the ranking would have to
 * bind every value twice (positional parameters cannot be reused), and an
 * off-by-one in a doubled bind list is the kind of bug that returns a wrong
 * answer instead of an error. Each is an indexed point lookup on a table with
 * one row per repository, and the first one usually hits.
 *
 * Every value is a BOUND parameter. The Surreal version had to splice the
 * repository key into the statement text as a record literal (bindings cannot
 * carry record ids), which the port deletes along with its injection surface.
 */
import { Effect, Option, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import type { DuckDbParam } from "@ax/lib/duckdb";
import type { PwdIdentity } from "../pwd.ts";
import type { Clause } from "@ax/lib/duckdb/clause";

export const RepositoryIdRow = Schema.Struct({ id: Schema.String });

const lookupOn = (column: string, value: DuckDbParam): Clause => ({
    sql: `SELECT id FROM repository WHERE ${column} = ? LIMIT 1`,
    params: [value],
});

/**
 * The statements that find the cached `repository` row for a git identity, in
 * strongest-identity-first order. A term the identity has no value for is
 * omitted rather than bound as NULL (`col = NULL` matches nothing, so binding it
 * would be a wasted round trip that reads like a real lookup).
 *
 * BOTH SPELLINGS OF THE REMOTE ARE TRIED, normalized first, and both before the
 * commit fallback. `chooseIdentity` ranks on the NORMALIZED remote, but the git
 * ingest stage persists `repository.remote_url` RAW
 * (`ingest/git.ts` writes `repo.remoteUrl`), and `normalizeGitRemoteUrl` is
 * lossy - "git@github.com:Necmttn/ax.git" and "github.com/necmttn/ax" are the
 * same repository under two spellings, and neither equals the other in SQL. A
 * lookup that bound only the normalized form therefore matched nothing on a
 * real cache and fell through to `initial_commit` - which is precisely the term
 * that CANNOT separate a fork from its upstream, since a fork shares the root
 * commit. So `--scope=here` in a fork could silently scope to the upstream's
 * row. Trying both spellings costs one extra indexed point lookup in the miss
 * case and keeps the remote - the only term that distinguishes forks - ahead of
 * the commit, whichever spelling the writer stored.
 *
 * `root_path` matches on the PRIMARY checkout root (`mainRepoRoot`), not on
 * `cwd` or on a linked worktree's root: that is what the git ingest persists, so
 * a query run from inside a worktree still finds the one repository row.
 */
export const repositoryLookupQueries = (who: PwdIdentity): ReadonlyArray<Clause> => {
    const queries: Clause[] = [];
    const remotes = new Set<string>();
    for (const remote of [who.remoteUrlNormalized, who.remoteUrl]) {
        // A repo whose remote already reads in normalized form yields one term,
        // not the same statement twice.
        if (remote !== null && remote.length > 0) remotes.add(remote);
    }
    for (const remote of remotes) queries.push(lookupOn("remote_url", remote));
    if (who.initialCommit !== null && who.initialCommit.length > 0) {
        queries.push(lookupOn("initial_commit", who.initialCommit));
    }
    queries.push(lookupOn("root_path", who.mainRepoRoot));
    return queries;
};

/**
 * The cached `repository` row id for a git identity, or `none` when the cache
 * has never seen this repository (nothing has been ingested for it yet, or the
 * git stage has not run). `none` is not an error: a caller scoping to "here"
 * then honestly has zero rows to find, which is what `--scope=all` exists for.
 */
export const resolveCacheRepository = (
    who: PwdIdentity,
): Effect.Effect<Option.Option<string>, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        for (const clause of repositoryLookupQueries(who)) {
            const found = yield* cache.first(RepositoryIdRow, clause.sql, clause.params);
            if (Option.isSome(found)) return Option.some(found.value.id);
        }
        return Option.none<string>();
    });
