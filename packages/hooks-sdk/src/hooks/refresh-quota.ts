/**
 * refresh-quota hook
 *
 * Fires at SessionStart (once per session, off the hot path).
 * Responsibilities:
 *   1. AWAIT a best-effort refresh of the quota cache (`ax quota --fresh`).
 *      This MUST complete before the read - otherwise readQuotaCacheSync runs
 *      in the same tick and beats the network fetch, so a cold/stale cache
 *      would make the SessionStart splurge nudge read the pre-refresh cache
 *      and never fire (exactly when it should). SessionStart is off the hot
 *      path, so the ~hundreds-of-ms refresh latency is acceptable per spec.
 *   2. Read the (now-refreshed) quota cache synchronously.
 *   3. Compute the spend mode from the cache.
 *   4. If the mode is splurge, inject a one-line /dojo nudge into the session
 *      context so the model knows to run /dojo.
 *
 * Binary resolution: `ax` may not be on PATH in the hook's spawn environment
 * (the harness fires hooks with a minimal env). The refresh is fail-open: the
 * spawn's `.exited` promise is `.catch(() => undefined)`'d, so ENOENT / non-zero
 * exit / spawn errors resolve to `undefined` instead of rejecting. Wrapping that
 * already-caught promise in `Effect.promise` yields E = never, R = never - it can
 * never fail the hook. If the refresh fails, the hook just reads whatever cache
 * exists; computeSpendMode marks a stale/missing cache → conserve.
 *
 * Run type: Effect.gen → E = never, R = never (the only yielded effect is the
 * non-failing Effect.promise above). This satisfies the HookDefinition run type
 * (Effect<Verdict, never, GitEnv>) - a hook that needs no env is assignable to
 * the more-constrained signature.
 */
import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { Verdict } from "../verdict.ts";
import {
  computeSpendMode,
  DEFAULT_SPEND_CONFIG,
  defaultQuotaCachePath,
  readQuotaCacheSync,
  type SpendModeResult,
} from "../spend-mode.ts";

// ---------------------------------------------------------------------------
// Pure, testable nudge decision
// ---------------------------------------------------------------------------

/**
 * Given a spend mode result and the budget facts, return the /dojo nudge
 * string for splurge mode or null otherwise.
 *
 * Pure fn: no I/O, no Effect - safe to unit-test in isolation.
 */
export const spendNudge = (
  r: SpendModeResult,
  facts: { remainingPct: number; hoursToReset: number },
): string | null =>
  r.mode === "splurge"
    ? `splurge window: ~${facts.remainingPct}% of your 7d budget resets in ${facts.hoursToReset}h - run /dojo to spend it on self-improvement.`
    : null;

// ---------------------------------------------------------------------------
// Hook definition
// ---------------------------------------------------------------------------

const hook = defineHook({
  name: "refresh-quota",
  events: ["SessionStart"],
  // No tool matcher: SessionStart is a non-tool event.
  // No GitEnv needed: the only yielded effect is a non-failing Effect.promise,
  // so the run effect is E = never, R = never - assignable to R = GitEnv.
  run: () =>
    Effect.gen(function* () {
      // 1. AWAIT a best-effort cache refresh. The `.catch(() => undefined)` makes
      //    the promise never reject (ENOENT / non-zero exit / `ax` not on PATH all
      //    resolve to undefined), so Effect.promise gives E = never. We MUST await
      //    this before the read so the just-fetched cache is on disk.
      yield* Effect.promise(() =>
        Bun.spawn(["ax", "quota", "--fresh"], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited.catch(() => undefined),
      );

      // 2. Read the now-refreshed cache synchronously.
      const snap = readQuotaCacheSync(defaultQuotaCachePath());

      // 3. Compute spend mode.
      const result = computeSpendMode(snap, Date.now(), DEFAULT_SPEND_CONFIG);

      // 4. If splurge + seven_day present, inject the /dojo nudge.
      if (snap?.seven_day && result.mode === "splurge") {
        const remainingPct = Math.round(100 - snap.seven_day.utilization);
        const hoursToReset = Math.max(
          1,
          Math.round((Date.parse(snap.seven_day.resets_at) - Date.now()) / 3_600_000),
        );
        const nudge = spendNudge(result, { remainingPct, hoursToReset });
        if (nudge) return Verdict.inject(nudge);
      }

      return Verdict.allow;
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
