import { Effect, Schema } from "effect";
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
 *  A failure here is logged by the runner and must not affect the preceding ingest. */
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
    }),
};
