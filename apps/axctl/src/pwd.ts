/**
 * pwd.ts - resolve $PWD → git repo root → repository record identity.
 *
 * Read-only: this module NEVER upserts. Repository creation is the git ingest
 * stage's responsibility. This is purely a "given a directory, what repository
 * record does it correspond to?" resolver.
 */
import { Effect, FileSystem, Option, Schema } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient } from "@ax/lib/db";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import type { DbError } from "@ax/lib/errors";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { ProcessService, type ProcessError } from "@ax/lib/process";
import {
    chooseIdentity,
    normalizeGitRemoteUrl,
    type RepositoryIdentity,
} from "./ingest/repository-identity.ts";
import { resolveCacheRepository } from "./queries/repository-scope.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NotAGitRepoError extends Schema.TaggedErrorClass<NotAGitRepoError>(
    "NotAGitRepoError",
)("NotAGitRepoError", {
    cwd: Schema.String,
    message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What `$PWD` resolves to using GIT ALONE - no database of any kind.
 *
 * Split out of {@link PwdResolution} because the git half is the part every
 * engine needs and the only part the v2 DuckDB readers can use: `existsInDb`
 * below is a SurrealDB lookup, and a command routed without `AppLayer` (see the
 * `"cache"` command runtime) has no `SurrealClient` to make it with. The
 * DuckDB-side equivalent lives in `queries/repository-scope.ts`, over `CacheRead`.
 */
export interface PwdIdentity {
    /** Absolute path after symlink resolve. */
    readonly cwd: string;
    /** Result of `git rev-parse --show-toplevel`. */
    readonly repoRoot: string;
    /** Primary checkout root; differs from repoRoot inside linked worktrees. */
    readonly mainRepoRoot: string;
    /**
     * `remote.origin.url` EXACTLY as git reports it (e.g.
     * "git@github.com:foo/bar.git"), or null.
     *
     * Carried alongside the normalized form because the two are not
     * interchangeable at a lookup: `normalizeGitRemoteUrl` is lossy and has no
     * inverse, and the git ingest stage persists `repository.remote_url` RAW.
     * A reader holding only the normalized spelling therefore cannot match the
     * column it is querying - see `queries/repository-scope.ts`.
     */
    readonly remoteUrl: string | null;
    /** Normalized remote URL (e.g. "github.com/foo/bar"), or null. */
    readonly remoteUrlNormalized: string | null;
    /** SHA of the initial (root) commit, or null. */
    readonly initialCommit: string | null;
    /** Identity as computed by chooseIdentity(). */
    readonly identity: RepositoryIdentity;
}

export interface PwdResolution extends PwdIdentity {
    /** RecordId("repository", repositoryKey). */
    readonly repositoryRecordId: RecordId;
    /** true iff a row at that id already exists in the DB. */
    readonly existsInDb: boolean;
}

/**
 * What `$PWD` resolves to against the DuckDB cache - the v2 counterpart of
 * {@link PwdResolution}, and what every `--here` / `--scope=here` caller ports
 * to.
 *
 * There is no `repositoryRecordId` and no `existsInDb`, because in v2 those are
 * one question with one answer. Surreal keyed the row by the git-derived key, so
 * a caller could BUILD the id from git alone and then ask separately whether it
 * existed. DuckDB row ids are content-hashed by their writer, so a reader
 * constructing one would be guessing at a recipe - the row is looked UP by the
 * identity columns instead (see `queries/repository-scope.ts`), and either it is
 * there or it is not.
 */
export interface PwdCacheResolution extends PwdIdentity {
    /**
     * The cache's `repository` ROW id, or `null` when the cache has never seen
     * this repository.
     *
     * This is the value `session.repository` and `commit.repository` actually
     * hold - NOT `identity.repositoryKey`, which is the git-derived Surreal key
     * and matches nothing in a v2 cache.
     */
    readonly repositoryId: string | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const mainRepoRootFromGitCommonDir = (repoRoot: string, commonDir: string): string => {
    const trimmed = commonDir.trim();
    if (trimmed.length === 0 || trimmed === ".git") return repoRoot;
    const abs = posixPath.isAbsolute(trimmed)
        ? trimmed
        : posixPath.join(repoRoot, trimmed);
    return posixPath.dirname(abs);
};

/**
 * Resolve the current working directory (or the provided `cwd`) to a repository
 * IDENTITY, using git only. No database, so this works on every command runtime.
 *
 * Requires: ProcessService + FileSystem in the Effect environment.
 */
export const resolvePwdIdentity = (
    cwd?: string,
): Effect.Effect<
    PwdIdentity,
    NotAGitRepoError | ProcessError,
    ProcessService | FileSystem.FileSystem
> =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;
        const fs = yield* FileSystem.FileSystem;

        // Step 1: resolve symlinks so the path is canonical.
        const rawCwd = cwd ?? process.cwd();
        // OLD: realpath(rawCwd).catch(() => rawCwd) - fall back to the raw path
        // if symlink resolution fails for ANY reason (git validates existence
        // next), so recover ANY PlatformError to rawCwd - orAbsent.
        const resolvedCwd = yield* fs.realPath(rawCwd).pipe(orAbsent(rawCwd));

        // Step 2: git rev-parse --show-toplevel
        const toplevelResult = yield* proc.exec("git", ["rev-parse", "--show-toplevel"], {
            cwd: resolvedCwd,
        });
        if (toplevelResult.code !== 0) {
            return yield* new NotAGitRepoError({
                cwd: resolvedCwd,
                message: toplevelResult.stderr.trim() || "not a git repository",
            });
        }
        const repoRoot = toplevelResult.stdout.trim();

        const commonDirResult = yield* proc.exec("git", ["rev-parse", "--git-common-dir"], {
            cwd: repoRoot,
        });
        const mainRepoRoot = mainRepoRootFromGitCommonDir(
            repoRoot,
            commonDirResult.code === 0 ? commonDirResult.stdout.trim() : "",
        );

        // Step 3: git config --get remote.origin.url (null if missing / fails)
        const remoteResult = yield* proc.exec(
            "git",
            ["config", "--get", "remote.origin.url"],
            { cwd: repoRoot },
        );
        const rawRemoteUrl =
            remoteResult.code === 0 ? remoteResult.stdout.trim() || null : null;
        const remoteUrlNormalized =
            rawRemoteUrl !== null ? normalizeGitRemoteUrl(rawRemoteUrl) : null;

        // Step 4: git rev-list --max-parents=0 HEAD (null if empty repo)
        const rootCommitResult = yield* proc.exec(
            "git",
            ["rev-list", "--max-parents=0", "HEAD"],
            { cwd: repoRoot },
        );
        const initialCommit =
            rootCommitResult.code === 0
                ? (rootCommitResult.stdout.trim().split("\n")[0]?.trim() || null)
                : null;

        // Step 5: build identity
        const identity = chooseIdentity({
            remoteUrlNormalized,
            initialCommit,
            checkoutRoot: mainRepoRoot,
        });

        return {
            cwd: resolvedCwd,
            repoRoot,
            mainRepoRoot,
            remoteUrl: rawRemoteUrl,
            remoteUrlNormalized,
            initialCommit,
            identity,
        } satisfies PwdIdentity;
    });

/**
 * Resolve the current working directory (or the provided `cwd`) to the
 * repository ROW the DuckDB cache holds for it.
 *
 * The composition of the two halves w1 split apart: {@link resolvePwdIdentity}
 * (git only, no engine) and `resolveCacheRepository` (the lookup by identity
 * columns). Callers want this one - the identity alone cannot filter a query,
 * and the lookup alone does not know what to look for.
 *
 * A repository the cache has never seen yields `repositoryId: null` rather than
 * a failure: nothing has been ingested for it yet, so scoping to "here" honestly
 * finds zero rows, and failing would make `--here` unusable on a fresh repo.
 */
export const resolvePwdCacheRepository = (
    cwd?: string,
): Effect.Effect<
    PwdCacheResolution,
    NotAGitRepoError | ProcessError | CacheReadError,
    CacheRead | ProcessService | FileSystem.FileSystem
> =>
    Effect.gen(function* () {
        const resolved = yield* resolvePwdIdentity(cwd);
        const found = yield* resolveCacheRepository(resolved);
        return {
            ...resolved,
            repositoryId: Option.getOrNull(found),
        } satisfies PwdCacheResolution;
    });

/**
 * Resolve the current working directory (or the provided `cwd`) to a
 * `repository` record identity and check whether the record exists in DB.
 *
 * SURREAL-ERA, and doomed: it dies with the client in wave 3. A v2 caller wants
 * {@link resolvePwdCacheRepository}; a caller that needs only the git-derived
 * identity wants {@link resolvePwdIdentity}, which is this function minus any
 * database at all.
 *
 * Requires: SurrealClient + ProcessService in the Effect environment.
 */
export const resolvePwdRepository = (
    cwd?: string,
): Effect.Effect<
    PwdResolution,
    NotAGitRepoError | DbError | ProcessError,
    SurrealClient | ProcessService | FileSystem.FileSystem
> =>
    Effect.gen(function* () {
        const resolved = yield* resolvePwdIdentity(cwd);
        const repositoryRecordId = new RecordId("repository", resolved.identity.repositoryKey);

        const db = yield* SurrealClient;
        const queryResult = yield* db.query<[[{ id: unknown }[]]]>(
            `SELECT id FROM repository:\`${resolved.identity.repositoryKey}\` LIMIT 1`,
        );
        const rows = queryResult[0] ?? [];

        return {
            ...resolved,
            repositoryRecordId,
            existsInDb: rows.length > 0,
        } satisfies PwdResolution;
    });
