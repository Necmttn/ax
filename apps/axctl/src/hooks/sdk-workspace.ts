import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Schema } from "effect";
import { writeFileAtomic } from "@ax/lib/atomic-write";

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
 * The next-step guidance to print when an SDK-hook command (init/install) is
 * invoked on a compiled binary. Tells the user the supported path instead of
 * dead-ending on an internal SdkPathNotFoundError. (issue #564)
 */
export const COMPILED_BINARY_SDK_HOOK_HELP = [
    "SDK (TypeScript) hooks need a source checkout of ax.",
    "They run as `bun <file>` against the @ax/hooks-sdk workspace, which the",
    "compiled binary does not bundle - so `ax hooks init`/`install` can't work here.",
    "",
    "To author/install hooks like route-dispatch:",
    "  git clone https://github.com/Necmttn/ax && cd ax && bun install",
    "  ./apps/axctl/bin/axctl hooks init   # then `... hooks install <file>`",
    "",
    "On a compiled binary you can still:",
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

const GUARD_NAMES = [
    "enforce-worktree",
    "enforce-worktree-write",
    // Claude-only: suggests cheaper model when Agent dispatch has no explicit model set.
    // Codex has no Agent-tool dispatch equivalent; this hook is a no-op there.
    "route-dispatch",
    // Claude-only: fires at SessionStart to refresh the quota cache and inject a
    // /dojo nudge when the spend mode is splurge (quota budget resets soon).
    // Codex has no SessionStart equivalent; harmless to scaffold but won't fire.
    "refresh-quota",
] as const;

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

const starterHookContent = (guardName: string): string =>
    `import hook from "@ax/hooks-sdk/hooks/${guardName}";\nimport { runMain } from "@ax/hooks-sdk/define";\n\nexport default hook;\nif (import.meta.main) void runMain(hook);\n`;

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
