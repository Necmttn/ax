import { Effect, Schema } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";
import { DigestSnapshot, type DigestItem } from "./model.ts";
import { topForSnapshot } from "./rank.ts";
import { improveItems, costItems, churnItems, quotaToItem } from "./sources.ts";
import { loadQuotaCache, defaultQuotaCachePath } from "../quota/cache.ts";

export const defaultDigestPath = (): string => `${process.env.HOME}/.ax/digest.json`;

/** Pure: rank + cap + stamp. Unit-tested without IO. */
export const assembleSnapshot = (
  items: ReadonlyArray<DigestItem>,
  opts: { now: Date; windowDays: number },
): DigestSnapshot =>
  DigestSnapshot.make({
    generated_at: opts.now,
    window_days: opts.windowDays,
    items: topForSnapshot(items, 8),
  });

/** Collect items from every source (DB sources via Effect; quota via cache). */
export const collectItems = (
  now: Date,
  windowDays: number,
): Effect.Effect<DigestItem[], DbError, SurrealClient> =>
  Effect.gen(function* () {
    const out: DigestItem[] = [];
    out.push(...(yield* improveItems(now)));
    out.push(...(yield* costItems(now, windowDays)));
    out.push(...(yield* churnItems(now, windowDays)));
    const quota = yield* Effect.promise(() => loadQuotaCache(defaultQuotaCachePath()));
    if (quota) {
      const q = quotaToItem({ windowLabel: "7d", pctUsed: quota.seven_day?.utilization ?? 0 }, now);
      if (q) out.push(q);
    }
    return out;
  });

/** Atomic write (tmp + mv); mirrors quota/cache.ts. node:fs is CI-banned. */
export async function writeSnapshot(path: string, snap: DigestSnapshot): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const json = JSON.stringify(Schema.encodeSync(DigestSnapshot)(snap), null, 2);
  await Bun.write(tmp, `${json}\n`, { createPath: true });
  const result = Bun.spawnSync(["mv", tmp, path]);
  if (result.exitCode !== 0) {
    Bun.spawnSync(["rm", "-f", tmp]);
    throw new Error(`writeSnapshot: mv failed (exit ${result.exitCode})`);
  }
}

/** Build + persist the snapshot for the given window. */
export const buildAndWrite = (
  now: Date,
  windowDays: number,
): Effect.Effect<DigestSnapshot, DbError, SurrealClient> =>
  Effect.gen(function* () {
    const items = yield* collectItems(now, windowDays);
    const snap = assembleSnapshot(items, { now, windowDays });
    yield* Effect.promise(() => writeSnapshot(defaultDigestPath(), snap));
    return snap;
  });
