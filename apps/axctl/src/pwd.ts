/**
 * pwd.ts - resolve $PWD → git repo root → repository record identity.
 *
 * Read-only: this module NEVER upserts. Repository creation is the git ingest
 * stage's responsibility. This is purely a "given a directory, what repository
 * record does it correspond to?" resolver.
 */
import { realpath } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { ProcessService, type ProcessError } from "@ax/lib/process";
import {
    chooseIdentity,
    normalizeGitRemoteUrl,
    type RepositoryIdentity,
} from "./ingest/repository-identity.ts";

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

export interface PwdResolution {
    /** Absolute path after symlink resolve. */
    readonly cwd: string;
    /** Result of `git rev-parse --show-toplevel`. */
    readonly repoRoot: string;
    /** Normalized remote URL (e.g. "github.com/foo/bar"), or null. */
    readonly remoteUrlNormalized: string | null;
    /** SHA of the initial (root) commit, or null. */
    readonly initialCommit: string | null;
    /** Identity as computed by chooseIdentity(). */
    readonly identity: RepositoryIdentity;
    /** RecordId("repository", repositoryKey). */
    readonly repositoryRecordId: RecordId;
    /** true iff a row at that id already exists in the DB. */
    readonly existsInDb: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve the current working directory (or the provided `cwd`) to a
 * `repository` record identity and check whether the record exists in DB.
 *
 * Requires: SurrealClient + ProcessService in the Effect environment.
 */
export const resolvePwdRepository = (
    cwd?: string,
): Effect.Effect<
    PwdResolution,
    NotAGitRepoError | DbError | ProcessError,
    SurrealClient | ProcessService
> =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;

        // Step 1: resolve symlinks so the path is canonical.
        const rawCwd = cwd ?? process.cwd();
        // fall back to raw path if symlink resolution fails; git will validate existence next
        const resolvedCwd = yield* Effect.promise(() => realpath(rawCwd).catch(() => rawCwd));

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
            checkoutRoot: repoRoot,
        });

        // Step 6: build RecordId
        const repositoryRecordId = new RecordId("repository", identity.repositoryKey);

        // Step 7: check DB existence
        const db = yield* SurrealClient;
        const queryResult = yield* db.query<[[{ id: unknown }[]]]>(
            `SELECT id FROM repository:\`${identity.repositoryKey}\` LIMIT 1`,
        );
        const rows = queryResult[0] ?? [];
        const existsInDb = rows.length > 0;

        return {
            cwd: resolvedCwd,
            repoRoot,
            remoteUrlNormalized,
            initialCommit,
            identity,
            repositoryRecordId,
            existsInDb,
        } satisfies PwdResolution;
    });
