import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/**
 * Values resolved by `main.ts` from the Electron `app` object (and Node `process`)
 * and fed into {@link layer}. Nothing here imports `electron` at module scope -
 * the foundation modules stay framework-agnostic so they can be unit-tested.
 */
export interface MakeDesktopEnvironmentInput {
    /** `__dirname` of the bundled main process (e.g. `<app>/dist-electron`). */
    readonly dirname: string;
    /** Repo root in dev; ignored when packaged. Resolved by `main.ts`. */
    readonly repoRoot: string;
    /** `!app.isPackaged`. */
    readonly isDevelopment: boolean;
    /** `process.resourcesPath` - only meaningful when packaged. */
    readonly resourcesPath: string;
    /** `app.getPath("userData")`. */
    readonly userDataDir: string;
    /** `process.platform`. */
    readonly platform: NodeJS.Platform;
    /** `process.arch`. */
    readonly processArch: string;
    /** Absolute path to the bundled `surreal` binary. */
    readonly surrealBinaryPath: string;
    /** Absolute path to the bundled `bun` binary. */
    readonly bunBinaryPath: string;
    /**
     * `app.getPath("home")` (or `process.env.HOME`). Used to derive the
     * canonical ax data dir so desktop and the CLI daemon agree on it.
     */
    readonly homeDir: string;
    /**
     * `process.env.AX_DATA_DIR` if set. Overrides the derived default, matching
     * `@ax/lib` config + the daemon install scripts.
     */
    readonly axDataDirOverride: string | undefined;
}

export interface DesktopEnvironmentShape {
    /** The `node:path` module, via Effect's Path service. */
    readonly path: Path.Path;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
    readonly processArch: string;
    /** Packaged -> `process.resourcesPath`; dev -> repo root. */
    readonly appRoot: string;
    readonly userDataDir: string;
    readonly logsDir: string;
    readonly surrealBinaryPath: string;
    readonly bunBinaryPath: string;
    /**
     * Absolute path to the bundled preload script. Sits beside the bundled
     * `main.cjs` in `dist-electron/` (i.e. the main process `dirname`).
     */
    readonly preloadPath: string;
    /**
     * Entry point for `ax serve` source.
     * Packaged -> `<appRoot>/ax-src/apps/axctl/src/cli/index.ts`;
     * dev -> repo path.
     */
    readonly axSourceEntry: string;
    /**
     * Built studio SPA assets.
     * Packaged -> `<appRoot>/studio`; dev -> `<repoRoot>/apps/studio/dist-desktop`.
     */
    readonly studioStaticDir: string;
    /**
     * Canonical ax data dir, authoritative across desktop + CLI daemon.
     * Resolution mirrors `@ax/lib` config (`packages/lib/src/config.ts`) and the
     * daemon install scripts (`scripts/install-daemon.sh`, `db-start.sh`):
     * `$AX_DATA_DIR ?? $HOME/.local/share/ax`. The plist's rocksdb URL is
     * `rocksdb://<axDataDir>/db` - the surreal arg appends `/db`, so `axDataDir`
     * is the parent dir, not the rocksdb path itself.
     */
    readonly axDataDir: string;
}

/**
 * Canonical ax data dir resolution. Single source of truth shared with the CLI
 * daemon: `$AX_DATA_DIR` env override, else `$HOME/.local/share/ax`. Kept as a
 * standalone export so it can be unit-tested without an Electron `app`.
 */
export const resolveAxDataDir = (
    homeDir: string,
    axDataDirOverride: string | undefined,
    path: Path.Path,
): string => axDataDirOverride ?? path.join(homeDir, ".local", "share", "ax");

export class DesktopEnvironment extends Context.Service<
    DesktopEnvironment,
    DesktopEnvironmentShape
>()("@ax/studio-desktop/app/DesktopEnvironment") {}

export const make = (
    input: MakeDesktopEnvironmentInput,
    path: Path.Path,
): DesktopEnvironmentShape => {
    const appRoot = input.isDevelopment ? input.repoRoot : input.resourcesPath;

    const axSourceEntry = input.isDevelopment
        ? path.join(input.repoRoot, "apps/axctl/src/cli/index.ts")
        : path.join(appRoot, "ax-src/apps/axctl/src/cli/index.ts");

    const studioStaticDir = input.isDevelopment
        ? path.join(input.repoRoot, "apps/studio/dist-desktop")
        : path.join(appRoot, "studio");

    return DesktopEnvironment.of({
        path,
        isDevelopment: input.isDevelopment,
        platform: input.platform,
        processArch: input.processArch,
        appRoot,
        userDataDir: input.userDataDir,
        logsDir: path.join(input.userDataDir, "logs"),
        surrealBinaryPath: input.surrealBinaryPath,
        bunBinaryPath: input.bunBinaryPath,
        preloadPath: path.join(input.dirname, "preload.cjs"),
        axSourceEntry,
        studioStaticDir,
        axDataDir: resolveAxDataDir(input.homeDir, input.axDataDirOverride, path),
    });
};

export const layer = (input: MakeDesktopEnvironmentInput) =>
    Layer.effect(
        DesktopEnvironment,
        Effect.gen(function* () {
            const path = yield* Path.Path;
            return make(input, path);
        }),
    );
