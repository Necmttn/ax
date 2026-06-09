import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { recordLiteral } from "@ax/lib/ids";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { deriveClosureRows } from "../ingest/closure.ts";

export interface RevertedResult {
    readonly revertedCount: number;
    readonly totalCommits: number;
}

/**
 * Compute `commit.reverted` over FULL history (freshness backbone, ADR-0011).
 *
 * Reuses closure's pure {@link deriveClosureRows} fix-chain detection rather
 * than reading the window-truncated `later_fixed_by` edge. Closure rebuilds
 * that edge window-bounded (DELETE then re-RELATE only commits within
 * `--since`), so the persisted edge gives stale/wrong forward-looking numbers
 * when a NEW fix lands for an OLD feature commit. By re-deriving fix chains
 * over the FULL commit set we get the correct `reverted` flag every run.
 *
 * The commit load is intentionally unwindowed (no `WHERE ts > …`): freshness
 * depends on seeing the whole history every time.
 *
 * Writes are DIFF-ONLY: we load the current `reverted = true` set, compute the
 * keys to flip on/off, and emit UPDATEs BY PRIMARY ID only. We never do a
 * full-table `UPDATE commit SET reverted = …` (O(all commits) on every warm
 * `--since=1` run) and never `UPDATE … WHERE reverted = …` (UPDATE on the
 * indexed `reverted` field hits a known SurrealDB index-drift footgun in this
 * repo). Result: the warm path is O(changed commits).
 */
export const computeRevertedCommits = (): Effect.Effect<RevertedResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const commits = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, message, repository, type::string(ts) AS ts FROM commit ORDER BY ts ASC;`,
        ))?.[0] ?? [];
        const touched = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT in, out, out.path AS path FROM touched;`,
        ))?.[0] ?? [];

        const rows = deriveClosureRows({
            commits: commits as never,
            touched: touched as never,
            // sessionHealth is unused by the fix-chain path; passed empty only
            // to satisfy deriveClosureRows' shared input shape.
            sessionHealth: [],
        });
        const revertedKeys = new Set(rows.fixChains.map((c) => c.featureKey));

        // Current true-set, loaded by VALUE so we can diff bare keys.
        const existingRaw = (yield* db.query<[Array<string>]>(
            `SELECT VALUE type::string(id) FROM commit WHERE reverted = true;`,
        ))?.[0] ?? [];
        const existing = new Set(
            existingRaw.map((id) => recordKeyPart(id, "commit")).filter((k): k is string => k !== null),
        );

        const stmts: string[] = [];
        for (const k of revertedKeys) {
            if (!existing.has(k)) stmts.push(`UPDATE ${recordLiteral("commit", k)} SET reverted = true;`);
        }
        for (const k of existing) {
            if (!revertedKeys.has(k)) stmts.push(`UPDATE ${recordLiteral("commit", k)} SET reverted = false;`);
        }
        if (stmts.length > 0) {
            yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        }

        return { revertedCount: revertedKeys.size, totalCommits: commits.length };
    });
