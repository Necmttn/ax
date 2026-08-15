import { homedir } from "node:os";
import { Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import { withIngestLock } from "@ax/lib/ingest-lock";

export const HOOK_FIRE_SPOOL_FILE = "hook-fire.jsonl";
export const HOOK_FIRE_SPOOL_ROTATED_FILE = "hook-fire.1.jsonl";
export const HOOK_FIRE_SPOOL_LOCK_FILE = "hook-fire.lock";
export const HOOK_FIRE_SPOOL_MAX_BYTES = 1024 * 1024;
export const HOOK_FIRE_SPOOL_MAX_RECORD_BYTES = 64 * 1024;

export class HookFireSpoolError extends Schema.TaggedErrorClass<HookFireSpoolError>("HookFireSpoolError")(
    "HookFireSpoolError",
    {
        message: Schema.String,
        cause: Schema.Defect(),
    },
) {}

export const HookFireSpoolRow = Schema.Struct({
    id: Schema.String,
    ts: Schema.String,
    kind: Schema.Literal("hook_fire"),
    session: Schema.NullOr(Schema.String),
    file: Schema.NullOr(Schema.String),
    file_path: Schema.String,
    harness: Schema.Literals(["claude", "codex", "unknown"]),
    ok: Schema.Boolean,
    latency_ms: Schema.Finite,
    event: Schema.Literals(["pre-edit", "read", "write", "search", "unknown"]),
    inject: Schema.Boolean,
    reason: Schema.String,
    prior_sessions_considered: Schema.Finite,
    task_excerpt: Schema.String,
    top_prior_sessions: Schema.Array(Schema.String),
    injected_titles: Schema.Array(Schema.String),
});
export type HookFireSpoolRow = typeof HookFireSpoolRow.Type;

export const HookFireSpoolEnvelope = Schema.Struct({
    v: Schema.Literal(1),
    row: HookFireSpoolRow,
});
export type HookFireSpoolEnvelope = typeof HookFireSpoolEnvelope.Type;
export const HookFireSpoolJson = Schema.fromJsonString(HookFireSpoolEnvelope);

export const defaultHookFireSpoolDir = (): string => process.env.AX_HOOK_SPOOL_DIR ?? `${homedir()}/.ax/hooks/spool`;

export interface AppendHookFireSpoolOptions {
    readonly spoolDir?: string;
    readonly maxBytes?: number;
    readonly maxRecordBytes?: number;
}

export interface HookFireSpoolSnapshotFile {
    readonly name: typeof HOOK_FIRE_SPOOL_FILE | typeof HOOK_FIRE_SPOOL_ROTATED_FILE;
    readonly text: string;
}

export interface SnapshotHookFireSpoolOptions {
    readonly spoolDir?: string;
    /** Test seam for a forced rotation race. Production does not set it. */
    readonly afterRead?: (name: HookFireSpoolSnapshotFile["name"]) => Effect.Effect<void>;
}

const toSpoolError =
    (message: string) =>
    (cause: PlatformError.PlatformError): HookFireSpoolError =>
        new HookFireSpoolError({ message: `${message}: ${cause.message}`, cause });

/** Append one complete record and sync it before the hook continues. */
const appendHookFireSpoolUnlocked = (
    row: HookFireSpoolRow,
    options: AppendHookFireSpoolOptions = {},
): Effect.Effect<void, HookFireSpoolError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spoolDir = options.spoolDir ?? defaultHookFireSpoolDir();
        const activePath = path.join(spoolDir, HOOK_FIRE_SPOOL_FILE);
        const rotatedPath = path.join(spoolDir, HOOK_FIRE_SPOOL_ROTATED_FILE);
        const maxBytes = options.maxBytes ?? HOOK_FIRE_SPOOL_MAX_BYTES;
        const maxRecordBytes = options.maxRecordBytes ?? HOOK_FIRE_SPOOL_MAX_RECORD_BYTES;
        const encoder = new TextEncoder();
        const encoded = yield* Schema.encodeUnknownEffect(HookFireSpoolJson)({
            v: 1,
            row,
        }).pipe(
            Effect.mapError(
                (cause) =>
                    new HookFireSpoolError({
                        message: `could not encode hook fire spool row ${row.id}: ${cause.message}`,
                        cause,
                    }),
            ),
        );
        const record = `${encoded}\n`;
        const recordBytes = encoder.encode(record);

        if (recordBytes.byteLength > maxRecordBytes) {
            return yield* new HookFireSpoolError({
                message: `hook fire spool record is ${recordBytes.byteLength} bytes; limit is ${maxRecordBytes}`,
                cause: row,
            });
        }

        yield* fs
            .makeDirectory(spoolDir, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError(toSpoolError(`could not create hook spool directory ${spoolDir}`)));

        const exists = yield* fs
            .exists(activePath)
            .pipe(Effect.mapError(toSpoolError(`could not inspect hook spool ${activePath}`)));
        let size = 0;
        let needsNewline = false;
        if (exists) {
            const bytes = yield* fs
                .readFile(activePath)
                .pipe(Effect.mapError(toSpoolError(`could not read hook spool ${activePath}`)));
            size = bytes.byteLength;
            needsNewline = size > 0 && bytes[size - 1] !== 0x0a;
        }

        const prefixBytes = needsNewline ? encoder.encode("\n") : new Uint8Array();
        if (exists && size + prefixBytes.byteLength + recordBytes.byteLength > maxBytes) {
            yield* fs
                .remove(rotatedPath, { force: true })
                .pipe(Effect.mapError(toSpoolError(`could not remove old hook spool ${rotatedPath}`)));
            yield* fs
                .rename(activePath, rotatedPath)
                .pipe(Effect.mapError(toSpoolError(`could not rotate hook spool ${activePath}`)));
            size = 0;
            needsNewline = false;
        }

        const bytes = needsNewline ? encoder.encode(`\n${record}`) : recordBytes;
        yield* fs.open(activePath, { flag: "a", mode: 0o600 }).pipe(
            Effect.flatMap((file) => file.writeAll(bytes).pipe(Effect.andThen(file.sync))),
            Effect.scoped,
            Effect.mapError(toSpoolError(`could not sync hook spool ${activePath}`)),
        );
    });

/** Serialize spool operations through a lock that grants no database access. */
export const withHookFireSpoolLock = <A, E, R>(
    spoolDir: string,
    work: Effect.Effect<A, E, R>,
    maxWaitMs: number,
): Effect.Effect<A, E | HookFireSpoolError, R | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const lockPath = path.join(spoolDir, HOOK_FIRE_SPOOL_LOCK_FILE);
        const retryMs = 2;
        const attempts = Math.floor(maxWaitMs / retryMs) + 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const outcome = yield* withIngestLock(
                {
                    lockPath,
                    command: "hook-fire-spool",
                    staleMs: 5_000,
                    onBusy: () => Effect.succeed(false),
                },
                work,
            );
            if (outcome._tag === "completed") return outcome.value;
            if (outcome._tag === "timeout") {
                return yield* new HookFireSpoolError({
                    message: `hook fire spool lock timed out at ${lockPath}`,
                    cause: lockPath,
                });
            }
            if (attempt + 1 < attempts) yield* Effect.sleep(`${retryMs} millis`);
        }
        return yield* new HookFireSpoolError({
            message: `hook fire spool stayed busy for ${maxWaitMs} ms at ${lockPath}`,
            cause: lockPath,
        });
    });

/**
 * Append one row while holding the spool lock.
 *
 * A busy hook retries for at most 20 ms. The request caller then fails open.
 */
export const appendHookFireSpool = (
    row: HookFireSpoolRow,
    options: AppendHookFireSpoolOptions = {},
): Effect.Effect<void, HookFireSpoolError, FileSystem.FileSystem | Path.Path> => {
    const spoolDir = options.spoolDir ?? defaultHookFireSpoolDir();
    return withHookFireSpoolLock(spoolDir, appendHookFireSpoolUnlocked(row, options), 20);
};

/**
 * Copy both retained files into memory under the append lock.
 *
 * The lock is released before a drain writes any row into DuckDB. Rotation can
 * continue while the drain processes this immutable snapshot.
 */
export const snapshotHookFireSpool = (
    options: SnapshotHookFireSpoolOptions = {},
): Effect.Effect<
    ReadonlyArray<HookFireSpoolSnapshotFile>,
    PlatformError.PlatformError | HookFireSpoolError,
    FileSystem.FileSystem | Path.Path
> => {
    const spoolDir = options.spoolDir ?? defaultHookFireSpoolDir();
    return withHookFireSpoolLock(
        spoolDir,
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const files: HookFireSpoolSnapshotFile[] = [];
            for (const name of [HOOK_FIRE_SPOOL_ROTATED_FILE, HOOK_FIRE_SPOOL_FILE] as const) {
                const filePath = path.join(spoolDir, name);
                if (!(yield* fs.exists(filePath))) continue;
                files.push({ name, text: yield* fs.readFileString(filePath) });
                if (options.afterRead !== undefined) yield* options.afterRead(name);
            }
            return files;
        }),
        1_000,
    );
};
