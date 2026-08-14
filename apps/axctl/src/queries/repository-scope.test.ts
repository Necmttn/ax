/**
 * The DuckDB repository lookup `--scope=here` runs on, against a REAL cache.
 *
 * This is the piece that let `ax recall` off the SurrealDB runtime: default
 * scope resolution used to end in `resolvePwdRepository`, whose last step is a
 * `SELECT ... FROM repository:<key>` through `SurrealClient` - so a command
 * routed without `AppLayer` died there, and a machine with no SurrealDB at all
 * could not run recall.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import type { RepositoryIdentityKind } from "../ingest/repository-identity.ts";
import type { PwdIdentity } from "../pwd.ts";
import { publishCacheFixture, readFixture, runWithPlatform } from "../testing/cache-fixture.ts";
import { repositoryLookupQueries, resolveCacheRepository } from "./repository-scope.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("repository scope");

const identity = (
    over: Partial<Omit<PwdIdentity, "identity">> & { readonly kind?: RepositoryIdentityKind } = {},
): PwdIdentity => ({
    cwd: "/w/ax",
    repoRoot: "/w/ax",
    mainRepoRoot: "/w/ax",
    remoteUrl: "git@github.com:Necmttn/ax.git",
    remoteUrlNormalized: "github.com/necmttn/ax",
    initialCommit: "abc123",
    ...over,
    identity: { kind: over.kind ?? "remote", repositoryKey: "github_com_necmttn_ax" },
});

/** Two repositories, one of which matches the identity above three ways over. */
const REPOSITORIES = (w: CacheWriteService) =>
    w.putMany("repository", [
        {
            id: "repo-row-ax",
            name: "ax",
            remote_url: "github.com/necmttn/ax",
            root_path: "/w/ax",
            initial_commit: "abc123",
        },
        {
            id: "repo-row-other",
            name: "other",
            remote_url: "github.com/necmttn/other",
            root_path: "/w/other",
            initial_commit: "def456",
        },
    ]);

const lookup = (who: PwdIdentity, snapshotPath: string) =>
    runWithPlatform(
        resolveCacheRepository(who).pipe(Effect.provide(readFixture(snapshotPath, dylibPath))),
    );

describe("repositoryLookupQueries", () => {
    test("tries the identity terms in chooseIdentity's own order, all bound", () => {
        const queries = repositoryLookupQueries(identity());

        expect(queries.map((q) => q.sql)).toEqual([
            "SELECT id FROM repository WHERE remote_url = ? LIMIT 1",
            "SELECT id FROM repository WHERE remote_url = ? LIMIT 1",
            "SELECT id FROM repository WHERE initial_commit = ? LIMIT 1",
            "SELECT id FROM repository WHERE root_path = ? LIMIT 1",
        ]);
        expect(queries.map((q) => q.params)).toEqual([
            ["github.com/necmttn/ax"],
            ["git@github.com:Necmttn/ax.git"],
            ["abc123"],
            ["/w/ax"],
        ]);
        // No value is ever spliced into the statement text.
        for (const q of queries) expect(q.sql).not.toContain("'");
    });

    test("both remote spellings are tried BEFORE the initial-commit fallback", () => {
        // `ingest/git.ts` persists the RAW remote while `chooseIdentity` ranks
        // the normalized one, so the raw spelling has to be a remote term and
        // not an afterthought: a fork shares its upstream's root commit, so a
        // lookup that reached `initial_commit` with the remote unmatched could
        // select the UPSTREAM's row for a fork's `--scope=here`.
        const columnOf = (sql: string) => sql.split("WHERE ")[1]?.split(" =")[0];
        const columns = repositoryLookupQueries(identity()).map((q) => columnOf(q.sql));

        expect(columns).toEqual(["remote_url", "remote_url", "initial_commit", "root_path"]);
    });

    test("a remote that is already normalized yields ONE term, not the same statement twice", () => {
        const queries = repositoryLookupQueries(
            identity({ remoteUrl: "github.com/necmttn/ax" }),
        );

        expect(queries.map((q) => q.params)).toEqual([
            ["github.com/necmttn/ax"],
            ["abc123"],
            ["/w/ax"],
        ]);
    });

    test("omits the terms the git identity has no value for", () => {
        const queries = repositoryLookupQueries(
            identity({ remoteUrl: null, remoteUrlNormalized: null, initialCommit: null }),
        );

        // `col = NULL` matches nothing, so a bound-NULL term would be a wasted
        // round trip that reads like a real lookup.
        expect(queries).toHaveLength(1);
        expect(queries[0]?.sql).toContain("root_path");
        expect(queries[0]?.params).toEqual(["/w/ax"]);
    });
});

describe("resolveCacheRepository", () => {
    dtest("finds the repository row by remote url and returns its ROW id", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-remote-"), dylibPath, REPOSITORIES),
        );
        const found = await lookup(identity(), fixture.snapshotPath);

        // The ROW id, not the git-derived key: the row id is what
        // `session.repository` / `commit.repository` actually hold.
        expect(Option.getOrNull(found)).toBe("repo-row-ax");
    });

    dtest("falls back to the initial commit when there is no remote", async () => {
        // The row matches ONLY on initial_commit - its root_path is elsewhere, so
        // a resolver that quietly relied on the path term would find nothing.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-initial-"), dylibPath, (w) =>
                w.put("repository", {
                    id: "repo-row-by-commit",
                    name: "ax",
                    initial_commit: "abc123",
                    root_path: "/somewhere/else",
                }),
            ),
        );
        const found = await lookup(
            identity({ remoteUrl: null, remoteUrlNormalized: null, kind: "initial_commit" }),
            fixture.snapshotPath,
        );

        expect(Option.getOrNull(found)).toBe("repo-row-by-commit");
    });

    dtest("falls back to the checkout root when there is neither", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-root-"), dylibPath, (w) =>
                w.put("repository", { id: "repo-row-by-path", name: "ax", root_path: "/w/ax" }),
            ),
        );
        const found = await lookup(
            identity({
                remoteUrl: null,
                remoteUrlNormalized: null,
                initialCommit: null,
                kind: "local_path_hash",
            }),
            fixture.snapshotPath,
        );

        expect(Option.getOrNull(found)).toBe("repo-row-by-path");
    });

    dtest("a remote-url match outranks another row that only shares the checkout root", async () => {
        // The shape a stale row leaves behind: some other repository row whose
        // persisted root_path still points at this checkout. The strongest
        // identity term has to win, or `--scope=here` silently scopes to the
        // wrong repository.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-rank-"), dylibPath, (w) =>
                w.putMany("repository", [
                    { id: "repo-row-stale", name: "stale", remote_url: null, root_path: "/w/ax" },
                    {
                        id: "repo-row-ax",
                        name: "ax",
                        remote_url: "github.com/necmttn/ax",
                        root_path: null,
                    },
                ]),
            ),
        );
        const found = await lookup(identity(), fixture.snapshotPath);

        expect(Option.getOrNull(found)).toBe("repo-row-ax");
    });

    dtest("finds the row when the cache stored the RAW remote url", async () => {
        // What `ingest/git.ts` actually persists is `repo.remoteUrl` - the raw
        // spelling git reports - while `chooseIdentity` ranks the normalized
        // one. A reader that bound only the normalized form matched nothing
        // here and fell through to the weaker terms.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-raw-"), dylibPath, (w) =>
                w.put("repository", {
                    id: "repo-row-raw",
                    name: "ax",
                    remote_url: "git@github.com:Necmttn/ax.git",
                    root_path: "/somewhere/else",
                    initial_commit: null,
                }),
            ),
        );
        const found = await lookup(identity(), fixture.snapshotPath);

        expect(Option.getOrNull(found)).toBe("repo-row-raw");
    });

    dtest("a fork does not resolve to its upstream through the shared root commit", async () => {
        // A fork shares its upstream's root commit, so `initial_commit` cannot
        // separate them - the remote is the only term that can. With the raw
        // spelling stored, a normalized-only lookup missed the remote, reached
        // the commit, and scoped `--scope=here` to the UPSTREAM's row.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-fork-"), dylibPath, (w) =>
                w.putMany("repository", [
                    {
                        id: "repo-row-upstream",
                        name: "ax",
                        remote_url: "git@github.com:upstream/ax.git",
                        root_path: "/w/upstream-ax",
                        initial_commit: "abc123",
                    },
                    {
                        id: "repo-row-fork",
                        name: "ax",
                        remote_url: "git@github.com:Necmttn/ax.git",
                        root_path: "/w/ax",
                        initial_commit: "abc123",
                    },
                ]),
            ),
        );
        const found = await lookup(identity(), fixture.snapshotPath);

        expect(Option.getOrNull(found)).toBe("repo-row-fork");
    });

    dtest("a repository the cache has never seen is none, not a wrong row", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-miss-"), dylibPath, REPOSITORIES),
        );
        const found = await lookup(
            identity({
                cwd: "/w/nope",
                repoRoot: "/w/nope",
                mainRepoRoot: "/w/nope",
                remoteUrl: "git@github.com:Necmttn/nope.git",
                remoteUrlNormalized: "github.com/necmttn/nope",
                initialCommit: "999999",
            }),
            fixture.snapshotPath,
        );

        expect(Option.isNone(found)).toBe(true);
    });

    dtest("an empty repository table is none", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-empty-"), dylibPath, () => Effect.void),
        );
        const found = await lookup(identity(), fixture.snapshotPath);
        expect(Option.isNone(found)).toBe(true);
    });
});
