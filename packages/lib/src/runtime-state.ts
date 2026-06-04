import { Effect, FileSystem, type PlatformError } from "effect";
import { homedir } from "node:os";
import { posixPath } from "@ax/lib/shared/path";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { decodeJsonOrNull } from "./decode.ts";

/**
 * Persistent state for the local daemon (chosen port, schema version, etc).
 * Kept in a plain JSON file so install / CLI / doctor all see the same view
 * without needing the DB to be up.
 */
export interface RuntimeState {
    readonly version: 1;
    readonly db: {
        readonly host: string;
        readonly port: number;
    };
    readonly updatedAt: string;
}

export const DEFAULT_DB_HOST = "127.0.0.1";
export const DEFAULT_DB_PORT = 8521;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export function runtimeStatePath(
    dataDir = process.env.AX_DATA_DIR ??
        posixPath.join(homedir(), ".local", "share", "ax"),
): string {
    return posixPath.join(dataDir, "runtime.json");
}

export function defaultRuntimeState(): RuntimeState {
    return {
        version: 1,
        db: { host: DEFAULT_DB_HOST, port: DEFAULT_DB_PORT },
        updatedAt: new Date(0).toISOString(),
    };
}

/** Parse a raw runtime.json payload, tolerating any unrecognised shape. */
function parseRuntimeState(raw: string | null): RuntimeState {
    if (raw === null) return defaultRuntimeState();
    const parsed = decodeJsonOrNull(raw);
    if (!isRecord(parsed)) return defaultRuntimeState();

    const db = isRecord(parsed.db) ? parsed.db : {};
    const host = typeof db.host === "string" && db.host.length > 0 ? db.host : DEFAULT_DB_HOST;
    const portRaw = typeof db.port === "number" ? db.port : Number.parseInt(String(db.port ?? ""), 10);
    const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : DEFAULT_DB_PORT;
    const updatedAt =
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString();
    return { version: 1, db: { host, port }, updatedAt };
}

/**
 * Read runtime state from disk. Yields defaults when the file is missing,
 * unreadable, or has an unrecognised shape - we never fail here because the
 * call sites (config bootstrap, doctor) must keep working on first-run.
 * `orAbsent(null)` recovers ANY `PlatformError` (missing OR unreadable) to the
 * "use defaults" sentinel, matching the original sync tolerance exactly.
 */
export function readRuntimeState(
    path = runtimeStatePath(),
): Effect.Effect<RuntimeState, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const raw = yield* fs.readFileString(path).pipe(orAbsent<string | null>(null));
        return parseRuntimeState(raw);
    });
}

/**
 * Atomic write via `${path}.tmp` + rename so concurrent CLI invocations never
 * see a half-written file. Propagates any `PlatformError` (matching the
 * original sync behaviour, which let fs exceptions surface to callers).
 */
export function writeRuntimeState(
    state: Omit<RuntimeState, "version" | "updatedAt"> & { readonly updatedAt?: string },
    path = runtimeStatePath(),
): Effect.Effect<RuntimeState, PlatformError.PlatformError, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const next: RuntimeState = {
            version: 1,
            db: { host: state.db.host, port: state.db.port },
            updatedAt: state.updatedAt ?? new Date().toISOString(),
        };
        yield* fs.makeDirectory(posixPath.dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        yield* fs.writeFileString(tmp, JSON.stringify(next, null, 2));
        yield* fs.rename(tmp, path);
        return next;
    });
}

/** Compose the canonical ws://host:port URL for the SurrealDB client. */
export function dbUrlFromState(state: RuntimeState): string {
    return `ws://${state.db.host}:${state.db.port}`;
}
