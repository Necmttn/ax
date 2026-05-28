/**
 * git-window.ts - Resolve a commit-anchored time window for `ax sessions near`.
 *
 * Returns the window [predecessorTs, commitTs] for a given SHA, or sentinels
 * for orphan/unknown cases. Pure process calls - no DB dependency.
 */
import { Effect } from "effect";
import { ProcessService, type ProcessError } from "./process.ts";

export type CommitWindow =
    | { readonly kind: "window"; readonly from: Date; readonly to: Date }
    | { readonly kind: "orphan"; readonly commitTs: Date }
    | { readonly kind: "not_found" };

/**
 * Resolve a [predecessor..commit] time window for `sha` inside `repoRoot`.
 *
 * - Returns `{ kind: "window", from, to }` when a predecessor commit exists.
 * - Returns `{ kind: "orphan", commitTs }` for the root commit (no parent).
 * - Returns `{ kind: "not_found" }` when `sha` doesn't resolve in the repo.
 */
export const findCommitWindow = (
    repoRoot: string,
    sha: string,
): Effect.Effect<CommitWindow, ProcessError, ProcessService> =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;

        // Step 1: verify sha exists and get its author timestamp
        const commitResult = yield* proc.exec(
            "git",
            ["log", "-1", "--format=%H %aI", sha],
            { cwd: repoRoot },
        );

        if (commitResult.code !== 0 || !commitResult.stdout.trim()) {
            return { kind: "not_found" } satisfies CommitWindow;
        }

        const [_commitSha, commitIso] = commitResult.stdout.trim().split(" ");
        if (!commitIso) {
            return { kind: "not_found" } satisfies CommitWindow;
        }
        const commitTs = new Date(commitIso);
        if (isNaN(commitTs.getTime())) {
            return { kind: "not_found" } satisfies CommitWindow;
        }

        // Step 2: get predecessor commit timestamp (parent of sha)
        // `<sha>^` resolves to the first parent; fails for root commits.
        const predResult = yield* proc.exec(
            "git",
            ["log", "-1", "--format=%aI", `${sha}^`],
            { cwd: repoRoot },
        );

        if (predResult.code !== 0 || !predResult.stdout.trim()) {
            // Root commit (no parent) - return orphan sentinel
            return { kind: "orphan", commitTs } satisfies CommitWindow;
        }

        const predIso = predResult.stdout.trim();
        const predTs = new Date(predIso);
        if (isNaN(predTs.getTime())) {
            return { kind: "orphan", commitTs } satisfies CommitWindow;
        }

        return { kind: "window", from: predTs, to: commitTs } satisfies CommitWindow;
    });
