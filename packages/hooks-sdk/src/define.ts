import { Effect } from "effect";
import { decodeHookInput } from "./adapters/decode.ts";
import { encodeVerdict, type ProcessOutcome } from "./adapters/encode.ts";
import type { HookEvent, HookEventName } from "./event.ts";
import { GitEnv, GitEnvLive } from "./git-env.ts";
import { Verdict } from "./verdict.ts";

export interface HookDefinition {
  readonly name: string;
  readonly events: ReadonlyArray<HookEventName>;
  /** tool-name filter; omitted = all tools (and non-tool events). */
  readonly matcher?: { readonly tools?: ReadonlyArray<string> };
  readonly run: (event: HookEvent) => Effect.Effect<Verdict, never, GitEnv>;
}

/** Identity with types - gives hook files inference + a stable metadata shape
 *  that `ax hooks install` and `ax hooks backtest` import. */
export const defineHook = (def: HookDefinition): HookDefinition => def;

/** True when `event` passes the hook's event + tool matcher. */
export const matches = (def: HookDefinition, event: HookEvent): boolean => {
  if (!(def.events as ReadonlyArray<string>).includes(event.event)) return false;
  const tools = def.matcher?.tools;
  if (tools && tools.length > 0) {
    if (event.tool === null) return false;
    if (!tools.includes(event.tool.name)) return false;
  }
  return true;
};

/** Decode → match → run → encode. Defects fail OPEN (allow): a buggy hook
 *  must never wedge the agent. */
export const runHook = (
  def: HookDefinition,
  stdinText: string,
  env: Record<string, string | undefined>,
): Effect.Effect<ProcessOutcome, never, GitEnv> =>
  Effect.gen(function* () {
    const event = decodeHookInput(stdinText, env);
    if (!matches(def, event)) return encodeVerdict(Verdict.allow, event.harness);
    const verdict = yield* def.run(event).pipe(
      Effect.catchDefect(() => Effect.succeed(Verdict.allow)),
    );
    return encodeVerdict(verdict, event.harness);
  });

/** Process entrypoint for `bun <hook>.ts`. Call under `import.meta.main`. */
export const runMain = async (def: HookDefinition): Promise<void> => {
  if (process.stdin.isTTY) {
    process.stderr.write(`${def.name}: hook expects JSON on stdin (see @ax/hooks-sdk)\n`);
    process.exit(0);
  }
  const stdinText = await Bun.stdin.text();
  const outcome = await Effect.runPromise(
    runHook(def, stdinText, process.env as Record<string, string | undefined>).pipe(
      Effect.provide(GitEnvLive),
    ),
  );
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exit(outcome.exitCode);
};
