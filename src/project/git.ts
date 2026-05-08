import { dirname, extname } from "node:path";
import { stat } from "node:fs/promises";
import { Effect } from "effect";
import type { GitState, ProjectFileChange } from "./types.ts";

interface RunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

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

const runGit = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<RunResult> =>
    Effect.promise(async () => {
        const proc = Bun.spawn(["git", "-C", cwd, ...args], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        return { stdout, stderr, code: proc.exitCode ?? 0 };
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

function parseStatusLine(line: string): ProjectFileChange | null {
    if (line.length < 4) return null;
    const stagedStatus = line[0] ?? " ";
    const unstagedStatus = line[1] ?? " ";
    const rawPath = line.slice(3);
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
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

export const getGitState = (cwd = process.cwd()): Effect.Effect<GitState> =>
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
            runGit(root, ["status", "--porcelain=v1", "-b"]),
            runGit(root, ["rev-parse", "--short", "HEAD"]),
        ]);

        const lines = status.stdout.split("\n").filter((line) => line.length > 0);
        const branch = lines.length > 0 ? parseBranch(lines[0]!) : null;
        const changes = lines.slice(1).map(parseStatusLine).filter((row): row is ProjectFileChange => row !== null);

        return {
            root,
            cwd,
            branch,
            head: head.code === 0 ? head.stdout.trim() || null : null,
            dirty: changes.length > 0,
            changes,
        };
    });
