/**
 * refresh-quota hook
 *
 * Fires at SessionStart (once per session, off the hot path).
 * Responsibilities:
 *   1. Kick off a best-effort background refresh of the quota cache. The
 *      refresh is fire-and-forget: if `ax` isn't on PATH or the spawn fails
 *      for any reason, the error is swallowed and the hook continues with
 *      whatever cache is on disk.
 *   2. Read the quota cache synchronously.
 *   3. Compute the spend mode from the cache.
 *   4. If the mode is splurge, inject a one-line /dojo nudge into the session
 *      context so the model knows to run /dojo.
 *
 * Binary resolution: `ax` may not be on PATH in the hook's spawn environment
 * (the harness fires hooks with a minimal env). The spawn is fully best-effort:
 * any error (ENOENT, non-zero exit) is caught synchronously via a try/catch
 * before the process even starts, and the Promise rejection is caught via
 * .catch(() => {}). The hook never awaits the refresh - it fires and forgets.
 * The actual quota nudge decision is always synchronous against the current
 * cache file, so a failed refresh only means the cache is slightly stale
 * (not a correctness problem; computeSpendMode marks stale → conserve).
 *
 * Run type: Effect.sync → R = never. TypeScript allows assigning R=never to
 * the HookDefinition run type (Effect<Verdict, never, GitEnv>) because a hook
 * that needs no env satisfies the more-constrained signature. Same pattern as
 * route-dispatch.ts.
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
  // No GitEnv needed: all I/O is sync fs + a best-effort fire-and-forget spawn.
  // Effect.sync → R = never, which satisfies HookDefinition's R = GitEnv.
  run: () =>
    Effect.sync(() => {
      // 1. Fire-and-forget cache refresh. Best-effort: any spawn error is
      //    silently swallowed. We do NOT await - the hook returns immediately
      //    after reading the existing cache.
      try {
        Bun.spawn(["ax", "quota", "--fresh"], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited.catch(() => {
          // Non-zero exit or spawn error after process starts - ignore.
        });
      } catch {
        // ENOENT or other synchronous spawn error (`ax` not on PATH) - ignore.
      }

      // 2. Read the current cache synchronously (may be slightly stale if the
      //    refresh above hasn't finished yet; that's intentional - correctness
      //    comes from the staleness check inside computeSpendMode).
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
