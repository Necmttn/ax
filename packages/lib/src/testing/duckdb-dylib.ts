/**
 * Test-only resolution of a libduckdb shared library.
 *
 * Order: `AX_DUCKDB_DYLIB` (the injection point the custom static dylib from
 * chunk w0-dylib-ci will use) -> the gitignored `vendor/duckdb/<version>/`
 * cache -> a one-time download of the official prebuilt release. When the
 * download is impossible (offline CI, unsupported platform) this returns a
 * REASON rather than throwing, so suites can skip with a notice instead of
 * failing red for an environment problem.
 */
import { existsSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

export const DUCKDB_VERSION = "v1.5.5";

export type TestDylib =
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly reason: string };

export type RepoRootResult = { readonly ok: true; readonly dir: string } | { readonly ok: false };

/**
 * Walk up from `startDir` looking for the directory holding `turbo.json`.
 * Exported separately from `repoRoot()` below so the failure path (no
 * `turbo.json` found within 10 levels) is unit-testable without having to
 * fake `import.meta.url`.
 */
export const repoRootFrom = (startDir: string): RepoRootResult => {
    let dir = startDir;
    for (let i = 0; i < 10; i += 1) {
        if (existsSync(join(dir, "turbo.json"))) return { ok: true, dir };
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return { ok: false };
};

/**
 * Repo root, found by walking up from this file. Uses `Bun.fileURLToPath`
 * (not `new URL(...).pathname`) because the pathname is percent-encoded -
 * a checkout under a path with a space or non-ASCII character (e.g.
 * `/Users/x/My Projects/...`) would make every `existsSync` probe below miss
 * and the walk would exhaust silently.
 */
const repoRoot = (): RepoRootResult => repoRootFrom(dirname(Bun.fileURLToPath(import.meta.url)));

const libFileName = (): string => (platform() === "darwin" ? "libduckdb.dylib" : "libduckdb.so");

/** Official release asset for this platform, or null when unsupported. */
const releaseAsset = (): string | null => {
    if (platform() === "darwin") return "libduckdb-osx-universal.zip";
    if (platform() === "linux") {
        return arch() === "arm64" ? "libduckdb-linux-arm64.zip" : "libduckdb-linux-amd64.zip";
    }
    return null;
};

export const vendorDir = (root: string): string => join(root, "vendor", "duckdb", DUCKDB_VERSION);

export const resolveTestDylib = async (): Promise<TestDylib> => {
    const injected = process.env.AX_DUCKDB_DYLIB?.trim();
    if (injected) {
        return existsSync(injected)
            ? { ok: true, path: injected }
            : { ok: false, reason: `AX_DUCKDB_DYLIB points at a missing file: ${injected}` };
    }

    const root = repoRoot();
    if (!root.ok) {
        return {
            ok: false,
            reason:
                "could not locate the repo root (walked up 10 levels from duckdb-dylib.ts without finding turbo.json)",
        };
    }
    const dir = vendorDir(root.dir);

    const cached = join(dir, libFileName());
    if (existsSync(cached)) return { ok: true, path: cached };

    const asset = releaseAsset();
    if (asset === null) {
        return { ok: false, reason: `no official libduckdb build for ${platform()}/${arch()}` };
    }

    const url = `https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${asset}`;
    try {
        mkdirSync(dir, { recursive: true });
        const zipPath = join(dir, asset);
        const response = await fetch(url);
        if (!response.ok) {
            return { ok: false, reason: `download failed: ${url} -> HTTP ${response.status}` };
        }
        await Bun.write(zipPath, await response.arrayBuffer());
        const unzip = Bun.spawnSync(["unzip", "-o", "-q", zipPath, "-d", dir], {
            stdout: "ignore",
            stderr: "pipe",
        });
        if (unzip.exitCode !== 0) {
            return { ok: false, reason: `unzip failed: ${unzip.stderr.toString().trim()}` };
        }
        if (!existsSync(cached)) {
            return { ok: false, reason: `archive ${asset} did not contain ${libFileName()}` };
        }
        return { ok: true, path: cached };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `download failed: ${url} -> ${message}` };
    }
};

/** Prints a uniform notice so a skipped suite is visible in test output. */
export const noteSkippedDylib = (suite: string, reason: string): void => {
    console.warn(`[skip] ${suite}: no libduckdb available (${reason})`);
};
