import { Effect, FileSystem, Layer, PlatformError, Stream } from "effect";

/**
 * In-memory `FileSystem` layer for migration tests. Seed a `path -> content`
 * map; reads resolve from it and misses fail with a real `PlatformError`
 * (`reason._tag === "NotFound"`) so the production NotFound-skip catch is
 * exercised honestly. Inject `errors` to simulate non-NotFound failures (e.g.
 * PermissionDenied) and prove they re-raise rather than being swallowed.
 *
 * `stream` deliberately emits content in small (3-byte) chunks so tests
 * exercise `Stream.decodeText`'s cross-chunk buffering for multi-byte UTF-8 -
 * the one place the streaming line reader could diverge from node `readLines`.
 *
 * For NEW tests only. Forced edits to EXISTING tests must use the real
 * `BunFileSystem.layer` against a tmp dir, not this mock (see the migration
 * plan's test-discipline rules).
 */
const notFound = (method: string, path: string): PlatformError.PlatformError =>
    PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
    });

const chunkBytes = (bytes: Uint8Array, size: number): Uint8Array[] => {
    const out: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
    return out;
};

export interface TestFileSystemOptions {
    /** Inject a non-NotFound failure for a path (e.g. PermissionDenied). */
    readonly errors?: Record<string, PlatformError.PlatformError>;
}

export const layerTestFileSystem = (
    files: Record<string, string>,
    opts?: TestFileSystemOptions,
): Layer.Layer<FileSystem.FileSystem> => {
    const encoder = new TextEncoder();
    const injected = (path: string): PlatformError.PlatformError | undefined => opts?.errors?.[path];

    return FileSystem.layerNoop({
        readFileString: (path) => {
            const err = injected(path);
            if (err) return Effect.fail(err);
            return path in files
                ? Effect.succeed(files[path]!)
                : Effect.fail(notFound("readFileString", path));
        },
        readFile: (path) => {
            const err = injected(path);
            if (err) return Effect.fail(err);
            return path in files
                ? Effect.succeed(encoder.encode(files[path]!))
                : Effect.fail(notFound("readFile", path));
        },
        stream: (path) => {
            const err = injected(path);
            if (err) return Stream.fail(err);
            if (!(path in files)) return Stream.fail(notFound("stream", path));
            return Stream.fromIterable(chunkBytes(encoder.encode(files[path]!), 3));
        },
        exists: (path) => Effect.succeed(path in files),
        readDirectory: (dir) => {
            const prefix = dir.endsWith("/") ? dir : `${dir}/`;
            const entries = new Set<string>();
            for (const key of Object.keys(files)) {
                if (key.startsWith(prefix)) {
                    const rest = key.slice(prefix.length);
                    const head = rest.split("/")[0];
                    if (head) entries.add(head);
                }
            }
            return Effect.succeed([...entries]);
        },
    });
};
