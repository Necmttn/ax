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
     * ax data dir (SurrealDB + friends). Sensible default for now;
     * Phase 2 Task 2.1 reconciles this with the CLI's canonical data dir.
     */
    readonly axDataDir: string;
}

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
        axDataDir: path.join(input.userDataDir, "db"),
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
