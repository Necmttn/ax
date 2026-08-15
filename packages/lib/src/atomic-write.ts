import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { stageAndRename } from "./staged-rename.ts";

/**
 * Crash-safe file write shared by every "reconciling front door" mutator
 * (`ax hooks`, `ax skills`, `ax agents`). The contract:
 *
 *   1. `validate(text)` runs BEFORE any disk touch - a bad payload never
 *      reaches the filesystem, so a half-written config is impossible.
 *   2. content lands in a sibling temp file (same directory => same filesystem
 *      => `rename` is atomic, never EXDEV).
 *   3. the prior file (if any) is copied to `<path>.bak` before the swap, so
 *      a manual rollback is always one `mv` away.
 *   4. the temp file is removed on ANY failure (validation / backup / rename),
 *      leaving no `.tmp` litter.
 *
 * Steps 2 and 4 - and the parent-directory creation - are `stageAndRename`
 * (`@ax/lib/staged-rename`), shared with the dylib extractor and the snapshot
 * publisher. What stays here is what is specific to a config write: validate
 * first, and back up the prior file in the pre-rename window.
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
): Effect.Effect<void, PlatformError | E, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        // (1) validate before touching disk
        if (options?.validate) yield* options.validate(text);

        const backup = options?.backup ?? true;

        yield* stageAndRename<PlatformError | E>(path, {
            // (2) stage in a sibling temp file
            stage: (tmp) => fs.writeFileString(tmp, text),
            // (3) back up the prior file, if present - in the window where the
            //     target is still the OLD file
            beforeRename: () =>
                Effect.gen(function* () {
                    if (backup && (yield* fs.exists(path))) yield* fs.copyFile(path, `${path}.bak`);
                }),
            // (4) atomic swap + temp-file cleanup live in stageAndRename
            onFsError: (_step, err) => err,
        });
    });
