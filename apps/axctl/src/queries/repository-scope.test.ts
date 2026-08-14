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
            "SELECT id FROM repository WHERE initial_commit = ? LIMIT 1",
            "SELECT id FROM repository WHERE root_path = ? LIMIT 1",
        ]);
        expect(queries.map((q) => q.params)).toEqual([
            ["github.com/necmttn/ax"],
            ["abc123"],
            ["/w/ax"],
        ]);
        // No value is ever spliced into the statement text.
        for (const q of queries) expect(q.sql).not.toContain("'");
    });

    test("omits the terms the git identity has no value for", () => {
        const queries = repositoryLookupQueries(
            identity({ remoteUrlNormalized: null, initialCommit: null }),
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
            identity({ remoteUrlNormalized: null, kind: "initial_commit" }),
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
            identity({ remoteUrlNormalized: null, initialCommit: null, kind: "local_path_hash" }),
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

    dtest("a repository the cache has never seen is none, not a wrong row", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-repo-scope-miss-"), dylibPath, REPOSITORIES),
        );
        const found = await lookup(
            identity({
                cwd: "/w/nope",
                repoRoot: "/w/nope",
                mainRepoRoot: "/w/nope",
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
