import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * Crash-safe file write shared by every "reconciling front door" mutator
 * (`ax hooks`, `ax skills`, `ax agents`). The contract:
 *
 *   1. `validate(text)` runs BEFORE any disk touch - a bad payload never
 *      reaches the filesystem, so a half-written config is impossible.
 *   2. content lands in a sibling temp file (`<path>.<pid>.tmp`, same
 *      directory => same filesystem => `rename` is atomic, never EXDEV).
 *   3. the prior file (if any) is copied to `<path>.bak` before the swap, so
 *      a manual rollback is always one `mv` away.
 *   4. the temp file is removed on ANY failure (validation / backup / rename)
 *      via `Effect.ensuring`, leaving no `.tmp` litter.
 *
 * Filesystem failures surface as effect's tagged `PlatformError`; the optional
 * validator contributes its own typed error `E` to the channel.
 */
export interface AtomicWriteOptions<E = never> {
    /** Re-parse / shape-check the payload before writing. Runs first. */
    readonly validate?: (text: string) => Effect.Effect<void, E>;
    /** Copy the existing target to `<path>.bak` before swapping. Default true. */
    readonly backup?: boolean;
}

export const writeFileAtomic = <E = never>(
    path: string,
    text: string,
    options?: AtomicWriteOptions<E>,
): Effect.Effect<void, PlatformError | E, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        // (1) validate before touching disk
        if (options?.validate) yield* options.validate(text);

        const dir = pathSvc.dirname(path);
        const tmp = `${path}.${process.pid}.tmp`;
        const backup = options?.backup ?? true;

        const commit = Effect.gen(function* () {
            yield* fs.makeDirectory(dir, { recursive: true });
            // (2) stage in a sibling temp file
            yield* fs.writeFileString(tmp, text);
            // (3) back up the prior file, if present
            if (backup && (yield* fs.exists(path))) {
                yield* fs.copyFile(path, `${path}.bak`);
            }
            // (4) atomic swap
            yield* fs.rename(tmp, path);
        });

        // remove the temp file on any failure; after a successful rename it is
        // already gone, and `remove` of a missing path is swallowed by `ignore`.
        yield* commit.pipe(
            Effect.ensuring(fs.remove(tmp).pipe(Effect.ignore)),
        );
    });
