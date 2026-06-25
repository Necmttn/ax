import { Effect } from "effect";
import { decodeHookInput } from "./adapters/decode.ts";
import { encodeVerdict, type ProcessOutcome } from "./adapters/encode.ts";
import { matches, type HookDefinition } from "./define.ts";
import { GitEnv, GitEnvLive } from "./git-env.ts";
import { mergeVerdicts } from "./merge-verdicts.ts";
import { Verdict } from "./verdict.ts";

import enforceWorktree from "./hooks/enforce-worktree.ts";
import enforceWorktreeWrite from "./hooks/enforce-worktree-write.ts";
import routeDispatch from "./hooks/route-dispatch.ts";
import refreshQuota from "./hooks/refresh-quota.ts";

/**
 * Every guard the dispatcher multiplexes, in a stable order (mirrors
 * GUARD_NAMES). Importing a guard module does NOT self-run it: the
 * `if (import.meta.main)` arm in each file is false when it is imported rather
 * than spawned directly, so this registry is side-effect-free.
 */
export const ALL_GUARDS: ReadonlyArray<HookDefinition> = [
  enforceWorktree,
  enforceWorktreeWrite,
  routeDispatch,
  refreshQuota,
];

/**
 * Decode the event once, run every guard whose matcher applies, and fold the
 * verdicts into one ProcessOutcome. This is the shared brain for both the
 * spawned-bundle path (`bun dispatch.js`) and - later - a daemon `/hooks/eval`
 * endpoint: a single decode + N in-process guard runs, no per-guard process.
 *
 * Each guard's defects fail OPEN independently (one buggy guard can't wedge the
 * agent or suppress the others); `mergeVerdicts` then applies block-wins
 * precedence across the survivors.
 */
export const dispatchEvent = (
  stdinText: string,
  env: Record<string, string | undefined>,
  guards: ReadonlyArray<HookDefinition> = ALL_GUARDS,
): Effect.Effect<ProcessOutcome, never, GitEnv> =>
  Effect.gen(function* () {
    const event = decodeHookInput(stdinText, env);
    const verdicts: Verdict[] = [];
    for (const guard of guards) {
      if (!matches(guard, event)) continue;
      const verdict = yield* guard
        .run(event)
        .pipe(Effect.catchDefect(() => Effect.succeed(Verdict.allow)));
      verdicts.push(verdict);
    }
    return encodeVerdict(mergeVerdicts(verdicts), event.harness);
  });

/** One provider hook entry the dispatcher must be registered for: an event and
 *  the tool-name filter (null = no matcher = every tool / non-tool event). */
export interface DispatchInstallEntry {
  readonly event: string;
  readonly tools: ReadonlyArray<string> | null;
}

/**
 * Compute the minimal set of provider hook entries that route every guard's
 * events to the single dispatcher. Guards are grouped by event; within an
 * event the tool matchers are UNION-ed, and a guard with no matcher (matches
 * all tools, e.g. a SessionStart guard) collapses that event to `tools: null`
 * (no filter). This keeps the dispatcher from firing on tools no guard cares
 * about (vs. installing it matcher-less on every PreToolUse). Order follows the
 * guard registry, so the plan is deterministic.
 */
export const dispatchInstallPlan = (
  guards: ReadonlyArray<HookDefinition> = ALL_GUARDS,
): ReadonlyArray<DispatchInstallEntry> => {
  const byEvent = new Map<string, { tools: Set<string>; all: boolean }>();
  for (const guard of guards) {
    for (const event of guard.events) {
      const slot = byEvent.get(event) ?? { tools: new Set<string>(), all: false };
      const tools = guard.matcher?.tools;
      if (!tools || tools.length === 0) slot.all = true;
      else for (const t of tools) slot.tools.add(t);
      byEvent.set(event, slot);
    }
  }
  return [...byEvent.entries()].map(([event, slot]) => ({
    event,
    tools: slot.all ? null : [...slot.tools],
  }));
};

/**
 * Process entrypoint for `bun dispatch.js`. Mirrors `runMain` but multiplexes
 * the whole guard set in one spawn. Reads stdin, runs the guards against the
 * agent's own env + live git, emits the merged outcome, exits.
 */
/**
 * Run the dispatcher against an ALREADY-READ stdin string, emit the merged
 * outcome, exit. This is the daemon shim's fallback entry: when the daemon is
 * down the shim has already consumed stdin, so it hands the text here rather
 * than re-reading it. Pulls effect/GitEnvLive (the slow path) on purpose.
 */
export const runDispatchFromStdin = async (
  stdinText: string,
  guards: ReadonlyArray<HookDefinition> = ALL_GUARDS,
): Promise<void> => {
  const outcome = await Effect.runPromise(
    dispatchEvent(stdinText, process.env as Record<string, string | undefined>, guards).pipe(
      Effect.provide(GitEnvLive),
    ),
  );
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exit(outcome.exitCode);
};

export const runDispatchMain = async (
  guards: ReadonlyArray<HookDefinition> = ALL_GUARDS,
): Promise<void> => {
  if (process.stdin.isTTY) {
    process.stderr.write("ax hook dispatcher expects JSON on stdin (see @ax/hooks-sdk)\n");
    process.exit(0);
  }
  const stdinText = await Bun.stdin.text();
  await runDispatchFromStdin(stdinText, guards);
};

if (import.meta.main) void runDispatchMain();
