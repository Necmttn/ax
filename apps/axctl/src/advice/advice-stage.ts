import { Cause, Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, recordRef, surrealOptionString } from "@ax/lib/shared/surql";
import { surrealLiteral } from "@ax/lib/json";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { BaseStageStats, type IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { type AdviceRecord, parseAdviceLog, adviceRowKey } from "./model.ts";

/** The append-only advice ledger the tap writes; survives re-ingest (not truncated). */
export const defaultAdviceLogPath = (): string => `${process.env.HOME}/.ax/hooks/advise-log.jsonl`;

const buildStatements = (rows: ReadonlyArray<AdviceRecord>): string[] =>
  rows.map((r) => {
    const id = adviceRowKey(r);
    // session_id is the CC session UUID, which IS the bare `session` record id
    // for claude main sessions. A dangling ref (session not yet ingested) is
    // fine - the query left-joins.
    const session = r.sessionId ? recordRef("session", r.sessionId) : "NONE";
    return (
      `UPSERT ${recordRef("advice", id)} CONTENT { ` +
      `ts: ${surrealDate(r.ts)}, ` +
      `session: ${session}, ` +
      `tool: ${surrealOptionString(r.tool)}, ` +
      `description: ${surrealOptionString(r.description)}, ` +
      `verdict: ${surrealLiteral(r.verdict)}, ` +
      `advice_text: ${surrealOptionString(r.adviceText)}, ` +
      `suggested_model: ${surrealOptionString(r.suggestedModel)} };`
    );
  });

/**
 * Read the advice ledger, keep rows at/after `since`, and idempotently UPSERT
 * them (stable id from session+ts+description). Returns the count written.
 * since-aware so a windowed `ax ingest --since=N` only touches recent rows; the
 * file is NEVER truncated, so history survives.
 */
export const ingestAdviceLog = (
  since: Date,
): Effect.Effect<number, DbError, SurrealClient> =>
  Effect.gen(function* () {
    const db = yield* SurrealClient;
    const path = defaultAdviceLogPath();
    const text = yield* Effect.promise(async () => {
      const f = Bun.file(path);
      return (await f.exists()) ? await f.text() : "";
    });
    const rows = parseAdviceLog(text).filter((r) => r.ts.getTime() >= since.getTime());
    if (rows.length === 0) return 0;
    yield* executeStatementsWith(db, buildStatements(rows), { chunkSize: 500 });
    return rows.length;
  });

export const AdviceKey = Schema.Literal("advice");
export type AdviceKey = typeof AdviceKey.Type;

export class AdviceStats extends BaseStageStats.extend<AdviceStats>("AdviceStats")({
  advice: Schema.Number,
}) {}

export const adviceStage: StageDef<AdviceStats, SurrealClient> = {
  meta: StageMeta.make({ key: "advice", deps: [], tags: ["derive"] }),
  run: (ctx: IngestContext) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const n = yield* ingestAdviceLog(ctx.since);
      return AdviceStats.make({ durationMs: Date.now() - t0, summary: `ingested ${n} advice rows`, advice: n });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`advice stage skipped: ${Cause.pretty(cause)}`).pipe(
          Effect.as(AdviceStats.make({ durationMs: 0, summary: "advice skipped (non-fatal)", advice: 0 })),
        ),
      ),
    ),
};
