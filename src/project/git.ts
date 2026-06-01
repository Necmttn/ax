import { dirname, extname } from "node:path";
import { stat } from "node:fs/promises";
import { Effect } from "effect";
import { ProcessService, type ProcessResult } from "@ax/lib/process";
import type { GitState, ProjectFileChange } from "./types.ts";

const exists = (path: string): Promise<boolean> =>
    stat(path)
        .then(() => true)
        .catch(() => false);

export async function findGitRoot(cwd: string): Promise<string | null> {
    let cur = cwd;
    for (let i = 0; i < 16; i += 1) {
        if (await exists(`${cur}/.git`)) return cur;
        const parent = dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
    return null;
}

const runGit = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<ProcessResult, never, ProcessService> =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;
        return yield* proc.exec("git", ["-C", cwd, ...args]).pipe(
            // exec errors (e.g. binary missing) bubble up as success with
            // code:1-like behavior - we only care about exit code here.
            Effect.orElseSucceed(() => ({ stdout: "", stderr: "", code: 1 })),
        );
    });

export function detectLang(path: string): string | null {
    const ext = extname(path).toLowerCase();
    switch (ext) {
        case ".ts":
            return "typescript";
        case ".tsx":
            return "typescript-react";
        case ".js":
            return "javascript";
        case ".jsx":
            return "javascript-react";
        case ".json":
            return "json";
        case ".md":
        case ".mdx":
            return "markdown";
        case ".surql":
            return "surrealql";
        case ".sql":
            return "sql";
        case ".yaml":
        case ".yml":
            return "yaml";
        case ".toml":
            return "toml";
        default:
            return null;
    }
}

const isRenameOrCopyStatus = (status: string): boolean => status === "R" || status === "C";

function isRenameOrCopyRecord(record: string): boolean {
    return isRenameOrCopyStatus(record[0] ?? " ") || isRenameOrCopyStatus(record[1] ?? " ");
}

function parseStatusRecord(record: string): ProjectFileChange | null {
    if (record.length < 4) return null;
    const stagedStatus = record[0] ?? " ";
    const unstagedStatus = record[1] ?? " ";
    const path = record.slice(3);
    const untracked = stagedStatus === "?" && unstagedStatus === "?";
    return {
        path,
        status: `${stagedStatus}${unstagedStatus}`.trim() || "modified",
        staged: stagedStatus !== " " && stagedStatus !== "?",
        unstaged: unstagedStatus !== " " && unstagedStatus !== "?",
        untracked,
        lang: detectLang(path),
    };
}

function parseBranch(line: string): string | null {
    if (!line.startsWith("## ")) return null;
    const withoutPrefix = line.slice(3);
    return withoutPrefix.split("...")[0]?.trim() || null;
}

export const getGitState = (cwd = process.cwd()): Effect.Effect<GitState, never, ProcessService> =>
    Effect.gen(function* () {
        const root = yield* Effect.promise(() => findGitRoot(cwd));
        if (!root) {
            return {
                root: null,
                cwd,
                branch: null,
                head: null,
                dirty: false,
                changes: [],
            };
        }

        const [status, head] = yield* Effect.all([
            runGit(root, ["status", "--porcelain=v1", "-z", "-b"]),
            runGit(root, ["rev-parse", "--short", "HEAD"]),
        ]);

        if (status.code !== 0) {
            return yield* Effect.die(
                new Error(
                    `git status failed in ${root} with exit code ${status.code}\nstdout:\n${status.stdout}\nstderr:\n${status.stderr}`,
                ),
            );
        }

        const records = status.stdout.split("\0");
        const branch = records[0]?.startsWith("## ") === true ? parseBranch(records[0]!) : null;
        const changes: Array<ProjectFileChange> = [];

        for (let i = branch === null ? 0 : 1; i < records.length; i += 1) {
            const record = records[i];
            if (!record) continue;

            const change = parseStatusRecord(record);
            if (change) changes.push(change);
            if (isRenameOrCopyRecord(record)) i += 1;
        }

        return {
            root,
            cwd,
            branch,
            head: head.code === 0 ? head.stdout.trim() || null : null,
            dirty: changes.length > 0,
            changes,
        };
    });
