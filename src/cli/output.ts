/**
 * Shared CLI output helpers used across axctl subcommands.
 */
import { Effect } from "effect";
import { DbError } from "../lib/errors.ts";

/**
 * Detect if a command's output should be JSON.
 * Returns true when --json is present OR when stdout is not a TTY (piped).
 */
export function wantsJson(args: readonly string[]): boolean {
    return args.includes("--json") || process.stdout.isTTY === false;
}

/**
 * Pipe helper: catch a DbError, write the error message to stderr, and exit.
 *
 * Usage:
 *   yield* someEffect.pipe(catchDbErrorAndExit("axctl my-cmd"));
 */
export const catchDbErrorAndExit =
    (prefix: string) =>
    <A, R>(eff: Effect.Effect<A, DbError, R>): Effect.Effect<A, never, R> =>
        eff.pipe(
            Effect.catchTag("DbError", (e) =>
                Effect.promise(async () => {
                    process.stderr.write(`${prefix}: DB error - ${e.message}\n`);
                    process.exit(1);
                }),
            ),
        ) as Effect.Effect<A, never, R>;
