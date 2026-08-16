import { Cause, Effect, Schema } from "effect";
import { cacheRow } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { BaseStageStats, type IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { parseAdviceLog, adviceRowKey } from "./model.ts";

/** The append-only advice ledger the tap writes; survives re-ingest (not truncated). */
export const defaultAdviceLogPath = (): string => `${process.env.HOME}/.ax/hooks/advise-log.jsonl`;

/**
 * Read the advice ledger, keep rows at/after `since`, and idempotently UPSERT
 * them (stable id from session+ts+description). Returns the count written.
 * since-aware so a windowed `ax ingest --since=N` only touches recent rows; the
 * file is NEVER truncated, so history survives.
 */
export const ingestAdviceLog = (
  write: CacheWriteService,
  since: Date,
): Effect.Effect<number, CacheWriteError> =>
  Effect.gen(function* () {
    const path = defaultAdviceLogPath();
    const text = yield* Effect.promise(async () => {
      const f = Bun.file(path);
      return (await f.exists()) ? await f.text() : "";
    });
    const rows = parseAdviceLog(text).filter((r) => r.ts.getTime() >= since.getTime());
    if (rows.length === 0) return 0;
    yield* write.putMany("advice", rows.map((r) => cacheRow({
      id: adviceRowKey(r),
      ts: r.ts,
      session: r.sessionId ?? null,
      tool: r.tool ?? null,
      description: r.description ?? null,
      verdict: r.verdict,
      advice_text: r.adviceText ?? null,
      suggested_model: r.suggestedModel ?? null,
    })));
    return rows.length;
  });

export const AdviceKey = Schema.Literal("advice");
export type AdviceKey = typeof AdviceKey.Type;

export class AdviceStats extends BaseStageStats.extend<AdviceStats>("AdviceStats")({
  advice: Schema.Number,
}) {}

export const adviceStage: StageDef<AdviceStats, never, CacheWriteError> = {
  meta: StageMeta.make({ key: "advice", deps: [], tags: ["derive"] }),
  run: (ctx: IngestContext, write) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const n = yield* ingestAdviceLog(write, ctx.since);
      return AdviceStats.make({ durationMs: Date.now() - t0, summary: `ingested ${n} advice rows`, advice: n });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`advice stage skipped: ${Cause.pretty(cause)}`).pipe(
          Effect.as(AdviceStats.make({ durationMs: 0, summary: "advice skipped (non-fatal)", advice: 0 })),
        ),
      ),
    ),
};
