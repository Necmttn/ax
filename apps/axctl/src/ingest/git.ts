import { homedir } from "node:os";
import { Effect, FileSystem, Path, type PlatformError, Schema } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import {
    checkoutRecordKey,
    commitRecordKey,
    fileRecordKey,
} from "./record-keys.ts";
import { recordLiteral, stableDigest } from "@ax/lib/ids";
import {
    chooseIdentity,
    classifyCheckoutKind,
    normalizeGitRemoteUrl,
    type CheckoutKind,
    type RepositoryIdentityKind,
} from "./repository-identity.ts";
import { surrealString } from "@ax/lib/shared/surql";
import { pathToProjectSlug } from "@ax/lib/shared/project-slug";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";

/**
 * Optional override file: one absolute repo path per line. Lines starting with
 * '#' are ignored.
 */
/** @internal exported for tests. */
export const REPO_LIST_FILE =
    process.env.AX_REPO_LIST ??
    posixPath.join(homedir(), ".local", "share", "ax", "ax-repos.txt");

/** Hard cap on history depth so cold runs stay bounded. */
const DEFAULT_SINCE_DAYS = 30;
const MAX_SINCE_DAYS = 90;

interface RepoInfo {
    /** Canonical absolute path to the repo root (parent of .git). */
    path: string;
    repositoryKey: string;
    checkoutKey: string;
    identityKind: RepositoryIdentityKind;
    remoteUrl: string | null;
    remoteUrlNormalized: string | null;
    initialCommit: string | null;
    gitDir: string | null;
    branch: string | null;
    headSha: string | null;
    worktreeKind: CheckoutKind;
}

interface CommitRow {
    sha: string;
    ts: string; // ISO author date
    author: string;
    message: string;
}

interface FileTouch {
    path: string;
    additions: number | null;
    deletions: number | null;
}

interface CommitWithFiles extends CommitRow {
    files: FileTouch[];
}

// ---------- repo discovery ----------

/** @internal exported for tests: proves OPTIONAL-config read tolerance. */
export const readRepoListFile = (): Effect.Effect<string[], never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const txt = yield* fs.readFileString(REPO_LIST_FILE);
        return txt
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith("#"));
    }).pipe(
        // An OPTIONAL override file: a missing file (NotFound) is the common
        // case, but a permission/EISDIR/IO fault on this best-effort config read
        // must ALSO be treated as "no override" rather than aborting the whole
        // git ingest stage. orAbsent recovers ANY PlatformError to an empty list.
        orAbsent<string[]>([]),
    );

/** @internal exported for tests: proves discovery-PROBE tolerance. */
export const isGitRepo = (
    path: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;
        // A discovery PROBE: `fs.exists` reports presence without throwing on
        // absence. Any PlatformError (permission/EISDIR/IO on the `.git` path)
        // means "treat as not a repo and continue", matching the prior
        // `stat(...).then(true).catch(false)` best-effort semantics. orAbsent
        // recovers ANY PlatformError to false so a single inaccessible candidate
        // never aborts the whole repo walk.
        return yield* fs.exists(pathSvc.join(path, ".git"));
    }).pipe(orAbsent(false));

/**
 * Walk upward from `cwd` until we find a `.git` entry. Returns null when the
 * filesystem root is reached without a hit. Bounded to 12 levels for safety.
 */
const findRepoRoot = (
    cwd: string,
): Effect.Effect<string | null, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const pathSvc = yield* Path.Path;
        let cur = cwd;
        for (let i = 0; i < 12; i += 1) {
            if (yield* isGitRepo(cur)) return cur;
            const parent = pathSvc.dirname(cur);
            if (parent === cur) return null;
            cur = parent;
        }
        return null;
    });

const deriveReposFromSessions = (): Effect.Effect<
    string[],
    DbError | PlatformError.PlatformError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // GROUP ALL collapses everything; array::distinct dedupes.
        const result = yield* db.query<[Array<{ cwds: string[] }>]>(
            "SELECT array::distinct(cwd) AS cwds FROM session WHERE cwd IS NOT NONE GROUP ALL;",
        );
        const cwds = result?.[0]?.[0]?.cwds ?? [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const cwd of cwds) {
            if (typeof cwd !== "string" || cwd.length === 0) continue;
            const root = yield* findRepoRoot(cwd);
            if (!root) continue;
            if (seen.has(root)) continue;
            seen.add(root);
            out.push(root);
        }
        return out;
    });

const discoverRepos = (): Effect.Effect<
    RepoInfo[],
    DbError | PlatformError.PlatformError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fromFile = yield* readRepoListFile();
        const candidates: string[] = [];
        if (fromFile.length > 0) {
            // Only keep entries that actually have a `.git` directory.
            for (const path of fromFile) {
                const ok = yield* isGitRepo(path);
                if (ok) candidates.push(path);
            }
        }
        if (candidates.length === 0) {
            const fromSessions = yield* deriveReposFromSessions();
            candidates.push(...fromSessions);
        }
        const seen = new Set<string>();
        const repos: RepoInfo[] = [];
        for (const p of candidates) {
            if (seen.has(p)) continue;
            seen.add(p);
            repos.push(yield* buildRepoInfo(p));
        }
        return repos;
    });

const groupReposByRepositoryKey = (repos: readonly RepoInfo[]): RepoInfo[][] => {
    const groups = new Map<string, RepoInfo[]>();
    for (const repo of repos) {
        const group = groups.get(repo.repositoryKey);
        if (group) {
            group.push(repo);
        } else {
            groups.set(repo.repositoryKey, [repo]);
        }
    }
    return [...groups.values()];
};

// ---------- git subprocess helpers ----------

interface RunResult {
    stdout: string;
    code: number;
}

const runGit = (cwd: string, args: string[]): Effect.Effect<RunResult> =>
    Effect.promise(async () => {
        const proc = Bun.spawn(["git", "-C", cwd, ...args], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return { stdout, code: proc.exitCode ?? 0 };
    });

const trimmedGitOutput = (cwd: string, args: string[]): Effect.Effect<string | null> =>
    Effect.gen(function* () {
        const result = yield* runGit(cwd, args);
        if (result.code !== 0) return null;
        const trimmed = result.stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
    });

const readGitEntry = (
    path: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;
        const gitPath = pathSvc.join(path, ".git");
        const st = yield* fs.stat(gitPath);
        if (st.type === "Directory") return "directory";
        return (yield* fs.readFileString(gitPath)).trim();
    });

const buildRepoInfo = (
    path: string,
): Effect.Effect<RepoInfo, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const [remoteUrl, initialCommit, gitDir, branch, headSha, gitEntry] = yield* Effect.all(
            [
                trimmedGitOutput(path, ["config", "--get", "remote.origin.url"]),
                trimmedGitOutput(path, ["rev-list", "--max-parents=0", "HEAD"]),
                trimmedGitOutput(path, ["rev-parse", "--git-dir"]),
                trimmedGitOutput(path, ["branch", "--show-current"]),
                trimmedGitOutput(path, ["rev-parse", "HEAD"]),
                readGitEntry(path),
            ],
            { concurrency: 4 },
        );
        const firstInitialCommit = initialCommit?.split("\n")[0]?.trim() || null;
        const remoteUrlNormalized = remoteUrl ? normalizeGitRemoteUrl(remoteUrl) : null;
        const identity = chooseIdentity({
            remoteUrlNormalized,
            initialCommit: firstInitialCommit,
            checkoutRoot: path,
        });

        return {
            path,
            repositoryKey: identity.repositoryKey,
            checkoutKey: checkoutRecordKey(path),
            identityKind: identity.kind,
            remoteUrl,
            remoteUrlNormalized,
            initialCommit: firstInitialCommit,
            gitDir,
            branch,
            headSha,
            worktreeKind: classifyCheckoutKind(gitEntry),
        };
    });

const COMMIT_DELIM = "--AX-END--";

const parseCommitLog = (raw: string): CommitRow[] => {
    const out: CommitRow[] = [];
    // Each record: %H<tab>%aI<tab>%an<tab>%s\n--AX-END--\n
    const records = raw.split(`\n${COMMIT_DELIM}\n`).filter((r) => r.trim().length > 0);
    for (const rec of records) {
        const cleaned = rec.replace(/^\n+/, "");
        const tab1 = cleaned.indexOf("\t");
        if (tab1 < 0) continue;
        const sha = cleaned.slice(0, tab1);
        const tab2 = cleaned.indexOf("\t", tab1 + 1);
        if (tab2 < 0) continue;
        const ts = cleaned.slice(tab1 + 1, tab2);
        const tab3 = cleaned.indexOf("\t", tab2 + 1);
        if (tab3 < 0) continue;
        const author = cleaned.slice(tab2 + 1, tab3);
        const message = cleaned.slice(tab3 + 1).trim();
        if (sha.length !== 40) continue;
        out.push({ sha, ts, author, message });
    }
    return out;
};

const parseNumstat = (raw: string): FileTouch[] => {
    const files: FileTouch[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        // Format: <add>\t<del>\t<path>  ; binary files use '-' for both.
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const [aStr, dStr, ...rest] = parts;
        const path = rest.join("\t");
        if (!path) continue;
        const additions = aStr === "-" ? null : Number.parseInt(aStr, 10);
        const deletions = dStr === "-" ? null : Number.parseInt(dStr, 10);
        files.push({
            path,
            additions: Number.isFinite(additions as number) ? (additions as number) : null,
            deletions: Number.isFinite(deletions as number) ? (deletions as number) : null,
        });
    }
    return files;
};

const fetchCommits = (
    repo: RepoInfo,
    sinceDays: number,
): Effect.Effect<CommitWithFiles[]> =>
    Effect.gen(function* () {
        const since = `${sinceDays}.days.ago`;
        const log = yield* runGit(repo.path, [
            "log",
            `--since=${since}`,
            `--pretty=format:%H%x09%aI%x09%an%x09%s%n${COMMIT_DELIM}`,
            "--no-merges",
        ]);
        if (log.code !== 0) return [];
        const commits = parseCommitLog(log.stdout);
        if (commits.length === 0) return [];
        // Fetch numstat per commit. `git log --numstat` could batch this, but
        // mixing with the delimited message format above is fragile - separate
        // calls per commit are simple and reliable. Concurrency caps cost.
        const enriched = yield* Effect.forEach(
            commits,
            (c) =>
                Effect.gen(function* () {
                    const stat = yield* runGit(repo.path, [
                        "show",
                        "--numstat",
                        "--format=",
                        "--no-renames",
                        c.sha,
                    ]);
                    const files = stat.code === 0 ? parseNumstat(stat.stdout) : [];
                    return { ...c, files } satisfies CommitWithFiles;
                }),
            { concurrency: 4 },
        );
        return enriched;
    });

// ---------- DB writers ----------

const dbRecordLiteral = (fallbackTable: string, id: unknown, fallbackKey: string): string => {
    if (id === null || id === undefined) return recordLiteral(fallbackTable, fallbackKey);
    return typeof id === "string" ? id : String(id);
};

interface CommitLookupInput {
    repositoryId: string;
    stableRepo: string;
    checkoutPath: string;
    sha: string;
}

interface FileLookupInput {
    repositoryId: string;
    stableRepo: string;
    checkoutPath: string;
    path: string;
}

interface CommitUpsertInput {
    id: string;
    stableRepo: string;
    repositoryId: string;
    sha: string;
    message: string;
    author: string;
    ts: string;
}

interface FileUpsertInput {
    id: string;
    stableRepo: string;
    repositoryId: string;
    path: string;
}

export function buildCommitLookupQueries(input: CommitLookupInput): string[] {
    return [
        `SELECT id FROM commit WHERE repository = ${input.repositoryId} AND repo = ${surrealString(input.stableRepo)} AND sha = ${surrealString(input.sha)} LIMIT 1;`,
        `SELECT id FROM commit WHERE repo = ${surrealString(input.stableRepo)} AND sha = ${surrealString(input.sha)} LIMIT 1;`,
        `SELECT id FROM commit WHERE repository = ${input.repositoryId} AND sha = ${surrealString(input.sha)} LIMIT 1;`,
        `SELECT id FROM commit WHERE repo = ${surrealString(input.checkoutPath)} AND sha = ${surrealString(input.sha)} LIMIT 1;`,
    ];
}

export function buildFileLookupQueries(input: FileLookupInput): string[] {
    return [
        `SELECT id FROM file WHERE repository = ${input.repositoryId} AND repo = ${surrealString(input.stableRepo)} AND path = ${surrealString(input.path)} LIMIT 1;`,
        `SELECT id FROM file WHERE repo = ${surrealString(input.stableRepo)} AND path = ${surrealString(input.path)} LIMIT 1;`,
        `SELECT id FROM file WHERE repository = ${input.repositoryId} AND path = ${surrealString(input.path)} LIMIT 1;`,
        `SELECT id FROM file WHERE repo = ${surrealString(input.checkoutPath)} AND path = ${surrealString(input.path)} LIMIT 1;`,
    ];
}

export function buildCommitUpsertStatement(input: CommitUpsertInput): string {
    return `UPSERT ${input.id} CONTENT { sha: ${surrealString(input.sha)}, repo: ${surrealString(input.stableRepo)}, message: ${surrealString(input.message)}, author: ${surrealString(input.author)}, ts: d"${input.ts}", repository: ${input.repositoryId} };`;
}

export function buildFileUpsertStatement(input: FileUpsertInput): string {
    return `UPSERT ${input.id} CONTENT { repo: ${surrealString(input.stableRepo)}, path: ${surrealString(input.path)}, repository: ${input.repositoryId}, identity_scope: "repository" };`;
}

interface TouchedRelationFile {
    fileId: string;
    additions: number | null;
    deletions: number | null;
}

interface TouchedRelationInput {
    commitId: string;
    files: TouchedRelationFile[];
    repositoryId: string;
    checkoutId: string;
    ts: string;
}

export function touchedRelationRecordKey(
    commitId: string,
    fileId: string,
    checkoutId: string,
): string {
    return Bun.hash(`${relationEndpointKey(commitId)}|${relationEndpointKey(fileId)}|${relationEndpointKey(checkoutId)}`).toString(16).padStart(16, "0");
}

export function producedRelationRecordKey(sessionId: string, commitId: string): string {
    return Bun.hash(`${relationEndpointKey(sessionId)}|${relationEndpointKey(commitId)}`).toString(16).padStart(16, "0");
}

function relationEndpointKey(record: string): string {
    const trimmed = record.trim();
    const tagged = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):`(.+)`$/);
    if (tagged) return `${tagged[1]}:${tagged[2]}`;
    return trimmed;
}

export function buildTouchedRelationStatements(input: TouchedRelationInput): string[] {
    const stmts: string[] = [];
    for (const file of input.files) {
        const add = file.additions === null ? "NONE" : String(file.additions);
        const del = file.deletions === null ? "NONE" : String(file.deletions);
        const edgeKey = touchedRelationRecordKey(input.commitId, file.fileId, input.checkoutId);
        stmts.push(
            `RELATE ${input.commitId}->touched:\`${edgeKey}\`->${file.fileId} SET additions = ${add}, deletions = ${del}, repository = ${input.repositoryId}, checkout = ${input.checkoutId}, ts = d"${input.ts}";`,
        );
    }
    return stmts;
}

export function buildProducedRelationStatements(input: {
    readonly sessionIds: readonly string[];
    readonly commitId: string;
    readonly repositoryId: string;
    readonly checkoutId: string;
    readonly ts: string;
}): string[] {
    return input.sessionIds.map((sessionId) => {
        const edgeKey = producedRelationRecordKey(sessionId, input.commitId);
        return `RELATE ${sessionId}->produced:\`${edgeKey}\`->${input.commitId} SET repository = ${input.repositoryId}, checkout = ${input.checkoutId}, ts = d"${input.ts}", source = "git", kind = "commit";`;
    });
}

const findExistingRecord = (
    db: SurrealClientShape,
    queries: string[],
): Effect.Effect<unknown | null, DbError> =>
    Effect.gen(function* () {
        for (const query of queries) {
            const result = yield* db.query<[Array<{ id: unknown }>]>(query);
            const id = result?.[0]?.[0]?.id;
            if (id !== null && id !== undefined) return id;
        }
        return null;
    });

interface WriteStats {
    commits: number;
    files: number;
    produced: number;
    touched: number;
    sessions: number;
}

export function buildSessionRepoWhere(repoPath: string): string {
    const repoLit = surrealString(repoPath);
    const prefixLit = surrealString(repoPath.endsWith("/") ? repoPath : `${repoPath}/`);
    return `(cwd = ${repoLit} OR string::starts_with(cwd ?? "", ${prefixLit}))`;
}

export function nestedCheckoutPaths(
    repoPath: string,
    candidates: readonly string[],
): string[] {
    const prefix = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
    return candidates
        .filter((candidate) => candidate !== repoPath && candidate.startsWith(prefix))
        .sort((a, b) => b.length - a.length);
}

export function buildSessionCheckoutWhere(
    repoPath: string,
    excludedRepoPaths: readonly string[] = [],
): string {
    const base = buildSessionRepoWhere(repoPath);
    if (excludedRepoPaths.length === 0) return base;
    const excluded = excludedRepoPaths.map(buildSessionRepoWhere).join(" OR ");
    return `(${base} AND NOT (${excluded}))`;
}

export function buildSessionCheckoutUpdateStatement(
    repoPath: string,
    repositoryId: string,
    checkoutId: string,
    excludedRepoPaths: readonly string[] = [],
): string {
    return `UPDATE session SET repository = ${repositoryId}, checkout = ${checkoutId} WHERE ${buildSessionCheckoutWhere(repoPath, excludedRepoPaths)} RETURN NONE;`;
}

/**
 * Canonicalize `session.project` onto a single key for every session linked to
 * one logical repository. The harness parsers populate `project`
 * inconsistently - Claude stores a `~/.claude/projects/<slug>` dir slug, while
 * codex / pi / opencode / cursor store the raw cwd, and Claude worktrees get a
 * distinct slug per checkout - so the SAME repo fragments into many `project`
 * values and every exact-match grouping (project pages, workflow episodes)
 * misses cross-harness and cross-worktree sessions. Keying the rewrite on the
 * already-unified `repository` edge (rather than the cwd path) collapses all of
 * them, including orphan-worktree sessions whose checkout dir is gone. The
 * `project != ...` guard keeps the UPDATE a no-op once a session is canonical.
 */
export function buildCanonicalProjectUpdate(
    repositoryId: string,
    canonicalSlug: string,
): string {
    const slugLit = surrealString(canonicalSlug);
    return `UPDATE session SET project = ${slugLit} WHERE repository = ${repositoryId} AND (project IS NONE OR project != ${slugLit}) RETURN NONE;`;
}

/**
 * The canonical repo root for a group of same-repository checkouts. Prefer the
 * `normal` checkout (its path IS the repo root); otherwise the shortest path is
 * the closest-to-root worktree candidate. Used only as a fallback when the
 * persisted `repository.root_path` is unavailable (e.g. a worktree-only run
 * before any normal checkout was ever seen).
 */
function canonicalRootFromGroup(group: readonly RepoInfo[]): string | null {
    const normal = group.find((r) => r.worktreeKind === "normal");
    if (normal) return normal.path;
    const sorted = [...group].sort((a, b) => a.path.length - b.path.length);
    return sorted[0]?.path ?? null;
}

/**
 * Collapse every `session.project` value for one logical repository onto a
 * single canonical slug derived from the repo root. Runs once per repository
 * group after its checkouts are written. Prefers the persisted
 * `repository.root_path` (set by a prior run's normal checkout) so even a
 * worktree-scoped run converges onto the main checkout's slug.
 */
const canonicalizeGroupProject = (
    db: SurrealClientShape,
    group: readonly RepoInfo[],
): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
        const first = group[0];
        if (!first) return;
        const repositoryId = recordLiteral("repository", first.repositoryKey);
        const rootResult = yield* db.query<[Array<{ root_path?: unknown }>]>(
            `SELECT root_path FROM ${repositoryId};`,
        );
        const persisted = rootResult?.[0]?.[0]?.root_path;
        const rootPath =
            typeof persisted === "string" && persisted.length > 0
                ? persisted
                : canonicalRootFromGroup(group);
        if (!rootPath) return;
        yield* db.query(
            buildCanonicalProjectUpdate(repositoryId, pathToProjectSlug(rootPath)),
        );
    });

const linkedSessionCount = (
    db: SurrealClientShape,
    repoPath: string,
    excludedRepoPaths: readonly string[],
): Effect.Effect<number, DbError> =>
    Effect.gen(function* () {
        const result = yield* db.query<[Array<{ count?: unknown }>]>(
            `SELECT count() AS count FROM session WHERE ${buildSessionCheckoutWhere(repoPath, excludedRepoPaths)} GROUP ALL;`,
        );
        const count = Number(result?.[0]?.[0]?.count ?? 0);
        return Number.isFinite(count) ? count : 0;
    });

export function deriveRepositoryDisplayName(
    remoteUrlNormalized: string | null,
    repoPath: string,
): string {
    const remoteName = remoteUrlNormalized?.split("/").filter(Boolean).at(-1);
    return remoteName && remoteName.length > 0 ? remoteName : posixPath.basename(repoPath);
}

const writeRepo = (
    repo: RepoInfo,
    commits: CommitWithFiles[],
    allRepoPaths: readonly string[],
) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const repositoryId = recordLiteral("repository", repo.repositoryKey);
        const checkoutId = recordLiteral("checkout", repo.checkoutKey);
        const stableRepo = repo.repositoryKey;
        const excludedSessionPaths = nestedCheckoutPaths(repo.path, allRepoPaths);

        const repositoryName = deriveRepositoryDisplayName(repo.remoteUrlNormalized, repo.path);
        const shouldUpdateRepositoryRoot =
            repo.worktreeKind === "normal" ? "true" : "root_path IS NONE";
        yield* db.query(
            [
                `UPSERT ${repositoryId} MERGE {`,
                `name: ${surrealString(repositoryName)},`,
                `remote_url: ${repo.remoteUrl === null ? "NONE" : surrealString(repo.remoteUrl)},`,
                `initial_commit: ${repo.initialCommit === null ? "NONE" : surrealString(repo.initialCommit)},`,
                "updated_at: time::now()",
                "};",
                `UPDATE ${repositoryId} SET root_path = ${surrealString(repo.path)} WHERE ${shouldUpdateRepositoryRoot} RETURN NONE;`,
                repo.worktreeKind === "normal" && repo.branch !== null
                    ? `UPDATE ${repositoryId} SET default_branch = ${surrealString(repo.branch)} RETURN NONE;`
                    : "",
                `UPSERT ${checkoutId} MERGE {`,
                `repository: ${repositoryId},`,
                `path: ${surrealString(repo.path)},`,
                `branch: ${repo.branch === null ? "NONE" : surrealString(repo.branch)},`,
                `head_sha: ${repo.headSha === null ? "NONE" : surrealString(repo.headSha)},`,
                `worktree_name: ${repo.worktreeKind === "worktree" ? surrealString(posixPath.basename(repo.path)) : "NONE"},`,
                "dirty: false,",
                "updated_at: time::now()",
                "};",
                `DELETE has_checkout WHERE in = ${repositoryId} AND out = ${checkoutId};`,
                `RELATE ${repositoryId}->has_checkout->${checkoutId} SET ts = time::now();`,
            ].join(""),
        );
        const linkedSessions = yield* linkedSessionCount(db, repo.path, excludedSessionPaths);
        yield* db.query(
            buildSessionCheckoutUpdateStatement(
                repo.path,
                repositoryId,
                checkoutId,
                excludedSessionPaths,
            ),
        );

        if (commits.length === 0)
            return {
                commits: 0,
                files: 0,
                produced: 0,
                touched: 0,
                sessions: linkedSessions,
            } satisfies WriteStats;

        // 1. Bulk-upsert commits. If a previous ingest wrote this repo+sha
        // under the legacy local key, reuse that record id to satisfy the
        // existing unique index while adding repository links.
        const commitIds = new Map<string, string>();
        const commitStmts: string[] = [];
        for (const c of commits) {
            const fallbackKey = commitRecordKey(repo.repositoryKey, c.sha);
            const existing = yield* findExistingRecord(
                db,
                buildCommitLookupQueries({
                    repositoryId,
                    stableRepo,
                    checkoutPath: repo.path,
                    sha: c.sha,
                }),
            );
            const id = dbRecordLiteral("commit", existing, fallbackKey);
            commitIds.set(c.sha, id);
            commitStmts.push(buildCommitUpsertStatement({
                id,
                stableRepo,
                repositoryId,
                sha: c.sha,
                message: c.message,
                author: c.author,
                ts: c.ts,
            }));
        }
        yield* executeStatementsWith(db, commitStmts, { chunkSize: 500 });

        // 2. Bulk-upsert files (deduped by path).
        const seenFiles = new Set<string>();
        const fileIds = new Map<string, string>();
        const fileStmts: string[] = [];
        for (const c of commits) {
            for (const f of c.files) {
                if (seenFiles.has(f.path)) continue;
                seenFiles.add(f.path);
                const fallbackKey = fileRecordKey(repo.repositoryKey, f.path);
                const existing = yield* findExistingRecord(
                    db,
                    buildFileLookupQueries({
                        repositoryId,
                        stableRepo,
                        checkoutPath: repo.path,
                        path: f.path,
                    }),
                );
                const id = dbRecordLiteral("file", existing, fallbackKey);
                fileIds.set(f.path, id);
                fileStmts.push(buildFileUpsertStatement({
                    id,
                    stableRepo,
                    repositoryId,
                    path: f.path,
                }));
            }
        }
        yield* executeStatementsWith(db, fileStmts, { chunkSize: 500 });

        // 3. Bulk-RELATE commit -> touched -> file. Touched is checkout-scoped
        //    edge evidence, so re-runs delete only this checkout's rows before
        //    relating fresh rows. Sibling worktree evidence is preserved.
        let touchedCount = 0;
        for (const c of commits) {
            if (c.files.length === 0) continue;
            const cid = commitIds.get(c.sha) ?? recordLiteral("commit", commitRecordKey(repo.repositoryKey, c.sha));
            const stmts = buildTouchedRelationStatements({
                commitId: cid,
                files: c.files.map((f) => ({
                    fileId:
                        fileIds.get(f.path) ??
                        recordLiteral("file", fileRecordKey(repo.repositoryKey, f.path)),
                    additions: f.additions,
                    deletions: f.deletions,
                })),
                repositoryId,
                checkoutId,
                ts: c.ts,
            });
            touchedCount += c.files.length;
            yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        }

        // 4. session -> produced -> commit. For each commit, find sessions whose
        //    cwd starts with the repo path AND whose [started_at, ended_at]
        //    range covers the commit ts. Done per-commit in SurrealQL so we
        //    don't pull the session table to JS.
        let producedCount = 0;
        for (const c of commits) {
            const cid = commitIds.get(c.sha) ?? recordLiteral("commit", commitRecordKey(repo.repositoryKey, c.sha));
            const sel = yield* db.query<[Array<{ id: unknown }>]>(
                `SELECT id FROM session WHERE checkout = ${checkoutId} AND started_at <= d"${c.ts}" AND (ended_at IS NONE OR ended_at >= d"${c.ts}");`,
            );
            const sessions = sel?.[0] ?? [];
            if (sessions.length > 0) {
                const sessionIds = sessions.map((s) => {
                    // SurrealDB SDK returns RecordId instances; toString()
                    // gives the canonical `table:⟨id⟩` literal (escapes UUIDs
                    // with angle brackets when needed). Strings are accepted
                    // verbatim for completeness but in practice never occur.
                    return typeof s.id === "string" ? s.id : String(s.id);
                });
                const stmts = buildProducedRelationStatements({
                    sessionIds,
                    commitId: cid,
                    repositoryId,
                    checkoutId,
                    ts: c.ts,
                });
                yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
            }
            producedCount += sessions.length;
        }

        return {
            commits: commits.length,
            files: seenFiles.size,
            produced: producedCount,
            touched: touchedCount,
            sessions: linkedSessions,
        } satisfies WriteStats;
    });

// ---------- skip-unchanged watermark (hypothesis 007) ----------
//
// The git stage re-walks each repo's history (`git log` + a per-commit
// `git show --numstat`) on every run - the dominant warm cost. Most repos are
// unchanged between runs, so we cache a per-repo watermark in the shared
// `ingest_file_state` table (source_kind='git_repo'): the last-ingested HEAD
// sha and the history window (since_days) walked. On the next run, if HEAD and
// since_days are unchanged the repo's commits/files already persist in the DB,
// so we skip the (expensive) walk entirely - output-equivalent. New commits
// move HEAD, forcing a fresh walk; a different since_days also forces one (a
// wider window could surface older commits). NEVER `NOT IN`: the whole table
// is loaded once in a single indexed read into a JS Map keyed by repo path.
// `AX_REDERIVE_GIT=1` forces a full walk (ignores watermarks).

const GIT_WATERMARK_SOURCE = "git_repo";

interface GitWatermark {
    sha: string;
    sinceDays: number;
}

const gitWatermarkId = (repoPath: string): string =>
    recordLiteral("ingest_file_state", stableDigest(`git_repo|${repoPath}`));

const loadGitWatermarks = (
    db: SurrealClientShape,
): Effect.Effect<Map<string, GitWatermark>, DbError> =>
    Effect.gen(function* () {
        const rows = (yield* db.query<[Array<{ path?: string; sha?: string; since_days?: number }>]>(
            `SELECT path, sha, since_days FROM ingest_file_state WHERE source_kind = ${surrealString(GIT_WATERMARK_SOURCE)};`,
        ))?.[0] ?? [];
        const out = new Map<string, GitWatermark>();
        for (const row of rows) {
            if (
                typeof row.path === "string" &&
                typeof row.sha === "string" &&
                typeof row.since_days === "number"
            ) {
                out.set(row.path, { sha: row.sha, sinceDays: row.since_days });
            }
        }
        return out;
    });

const upsertGitWatermark = (
    db: SurrealClientShape,
    repoPath: string,
    sha: string,
    sinceDays: number,
): Effect.Effect<void, DbError> =>
    executeStatementsWith(
        db,
        [
            `UPSERT ${gitWatermarkId(repoPath)} CONTENT { path: ${surrealString(repoPath)}, source_kind: ${surrealString(GIT_WATERMARK_SOURCE)}, sha: ${surrealString(sha)}, since_days: ${Math.trunc(sinceDays)}, ingested_at: time::now() };`,
        ],
        { chunkSize: 1 },
    );

// ---------- public API ----------

export interface GitIngestOpts {
    sinceDays: number | undefined;
    /** Emitted after each repository is written, with cumulative counts, so
     *  the CLI progress bar ticks during the otherwise-silent repo walk. */
    onProgress?: (counts: Record<string, number>) => Effect.Effect<void>;
    /**
     * When provided, bypass `discoverRepos()` entirely and process only these
     * absolute repo paths. Each path must be a git repo root (parent of .git).
     * Used by `axctl ingest here` to restrict the git stage to $PWD.
     */
    repoPaths?: readonly string[];
}

export interface GitStats {
    repos: number;
    commits: number;
    files: number;
    produced: number;
    touched: number;
    sessions: number;
}

export const ingestGit = (
    opts: Partial<GitIngestOpts> = {},
): Effect.Effect<
    GitStats,
    DbError | PlatformError.PlatformError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const requested = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
        const sinceDays = Math.min(Math.max(requested, 1), MAX_SINCE_DAYS);

        // When repoPaths is provided, bypass discovery entirely.
        const repos: RepoInfo[] = opts.repoPaths && opts.repoPaths.length > 0
            ? yield* Effect.forEach(opts.repoPaths, (p) => buildRepoInfo(p), { concurrency: 4 })
            : yield* discoverRepos();

        if (repos.length === 0) {
            yield* Effect.logDebug("git ingest found no repositories");
            return { repos: 0, commits: 0, files: 0, produced: 0, touched: 0, sessions: 0 };
        }
        yield* Effect.logDebug("git ingest started", { repos: repos.length, sinceDays });
        const allRepoPaths = repos.map((repo) => repo.path);

        // Skip-unchanged watermark (hypothesis 007): load every per-repo HEAD
        // marker in ONE indexed read. A repo whose HEAD + window match its
        // watermark is unchanged ⇒ its commits/files already persist ⇒ skip the
        // (expensive) history walk. `AX_REDERIVE_GIT=1` forces a full walk.
        const forceRederive = process.env.AX_REDERIVE_GIT === "1";
        const db0 = yield* SurrealClient;
        const watermarks = forceRederive
            ? new Map<string, GitWatermark>()
            : yield* loadGitWatermarks(db0);

        // Collect per-repo work. Different logical repositories can run in
        // parallel, but checkouts/worktrees of the same repo are serialized.
        // Legacy data can contain multiple checkout-scoped commit rows for
        // the same repo+sha; parallel canonicalization would race on the
        // `commit_sha_uq` index.
        // Cumulative counters for progress. concurrency:4 means increments can
        // interleave; a progress bar tolerates an approximate count, and the
        // authoritative totals are recomputed from `perRepo` below.
        let doneRepos = 0;
        const running = { commits: 0, files: 0, produced: 0, touched: 0, sessions: 0 };
        const repoGroups = groupReposByRepositoryKey(repos);
        const perGroup = yield* Effect.forEach(
            repoGroups,
            (group) =>
                Effect.gen(function* () {
                    const groupStats = yield* Effect.forEach(
                        group,
                        (repo) =>
                            Effect.gen(function* () {
                            // Skip the history walk when HEAD + window are
                            // unchanged: the repo's commits/files already
                            // persist from a prior run (output-equivalent). The
                            // cheap repo/checkout/session-link upserts still run
                            // (writeRepo with no commits) so new sessions get
                            // linked even on a skipped repo.
                            const mark = repo.headSha ? watermarks.get(repo.path) : undefined;
                            const unchanged =
                                mark !== undefined &&
                                mark.sha === repo.headSha &&
                                mark.sinceDays === sinceDays;
                            const commits = unchanged
                                ? []
                                : yield* fetchCommits(repo, sinceDays);
                            const stats = yield* writeRepo(repo, commits, allRepoPaths);
                            // Record the watermark only after a real walk
                            // succeeded; a skipped repo's marker is already
                            // current. Requires a concrete HEAD sha.
                            if (!unchanged && repo.headSha) {
                                yield* upsertGitWatermark(db0, repo.path, repo.headSha, sinceDays);
                            }
                            yield* Effect.logDebug("git repository ingested", {
                                path: repo.path,
                                sessions: stats.sessions,
                                commits: stats.commits,
                                files: stats.files,
                                produced: stats.produced,
                                touched: stats.touched,
                            });
                            doneRepos += 1;
                            running.commits += stats.commits;
                            running.files += stats.files;
                            running.produced += stats.produced;
                            running.touched += stats.touched;
                            running.sessions += stats.sessions;
                            if (opts.onProgress) {
                                yield* opts.onProgress({ repos: doneRepos, ...running });
                            }
                            return stats;
                        }),
                        { concurrency: 1 },
                    );
                    // Now that every checkout of this repository is written and
                    // its sessions are linked to the repository edge, fold all
                    // their project keys (claude slug, codex/pi/opencode raw
                    // cwd, per-worktree slugs) onto one canonical slug.
                    yield* canonicalizeGroupProject(db0, group);
                    return groupStats;
                }),
            { concurrency: 4 },
        );
        const perRepo = perGroup.flat();

        const totals: WriteStats = perRepo.reduce<WriteStats>(
            (acc, s) => ({
                commits: acc.commits + s.commits,
                files: acc.files + s.files,
                produced: acc.produced + s.produced,
                touched: acc.touched + s.touched,
                sessions: acc.sessions + s.sessions,
            }),
            { commits: 0, files: 0, produced: 0, touched: 0, sessions: 0 },
        );
        const out: GitStats = { repos: repos.length, ...totals };
        yield* Effect.logDebug("git ingest complete", out);
        return out;
    });

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        ingestGit({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<GitStats>,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const GitKey = Schema.Literal("git");
export type GitKey = typeof GitKey.Type;

/**
 * Git stage - ingests Repository commits + touched files.
 *
 * Depends on: (none - leaf)
 * Consumed by: {@link SignalsKey}
 * Tags: ingest
 */
// Named GitStageStats to avoid collision with the original GitStats interface.
export class GitStageStats extends BaseStageStats.extend<GitStageStats>("GitStageStats")({
    commitsIngested: Schema.Number,
    repositoriesSeen: Schema.Number,
}) {}

export const gitStage: StageDef<
    GitStageStats,
    SurrealClient | FileSystem.FileSystem | Path.Path
> = {
    meta: StageMeta.make({ key: "git", deps: [], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            // Repo discovery tolerates a vanished override file / missing `.git`
            // (NotFound is recovered inside ingestGit); any PlatformError that
            // escapes here is a genuine FS fault (unreadable repo-list file or a
            // non-NotFound stat error), so it dies as a defect rather than
            // masquerading as a recoverable DbError.
            const result = yield* ingestGit({
                ...(sinceDays === undefined ? {} : { sinceDays }),
                ...(ctx.repoPaths === undefined ? {} : { repoPaths: ctx.repoPaths }),
            }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
            return GitStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.commits} commits from ${result.repos} repos`,
                commitsIngested: result.commits,
                repositoriesSeen: result.repos,
            });
        }),
};
