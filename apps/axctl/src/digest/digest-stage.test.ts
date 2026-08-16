import { describe, expect } from "bun:test";
import { Effect, Exit } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { DuckDbQueryError } from "@ax/lib/duckdb/errors";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { IngestContext } from "../ingest/stage/types.ts";
import { digestStage, DigestStats } from "./digest-stage.ts";
import { EmptyJudgmentTestLayer } from "../testing/judgment-test-layer.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("digest stage", { requireFts: true });
const ctx = IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });

const failingRead = (write: CacheWriteService, defect: boolean): CacheWriteService => ({
  ...write,
  rows: defect
    ? (() => Effect.die(new Error("simulated cache defect")))
    : (() => Effect.fail(new DuckDbQueryError({ sql: "SELECT", message: "simulated cache failure" }))),
}) as CacheWriteService;

describe("digestStage failure isolation with real DuckDB", () => {
  dtest("a typed cache failure returns zero items", async () => {
    let exit: Exit.Exit<unknown, unknown> | undefined;
    await runWithPlatform(publishCacheFixture(tempDir("ax-digest-failure-"), dylibPath, (write) =>
      Effect.gen(function* () {
        exit = yield* Effect.exit(
          digestStage.run(ctx, failingRead(write, false)).pipe(Effect.provide(EmptyJudgmentTestLayer)),
        );
      }),
    ));
    expect(Exit.isSuccess(exit!)).toBe(true);
    if (Exit.isSuccess(exit!)) {
      const stats = exit.value as DigestStats;
      expect(stats.items).toBe(0);
      expect(stats.summary).toContain("skipped");
    }
  });

  dtest("a cache defect also returns zero items", async () => {
    let exit: Exit.Exit<unknown, unknown> | undefined;
    await runWithPlatform(publishCacheFixture(tempDir("ax-digest-defect-"), dylibPath, (write) =>
      Effect.gen(function* () {
        exit = yield* Effect.exit(
          digestStage.run(ctx, failingRead(write, true)).pipe(Effect.provide(EmptyJudgmentTestLayer)),
        );
      }),
    ));
    expect(Exit.isSuccess(exit!)).toBe(true);
    if (Exit.isSuccess(exit!)) expect((exit.value as DigestStats).items).toBe(0);
  });
});
