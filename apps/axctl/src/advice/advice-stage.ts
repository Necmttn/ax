import { Cause, Effect, Schema } from "effect";
import { cacheRow } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import type { DbError } from "@ax/lib/errors";
import { posixPath } from "@ax/lib/shared/path";
import { BaseStageStats, type IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { runJsonlProviderFiles } from "../ingest/jsonl-work-unit.ts";
import type { JsonlFileCandidate } from "../ingest/walk-jsonl.ts";
import { parseAdviceLog, adviceRowKey } from "./model.ts";

const ADVICE_LOG_SOURCE_KIND = "advice_log";

/** The live advice ledger the tap writes. Older rows move to dated segments. */
export const defaultAdviceLogPath = (): string => `${process.env.HOME}/.ax/hooks/advise-log.jsonl`;

const adviceLogCandidates = (): Effect.Effect<JsonlFileCandidate[]> =>
  Effect.promise(async () => {
    const live = defaultAdviceLogPath();
    const dir = posixPath.dirname(live);
    const glob = new Bun.Glob("advise-log*.jsonl");
    const candidates: JsonlFileCandidate[] = [];
    try {
      for await (const name of glob.scan({ cwd: dir, onlyFiles: true })) {
        const path = posixPath.join(dir, name);
        try {
          const stat = await Bun.file(path).stat();
          candidates.push({ path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
        } catch {}
      }
    } catch {}
    return candidates.sort((a, b) => a.path.localeCompare(b.path));
  });

/**
 * Read the live ledger and its immutable dated segments. Keep rows at/after
 * `since`, and idempotently UPSERT them. Returns the count written. Each file
 * has a two-tier content watermark, so unchanged segments require no read.
 */
export const ingestAdviceLog = (
  write: CacheWriteService,
  since: Date,
): Effect.Effect<number, CacheWriteError | DbError> =>
  Effect.gen(function* () {
    const candidates = yield* adviceLogCandidates();
    let written = 0;
    yield* runJsonlProviderFiles(write, {
      candidates,
      sourceKind: ADVICE_LOG_SOURCE_KIND,
      forceEnv: "AX_REDERIVE_ADVICE",
      source: "advice",
      contentHash: true,
      processFile: (candidate) => Effect.gen(function* () {
        const text = yield* Effect.promise(() => Bun.file(candidate.path).text());
        const rows = parseAdviceLog(text).filter((r) => r.ts.getTime() >= since.getTime());
        if (rows.length > 0) {
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
          written += rows.length;
        }
        return true;
      }),
    });
    return written;
  });

export const AdviceKey = Schema.Literal("advice");
export type AdviceKey = typeof AdviceKey.Type;

export class AdviceStats extends BaseStageStats.extend<AdviceStats>("AdviceStats")({
  advice: Schema.Number,
}) {}

export const adviceStage: StageDef<AdviceStats, never, CacheWriteError> = {
  // Tagged derive for pipeline placement, but it is an external-ledger
  // LOADER (parse) over ~/.ax/hooks/advise-log.jsonl (#893).
  meta: StageMeta.make({
    key: "advice",
    deps: [],
    tags: ["derive"],
    writes: [
      { table: "advice", mode: "parse" },
      { table: "ingest_file_state", mode: "bookkeep" },
    ],
  }),
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
