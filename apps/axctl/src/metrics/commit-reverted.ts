import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
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
        const health = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT session, tool_errors, user_corrections, interruptions, context_pressure FROM session_health;`,
        ))?.[0] ?? [];

        const rows = deriveClosureRows({
            commits: commits as never,
            touched: touched as never,
            sessionHealth: health as never,
        });
        const revertedKeys = new Set(rows.fixChains.map((c) => c.featureKey));

        const stmts: string[] = [`UPDATE commit SET reverted = false;`];
        for (const key of revertedKeys) {
            stmts.push(`UPDATE ${recordLiteral("commit", key)} SET reverted = true;`);
        }
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });

        return { revertedCount: revertedKeys.size, totalCommits: commits.length };
    });
