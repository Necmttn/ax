/**
 * Where libduckdb comes from at runtime.
 *
 * Source mode (`bun run`): the asset path is already a real file, hand it back.
 * Compiled mode (`bun build --compile`): the asset lives in the binary's
 * virtual filesystem, and `dlopen` cannot open a `$bunfs` path - the bytes must
 * be materialised on disk first. They go to a CONTENT-HASH path so a given
 * binary extracts once and every later run (and every concurrent process)
 * reuses the same file. Mirrors the studio-embed pattern in
 * `scripts/gen-studio-embed.ts`.
 *
 * `AX_DUCKDB_DYLIB` overrides everything - it is how tests, and later the
 * custom static dylib from chunk w0-dylib-ci, inject their own build.
 *
 * RULING R6: this is a runtime module under `packages/lib/src/`, so
 * `node:fs` / `node:path` are banned (`check:no-node-fs`). Filesystem access
 * goes through `FileSystem.FileSystem`; path joins go through `posixPath`
 * (`@ax/lib/shared/path`). `node:os#homedir` is not banned and stays.
 */
import { Effect, FileSystem, type PlatformError } from "effect";
import { homedir } from "node:os";
import { posixPath } from "../shared/path.ts";
import { stageAndRename } from "../staged-rename.ts";
import { DuckDbDylibError } from "./errors.ts";

export interface ResolveDylibOptions {
    /** The bundled asset path (a `{ type: "file" }` import in compiled mode). */
    readonly assetPath?: string;
    /** Where extracted copies land. Defaults to {@link dylibCacheDir}. */
    readonly cacheDir?: string;
}

/** `~/.ax/cache/duckdb` (honours `AX_DATA_DIR`, like the serve pidfile). */
export const dylibCacheDir = (): string => {
    const base = process.env.AX_DATA_DIR?.trim();
    return base
        ? posixPath.join(base, "duckdb")
        : posixPath.join(homedir(), ".ax", "cache", "duckdb");
};

/** Is this path inside a compiled binary's virtual filesystem? */
export const isEmbeddedPath = (p: string): boolean =>
    p.startsWith("/$bunfs/") || p.startsWith("B:/~BUN/") || p.startsWith("/~BUN/");

/** Map a `PlatformError` into this module's own typed failure. */
const toDylibError =
    (context: string) =>
    (err: PlatformError.PlatformError): DuckDbDylibError =>
        new DuckDbDylibError({ message: `${context}: ${err.message}` });

/** First 16 hex chars of the sha256 over `bytes` - the content id that names
 *  the extraction path. */
const contentDigest = (bytes: ArrayBuffer): string => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new Uint8Array(bytes));
    return hasher.digest("hex").slice(0, 16);
};

/** Cache dir is owner-only (0700); the published dylib is read-only (0400). */
const CACHE_DIR_MODE = 0o700;
const DYLIB_FILE_MODE = 0o400;

/**
 * Materialise `embeddedPath`'s bytes at `<cacheDir>/<sha256-16>-libduckdb`,
 * reusing an existing extraction ONLY when the on-disk bytes still hash to the
 * same content id.
 *
 * Integrity (adversarial P2): the path is a CONTENT hash, so a rebuilt binary
 * with a new dylib gets a new path instead of racing the old one. But the reuse
 * branch must NOT blindly `dlopen` whatever sits at that predictable path - a
 * same-user process could plant a malicious library there and turn the next run
 * into an RCE. So reuse re-hashes the file on disk and accepts it only on a
 * digest match; a mismatch (tamper / truncated write) falls through and
 * re-extracts the trusted embedded bytes over it. The cache dir is created
 * owner-only (0700) and the published file is read-only (0400) to narrow the
 * window further.
 *
 * Concurrency: when extraction IS needed the bytes are staged at a
 * uniquely-suffixed sibling and published with `fs.rename` (same directory, so
 * the rename is atomic on every platform this runs on) - two processes racing
 * the same content hash both stage under distinct names and both rename onto the
 * same `out` path; since the bytes are identical (same content hash), whichever
 * rename lands last still produces the correct file, and neither process can
 * observe a partially written dylib.
 */
export const extractDylib = (
    embeddedPath: string,
    cacheDir: string,
): Effect.Effect<string, DuckDbDylibError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const bytes = yield* Effect.tryPromise({
            try: () => Bun.file(embeddedPath).arrayBuffer(),
            catch: (err) =>
                new DuckDbDylibError({
                    message: `failed to read the embedded dylib bytes at ${embeddedPath}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                }),
        });

        const digest = yield* Effect.sync(() => contentDigest(bytes));

        const out = posixPath.join(cacheDir, `${digest}-libduckdb`);

        const alreadyExtracted = yield* fs
            .exists(out)
            .pipe(Effect.mapError(toDylibError(`failed to check for an existing extraction at ${out}`)));
        if (alreadyExtracted) {
            // Re-hash the on-disk file: accept the cached copy ONLY if its bytes
            // still match the content id in its name. A mismatch means the file
            // was tampered with (or a torn write) - re-extract the trusted bytes.
            const onDisk = yield* Effect.tryPromise({
                try: () => Bun.file(out).arrayBuffer(),
                catch: (err) =>
                    new DuckDbDylibError({
                        message: `failed to re-hash the cached dylib at ${out}: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    }),
            });
            if (contentDigest(onDisk) === digest) return out;
            // else: fall through and re-extract over the tampered/torn file.
        }

        yield* fs
            .makeDirectory(cacheDir, { recursive: true, mode: CACHE_DIR_MODE })
            .pipe(Effect.mapError(toDylibError(`failed to create the dylib cache dir ${cacheDir}`)));

        // Stage in a uniquely-named sibling and rename, so a concurrent reader
        // can never observe a half-written dylib, and the staging file is
        // removed on every failure path. That whole dance - including the
        // pid+uuid naming that cross-review P3-3 established (a pid-only suffix
        // is not unique WITHIN a process, so two fibers extracting the same
        // content hash shared one staging path and could rename or remove the
        // file the other was still writing) - is `stageAndRename`.
        yield* stageAndRename<DuckDbDylibError>(out, {
            stage: (staging) =>
                Effect.tryPromise({
                    try: () => Bun.write(staging, bytes),
                    catch: (err) =>
                        new DuckDbDylibError({
                            message: `failed to stage the extracted dylib at ${staging}: ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        }),
                }),
            // Publish read-only so a later same-user process cannot overwrite the
            // trusted bytes in place (a fresh extraction still renames over it -
            // rename needs write on the DIR, not the file). Best-effort: a chmod
            // failure must not fail the whole open - the reuse re-hash above is
            // the actual integrity gate.
            afterRename: fs.chmod(out, DYLIB_FILE_MODE).pipe(Effect.ignore),
            onFsError: (step, err) =>
                toDylibError(`failed to publish the extracted dylib to ${out} (${step})`)(err),
        });

        return out;
    });

/**
 * Resolve the libduckdb path to hand to `dlopen`. Order:
 *   1. `AX_DUCKDB_DYLIB` - explicit override; fails if it points nowhere.
 *   2. `options.assetPath` - the bundled asset. If it is a real on-disk file
 *      (source mode), hand it back unchanged. If it lives in `$bunfs`
 *      (compiled mode), extract it first.
 *   3. Neither is set - a typed failure naming both knobs.
 */
export const resolveDylibPath = (
    options?: ResolveDylibOptions,
): Effect.Effect<string, DuckDbDylibError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const injected = process.env.AX_DUCKDB_DYLIB?.trim();
        if (injected) {
            const exists = yield* fs
                .exists(injected)
                .pipe(Effect.mapError(toDylibError(`failed to check AX_DUCKDB_DYLIB at ${injected}`)));
            if (exists) return injected;
            return yield* new DuckDbDylibError({
                message: `AX_DUCKDB_DYLIB points at a missing file: ${injected}`,
            });
        }

        const asset = options?.assetPath;
        if (asset === undefined) {
            return yield* new DuckDbDylibError({
                message:
                    "no libduckdb available: set AX_DUCKDB_DYLIB, or pass assetPath from the embedded build",
            });
        }

        if (!isEmbeddedPath(asset)) {
            const exists = yield* fs
                .exists(asset)
                .pipe(Effect.mapError(toDylibError(`failed to check the bundled asset path ${asset}`)));
            if (exists) return asset;
            return yield* new DuckDbDylibError({ message: `libduckdb not found at ${asset}` });
        }

        return yield* extractDylib(asset, options?.cacheDir ?? dylibCacheDir());
    });
