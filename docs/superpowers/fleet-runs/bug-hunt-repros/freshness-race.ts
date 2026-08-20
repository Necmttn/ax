import { Effect, Layer } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/node_modules/effect/dist/index.js";
import { BunFileSystem, BunPath } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/node_modules/.bun/@effect+platform-bun@4.0.0-beta.78+1ccbc7ebc433c9b1/node_modules/@effect/platform-bun/dist/index.js";
import { CacheRead, type CacheReadService } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/packages/lib/src/duckdb/seam.ts";
import {
  BackgroundIngestSpawner,
  maybeSpawnBackgroundIngest,
} from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/apps/axctl/src/queries/ingest-staleness.ts";

const calls: number[] = [];
const stale = new Date(Date.now() - 13 * 86_400_000);
const cache = Layer.succeed(CacheRead, {
  snapshotPath: "(race-repro)",
  rows: () => Effect.succeed([{ ended_at: stale, started_at: stale }]),
  first: () => Effect.succeed(null),
  raw: () => Effect.succeed([]),
} as unknown as CacheReadService);
const spawner = Layer.succeed(BackgroundIngestSpawner, {
  spawn: () => Effect.sync(() => { calls.push(Date.now()); }),
});
const layer = Layer.mergeAll(cache, spawner, BunFileSystem.layer, BunPath.layer);

await Effect.runPromise(
  Effect.all(Array.from({ length: 20 }, () => maybeSpawnBackgroundIngest), {
    concurrency: "unbounded",
  }).pipe(Effect.provide(layer)),
);
console.log(`spawn calls: ${calls.length}`);
