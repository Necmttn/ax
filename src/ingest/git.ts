import { readFile, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";

/**
 * Optional override file: one absolute repo path per line. Lines starting with
 * '#' are ignored.
 */
const REPO_LIST_FILE =
    process.env.AGENTCTL_REPO_LIST ??
    join(homedir(), ".local", "share", "agentctl", "agentctl-repos.txt");

/** Hard cap on history depth so cold runs stay bounded. */
const DEFAULT_SINCE_DAYS = 30;
const MAX_SINCE_DAYS = 90;

interface RepoInfo {
    /** Canonical absolute path to the repo root (parent of .git). */
    path: string;
    /** Stable slug used in record keys: basename + 8-char path hash. */
    slug: string;
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

const readRepoListFile = (): Effect.Effect<string[]> =>
    Effect.promise(async () => {
        try {
            const txt = await readFile(REPO_LIST_FILE, "utf8");
            return txt
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0 && !l.startsWith("#"));
        } catch {
            return [];
        }
    });

const isGitRepo = (path: string): Promise<boolean> =>
    stat(join(path, ".git"))
        .then(() => true)
        .catch(() => false);

/**
 * Walk upward from `cwd` until we find a `.git` entry. Returns null when the
 * filesystem root is reached without a hit. Bounded to 12 levels for safety.
 */
async function findRepoRoot(cwd: string): Promise<string | null> {
    let cur = cwd;
    for (let i = 0; i < 12; i += 1) {
        if (await isGitRepo(cur)) return cur;
        const parent = dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
    return null;
}

const deriveReposFromSessions = (): Effect.Effect<string[], DbError, SurrealClient> =>
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
            const root = yield* Effect.promise(() => findRepoRoot(cwd));
            if (!root) continue;
            if (seen.has(root)) continue;
            seen.add(root);
            out.push(root);
        }
        return out;
    });

const repoSlug = (path: string): string => {
    const base = basename(path).replace(/[^a-zA-Z0-9]/g, "_") || "repo";
    const hash = Bun.hash(path).toString(16).slice(0, 8);
    return `${base}__${hash}`;
};

const discoverRepos = (): Effect.Effect<RepoInfo[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const fromFile = yield* readRepoListFile();
        const candidates: string[] = [];
        if (fromFile.length > 0) {
            // Only keep entries that actually have a `.git` directory.
            for (const path of fromFile) {
                const ok = yield* Effect.promise(() => isGitRepo(path));
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
            repos.push({ path: p, slug: repoSlug(p) });
        }
        return repos;
    });

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

const COMMIT_DELIM = "--AGENTCTL-END--";

const parseCommitLog = (raw: string): CommitRow[] => {
    const out: CommitRow[] = [];
    // Each record: %H<tab>%aI<tab>%an<tab>%s\n--AGENTCTL-END--\n
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

const sqlString = (s: string): string => {
    // Escape backslashes and double quotes; SurrealDB allows double-quoted strings.
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

const fileRecordKey = (repoSlugStr: string, path: string): string => {
    const pathPart = path.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
    const hash = Bun.hash(path).toString(16).slice(0, 8);
    return `${repoSlugStr}__${pathPart}__${hash}`;
};

const commitRecordKey = (repoSlugStr: string, sha: string): string =>
    `${repoSlugStr}__${sha}`;

interface WriteStats {
    commits: number;
    files: number;
    produced: number;
    touched: number;
}

const writeRepo = (repo: RepoInfo, commits: CommitWithFiles[]) =>
    Effect.gen(function* () {
        if (commits.length === 0)
            return { commits: 0, files: 0, produced: 0, touched: 0 } satisfies WriteStats;
        const db = yield* SurrealClient;

        // 1. Bulk-upsert commits.
        const commitStmts = commits.map((c) => {
            const id = commitRecordKey(repo.slug, c.sha);
            return `UPSERT commit:\`${id}\` CONTENT { sha: ${sqlString(c.sha)}, repo: ${sqlString(repo.path)}, message: ${sqlString(c.message)}, author: ${sqlString(c.author)}, ts: d"${c.ts}" };`;
        });
        for (let i = 0; i < commitStmts.length; i += 500) {
            yield* db.query(commitStmts.slice(i, i + 500).join(""));
        }

        // 2. Bulk-upsert files (deduped by path).
        const seenFiles = new Set<string>();
        const fileStmts: string[] = [];
        for (const c of commits) {
            for (const f of c.files) {
                const key = fileRecordKey(repo.slug, f.path);
                if (seenFiles.has(key)) continue;
                seenFiles.add(key);
                fileStmts.push(
                    `UPSERT file:\`${key}\` CONTENT { repo: ${sqlString(repo.path)}, path: ${sqlString(f.path)} };`,
                );
            }
        }
        for (let i = 0; i < fileStmts.length; i += 500) {
            yield* db.query(fileStmts.slice(i, i + 500).join(""));
        }

        // 3. Bulk-RELATE commit -> touched -> file. Idempotency: re-running
        //    creates duplicate edge rows. Cheaper to dedupe at write time:
        //    DELETE existing edges for this commit first, then RELATE fresh.
        let touchedCount = 0;
        for (const c of commits) {
            if (c.files.length === 0) continue;
            const cid = commitRecordKey(repo.slug, c.sha);
            const stmts: string[] = [
                `DELETE touched WHERE in = commit:\`${cid}\`;`,
            ];
            for (const f of c.files) {
                const fkey = fileRecordKey(repo.slug, f.path);
                const add = f.additions === null ? "NONE" : String(f.additions);
                const del = f.deletions === null ? "NONE" : String(f.deletions);
                stmts.push(
                    `RELATE commit:\`${cid}\`->touched->file:\`${fkey}\` SET additions = ${add}, deletions = ${del};`,
                );
                touchedCount += 1;
            }
            for (let i = 0; i < stmts.length; i += 500) {
                yield* db.query(stmts.slice(i, i + 500).join(""));
            }
        }

        // 4. session -> produced -> commit. For each commit, find sessions whose
        //    cwd starts with the repo path AND whose [started_at, ended_at]
        //    range covers the commit ts. Done per-commit in SurrealQL so we
        //    don't pull the session table to JS.
        const repoLit = sqlString(repo.path);
        let producedCount = 0;
        for (const c of commits) {
            const cid = commitRecordKey(repo.slug, c.sha);
            // Two-step: clear existing produced edges for this commit
            // (idempotency), then look up matching session ids in JS and
            // RELATE one-by-one. SurrealQL FOR-loop with `$s.id->produced->`
            // hits a parser bug ('.' not allowed before '->'); the JS-driven
            // form sidesteps it cleanly.
            yield* db.query(`DELETE produced WHERE out = commit:\`${cid}\`;`);
            const sel = yield* db.query<[Array<{ id: unknown }>]>(
                `SELECT id FROM session WHERE string::starts_with(cwd ?? "", ${repoLit}) AND started_at <= d"${c.ts}" AND (ended_at IS NONE OR ended_at >= d"${c.ts}");`,
            );
            const sessions = sel?.[0] ?? [];
            if (sessions.length > 0) {
                const stmts = sessions.map((s) => {
                    // SurrealDB SDK returns RecordId instances; toString()
                    // gives the canonical `table:⟨id⟩` literal (escapes UUIDs
                    // with angle brackets when needed). Strings are accepted
                    // verbatim for completeness but in practice never occur.
                    const idStr =
                        typeof s.id === "string" ? s.id : String(s.id);
                    return `RELATE ${idStr}->produced->commit:\`${cid}\`;`;
                });
                for (let i = 0; i < stmts.length; i += 500) {
                    yield* db.query(stmts.slice(i, i + 500).join(""));
                }
            }
            producedCount += sessions.length;
        }

        return {
            commits: commits.length,
            files: seenFiles.size,
            produced: producedCount,
            touched: touchedCount,
        } satisfies WriteStats;
    });

// ---------- public API ----------

export interface GitIngestOpts {
    sinceDays: number | undefined;
}

export interface GitStats {
    repos: number;
    commits: number;
    files: number;
    produced: number;
    touched: number;
}

export const ingestGit = (
    opts: Partial<GitIngestOpts> = {},
): Effect.Effect<GitStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const requested = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
        const sinceDays = Math.min(Math.max(requested, 1), MAX_SINCE_DAYS);

        const repos = yield* discoverRepos();
        if (repos.length === 0) {
            console.log("[git] no repos discovered (empty agentctl-repos.txt + no session.cwd hits)");
            return { repos: 0, commits: 0, files: 0, produced: 0, touched: 0 };
        }
        console.log(`[git] ingesting ${repos.length} repo(s) since=${sinceDays}d`);

        // Collect per-repo work. Concurrency=4: each repo spawns its own git
        // subprocesses + DB writes; 4 wide is a sweet spot before disk/git
        // contention dominates.
        const perRepo = yield* Effect.forEach(
            repos,
            (repo) =>
                Effect.gen(function* () {
                    const commits = yield* fetchCommits(repo, sinceDays);
                    const stats = yield* writeRepo(repo, commits);
                    console.log(
                        `[git] ${repo.path}  commits=${stats.commits} files=${stats.files} produced=${stats.produced} touched=${stats.touched}`,
                    );
                    return stats;
                }),
            { concurrency: 4 },
        );

        const totals: WriteStats = perRepo.reduce<WriteStats>(
            (acc, s) => ({
                commits: acc.commits + s.commits,
                files: acc.files + s.files,
                produced: acc.produced + s.produced,
                touched: acc.touched + s.touched,
            }),
            { commits: 0, files: 0, produced: 0, touched: 0 },
        );
        const out: GitStats = { repos: repos.length, ...totals };
        console.log(
            `[git] DONE repos=${out.repos} commits=${out.commits} files=${out.files} produced=${out.produced} touched=${out.touched}`,
        );
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
