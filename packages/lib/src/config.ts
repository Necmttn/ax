import { homedir } from "node:os";
import {
    Config,
    ConfigProvider,
    Context,
    Effect,
    FileSystem,
    Layer,
    Redacted,
    Schema,
} from "effect";
import { posixPath } from "@ax/lib/shared/path";
import { dbUrlFromState, readRuntimeState, runtimeStatePath } from "./runtime-state.ts";

export interface AxConfigShape {
    readonly db: {
        readonly url: string;
        readonly ns: string;
        readonly db: string;
        readonly user: string;
        /** Redacted so the password never leaks via logs/inspect. Unwrap with `Redacted.value`. */
        readonly pass: Redacted.Redacted<string>;
    };
    readonly paths: {
        readonly home: string;
        readonly transcriptsDir: string;
        readonly skillDirs: ReadonlyArray<string>;
        readonly commandDirs: ReadonlyArray<string>;
        readonly codexDir: string;
        readonly piDir: string;
        readonly opencodeDir: string;
        readonly cursorUserDir: string;
        readonly dataDir: string;
        readonly claudeUsageDir: string;
        readonly repoListFile: string;
    };
    readonly knobs: {
        readonly claudeConcurrency: number;
        readonly codexConcurrency: number;
        readonly codexProgressEvery: number;
        readonly codexFlushEvery: number;
        readonly codexRawMaxBytes: number;
        readonly codexPayloadMaxBytes: number;
        /** hard wall-clock cap (seconds) on a single CLI ingest before it self-cancels */
        readonly ingestTimeoutSeconds: number;
        /** fan-out width for per-session enrichment in session-list queries */
        readonly sessionsEnrichConcurrency: number;
    };
}

const HOME = homedir();

const DEFAULTS = {
    claudeConcurrency: 4,
    codexConcurrency: 1,
    codexProgressEvery: 10,
    codexFlushEvery: 500,
    codexRawMaxBytes: 5 * 1024 * 1024,
    codexPayloadMaxBytes: 1200,
    ingestTimeoutSeconds: 900,
    sessionsEnrichConcurrency: 16,
} as const;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Missing var -> fallback. Junk / zero / negative -> fallback (matches the old
 *  hand-rolled `positiveInt`: any unusable value silently degrades to default). */
const positiveInt = (name: string, fallback: number): Config.Config<number> =>
    Config.schema(PositiveInt, name).pipe(
        Config.orElse(() => Config.succeed(fallback)),
    );

/** Missing var -> fallback. Junk / negative -> fallback; zero is allowed. */
const nonNegativeInt = (name: string, fallback: number): Config.Config<number> =>
    Config.schema(NonNegativeInt, name).pipe(
        Config.orElse(() => Config.succeed(fallback)),
    );

/** Comma-separated list: trims entries, drops empties. Missing var -> []. */
const csvList = (name: string): Config.Config<ReadonlyArray<string>> =>
    Config.string(name).pipe(
        Config.map((raw) => raw.split(",").map((s) => s.trim()).filter(Boolean)),
        Config.withDefault([] as ReadonlyArray<string>),
    );

/** `env.X ?? fallback` semantics: only a MISSING var falls back (empty string
 *  is honored as-is, exactly like the previous `??`-based reads). */
const stringOr = (name: string, fallback: string): Config.Config<string> =>
    Config.string(name).pipe(Config.withDefault(fallback));

/**
 * The full config recipe, read through the ambient `ConfigProvider`. Requires
 * `FileSystem` because the persisted DB endpoint comes from `runtime.json` via
 * `readRuntimeState`. `Effect.orDie` is safe: every leaf has a fallback, so the
 * only theoretical failure is a provider source error (impossible for env).
 */
const snapshotConfig: Effect.Effect<AxConfigShape, never, FileSystem.FileSystem> =
    Effect.gen(function* () {
        const home = yield* stringOr("HOME", HOME);
        const dataDir = yield* stringOr(
            "AX_DATA_DIR",
            posixPath.join(home, ".local", "share", "ax"),
        );
        const runtime = yield* readRuntimeState(runtimeStatePath(dataDir));
        return {
            db: {
                // Precedence: explicit env override -> persisted runtime endpoint -> default.
                // install writes runtime.json after a successful port pick, so a one-time
                // port fallback keeps every later CLI invocation pointed at the right
                // listener without the user needing to set env vars.
                url: yield* stringOr("AX_DB_URL", dbUrlFromState(runtime)),
                ns: yield* stringOr("AX_DB_NS", "ax"),
                db: yield* stringOr("AX_DB_DB", "main"),
                user: yield* stringOr("AX_DB_USER", "root"),
                pass: yield* Config.redacted("AX_DB_PASS").pipe(
                    Config.withDefault(Redacted.make("root")),
                ),
            },
            paths: {
                home,
                transcriptsDir: yield* stringOr(
                    "AX_TRANSCRIPTS_DIR",
                    posixPath.join(home, ".claude", "projects"),
                ),
                skillDirs: yield* csvList("AX_SKILLS_DIRS"),
                commandDirs: yield* csvList("AX_COMMAND_DIRS"),
                codexDir: yield* stringOr(
                    "AX_CODEX_DIR",
                    posixPath.join(home, ".codex", "sessions"),
                ),
                piDir: yield* stringOr(
                    "AX_PI_DIR",
                    posixPath.join(home, ".pi", "agent", "sessions"),
                ),
                opencodeDir: yield* stringOr(
                    "AX_OPENCODE_DIR",
                    posixPath.join(home, ".local", "share", "opencode"),
                ),
                cursorUserDir: yield* stringOr(
                    "AX_CURSOR_USER_DIR",
                    posixPath.join(home, "Library", "Application Support", "Cursor", "User"),
                ),
                dataDir,
                claudeUsageDir: yield* stringOr(
                    "AX_CLAUDE_USAGE_DIR",
                    posixPath.join(home, ".claude", "usage-data"),
                ),
                repoListFile: yield* stringOr(
                    "AX_REPO_LIST",
                    posixPath.join(dataDir, "ax-repos.txt"),
                ),
            },
            knobs: {
                claudeConcurrency: yield* positiveInt(
                    "AX_CLAUDE_CONCURRENCY",
                    DEFAULTS.claudeConcurrency,
                ),
                codexConcurrency: yield* positiveInt(
                    "AX_CODEX_CONCURRENCY",
                    DEFAULTS.codexConcurrency,
                ),
                codexProgressEvery: yield* positiveInt(
                    "AX_CODEX_PROGRESS_EVERY",
                    DEFAULTS.codexProgressEvery,
                ),
                codexFlushEvery: yield* positiveInt(
                    "AX_CODEX_FLUSH_EVERY",
                    DEFAULTS.codexFlushEvery,
                ),
                codexRawMaxBytes: yield* nonNegativeInt(
                    "AX_CODEX_RAW_MAX_BYTES",
                    DEFAULTS.codexRawMaxBytes,
                ),
                codexPayloadMaxBytes: yield* nonNegativeInt(
                    "AX_CODEX_PAYLOAD_MAX_BYTES",
                    DEFAULTS.codexPayloadMaxBytes,
                ),
                ingestTimeoutSeconds: yield* positiveInt(
                    "AX_INGEST_TIMEOUT_SECONDS",
                    DEFAULTS.ingestTimeoutSeconds,
                ),
                sessionsEnrichConcurrency: yield* positiveInt(
                    "AX_SESSIONS_ENRICH_CONCURRENCY",
                    DEFAULTS.sessionsEnrichConcurrency,
                ),
            },
        };
    }).pipe(Effect.orDie);

/** `process.env`-shaped records carry `undefined` holes; `ConfigProvider.fromEnv`
 *  wants a dense `Record<string, string>`. */
const compactEnv = (
    env: Record<string, string | undefined>,
): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
};

/**
 * Read a fresh snapshot of the config. With no argument, reads `process.env`
 * at *run* time (same semantics as the previous hand-rolled reader); pass an
 * explicit env record for hermetic tests. Requires `FileSystem` because the
 * persisted DB endpoint is read from `runtime.json` via `readRuntimeState`.
 * Pure path math is done through the shared `posixPath` instance, so no `Path`
 * dependency is incurred. Effect callers should prefer the `AxConfig` service.
 */
export const envSnapshot = Effect.fn("config.envSnapshot")(function* (
    env?: Record<string, string | undefined>,
) {
    // The generator body runs at *effect run* time, so `process.env` is read
    // per run - same deferred-read semantics as the previous `Effect.suspend`.
    return yield* snapshotConfig.pipe(
        Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: compactEnv(env ?? process.env) }),
        ),
    );
});

/** Effect service exposing the typed config snapshot. */
export class AxConfig extends Context.Service<
    AxConfig,
    AxConfigShape
>()("ax/AxConfig") {}

/**
 * Live layer reads from process.env once at acquisition. The build now requires
 * `FileSystem` (to read the persisted runtime endpoint); `layers.ts` provides
 * `BunFileSystem.layer` beneath this layer so consumers see plain `AxConfig`.
 */
export const AxConfigLive: Layer.Layer<AxConfig, never, FileSystem.FileSystem> =
    Layer.effect(AxConfig)(envSnapshot());

/**
 * Test factory: deep-merge overrides into a default snapshot. Requires
 * `FileSystem` because it builds on `envSnapshot`. Use as
 * `Layer.succeed(AxConfig, yield* makeTestConfig({ db: { url: ... } }))` or via
 * the `AxConfigTest` layer.
 */
export const makeTestConfig = Effect.fn("config.makeTestConfig")(function* (
    overrides: DeepPartial<AxConfigShape> = {},
) {
    const base = yield* envSnapshot({});
    return {
        db: { ...base.db, ...(overrides.db ?? {}) },
        paths: { ...base.paths, ...(overrides.paths ?? {}) },
        knobs: { ...base.knobs, ...(overrides.knobs ?? {}) },
    } satisfies AxConfigShape;
});

export const AxConfigTest = (
    overrides: DeepPartial<AxConfigShape> = {},
): Layer.Layer<AxConfig, never, FileSystem.FileSystem> =>
    Layer.effect(AxConfig)(makeTestConfig(overrides));

type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends
        | ReadonlyArray<unknown>
        | string
        | number
        | boolean
        | Redacted.Redacted<string>
        ? T[K]
        : DeepPartial<T[K]>;
};
