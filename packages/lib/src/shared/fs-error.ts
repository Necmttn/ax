import { Effect, type PlatformError } from "effect";

/**
 * True iff a `PlatformError` is "path does not exist" (ENOENT). The wrapper's
 * `reason` is a `BadArgument | SystemError`; only a `SystemError` carries the
 * portable `NotFound` tag, so a `BadArgument` reason returns false here.
 */
export const isNotFound = (e: PlatformError.PlatformError): boolean =>
    e.reason._tag === "NotFound";

/**
 * Recover a NotFound (vanished file) read to `fallback`; RE-RAISE every other
 * `PlatformError` (never swallow IO/permission errors). Composes data-last:
 *
 * ```ts
 * fs.readDirectory(dir).pipe(skipNotFound([] as string[]))
 * ```
 */
export const skipNotFound =
    <A>(fallback: A) =>
    <B, R>(
        // `B` (the effect's own success type) is inferred from the effect, so a
        // widening fallback composes: `skipNotFound(null)` over an
        // `Effect<FileExtract | null>` yields `Effect<FileExtract | null>`
        // (result is the `B | A` union, here `FileExtract | null | null`).
        eff: Effect.Effect<B, PlatformError.PlatformError, R>,
    ): Effect.Effect<B | A, PlatformError.PlatformError, R> =>
        Effect.catchTag(eff, "PlatformError", (e) =>
            isNotFound(e) ? Effect.succeed(fallback) : Effect.fail(e),
        );
