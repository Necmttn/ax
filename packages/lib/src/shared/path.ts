import { Effect, Path } from "effect";

/**
 * A process-wide POSIX `Path` instance for PURE path-string math (join/basename/
 * dirname/resolve/isAbsolute/relative/extname) in code that is synchronous or
 * outside an Effect context. Effect-context code should `yield* Path.Path`
 * instead. One `runSync` repo-wide: `Path` methods are pure string ops and the
 * layer has no real environment, so this side-effect-free extraction is cheap
 * and safe to share across modules.
 */
export const posixPath: Path.Path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
