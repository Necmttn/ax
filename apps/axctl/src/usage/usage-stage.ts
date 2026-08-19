import { Cause, Effect, Schema } from "effect";
import { cacheRow, jsonParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { BaseStageStats, type IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { UsageRecord, parseUsageLine } from "./model.ts";
import { defaultUsageLogPath } from "./record.ts";

export const invocationRowKey = (r: UsageRecord): string =>
  Bun.hash(`${r.ts.getTime()}:${r.command}:${r.repo_key ?? ""}:${r.origin}`).toString(16);

export const parseUsageLog = (text: string): UsageRecord[] =>
  text.split("\n").map(parseUsageLine).filter((r): r is UsageRecord => r !== null);

export const ingestUsageLog = (write: CacheWriteService): Effect.Effect<number, CacheWriteError> =>
  Effect.gen(function* () {
    const path = defaultUsageLogPath();
    const text = yield* Effect.promise(async () => {
      const f = Bun.file(path);
      return (await f.exists()) ? await f.text() : "";
    });
    const rows = parseUsageLog(text);
    if (rows.length === 0) return 0;
    yield* write.putMany("ax_invocation", rows.map((r) => cacheRow({
      id: invocationRowKey(r),
      ts: r.ts,
      command: r.command,
      flags: jsonParam([...r.flags]),
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      origin: r.origin,
      repo_key: r.repo_key ?? null,
      ax_version: r.ax_version,
    })));
    yield* Effect.promise(() => Bun.write(path, ""));
    return rows.length;
  });

export const UsageKey = Schema.Literal("usage");
export type UsageKey = typeof UsageKey.Type;

export class UsageStats extends BaseStageStats.extend<UsageStats>("UsageStats")({
  invocations: Schema.Number,
}) {}

export const usageStage: StageDef<UsageStats, never, CacheWriteError> = {
  // Tagged derive for pipeline placement, but it is an external-ledger
  // LOADER (parse): it drains + truncates the usage log, so these cache rows
  // are the only durable copy (#893).
  meta: StageMeta.make({ key: "usage", deps: [], tags: ["derive"], writes: [{ table: "ax_invocation", mode: "parse" }] }),
  run: (_ctx: IngestContext, write) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const n = yield* ingestUsageLog(write);
      return UsageStats.make({ durationMs: Date.now() - t0, summary: `ingested ${n} invocations`, invocations: n });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`usage stage skipped: ${Cause.pretty(cause)}`).pipe(
          Effect.as(UsageStats.make({ durationMs: 0, summary: "usage skipped (non-fatal)", invocations: 0 })),
        ),
      ),
    ),
};
