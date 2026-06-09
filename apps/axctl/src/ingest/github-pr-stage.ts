/**
 * github-pr stage: fetch PRs via `gh`, normalize, and persist them, linking
 * each PR's merge/head commit to the sessions that produced it.
 *
 * Runs AFTER `git` (deps: ["git"]) so `repository` / `commit` / `produced` rows
 * already exist for PR→session linking. Repositories without a GitHub remote (or
 * on a host without `gh`) yield 0 PRs from the total `fetchPullRequests`, so they
 * are scanned and skipped silently with nothing written.
 *
 * The fetcher is injectable (`GithubPrIngestDeps.fetchImpl`) so the composition
 * core can be unit-tested without spawning the `gh` subprocess.
 */

import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealString } from "@ax/lib/shared/surql";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { fetchPullRequests } from "./github-pr-fetch.ts";
import { writePullRequests } from "./github-pr-write.ts";

export const GithubPrKey = Schema.Literal("github-pr");
export type GithubPrKey = typeof GithubPrKey.Type;

/** Stats reported by the github-pr stage. */
export class GithubPrStageStats extends BaseStageStats.extend<GithubPrStageStats>("GithubPrStageStats")({
    repositoriesScanned: Schema.Number,
    pullRequestsIngested: Schema.Number,
    reviewsIngested: Schema.Number,
    checksIngested: Schema.Number,
    deliveryOutcomes: Schema.Number,
}) {}

export interface GithubPrIngestDeps {
    readonly fetchImpl?: (input: {
        readonly cwd: string;
        readonly limit: number;
    }) => Effect.Effect<unknown[], never, never>;
    readonly limit?: number;
    /**
     * When non-empty, restrict the repository scan to checkouts whose
     * `root_path` is in this list (used by `ax ingest here` to scope PR ingest
     * to $PWD). Absent/empty → scan every GitHub-remoted repository.
     */
    readonly repoPaths?: readonly string[];
}

/**
 * Strip a `table:` prefix and surrounding backticks / ⟨⟩ brackets from a
 * `type::string(id)` result, returning the bare record key. Pair with
 * `recordLiteral(table, key)` to rebuild an embeddable literal.
 */
const stripRecordKey = (table: string, idStr: string): string => {
    let key = idStr.trim().replace(new RegExp(`^${table}:`), "");
    if (key.startsWith("⟨") && key.endsWith("⟩")) key = key.slice(1, -1);
    if (key.startsWith("`") && key.endsWith("`")) key = key.slice(1, -1);
    return key;
};

interface GithubPrTotals {
    repositoriesScanned: number;
    pullRequests: number;
    reviews: number;
    checks: number;
    deliveryOutcomes: number;
}

/**
 * Composition core: discover GitHub-remote repositories, fetch + normalize +
 * write their PRs. The fetcher defaults to the real `gh`-spawning
 * `fetchPullRequests` but is injectable for tests.
 */
export const ingestGithubPrs = (
    deps?: GithubPrIngestDeps,
): Effect.Effect<GithubPrTotals, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = deps?.limit ?? 200;
        const fetchImpl = deps?.fetchImpl ?? fetchPullRequests;

        // Scope the scan to specific paths when requested (ingest here),
        // otherwise scan every GitHub-remoted repository. A path can be either a
        // repository's canonical `root_path` (run from the main checkout) or a
        // worktree path (run from `.claude/worktrees/*`). The latter never
        // equals `root_path`, so we also resolve via the `checkout` table, whose
        // per-worktree `path` → `repository` mapping the git stage populates
        // (github-pr deps on "git", so the $PWD checkout exists by the time we run).
        const repoPaths = deps?.repoPaths ?? [];
        const quotedPaths = repoPaths.map((p) => surrealString(p)).join(", ");
        const repoPathFilter =
            repoPaths.length > 0
                ? ` AND (root_path IN [${quotedPaths}] OR id IN (SELECT VALUE repository FROM checkout WHERE path IN [${quotedPaths}]))`
                : "";
        const repoRows = yield* db.query<
            [Array<{ id: string; root_path: string | null; remote_url: string | null }>]
        >(
            `SELECT type::string(id) AS id, root_path, remote_url FROM repository WHERE remote_url != NONE AND root_path != NONE${repoPathFilter};`,
        );
        const repos = repoRows?.[0] ?? [];

        const totals: GithubPrTotals = {
            repositoriesScanned: 0,
            pullRequests: 0,
            reviews: 0,
            checks: 0,
            deliveryOutcomes: 0,
        };

        for (const repo of repos) {
            if (typeof repo.root_path !== "string" || repo.root_path.length === 0) continue;

            const key = stripRecordKey("repository", repo.id);
            const repositoryId = recordLiteral("repository", key);

            // Count every attempted repo as scanned, whether or not it has PRs.
            totals.repositoriesScanned += 1;

            // TODO: honour ctx.since to bound the gh pr list window (v0 fetches a fixed limit)
            const prs = yield* fetchImpl({ cwd: repo.root_path, limit });
            if (prs.length === 0) continue;

            const stats = yield* writePullRequests({ repositoryId, repositoryKey: key, prs });
            totals.pullRequests += stats.pullRequests;
            totals.reviews += stats.reviews;
            totals.checks += stats.checks;
            totals.deliveryOutcomes += stats.deliveryOutcomes;
        }

        return totals;
    });

/**
 * github-pr stage - fetches + normalizes + persists GitHub PRs and links them
 * to producing sessions.
 *
 * Depends on: {@link GitKey} (repository / commit / produced rows)
 * Tags: ingest
 */
export const githubPrStage: StageDef<GithubPrStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "github-pr", deps: ["git"], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestGithubPrs(
                ctx.repoPaths === undefined ? undefined : { repoPaths: ctx.repoPaths },
            );
            return GithubPrStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.pullRequests} PRs from ${result.repositoriesScanned} repos`,
                repositoriesScanned: result.repositoriesScanned,
                pullRequestsIngested: result.pullRequests,
                reviewsIngested: result.reviews,
                checksIngested: result.checks,
                deliveryOutcomes: result.deliveryOutcomes,
            });
        }),
};
