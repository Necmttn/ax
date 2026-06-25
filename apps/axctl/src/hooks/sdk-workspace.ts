import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Schema } from "effect";
import { writeFileAtomic } from "@ax/lib/atomic-write";
import {
    GUARD_NAMES,
    starterHookContent,
    DISPATCHER_NAME,
    dispatcherScaffoldContent,
    SHIM_NAME,
    shimScaffoldContent,
} from "./guard-names.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SdkPathNotFoundError extends Schema.TaggedErrorClass<SdkPathNotFoundError>(
    "SdkPathNotFoundError",
)("SdkPathNotFoundError", {
    attempted: Schema.String,
    reason: Schema.String,
}) {}

export class BunInstallError extends Schema.TaggedErrorClass<BunInstallError>(
    "BunInstallError",
)("BunInstallError", {
    dir: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Compiled-binary detection + fallback guidance
// ---------------------------------------------------------------------------

/**
 * True when axctl is running from a `bun build --compile` binary rather than a
 * source checkout. Compiled binaries live inside bun's virtual filesystem
 * (`/$bunfs/root/...`), so the packages/hooks-sdk source tree is absent and SDK
 * (TypeScript) hooks - which run as `bun <file>` against that workspace - can be
 * neither scaffolded nor installed.
 */
export const isCompiledBinary = (): boolean =>
    import.meta.dir.includes("$bunfs") || import.meta.url.includes("$bunfs");

/**
 * Fallback guidance for the rare compiled binary built WITHOUT the bundled-hook
 * embed manifest (`HOOKS_EMBED` empty). A normal release binary embeds a
 * standalone `.js` per guard, so `ax hooks init` works fully offline there (no
 * source checkout, no `bun install` - issue #573); this text only prints when
 * that manifest is missing, which means a broken build. (issue #564)
 */
export const COMPILED_BINARY_SDK_HOOK_HELP = [
    "This axctl binary has no bundled hooks (empty embed manifest) - usually a",
    "broken/dev build. A normal release embeds the guards, so `ax hooks init`",
    "writes them to ~/.ax/hooks offline with no repo checkout.",
    "",
    "Fix: reinstall the latest release (curl -fsSL https://ax.necmttn.com/install.sh | sh),",
    "then `ax hooks init` and `ax hooks install --all --providers=claude,codex`.",
    "",
    "Or run from a source checkout:",
    "  git clone https://github.com/Necmttn/ax && cd ax && bun install",
    "  ./apps/axctl/bin/axctl hooks init && ./apps/axctl/bin/axctl hooks install --all",
    "",
    "Meanwhile you can still:",
    "  - route models by setting `model:` explicitly per dispatch (efficient-dispatch skill)",
    "  - measure routing with `ax dispatches` / `ax cost split`",
    "  - add native (non-SDK) hooks via `ax hooks add --command=\"...\"`",
].join("\n");

// ---------------------------------------------------------------------------
// resolveSdkPath
// ---------------------------------------------------------------------------

/**
 * Locate packages/hooks-sdk relative to this source file.
 * import.meta.dir -> apps/axctl/src/hooks -> up 4 levels -> repo root -> packages/hooks-sdk.
 * Fails with SdkPathNotFoundError if the directory does not exist (axctl is
 * not running from source).
 */
export const resolveSdkPath = (): Effect.Effect<
    string,
    SdkPathNotFoundError | PlatformError,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;
        // apps/axctl/src/hooks -> apps/axctl/src -> apps/axctl -> apps -> repo-root
        const repoRoot = pathSvc.resolve(import.meta.dir, "..", "..", "..", "..");
        const sdkPath = pathSvc.join(repoRoot, "packages", "hooks-sdk");
        const exists = yield* fs.exists(sdkPath);
        if (!exists) {
            return yield* new SdkPathNotFoundError({
                attempted: sdkPath,
                reason: "packages/hooks-sdk not found - axctl must run from source (not a compiled binary)",
            });
        }
        return sdkPath;
    });

// ---------------------------------------------------------------------------
// scaffoldWorkspace
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
    /** Absolute path to the workspace directory to create/populate. */
    readonly dir: string;
    /** Absolute path to packages/hooks-sdk (file: dep in generated package.json). */
    readonly sdkPath: string;
    /** Whether to run `bun install` after scaffolding. */
    readonly install: boolean;
}

const packageJsonContent = (sdkPath: string): string =>
    `${JSON.stringify(
        {
            name: "ax-hooks-workspace",
            private: true,
            type: "module",
            dependencies: {
                "@ax/hooks-sdk": `file:${sdkPath}`,
            },
        },
        null,
        2,
    )}\n`;

/**
 * Scaffold a hook workspace at `dir`:
 *   1. mkdir -p dir
 *   2. Write package.json (atomic) with a `file:` dep on hooks-sdk
 *   3. For each guard, write a starter .ts file only if it does NOT exist yet
 *      (never overwrite user edits)
 *   4. Optionally run `bun install`
 *
 * Returns the list of paths written (package.json + any new .ts files).
 */
export const scaffoldWorkspace = (
    opts: ScaffoldOptions,
): Effect.Effect<
    ReadonlyArray<string>,
    PlatformError | BunInstallError,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        // 1. mkdir -p dir
        yield* fs.makeDirectory(opts.dir, { recursive: true });

        const written: string[] = [];

        // 2. Write package.json (always, atomic - idempotent on re-run)
        const pkgPath = pathSvc.join(opts.dir, "package.json");
        yield* writeFileAtomic(pkgPath, packageJsonContent(opts.sdkPath), { backup: false });
        written.push(pkgPath);

        // 3. Starter hook files - only if absent
        for (const guardName of GUARD_NAMES) {
            const hookPath = pathSvc.join(opts.dir, `${guardName}.ts`);
            const exists = yield* fs.exists(hookPath);
            if (!exists) {
                yield* writeFileAtomic(hookPath, starterHookContent(guardName), { backup: false });
                written.push(hookPath);
            }
        }

        // 3b. The dispatcher entry (one spawn multiplexes all guards) - only if absent.
        const dispatchPath = pathSvc.join(opts.dir, `${DISPATCHER_NAME}.ts`);
        if (!(yield* fs.exists(dispatchPath))) {
            yield* writeFileAtomic(dispatchPath, dispatcherScaffoldContent(), { backup: false });
            written.push(dispatchPath);
        }

        // 3c. The daemon-first shim (opt-in via `--daemon`); falls back to the
        // sibling dispatch.ts. Source scaffold -> .ts sibling.
        const shimPath = pathSvc.join(opts.dir, `${SHIM_NAME}.ts`);
        if (!(yield* fs.exists(shimPath))) {
            yield* writeFileAtomic(shimPath, shimScaffoldContent("ts"), { backup: false });
            written.push(shimPath);
        }

        // 4. bun install
        if (opts.install) {
            yield* Effect.tryPromise({
                try: async () => {
                    const proc = Bun.spawn(["bun", "install"], {
                        cwd: opts.dir,
                        stdout: "pipe",
                        stderr: "pipe",
                    });
                    const exitCode = await proc.exited;
                    if (exitCode !== 0) {
                        const stderrText = await new Response(proc.stderr).text();
                        throw new BunInstallError({
                            dir: opts.dir,
                            exitCode,
                            stderr: stderrText,
                        });
                    }
                },
                catch: (e) => {
                    if (e instanceof BunInstallError) return e;
                    return new BunInstallError({
                        dir: opts.dir,
                        exitCode: -1,
                        stderr: String(e),
                    });
                },
            });
        }

        return written;
    });

// ---------------------------------------------------------------------------
// scaffoldFromEmbed (compiled-binary path)
// ---------------------------------------------------------------------------

/**
 * Compiled-binary scaffold: write each embedded, pre-bundled standalone hook to
 * `<dir>/<guard>.js` (only if absent - never clobber user edits). No
 * package.json and no `bun install`: the bundles inline effect, so they fire as
 * `bun <file>.js` with no node_modules. `embed` is `HOOKS_EMBED` (key = guard
 * name, value = the `/$bunfs` path baked in by gen-hooks-embed.ts); passed in so
 * the function stays unit-testable with a fixture map.
 *
 * Returns the list of `.js` paths newly written.
 */
export const scaffoldFromEmbed = (
    embed: Record<string, string>,
    dir: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        yield* fs.makeDirectory(dir, { recursive: true });

        const written: string[] = [];
        for (const [guard, embeddedPath] of Object.entries(embed)) {
            const dest = pathSvc.join(dir, `${guard}.js`);
            const exists = yield* fs.exists(dest);
            if (exists) continue;
            // Bun.file reads both real disk files (tests) and embedded /$bunfs
            // paths (compiled binary). The read is infallible by construction
            // (the path comes from the embed map the binary baked in).
            const content = yield* Effect.promise(() => Bun.file(embeddedPath).text());
            yield* writeFileAtomic(dest, content, { backup: false });
            written.push(dest);
        }
        return written;
    });

// ---------------------------------------------------------------------------
// listInstallableGuards (`ax hooks install --all` resolution)
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk guard files in a scaffolded workspace, one per
 * `GUARD_NAMES`. Either extension may be present depending on how the workspace
 * was scaffolded: `.ts` shims on a source checkout, standalone `.js` bundles on
 * a compiled binary. Prefers `.ts` when both exist (a source checkout that also
 * has stray bundles). Guards with no file present are skipped, so the result is
 * the set `ax hooks install --all` can actually install. Returns absolute paths
 * in `GUARD_NAMES` order.
 */
export const listInstallableGuards = (
    dir: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;
        const found: string[] = [];
        for (const guard of GUARD_NAMES) {
            const tsPath = pathSvc.join(dir, `${guard}.ts`);
            const jsPath = pathSvc.join(dir, `${guard}.js`);
            if (yield* fs.exists(tsPath)) found.push(tsPath);
            else if (yield* fs.exists(jsPath)) found.push(jsPath);
        }
        return found;
    });
