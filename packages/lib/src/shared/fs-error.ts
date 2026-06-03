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

/**
 * Best-effort recovery for discovery PROBES and OPTIONAL reads: ANY
 * `PlatformError` (NotFound, permission, EISDIR, IO) recovers to `fallback` and
 * the error is cleared from the E channel. Use ONLY where the operation means
 * "does this exist / read it if present" and any failure legitimately means
 * "treat as absent and continue" - NOT for reads whose failure would silently
 * drop real data (use {@link skipNotFound} there). Composes data-last:
 *
 * ```ts
 * fs.exists(join(p, ".git")).pipe(orAbsent(false))
 * fs.readFileString(optionalConfig).pipe(orAbsent(""))
 * ```
 */
export const orAbsent =
    <A>(fallback: A) =>
    <R>(
        eff: Effect.Effect<A, PlatformError.PlatformError, R>,
    ): Effect.Effect<A, never, R> =>
        Effect.catchTag(eff, "PlatformError", () => Effect.succeed(fallback));
