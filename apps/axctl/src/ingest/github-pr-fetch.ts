/**
 * Fetch pull requests from GitHub via the `gh` CLI.
 *
 * Contract: any failure (gh not installed, repo has no GitHub remote,
 * not authenticated, non-zero exit) resolves to an empty array. The
 * Effect's error channel is `never`, so callers treat "no gh" as "no PRs"
 * without branching on errors.
 */

import { Effect } from "effect";

/**
 * Comma-joined field list passed to `gh pr list --json`.
 * Covers identity, diff stats, CI signal, and review history.
 */
export const PR_LIST_JSON_FIELDS: string =
    "number,title,state,baseRefName,headRefName,headRefOid,mergeCommit,author,url,createdAt,closedAt,mergedAt,additions,deletions,changedFiles,commits,labels,reviews,statusCheckRollup";

/**
 * Build the argv passed to `gh` (not including `"gh"` itself).
 * Limit is clamped to [1, 1000].
 */
export function prListArgs(limit: number): string[] {
    const clamped = Math.min(1000, Math.max(1, Math.trunc(limit)));
    return [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        String(clamped),
        "--json",
        PR_LIST_JSON_FIELDS,
    ];
}

/**
 * Parse the stdout of `gh pr list --json …` into an array.
 * Returns `[]` for any non-array JSON value or any parse error.
 */
export function parsePrListOutput(stdout: string): unknown[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return [];
    }
    return Array.isArray(parsed) ? parsed : [];
}

/**
 * Spawn `gh pr list` in `input.cwd` and return the parsed PR array.
 * Always resolves - never rejects and never surfaces an error channel.
 */
export const fetchPullRequests = (input: {
    readonly cwd: string;
    readonly limit: number;
}): Effect.Effect<unknown[], never, never> =>
    Effect.promise(async () => {
        try {
            const proc = Bun.spawn(["gh", ...prListArgs(input.limit)], {
                cwd: input.cwd,
                stdout: "pipe",
                stderr: "pipe",
            });

            const [stdout, _stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);

            if (exitCode !== 0) return [];

            return parsePrListOutput(stdout);
        } catch {
            return [];
        }
    });
