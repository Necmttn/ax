/**
 * Community pattern contribution: write exactly one ProfileV1 taste-pattern
 * entry into community/patterns/<category>/<name>.json on the user's fork and
 * open a human-reviewed PR against Necmttn/ax.
 */
import { withAxAttribution } from "@ax/lib/shared/attribution";
import { prettyPrint } from "@ax/lib/json";
import { Effect, Schema } from "effect";
import { GitHubApiError, GitHubEnv } from "./github-env.ts";
import type { TastePattern } from "./schema.ts";

export const REGISTRY_REPO = "Necmttn/ax";

export class PatternContributionError extends Schema.TaggedErrorClass<PatternContributionError>(
    "PatternContributionError",
)("PatternContributionError", {
    message: Schema.String,
}) {}

const asRecord = (u: unknown): Record<string, unknown> =>
    typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {};

export type PatternContributionResult = {
    readonly status: "pr-opened";
    readonly prUrl: string;
    readonly path: string;
};

export function patternFilePath(pattern: TastePattern): string {
    return `community/patterns/${pattern.category}/${pattern.name}.json`;
}

export function patternBranchName(pattern: TastePattern): string {
    return `ax-pattern-${pattern.category}-${pattern.name}`;
}

export function patternContributionBody(pattern: TastePattern, path: string): string {
    const label = `${pattern.category}/${pattern.name}`;
    const evidence = pattern.evidence;
    const blocks = [
        `Contributes \`${label}\` to the community pattern registry.`,
        `File: \`${path}\``,
        `Evidence: ${evidence.sessions} session(s), confidence ${evidence.confidence}`,
        "This PR intentionally changes one `community/patterns/` JSON file and stays human-reviewed.",
        "Opened by `ax contribute pattern`.",
    ];
    return withAxAttribution(blocks.join("\n\n"));
}

/**
 * Fails on filename collision instead of opening a duplicate contribution PR.
 * The branch is based on upstream main, not the fork's default branch, so the
 * resulting PR diff contains only the one pattern file.
 */
export const openPatternContribution = Effect.fn("profile.openPatternContribution")(
    function* (input: { readonly pattern: TastePattern; readonly login?: string }) {
        const gh = yield* GitHubEnv;
        const login = input.login ?? (yield* gh.login());
        if (login === null || login.trim() === "") {
            return yield* new PatternContributionError({
                message: "GitHub login unavailable; run `gh auth login` and retry.",
            });
        }

        const pattern = input.pattern;
        const path = patternFilePath(pattern);
        const branch = patternBranchName(pattern);

        const exists = yield* gh.api("GET", `/repos/${REGISTRY_REPO}/contents/${path}`).pipe(
            Effect.map(() => true),
            Effect.catchTag("GitHubApiError", (e: GitHubApiError) =>
                e.status === 404 ? Effect.succeed(false) : Effect.fail(e),
            ),
        );
        if (exists) {
            return yield* new PatternContributionError({
                message: `${path} already exists; extend or link the existing pattern instead of duplicating it.`,
            });
        }

        const fork = asRecord(yield* gh.api("POST", `/repos/${REGISTRY_REPO}/forks`, {}));
        const forkFullName = typeof fork.full_name === "string" ? fork.full_name : `${login}/ax`;

        const baseRef = asRecord(yield* gh.api("GET", `/repos/${REGISTRY_REPO}/git/ref/heads/main`));
        const baseSha = String(asRecord(baseRef.object).sha ?? "");
        const baseCommit = asRecord(yield* gh.api("GET", `/repos/${REGISTRY_REPO}/git/commits/${baseSha}`));
        const baseTreeSha = String(asRecord(baseCommit.tree).sha ?? "");

        const blob = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/blobs`, {
                content: `${prettyPrint(pattern)}\n`,
                encoding: "utf-8",
            }),
        );

        const tree = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/trees`, {
                base_tree: baseTreeSha,
                tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
            }),
        );

        const commit = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/commits`, {
                message: `community: contribute pattern ${pattern.category}/${pattern.name}`,
                tree: tree.sha,
                parents: [baseSha],
            }),
        );

        yield* gh.api("POST", `/repos/${forkFullName}/git/refs`, {
            ref: `refs/heads/${branch}`,
            sha: commit.sha,
        });

        const pr = asRecord(
            yield* gh.api("POST", `/repos/${REGISTRY_REPO}/pulls`, {
                title: `community: contribute pattern ${pattern.category}/${pattern.name}`,
                head: `${login}:${branch}`,
                base: "main",
                body: patternContributionBody(pattern, path),
            }),
        );

        return {
            status: "pr-opened",
            prUrl: String(pr.html_url ?? ""),
            path,
        } satisfies PatternContributionResult;
    },
);
