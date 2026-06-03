import { Effect, FileSystem, Layer, Option, PlatformError, Stream } from "effect";

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
    /**
     * Inject a MID-STREAM failure for a path: `stream` emits the seeded content
     * in chunks until at least `afterBytes` bytes have flowed, then fails with
     * `error`. Simulates a file that vanishes / faults part-way through a long
     * read (e.g. a session dir cleaned up while the reader is mid-file), so the
     * mid-stream NotFound-after-partial-flush guard is testable.
     */
    readonly streamFailAfter?: Record<
        string,
        { readonly afterBytes: number; readonly error: PlatformError.PlatformError }
    >;
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
            const chunks = chunkBytes(encoder.encode(files[path]!), 3);
            const failAfter = opts?.streamFailAfter?.[path];
            if (failAfter) {
                // Emit chunks until `afterBytes` bytes have flowed, then fail.
                let flowed = 0;
                const prefix: Uint8Array[] = [];
                for (const chunk of chunks) {
                    if (flowed >= failAfter.afterBytes) break;
                    prefix.push(chunk);
                    flowed += chunk.length;
                }
                return Stream.concat(
                    Stream.fromIterable(prefix),
                    Stream.fail(failAfter.error),
                );
            }
            return Stream.fromIterable(chunks);
        },
        exists: (path) => Effect.succeed(path in files),
        // `stat` infers type from the seeded map: an exact key is a `File`, a
        // path that is a strict prefix of some key is a `Directory`, anything
        // else is NotFound. This lets the transcripts-root directory filter
        // (which skips e.g. a `.DS_Store` File) be tested honestly.
        stat: (path) => {
            const err = injected(path);
            if (err) return Effect.fail(err);
            const info = (type: FileSystem.File.Type): FileSystem.File.Info => ({
                type,
                mtime: Option.none(),
                atime: Option.none(),
                birthtime: Option.none(),
                dev: 0,
                ino: Option.none(),
                mode: 0,
                nlink: Option.none(),
                uid: Option.none(),
                gid: Option.none(),
                rdev: Option.none(),
                size: FileSystem.Size(type === "File" ? files[path]!.length : 0),
                blksize: Option.none(),
                blocks: Option.none(),
            });
            if (path in files) return Effect.succeed(info("File"));
            const prefix = path.endsWith("/") ? path : `${path}/`;
            if (Object.keys(files).some((key) => key.startsWith(prefix))) {
                return Effect.succeed(info("Directory"));
            }
            return Effect.fail(notFound("stat", path));
        },
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
