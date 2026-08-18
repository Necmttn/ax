/**
 * Load `@duckdb/node-api` over AX'S OWN libduckdb build.
 *
 * The napi driver ships as two layers: `@duckdb/node-api` (pure JS) over
 * `@duckdb/node-bindings` (a `duckdb.node` addon that links
 * `@rpath/libduckdb.dylib` / `$ORIGIN/libduckdb.so`). Stock, the addon loads
 * the OFFICIAL dylib sitting next to it in node_modules - which has ICU (so
 * `CURRENT_TIMESTAMP - INTERVAL` binds, changing semantics every
 * `check:timestamp-cast` guard assumes away) and loads FTS as a DOWNLOADED
 * extension (dead offline). ax's static build (ICU-less, FTS linked in) is a
 * behavior contract, not a packaging detail - so the addon must run against
 * ax's dylib, never the official one.
 *
 * Mechanism (validated by the #880 spike): stage `duckdb.node` NEXT TO ax's
 * dylib in a content-addressed cache dir - the addon's runtime linker looks in
 * its own directory first (`@loader_path` / `$ORIGIN`) - then load the staged
 * addon and hand it to `@duckdb/node-api` in place of the stock binding:
 *
 *  - SOURCE mode: seed `require.cache` under `@duckdb/node-bindings`' resolved
 *    id BEFORE the first import of `@duckdb/node-api`, so its internal
 *    `require("@duckdb/node-bindings")` hits the staged addon. Verified to
 *    take under bun via the ICU fingerprint (spike 6), and re-verified
 *    structurally after every load below.
 *  - COMPILED mode (`bun build --compile`): `require.cache` cannot intercept a
 *    BUNDLED module graph, so the build's bundler plugin replaces
 *    `@duckdb/node-bindings` with a shim reading
 *    `globalThis[AX_NAPI_BINDING_GLOBAL]`, which this module sets before
 *    importing. The addon bytes travel as a `{ type: "file" }` embedded asset
 *    (`nodeBindingAssetPath`), same as the dylib.
 *
 * ONE ENGINE PER PROCESS: the seeded binding is process-global (require.cache
 * and the shim global alike), so the first successful load pins BOTH the
 * addon and the dylib for the life of the process. A later call with the same
 * pair returns the memoized module; a different pair is a typed refusal -
 * silently answering with the previously-loaded engine is the exact
 * wrong-engine failure mode this module exists to prevent.
 *
 * RULING R6 applies: no `node:fs`/`node:path` (`check:no-node-fs`) -
 * filesystem work goes through `FileSystem.FileSystem` + `Bun.file`, path
 * joins through `posixPath`. `node:module`'s `createRequire` is the load
 * mechanism itself and is fine.
 */
import { Effect, FileSystem, type PlatformError } from "effect";
import { createRequire } from "node:module";
import { posixPath } from "../shared/path.ts";
import { stageAndRename } from "../staged-rename.ts";
import { dylibCacheDir } from "./dylib.ts";
import { DuckDbDylibError } from "./errors.ts";
import type * as NodeApi from "@duckdb/node-api";

/** The `@duckdb/node-api` module namespace, as this package consumes it. */
export type DuckDbNodeApi = typeof NodeApi;

/**
 * The global the compiled build's bundler shim reads the staged addon from.
 * Kept as an exported constant so `scripts/build-axctl.ts`'s plugin and this
 * loader can never drift apart on the name.
 */
export const AX_NAPI_BINDING_GLOBAL = "__AX_DUCKDB_NODE_BINDING__";

/** What the staged addon's engine library must be called for the addon's own
 *  runtime linker (`@loader_path` / `$ORIGIN`) to pick it up. */
export const engineLibraryName = (): string =>
    process.platform === "darwin" ? "libduckdb.dylib" : "libduckdb.so";

const requireHere = createRequire(import.meta.url);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const toDylibError =
    (context: string) =>
    (err: PlatformError.PlatformError): DuckDbDylibError =>
        new DuckDbDylibError({ message: `${context}: ${err.message}` });

/**
 * Resolve the on-disk `duckdb.node` for this platform, from the SOURCE tree's
 * node_modules. The platform packages are optionalDependencies of
 * `@duckdb/node-bindings` (not of `@ax/lib`), so resolution must start from
 * the bindings package's own directory - a bare resolve from here only sees
 * `@ax/lib`'s declared deps. Mirrors the platform switch in the bindings
 * package's `duckdb.js`, including the musl fallback, without importing
 * `detect-libc` (trying the glibc name first and falling back covers both).
 */
export const resolveSourceNodeBinding = (): string => {
    const bindingsEntry = requireHere.resolve("@duckdb/node-bindings");
    const requireFromBindings = createRequire(bindingsEntry);
    const key = `${process.platform}-${process.arch}`;
    const candidates = [
        `@duckdb/node-bindings-${key}/duckdb.node`,
        `@duckdb/node-bindings-${key}-musl/duckdb.node`,
    ];
    for (const candidate of candidates) {
        try {
            return requireFromBindings.resolve(candidate);
        } catch {
            /* try the next spelling */
        }
    }
    throw new DuckDbDylibError({
        message:
            `no duckdb.node for ${key}: none of [${candidates.join(", ")}] resolved from ` +
            `${bindingsEntry} - is @duckdb/node-bindings installed for this platform?`,
    });
};

/** First 16 hex chars of sha256 over the given byte buffers, in order - the
 *  content id naming the staged addon+dylib pair. */
const pairDigest = (buffers: ReadonlyArray<ArrayBuffer>): string => {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const b of buffers) hasher.update(new Uint8Array(b));
    return hasher.digest("hex").slice(0, 16);
};

const CACHE_DIR_MODE = 0o700;

const readBytes = (path: string, what: string): Effect.Effect<ArrayBuffer, DuckDbDylibError> =>
    Effect.tryPromise({
        try: () => Bun.file(path).arrayBuffer(),
        catch: (err) =>
            new DuckDbDylibError({ message: `failed to read ${what} at ${path}: ${errorMessage(err)}` }),
    });

/**
 * Materialise `bytes` at `out` unless a byte-identical copy is already there.
 * Same integrity stance as `extractDylib` (dylib.ts): an existing file at the
 * content-addressed path is accepted only after re-hashing it, so a
 * tampered/torn file is silently repaired rather than silently loaded.
 */
const materialize = (
    fs: FileSystem.FileSystem,
    bytes: ArrayBuffer,
    out: string,
): Effect.Effect<void, DuckDbDylibError> =>
    Effect.gen(function* () {
        const exists = yield* fs
            .exists(out)
            .pipe(Effect.mapError(toDylibError(`failed to check for a staged file at ${out}`)));
        if (exists) {
            const onDisk = yield* readBytes(out, "the staged copy");
            if (pairDigest([onDisk]) === pairDigest([bytes])) return;
        }
        yield* stageAndRename<DuckDbDylibError>(out, {
            stage: (staging) =>
                Effect.tryPromise({
                    try: () => Bun.write(staging, bytes),
                    catch: (err) =>
                        new DuckDbDylibError({
                            message: `failed to stage ${out}: ${errorMessage(err)}`,
                        }),
                }),
            onFsError: (step, err) => toDylibError(`failed to publish ${out} (${step})`)(err),
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    });

/**
 * Point `linkPath` at `target` via a symlink, replacing a link that points
 * elsewhere. Two processes racing the same content-addressed stage dir both
 * want the same target, so an EEXIST with a matching target is success.
 */
const ensureSymlink = (
    fs: FileSystem.FileSystem,
    target: string,
    linkPath: string,
): Effect.Effect<void, DuckDbDylibError> =>
    Effect.gen(function* () {
        const current = yield* fs.readLink(linkPath).pipe(
            Effect.match({ onFailure: () => null, onSuccess: (t) => t }),
        );
        if (current === target) return;
        // Whatever occupies the path - a link to an older engine, a full copy
        // from a previous staging scheme, nothing at all - clear it;  the
        // ignore covers the nothing-there case.
        yield* fs.remove(linkPath).pipe(Effect.ignore);
        yield* fs.symlink(target, linkPath).pipe(
            Effect.catch((err) =>
                // A racing process may have created the identical link between
                // our check and our create - accept it iff it matches.
                fs.readLink(linkPath).pipe(
                    Effect.mapError(toDylibError(`failed to link the engine at ${linkPath}`)),
                    Effect.flatMap((t) =>
                        t === target
                            ? Effect.void
                            : Effect.fail(
                                  toDylibError(`failed to link the engine at ${linkPath}`)(err),
                              ),
                    ),
                ),
            ),
        );
    });

/** Load a `.node` addon from an absolute path. `require` handles the `.node`
 *  extension in source mode; a compiled binary has no module filesystem to
 *  resolve against, so fall back to the raw `process.dlopen` it wraps. */
const loadAddon = (nodePath: string): unknown => {
    try {
        return requireHere(nodePath);
    } catch (requireErr) {
        try {
            const mod = { exports: {} as unknown };
            // eslint-disable-next-line
            (process as unknown as { dlopen: (m: unknown, p: string) => void }).dlopen(mod, nodePath);
            return mod.exports;
        } catch (dlopenErr) {
            throw new DuckDbDylibError({
                message:
                    `failed to load the staged duckdb.node at ${nodePath}: ` +
                    `require: ${errorMessage(requireErr)}; dlopen: ${errorMessage(dlopenErr)}`,
            });
        }
    }
};

export interface LoadNodeApiOptions {
    /** ax's libduckdb, already resolved (see `resolveDylibPath`). */
    readonly dylibPath: string;
    /**
     * Where the `duckdb.node` addon bytes come from. Omitted (source mode) -
     * resolved from node_modules via {@link resolveSourceNodeBinding}. Set
     * (compiled mode) - the embedded `{ type: "file" }` asset path threaded
     * from `apps/axctl/src/duckdb-embed.gen.ts`.
     */
    readonly nodeBindingPath?: string | undefined;
    /** Where staged pairs land. Defaults to {@link dylibCacheDir}. */
    readonly cacheDir?: string | undefined;
}

interface LoadedNodeApi {
    readonly dylibPath: string;
    readonly nodeBindingPath: string;
    readonly api: DuckDbNodeApi;
}

/** The process-global load memo - see ONE ENGINE PER PROCESS above. */
let loaded: LoadedNodeApi | null = null;

/** Test-only: forget the memo. The NATIVE state cannot be unloaded, so this
 *  only makes sense in a fresh process or to exercise the conflict refusal. */
export const resetLoadedNodeApiForTests = (): void => {
    loaded = null;
};

const isCompiledLike = (p: string): boolean =>
    p.includes("/$bunfs/") || p.includes("/~BUN/") || p.includes("B:/~BUN/");

/**
 * Stage the addon+dylib pair and load `@duckdb/node-api` over it.
 *
 * `fs` is passed in (not required) for the same reason as everywhere else in
 * this package: the result keeps `R = never` so service methods can call it.
 */
export const loadNodeApiOver = (
    fs: FileSystem.FileSystem,
    options: LoadNodeApiOptions,
): Effect.Effect<DuckDbNodeApi, DuckDbDylibError> =>
    Effect.gen(function* () {
        const dylibPath = options.dylibPath;
        const nodeBindingPath =
            options.nodeBindingPath ??
            (yield* Effect.try({
                try: () => resolveSourceNodeBinding(),
                catch: (err) =>
                    err instanceof DuckDbDylibError
                        ? err
                        : new DuckDbDylibError({
                              message: `failed to resolve duckdb.node: ${errorMessage(err)}`,
                          }),
            }));

        if (loaded !== null) {
            if (loaded.dylibPath === dylibPath && loaded.nodeBindingPath === nodeBindingPath) {
                return loaded.api;
            }
            return yield* new DuckDbDylibError({
                message:
                    `a DuckDB engine is already loaded in this process (addon ${loaded.nodeBindingPath}, ` +
                    `dylib ${loaded.dylibPath}) and cannot be swapped for (${nodeBindingPath}, ${dylibPath}): ` +
                    `the napi binding is process-global. Run the other engine in a separate process.`,
            });
        }

        const nodeBytes = yield* readBytes(nodeBindingPath, "the duckdb.node addon");

        // The stage dir's identity: the addon's CONTENT (small - re-hashed on
        // every open, same integrity stance as extractDylib) plus the dylib's
        // resolved PATH. The dylib itself is SYMLINKED, not copied: it is the
        // exact file the FFI client used to hand to dlopen directly, so a
        // link adds no trust the direct open didn't already place in it - and
        // hashing 46MB of engine on every CLI start is a measurable startup
        // tax for no added protection (the compiled build's dylib is already
        // content-verified by extractDylib before it gets here).
        const cacheDir = options.cacheDir ?? dylibCacheDir();
        const stageDir = posixPath.join(
            cacheDir,
            `napi-${pairDigest([nodeBytes, new TextEncoder().encode(dylibPath).buffer as ArrayBuffer])}`,
        );
        yield* fs
            .makeDirectory(stageDir, { recursive: true, mode: CACHE_DIR_MODE })
            .pipe(Effect.mapError(toDylibError(`failed to create the napi stage dir ${stageDir}`)));

        const stagedNode = posixPath.join(stageDir, "duckdb.node");
        const stagedDylib = posixPath.join(stageDir, engineLibraryName());
        yield* materialize(fs, nodeBytes, stagedNode);
        yield* ensureSymlink(fs, dylibPath, stagedDylib);

        const api = yield* Effect.tryPromise({
            try: async () => {
                const binding = loadAddon(stagedNode);

                // Compiled path: the bundler shim reads this global.
                (globalThis as Record<string, unknown>)[AX_NAPI_BINDING_GLOBAL] = binding;

                // Source path: seed require.cache under the id node-api's own
                // `require("@duckdb/node-bindings")` resolves to. Skipped in a
                // compiled binary, where that resolve has no filesystem to hit
                // (the bundled graph goes through the shim instead).
                let bindingsId: string | null = null;
                if (!isCompiledLike(import.meta.url)) {
                    bindingsId = requireHere.resolve("@duckdb/node-bindings");
                    requireHere.cache[bindingsId] = {
                        id: bindingsId,
                        filename: bindingsId,
                        loaded: true,
                        exports: binding,
                    } as never;
                }

                const mod = (await import("@duckdb/node-api")) as DuckDbNodeApi;

                // The seed must have TAKEN: if bun resolved the real bindings
                // module instead of the cache entry, node-api is now wired to
                // the OFFICIAL engine - the silent wrong-engine outcome this
                // module exists to prevent. Refuse loudly instead.
                if (bindingsId !== null) {
                    const entry = requireHere.cache[bindingsId] as { exports?: unknown } | undefined;
                    if (entry?.exports !== binding) {
                        throw new DuckDbDylibError({
                            message:
                                "require.cache seeding of @duckdb/node-bindings did not take: " +
                                "@duckdb/node-api loaded the stock binding (official libduckdb), " +
                                "not ax's staged engine. Refusing to run on the wrong engine.",
                        });
                    }
                }
                if (typeof mod.DuckDBInstance?.create !== "function") {
                    throw new DuckDbDylibError({
                        message: "@duckdb/node-api loaded without DuckDBInstance.create - broken install?",
                    });
                }
                return mod;
            },
            catch: (err) =>
                err instanceof DuckDbDylibError
                    ? err
                    : new DuckDbDylibError({
                          message: `failed to load @duckdb/node-api over ${stagedNode}: ${errorMessage(err)}`,
                      }),
        });

        loaded = { dylibPath, nodeBindingPath, api };
        return api;
    });
