import { Cause, Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, recordRef, surrealOptionString } from "@ax/lib/shared/surql";
import { surrealLiteral } from "@ax/lib/json";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { BaseStageStats, type IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { UsageRecord, parseUsageLine } from "./model.ts";
import { defaultUsageLogPath } from "./record.ts";

export const invocationRowKey = (r: UsageRecord): string =>
  Bun.hash(`${r.ts.getTime()}:${r.command}:${r.repo_key ?? ""}:${r.origin}`).toString(16);

export const parseUsageLog = (text: string): UsageRecord[] =>
  text.split("\n").map(parseUsageLine).filter((r): r is UsageRecord => r !== null);

const buildStatements = (rows: ReadonlyArray<UsageRecord>): string[] =>
  rows.map((r) => {
    const id = invocationRowKey(r);
    const flagsJson = surrealLiteral(JSON.stringify([...r.flags]));
    const repo = surrealOptionString(r.repo_key);
    return `UPSERT ${recordRef("ax_invocation", id)} CONTENT { ts: ${surrealDate(r.ts)}, command: ${surrealLiteral(r.command)}, flags: ${flagsJson}, exit_code: ${r.exit_code}, duration_ms: ${r.duration_ms}, origin: ${surrealLiteral(r.origin)}, repo_key: ${repo}, ax_version: ${surrealLiteral(r.ax_version)} };`;
  });

export const ingestUsageLog = (): Effect.Effect<number, DbError, SurrealClient> =>
  Effect.gen(function* () {
    const db = yield* SurrealClient;
    const path = defaultUsageLogPath();
    const text = yield* Effect.promise(async () => {
      const f = Bun.file(path);
      return (await f.exists()) ? await f.text() : "";
    });
    const rows = parseUsageLog(text);
    if (rows.length === 0) return 0;
    yield* executeStatementsWith(db, buildStatements(rows), { chunkSize: 500 });
    yield* Effect.promise(() => Bun.write(path, ""));
    return rows.length;
  });

export const UsageKey = Schema.Literal("usage");
export type UsageKey = typeof UsageKey.Type;

export class UsageStats extends BaseStageStats.extend<UsageStats>("UsageStats")({
  invocations: Schema.Number,
}) {}

export const usageStage: StageDef<UsageStats, SurrealClient> = {
  meta: StageMeta.make({ key: "usage", deps: [], tags: ["derive"] }),
  run: (_ctx: IngestContext) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const n = yield* ingestUsageLog();
      return UsageStats.make({ durationMs: Date.now() - t0, summary: `ingested ${n} invocations`, invocations: n });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`usage stage skipped: ${Cause.pretty(cause)}`).pipe(
          Effect.as(UsageStats.make({ durationMs: 0, summary: "usage skipped (non-fatal)", invocations: 0 })),
        ),
      ),
    ),
};
