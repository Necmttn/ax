/**
 * Fetch pull requests from GitHub via the `gh` CLI.
 *
 * Contract: never rejects and never surfaces an error channel - every failure
 * (gh not installed, repo has no GitHub remote, not authenticated, non-zero
 * exit, timeout) resolves to `{ ok: false, prs: [], detail }` so the caller
 * can surface a degraded-stage warning instead of silently treating "gh is
 * stuck/broken" as "no PRs".
 *
 * Operational bounds (the daemon's `--since=1` path hits this on every
 * transcript change):
 *   - a HARD timeout kills the `gh` subprocess so a wedged gh/network/auth
 *     prompt cannot stall the whole ingest pipeline;
 *   - `updatedSince` maps to `--search "updated:>=<date>"` so incremental
 *     ingests only pull PRs that actually changed in the window instead of
 *     the full `--limit` page every run.
 */

import { Effect } from "effect";
import { runCommand } from "@ax/lib/process";

/**
 * Comma-joined field list passed to `gh pr list --json`.
 * Covers identity, diff stats, CI signal, and review history.
 *
 * NOTE: `commits` is intentionally omitted. gh resolves it as a GraphQL
 * connection that traverses each commit's `authors` sub-connection, and at the
 * stage's default `--limit` (200) the estimated node count exceeds GitHub's
 * 500k GraphQL ceiling ("requesting up to 1,000,000 possible nodes"), making
 * the whole call fail. We only used `commits` for a commit count; the writer's
 * `commit_count` falls back to 0 (the normalizer treats absent commits as 0),
 * and `scorePrSize` still scores on additions/deletions/changedFiles.
 */
export const PR_LIST_JSON_FIELDS: string =
    "number,title,state,baseRefName,headRefName,headRefOid,mergeCommit,author,url,createdAt,closedAt,mergedAt,additions,deletions,changedFiles,labels,reviews,statusCheckRollup";

/** Hard ceiling on a single `gh pr list` spawn before it is killed. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Input shape shared by the real fetcher and injected test doubles. */
export interface PrFetchInput {
    readonly cwd: string;
    readonly limit: number;
    /** `YYYY-MM-DD` lower bound for `--search "updated:>=<date>"`. Omitted →
     *  unbounded (full `--limit` page, e.g. forced full re-ingest). */
    readonly updatedSince?: string | undefined;
    /** Override the kill timeout (tests). */
    readonly timeoutMs?: number | undefined;
}

/** Outcome of one repo's PR fetch. `ok: false` carries a short failure detail
 *  so the stage can log a degraded warning. */
export interface PrFetchResult {
    readonly ok: boolean;
    readonly prs: unknown[];
    readonly detail?: string;
}

/**
 * Build the argv passed to `gh` (not including `"gh"` itself).
 * Limit is clamped to [1, 1000]. When `updatedSince` is provided the listing
 * is bounded with a search qualifier (`updated:>=<date>`), which gh combines
 * with `--state all`.
 */
export function prListArgs(limit: number, updatedSince?: string): string[] {
    const clamped = Math.min(1000, Math.max(1, Math.trunc(limit)));
    const args = [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        String(clamped),
        "--json",
        PR_LIST_JSON_FIELDS,
    ];
    if (typeof updatedSince === "string" && /^\d{4}-\d{2}-\d{2}$/.test(updatedSince)) {
        args.push("--search", `updated:>=${updatedSince}`);
    }
    return args;
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
 * Always resolves - never rejects and never surfaces an error channel. The
 * subprocess is killed after `timeoutMs` (default {@link DEFAULT_FETCH_TIMEOUT_MS}):
 * `Effect.timeoutOrElse` interrupts the spawn scope (which kills the child,
 * see `spawnScoped` in `@ax/lib/process`) and yields the degraded result.
 */
export const fetchPullRequests = (input: PrFetchInput): Effect.Effect<PrFetchResult, never, never> => {
    const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    return runCommand("gh", prListArgs(input.limit, input.updatedSince), { cwd: input.cwd }).pipe(
        Effect.map((result): PrFetchResult => {
            if (result.code !== 0) {
                const firstLine = result.stderr.trim().split("\n")[0] ?? "";
                return {
                    ok: false,
                    prs: [],
                    detail: `gh exited ${result.code}${firstLine ? `: ${firstLine}` : ""}`,
                };
            }
            return { ok: true, prs: parsePrListOutput(result.stdout) };
        }),
        Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
                Effect.succeed<PrFetchResult>({
                    ok: false,
                    prs: [],
                    detail: `gh pr list timed out after ${timeoutMs}ms`,
                }),
        }),
        // Spawn failures (gh missing, bad cwd, ...) degrade instead of failing.
        Effect.catch((err) =>
            Effect.succeed<PrFetchResult>({ ok: false, prs: [], detail: err.message }),
        ),
    );
};
