/**
 * github-pr-write: persist normalized GitHub PRs + link them to the sessions
 * that produced the PR's merge/head commit.
 *
 * Given a repository record literal and an array of raw `gh pr list --json`
 * objects, this writes `pull_request`, `review_event`, `check_run`, and
 * `delivery_outcome` rows. Normalization lives in `github-pr.ts`; scoring +
 * classification in `delivery.ts`; this module only formats SurrealQL literals
 * and batches the resulting UPSERT statements.
 */

import { Effect, Schema } from "effect";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import {
    aggregateReviewPain,
    normalizeCheckRun,
    normalizePullRequest,
    normalizeReviewEvent,
} from "./github-pr.ts";
import {
    classifyDeliveryStatus,
    scorePrSize,
    scoreReviewPain,
} from "./delivery.ts";

export interface WritePullRequestsInput {
    /** Already a record literal, e.g. recordLiteral("repository", key). */
    readonly repositoryId: string;
    /** The raw repository key (for deterministic child ids). */
    readonly repositoryKey: string;
    /** Raw `gh pr list --json` objects. */
    readonly prs: readonly unknown[];
}

export interface WritePullRequestsStats {
    readonly pullRequests: number;
    readonly reviews: number;
    readonly checks: number;
    readonly deliveryOutcomes: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {};

export const writePullRequests = (
    write: CacheWriteService,
    input: WritePullRequestsInput,
): Effect.Effect<WritePullRequestsStats, CacheWriteError> =>
    Effect.gen(function* () {
        let pullRequests = 0;
        let reviews = 0;
        let checks = 0;
        let deliveryOutcomes = 0;

        for (const raw of input.prs) {
            const np = normalizePullRequest(raw);
            if (np.number === null) continue; // can't key it

            const prId = stableId("pull_request", [input.repositoryKey, np.number]);
            const prRaw = asRecord(raw);

            yield* write.put("pull_request", cacheRow({
                id: prId, repository: input.repositoryId, provider: "github", number: np.number,
                title: np.title ?? "(untitled)", state: np.state, base_branch: np.baseBranch,
                head_branch: np.headBranch, head_sha: np.headSha, merge_sha: np.mergeSha,
                author: np.author, url: np.url, opened_at: tsParam(np.openedAt),
                closed_at: tsParam(np.closedAt), merged_at: tsParam(np.mergedAt),
                updated_at: new Date(), additions: np.additions, deletions: np.deletions,
                changed_files: np.changedFiles, commit_count: np.commitCount,
                labels: jsonParam(np.labels), raw: jsonParam(np.raw),
            }));
            pullRequests++;

            // Reviews. Key on review content (reviewer/ts/state) rather than
            // array index, so re-ingest with a different gh ordering/count
            // updates the same rows instead of orphaning them.
            const rawReviews = prRaw.reviews;
            if (Array.isArray(rawReviews)) {
                for (const review of rawReviews) {
                    const ne = normalizeReviewEvent(review);
                    if (ne.state === null) continue; // state is required

                    const reviewId = stableId("review_event", [prId, ne.reviewer, ne.ts, ne.state]);
                    yield* write.put("review_event", cacheRow({
                        id: reviewId, pull_request: prId, repository: input.repositoryId,
                        reviewer: ne.reviewer, reviewer_kind: ne.reviewerKind, state: ne.state,
                        body_excerpt: ne.bodyExcerpt || null, severity: ne.severity, category: ne.category,
                        unresolved: false, raw: jsonParam(ne.raw), ts: tsParam(ne.ts) ?? new Date(),
                    }));
                    reviews++;
                }
            }

            // Head commit lookup (one read). Prefer the merge commit.
            const sha = np.mergeSha ?? np.headSha;
            let commitRef: string | null = null;
            if (sha !== null) {
                const rows = yield* write.rows(Schema.Struct({ id: Schema.String }),
                    "SELECT id FROM commit WHERE repository = ? AND sha = ? LIMIT 1", [input.repositoryId, sha]);
                commitRef = rows[0]?.id ?? null;
            }

            // Checks. Key on check content (name/startedAt) rather than array
            // index, so a different rollup ordering on re-ingest updates the
            // same rows instead of orphaning them.
            const rawChecks = prRaw.statusCheckRollup;
            if (Array.isArray(rawChecks)) {
                for (const entry of rawChecks) {
                    const nc = normalizeCheckRun(entry);
                    if (nc.name === null && nc.status === null) continue;

                    const checkId = stableId("check_run", [prId, nc.name, nc.startedAt]);
                    yield* write.put("check_run", cacheRow({
                        id: checkId, pull_request: prId, commit: commitRef,
                        repository: input.repositoryId, provider: "github", name: nc.name ?? "(unknown)",
                        status: nc.status ?? "unknown", conclusion: nc.conclusion, url: nc.url,
                        raw: jsonParam(nc.raw), started_at: tsParam(nc.startedAt), completed_at: tsParam(nc.completedAt),
                    }));
                    checks++;
                }
            }

            // Delivery link: only when the PR's commit exists in the graph.
            if (commitRef !== null) {
                // A merge commit present in our local commit graph is a proxy
                // for "reached main", not a guarantee that it landed on the
                // default branch.
                const reachedMain = np.mergeSha !== null && commitRef !== null;

                const srows = yield* write.rows(Schema.Struct({ session: Schema.String }),
                    "SELECT in_id AS session FROM produced WHERE out_id = ?", [commitRef]);
                const sessionIds = srows.map((row) => row.session);

                const prSize = scorePrSize({
                    additions: np.additions,
                    deletions: np.deletions,
                    changedFiles: np.changedFiles,
                    commitCount: np.commitCount,
                });
                const reviewPain = scoreReviewPain(
                    aggregateReviewPain(prRaw.reviews, prRaw.statusCheckRollup),
                );
                const prStateForStatus: "open" | "closed" | "merged" | null =
                    np.state === "unknown" ? null : np.state;
                const status = classifyDeliveryStatus({
                    prState: prStateForStatus,
                    reachedMain,
                });

                for (const sidStr of sessionIds) {
                    // delivery_outcome.session is UNIQUE → one outcome per
                    // session; if a session maps to multiple PRs, last write
                    // wins (v0 accepted limitation). Keying by the session id
                    // is required: a different id with the same session would
                    // violate the UNIQUE index.
                    const deliveryId = stableId("delivery_outcome", [sidStr]);
                    yield* write.put("delivery_outcome", cacheRow({
                        id: deliveryId, session: sidStr, repository: input.repositoryId,
                        checkout: null, pull_request: prId, status, promotion_path: "pr",
                        main_branch: null, produced_commits: null, promoted_commits: null,
                        pr_size: jsonParam(prSize), review_pain: jsonParam(reviewPain), phase_metrics: null,
                        confidence: "medium", evidence: null, created_at: new Date(), updated_at: new Date(),
                    }));
                    deliveryOutcomes++;
                }
            }
        }

        return { pullRequests, reviews, checks, deliveryOutcomes };
    });
