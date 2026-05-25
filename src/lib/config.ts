import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { dbUrlFromState, readRuntimeState, runtimeStatePath } from "./runtime-state.ts";

export interface AxConfigShape {
    readonly db: {
        readonly url: string;
        readonly ns: string;
        readonly db: string;
        readonly user: string;
        readonly pass: string;
    };
    readonly paths: {
        readonly home: string;
        readonly transcriptsDir: string;
        readonly skillDirs: ReadonlyArray<string>;
        readonly commandDirs: ReadonlyArray<string>;
        readonly codexDir: string;
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
} as const;

const csv = (raw: string | undefined): string[] =>
    (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const positiveInt = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const nonNegativeInt = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Read a fresh snapshot from process.env. Pure - safe to call from
 * synchronous module init (paths.ts, top-level CLI helpers) when service
 * injection is too disruptive. Effect callers should prefer the
 * `AxConfig` service.
 */
export function envSnapshot(env: Record<string, string | undefined> = process.env): AxConfigShape {
    const home = env.HOME ?? HOME;
    const dataDir = env.AX_DATA_DIR ?? join(home, ".local", "share", "ax");
    const runtime = readRuntimeState(runtimeStatePath(dataDir));
    return {
        db: {
            // Precedence: explicit env override -> persisted runtime endpoint -> default.
            // install writes runtime.json after a successful port pick, so a one-time
            // port fallback keeps every later CLI invocation pointed at the right
            // listener without the user needing to set env vars.
            url: env.AX_DB_URL ?? dbUrlFromState(runtime),
            ns: env.AX_DB_NS ?? "ax",
            db: env.AX_DB_DB ?? "main",
            user: env.AX_DB_USER ?? "root",
            pass: env.AX_DB_PASS ?? "root",
        },
        paths: {
            home,
            transcriptsDir:
                env.AX_TRANSCRIPTS_DIR ?? join(home, ".claude", "projects"),
            skillDirs: csv(env.AX_SKILLS_DIRS),
            commandDirs: csv(env.AX_COMMAND_DIRS),
            codexDir: env.AX_CODEX_DIR ?? join(home, ".codex", "sessions"),
            dataDir,
            claudeUsageDir:
                env.AX_CLAUDE_USAGE_DIR ?? join(home, ".claude", "usage-data"),
            repoListFile:
                env.AX_REPO_LIST ?? join(dataDir, "ax-repos.txt"),
        },
        knobs: {
            claudeConcurrency: positiveInt(
                env.AX_CLAUDE_CONCURRENCY,
                DEFAULTS.claudeConcurrency,
            ),
            codexConcurrency: positiveInt(
                env.AX_CODEX_CONCURRENCY,
                DEFAULTS.codexConcurrency,
            ),
            codexProgressEvery: positiveInt(
                env.AX_CODEX_PROGRESS_EVERY,
                DEFAULTS.codexProgressEvery,
            ),
            codexFlushEvery: positiveInt(
                env.AX_CODEX_FLUSH_EVERY,
                DEFAULTS.codexFlushEvery,
            ),
            codexRawMaxBytes: nonNegativeInt(
                env.AX_CODEX_RAW_MAX_BYTES,
                DEFAULTS.codexRawMaxBytes,
            ),
            codexPayloadMaxBytes: nonNegativeInt(
                env.AX_CODEX_PAYLOAD_MAX_BYTES,
                DEFAULTS.codexPayloadMaxBytes,
            ),
        },
    };
}

/** Effect service exposing the typed config snapshot. */
export class AxConfig extends Context.Service<
    AxConfig,
    AxConfigShape
>()("ax/AxConfig") {}

/** Live layer reads from process.env once at acquisition. */
export const AxConfigLive: Layer.Layer<AxConfig> = Layer.effect(
    AxConfig,
)(Effect.sync(() => envSnapshot()));

/**
 * Test factory: deep-merge overrides into a default snapshot. Use as
 * `Layer.succeed(AxConfig, makeTestConfig({ db: { url: ... } }))`.
 */
export function makeTestConfig(
    overrides: DeepPartial<AxConfigShape> = {},
): AxConfigShape {
    const base = envSnapshot({});
    return {
        db: { ...base.db, ...(overrides.db ?? {}) },
        paths: { ...base.paths, ...(overrides.paths ?? {}) },
        knobs: { ...base.knobs, ...(overrides.knobs ?? {}) },
    };
}

export const AxConfigTest = (
    overrides: DeepPartial<AxConfigShape> = {},
): Layer.Layer<AxConfig> =>
    Layer.succeed(AxConfig)(makeTestConfig(overrides));

type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends ReadonlyArray<unknown> | string | number | boolean
        ? T[K]
        : DeepPartial<T[K]>;
};
