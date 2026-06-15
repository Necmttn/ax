import { Cause, Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { BaseStageStats, type IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { buildAndWrite } from "./snapshot.ts";

export const DigestKey = Schema.Literal("digest");
export type DigestKey = typeof DigestKey.Type;

export class DigestStats extends BaseStageStats.extend<DigestStats>("DigestStats")({
  items: Schema.Number,
}) {}

/** Derive-tagged: runs after proposals/metrics, computes + writes ~/.ax/digest.json.
 *  The runner does NOT isolate per-stage failures (it re-raises and aborts the
 *  whole ingest via Effect.forEach), and `writeSnapshot`'s mv-failure throw is a
 *  defect/die, so this stage swallows its OWN failures with `catchCause` (which
 *  recovers from the full cause, defects included): a DB hiccup or a
 *  full/read-only disk on the digest write logs a warning and yields a zero-item
 *  stats row, never failing the surrounding ingest run. */
export const digestStage: StageDef<DigestStats, SurrealClient> = {
  meta: StageMeta.make({ key: "digest", deps: ["proposals", "derive-metrics"], tags: ["derive"] }),
  run: (_ctx: IngestContext) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const snap = yield* buildAndWrite(new Date(), 14);
      return DigestStats.make({
        durationMs: Date.now() - t0,
        summary: `wrote digest with ${snap.items.length} items`,
        items: snap.items.length,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`digest stage skipped: ${Cause.pretty(cause)}`).pipe(
          Effect.as(
            DigestStats.make({ durationMs: 0, summary: "digest skipped (non-fatal)", items: 0 }),
          ),
        ),
      ),
    ),
};
