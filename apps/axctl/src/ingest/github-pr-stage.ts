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
import { fetchPullRequests, type PrFetchInput, type PrFetchResult } from "./github-pr-fetch.ts";
import { writePullRequests } from "./github-pr-write.ts";

export const GithubPrKey = Schema.Literal("github-pr");
export type GithubPrKey = typeof GithubPrKey.Type;

/** Per-repo fetches run with this bounded concurrency (each is one `gh`
 *  subprocess + a write batch; serial was the multi-repo stall shape). */
const FETCH_CONCURRENCY = 4;

/** Stats reported by the github-pr stage. */
export class GithubPrStageStats extends BaseStageStats.extend<GithubPrStageStats>("GithubPrStageStats")({
    repositoriesScanned: Schema.Number,
    repositoriesDegraded: Schema.Number,
    pullRequestsIngested: Schema.Number,
    reviewsIngested: Schema.Number,
    checksIngested: Schema.Number,
    deliveryOutcomes: Schema.Number,
}) {}

export interface GithubPrIngestDeps {
    readonly fetchImpl?: (input: PrFetchInput) => Effect.Effect<PrFetchResult, never, never>;
    readonly limit?: number;
    /**
     * When non-empty, restrict the repository scan to checkouts whose
     * `root_path` is in this list (used by `ax ingest here` to scope PR ingest
     * to $PWD). Absent/empty → scan every GitHub-remoted repository.
     */
    readonly repoPaths?: readonly string[];
    /**
     * `YYYY-MM-DD` lower bound forwarded to `gh pr list --search
     * "updated:>=<date>"`, derived from the ingest `since`. Absent → unbounded
     * fetch (forced full re-ingest / epoch-zero sentinel).
     */
    readonly updatedSince?: string;
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
    /** Repos whose `gh` fetch failed (timeout/auth/network) - logged as a
     *  degraded-stage warning, NOT silently treated as "no PRs". */
    repositoriesDegraded: number;
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
        // `remote_url CONTAINS "github"` keeps non-GitHub remotes (GitLab etc.)
        // out of the scan entirely - `gh` would fail on every one of them every
        // run, which is both a wasted spawn and a spurious degraded warning.
        // (GitHub Enterprise on a custom domain is excluded too; revisit if
        // that ever matters here.)
        const repoRows = yield* db.query<
            [Array<{ id: string; root_path: string | null; remote_url: string | null }>]
        >(
            `SELECT type::string(id) AS id, root_path, remote_url FROM repository WHERE remote_url != NONE AND remote_url CONTAINS "github" AND root_path != NONE${repoPathFilter};`,
        );
        const repos = (repoRows?.[0] ?? []).filter(
            (r): r is typeof r & { root_path: string } =>
                typeof r.root_path === "string" && r.root_path.length > 0,
        );

        // Bounded-concurrency per-repo fetch+write. Each fetch is hard-bounded
        // by the fetcher's kill timeout, and (when the caller passed
        // `updatedSince`) scoped to PRs updated within the ingest window.
        const perRepo = yield* Effect.forEach(
            repos,
            (repo) =>
                Effect.gen(function* () {
                    const key = stripRecordKey("repository", repo.id);
                    const repositoryId = recordLiteral("repository", key);

                    const fetched = yield* fetchImpl({
                        cwd: repo.root_path,
                        limit,
                        updatedSince: deps?.updatedSince,
                    });
                    if (!fetched.ok) {
                        // Degraded, not silent: a stuck/broken gh must be visible
                        // in the ingest output instead of masquerading as "0 PRs".
                        yield* Effect.logWarning("github-pr fetch degraded", {
                            repo: repo.root_path,
                            detail: fetched.detail ?? "unknown failure",
                        });
                        return { degraded: true as const, pullRequests: 0, reviews: 0, checks: 0, deliveryOutcomes: 0 };
                    }
                    if (fetched.prs.length === 0) {
                        return { degraded: false as const, pullRequests: 0, reviews: 0, checks: 0, deliveryOutcomes: 0 };
                    }
                    const stats = yield* writePullRequests({ repositoryId, repositoryKey: key, prs: fetched.prs });
                    return { degraded: false as const, ...stats };
                }),
            { concurrency: FETCH_CONCURRENCY },
        );

        const totals: GithubPrTotals = {
            repositoriesScanned: repos.length,
            repositoriesDegraded: 0,
            pullRequests: 0,
            reviews: 0,
            checks: 0,
            deliveryOutcomes: 0,
        };
        for (const r of perRepo) {
            if (r.degraded) totals.repositoriesDegraded += 1;
            totals.pullRequests += r.pullRequests;
            totals.reviews += r.reviews;
            totals.checks += r.checks;
            totals.deliveryOutcomes += r.deliveryOutcomes;
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
            // Epoch-zero `since` is the "full re-derive" sentinel → unbounded
            // fetch; otherwise bound the gh search to the ingest window (the
            // date floor of `since` is inclusive-safe for `updated:>=`).
            const updatedSince = ctx.since.getTime() > 0 ? ctx.since.toISOString().slice(0, 10) : undefined;
            const result = yield* ingestGithubPrs({
                ...(ctx.repoPaths === undefined ? {} : { repoPaths: ctx.repoPaths }),
                ...(updatedSince === undefined ? {} : { updatedSince }),
            });
            const degraded = result.repositoriesDegraded > 0 ? ` (${result.repositoriesDegraded} degraded)` : "";
            return GithubPrStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.pullRequests} PRs from ${result.repositoriesScanned} repos${degraded}`,
                repositoriesScanned: result.repositoriesScanned,
                repositoriesDegraded: result.repositoriesDegraded,
                pullRequestsIngested: result.pullRequests,
                reviewsIngested: result.reviews,
                checksIngested: result.checks,
                deliveryOutcomes: result.deliveryOutcomes,
            });
        }),
};
