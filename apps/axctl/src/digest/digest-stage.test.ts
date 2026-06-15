import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";
import { IngestContext } from "../ingest/stage/types.ts";
import { digestStage, DigestStats } from "./digest-stage.ts";

const ctx = IngestContext.make({
  cwd: "/tmp",
  since: new Date(0),
  debug: false,
});

/** A SurrealClient whose every query fails with a typed DbError - simulates a
 *  DB hiccup hit while collecting digest source items. */
const failingDb = Layer.succeed(SurrealClient, {
  query: (_sql: string) =>
    Effect.fail(new DbError({ operation: "query", message: "simulated DB failure" })),
} as never);

/** A SurrealClient whose query *dies* (defect) - simulates the
 *  `catchAll`-bypassing failure mode the review flagged. */
const dyingDb = Layer.succeed(SurrealClient, {
  query: (_sql: string) => Effect.die(new Error("simulated DB defect")),
} as never);

describe("digestStage failure isolation", () => {
  it("a typed DB failure yields Success with 0 items (never aborts ingest)", async () => {
    const exit = await Effect.runPromiseExit(
      digestStage.run(ctx).pipe(Effect.provide(failingDb)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const stats = exit.value as DigestStats;
      expect(stats.items).toBe(0);
      expect(stats.summary).toContain("skipped");
    }
  });

  it("a DB defect (die) is also swallowed - Success with 0 items", async () => {
    const exit = await Effect.runPromiseExit(
      digestStage.run(ctx).pipe(Effect.provide(dyingDb)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const stats = exit.value as DigestStats;
      expect(stats.items).toBe(0);
    }
  });
});
