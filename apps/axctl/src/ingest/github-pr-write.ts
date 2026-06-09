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

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral, stableDigest } from "@ax/lib/ids";
import { surrealDate, surrealJson, surrealOptionDate, surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
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

/**
 * Turn a `type::string(id)` query result back into an embeddable record literal.
 * Strips a leading `table:` prefix and surrounding backticks / ⟨⟩ brackets, then
 * rebuilds via `recordLiteral`. Copied from `dashboard/cost-query.ts`.
 */
const toRecordRef = (table: string, id: string): string => {
    let key = id.trim().replace(new RegExp(`^${table}:`), "");
    if (key.startsWith("⟨") && key.endsWith("⟩")) key = key.slice(1, -1);
    if (key.startsWith("`") && key.endsWith("`")) key = key.slice(1, -1);
    return recordLiteral(table, key);
};

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {};

export const writePullRequests = (
    input: WritePullRequestsInput,
): Effect.Effect<WritePullRequestsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const statements: string[] = [];

        let pullRequests = 0;
        let reviews = 0;
        let checks = 0;
        let deliveryOutcomes = 0;

        for (const raw of input.prs) {
            const np = normalizePullRequest(raw);
            if (np.number === null) continue; // can't key it

            const prKey = stableDigest(`${input.repositoryKey}|${np.number}`);
            const prId = recordLiteral("pull_request", prKey);
            const prRaw = asRecord(raw);

            statements.push(
                `UPSERT ${prId} CONTENT { ` +
                    `repository: ${input.repositoryId}, ` +
                    `provider: "github", ` +
                    `number: ${np.number}, ` +
                    `title: ${surrealString(np.title ?? "(untitled)")}, ` +
                    `state: ${surrealString(np.state)}, ` +
                    `base_branch: ${np.baseBranch === null ? "NONE" : surrealString(np.baseBranch)}, ` +
                    `head_branch: ${np.headBranch === null ? "NONE" : surrealString(np.headBranch)}, ` +
                    `head_sha: ${np.headSha === null ? "NONE" : surrealString(np.headSha)}, ` +
                    `merge_sha: ${np.mergeSha === null ? "NONE" : surrealString(np.mergeSha)}, ` +
                    `author: ${np.author === null ? "NONE" : surrealString(np.author)}, ` +
                    `url: ${np.url === null ? "NONE" : surrealString(np.url)}, ` +
                    `opened_at: ${surrealOptionDate(np.openedAt)}, ` +
                    `closed_at: ${surrealOptionDate(np.closedAt)}, ` +
                    `merged_at: ${surrealOptionDate(np.mergedAt)}, ` +
                    `updated_at: time::now(), ` +
                    `additions: ${np.additions}, ` +
                    `deletions: ${np.deletions}, ` +
                    `changed_files: ${np.changedFiles}, ` +
                    `commit_count: ${np.commitCount}, ` +
                    `labels: ${surrealJson(np.labels)}, ` +
                    `raw: ${surrealJson(np.raw)} ` +
                    `};`,
            );
            pullRequests++;

            // Reviews. Key on review content (reviewer/ts/state) rather than
            // array index, so re-ingest with a different gh ordering/count
            // updates the same rows instead of orphaning them.
            const rawReviews = prRaw.reviews;
            if (Array.isArray(rawReviews)) {
                for (const review of rawReviews) {
                    const ne = normalizeReviewEvent(review);
                    if (ne.state === null) continue; // state is required

                    const reviewId = recordLiteral(
                        "review_event",
                        stableDigest(`${prKey}|review|${ne.reviewer ?? ""}|${ne.ts ?? ""}|${ne.state}`),
                    );
                    statements.push(
                        `UPSERT ${reviewId} CONTENT { ` +
                            `pull_request: ${prId}, ` +
                            `repository: ${input.repositoryId}, ` +
                            `reviewer: ${ne.reviewer === null ? "NONE" : surrealString(ne.reviewer)}, ` +
                            `reviewer_kind: ${surrealString(ne.reviewerKind)}, ` +
                            `state: ${surrealString(ne.state)}, ` +
                            `body_excerpt: ${ne.bodyExcerpt.length === 0 ? "NONE" : surrealString(ne.bodyExcerpt)}, ` +
                            `severity: ${surrealString(ne.severity)}, ` +
                            `category: ${surrealString(ne.category)}, ` +
                            `unresolved: false, ` +
                            `raw: ${surrealJson(ne.raw)}, ` +
                            `ts: ${ne.ts ? surrealDate(ne.ts) : "time::now()"} ` +
                            `};`,
                    );
                    reviews++;
                }
            }

            // Head commit lookup (one read). Prefer the merge commit.
            const sha = np.mergeSha ?? np.headSha;
            let commitRef: string | null = null;
            if (sha !== null) {
                const rows = yield* db.query<[string[]]>(
                    `SELECT VALUE type::string(id) FROM commit WHERE repository = ${input.repositoryId} AND sha = ${surrealString(sha)} LIMIT 1;`,
                );
                const commitIdStr = rows?.[0]?.[0] ?? null;
                commitRef = commitIdStr ? toRecordRef("commit", commitIdStr) : null;
            }

            // Checks. Key on check content (name/startedAt) rather than array
            // index, so a different rollup ordering on re-ingest updates the
            // same rows instead of orphaning them.
            const rawChecks = prRaw.statusCheckRollup;
            if (Array.isArray(rawChecks)) {
                for (const entry of rawChecks) {
                    const nc = normalizeCheckRun(entry);
                    if (nc.name === null && nc.status === null) continue;

                    const checkId = recordLiteral(
                        "check_run",
                        stableDigest(`${prKey}|check|${nc.name ?? ""}|${nc.startedAt ?? ""}`),
                    );
                    statements.push(
                        `UPSERT ${checkId} CONTENT { ` +
                            `pull_request: ${prId}, ` +
                            `commit: ${commitRef ?? "NONE"}, ` +
                            `repository: ${input.repositoryId}, ` +
                            `provider: "github", ` +
                            `name: ${surrealString(nc.name ?? "(unknown)")}, ` +
                            `status: ${surrealString(nc.status ?? "unknown")}, ` +
                            `conclusion: ${nc.conclusion === null ? "NONE" : surrealString(nc.conclusion)}, ` +
                            `url: ${nc.url === null ? "NONE" : surrealString(nc.url)}, ` +
                            `raw: ${surrealJson(nc.raw)}, ` +
                            `started_at: ${surrealOptionDate(nc.startedAt)}, ` +
                            `completed_at: ${surrealOptionDate(nc.completedAt)} ` +
                            `};`,
                    );
                    checks++;
                }
            }

            // Delivery link: only when the PR's commit exists in the graph.
            if (commitRef !== null) {
                // A merge commit present in our local commit graph is a proxy
                // for "reached main", not a guarantee that it landed on the
                // default branch.
                const reachedMain = np.mergeSha !== null && commitRef !== null;

                const srows = yield* db.query<[string[]]>(
                    `SELECT VALUE type::string(in) FROM produced WHERE out = ${commitRef};`,
                );
                const sessionIds = srows?.[0] ?? [];

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
                    const sessionRef = toRecordRef("session", sidStr);
                    // delivery_outcome.session is UNIQUE → one outcome per
                    // session; if a session maps to multiple PRs, last write
                    // wins (v0 accepted limitation). Keying by the session id
                    // is required: a different id with the same session would
                    // violate the UNIQUE index.
                    const deliveryId = recordLiteral(
                        "delivery_outcome",
                        stableDigest(sidStr),
                    );
                    statements.push(
                        `UPSERT ${deliveryId} CONTENT { ` +
                            `session: ${sessionRef}, ` +
                            `repository: ${input.repositoryId}, ` +
                            `pull_request: ${prId}, ` +
                            `status: ${surrealString(status)}, ` +
                            // promotion_path is `string DEFAULT 'unknown'` but
                            // SurrealDB v3 doesn't apply the DEFAULT on CONTENT
                            // upserts (the field coerces NONE → error). This
                            // writer only links a PR, so the path is "pr".
                            `promotion_path: "pr", ` +
                            `pr_size: ${surrealJson(prSize)}, ` +
                            `review_pain: ${surrealJson(reviewPain)}, ` +
                            `confidence: "medium", ` +
                            `created_at: time::now(), ` +
                            `updated_at: time::now() ` +
                            `};`,
                    );
                    deliveryOutcomes++;
                }
            }
        }

        yield* executeStatementsWith(db, statements, { chunkSize: 500 });

        return { pullRequests, reviews, checks, deliveryOutcomes };
    });
