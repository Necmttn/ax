/**
 * The hook-effect vocabulary, in one dependency-free place.
 *
 * `hook_command_invocation.effect` is written by the claude transcript parser
 * (`apps/axctl/src/ingest/transcripts.ts` owns the full `HookEffect` union) and
 * read by several derivations. Only FOUR of its values mean the hook actually
 * did something to the run; `allowed`, `no_op` and `unknown` are fires with no
 * observed consequence, and a hook that passes silently is written nowhere at
 * all, so its absence is not evidence either way.
 *
 * This module exists so a reader needing those four strings does not import the
 * whole parser to get them - and so nobody writes a second, drifting list. It
 * has no imports on purpose: `packages/lib` cannot depend on `apps/*`, and the
 * parser side asserts compatibility with a TYPE-only import back to here.
 */

export const REAL_HOOK_EFFECTS = [
    "blocked",
    "injected_context",
    "modified_input",
    "notified",
] as const;

/** One of the four effects that count as a real intervention. */
export type RealHookEffect = (typeof REAL_HOOK_EFFECTS)[number];

/** Does this stored `effect` value name a real intervention? */
export const isRealHookEffect = (effect: string): effect is RealHookEffect =>
    (REAL_HOOK_EFFECTS as ReadonlyArray<string>).includes(effect);
