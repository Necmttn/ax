#!/usr/bin/env bun
/**
 * One resolver for "the duckdb CLI binary" - shared by scripts/bench/run.ts,
 * packages/schema/src/duckdb-load.test.ts, and scripts/build-duckdb.test.ts.
 * Previously three separate lookups behind two env names (`AX_DUCKDB_BIN`,
 * `AX_DUCKDB_SHELL`); collapsed to one name and one implementation.
 *
 * Order:
 *   1. the custom static build at
 *      `${DUCKDB_DIST_DIR ?? <repoRoot>/dist/duckdb}/duckdb` (produced by
 *      `scripts/build-duckdb.sh`, mirrors the dylib lookup in
 *      `packages/lib/src/testing/duckdb-dylib.ts`) - the only binary with
 *      fts+json statically linked, so it is the only one that can
 *      `LOAD fts` offline.
 *   2. `AX_DUCKDB_BIN`, resolved against the caller's cwd right here (not
 *      deferred) - every duckdb spawn in scripts/bench/run.ts runs with
 *      `cwd: workDir`, so a relative AX_DUCKDB_BIN would otherwise be looked
 *      up relative to the wrong directory (see the comment this replaces at
 *      the old scripts/bench/run.ts:53-56). When set, this knob takes
 *      priority over PATH even if it turns out to point nowhere - it fails
 *      loudly (a `null` return) rather than silently falling through to a
 *      different binary the caller didn't ask for.
 *   3. `duckdb` on PATH.
 *   4. `null` - no duckdb binary available.
 *
 * `node:fs` / `node:path` are used deliberately: this is a repo-tooling
 * script under scripts/, outside the `check:no-node-fs` runtime scan scope
 * (apps/-star-/src and packages/-star-/src only).
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Walk up from `startDir` looking for the directory holding `turbo.json`.
 *  Mirrors `repoRootFrom` in `packages/lib/src/testing/duckdb-dylib.ts`. */
const repoRootFrom = (startDir: string): string | null => {
    let dir = startDir;
    for (let i = 0; i < 10; i += 1) {
        if (existsSync(join(dir, "turbo.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
};

const repoRoot = (): string | null => repoRootFrom(dirname(Bun.fileURLToPath(import.meta.url)));

const isExecutableFile = (path: string): boolean => {
    try {
        const stat = statSync(path);
        return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
        return false;
    }
};

/** The custom static-build dist dir: `DUCKDB_DIST_DIR`, or `<repoRoot>/dist/duckdb`
 *  when unset and a repo root can be found. Mirrors `customBuildDistDir` in
 *  `packages/lib/src/testing/duckdb-dylib.ts`. */
export const customBuildDistDir = (
    env: Record<string, string | undefined>,
): string | null => {
    const fromEnv = env.DUCKDB_DIST_DIR?.trim();
    if (fromEnv) return fromEnv;
    const root = repoRoot();
    return root ? join(root, "dist", "duckdb") : null;
};

export const duckdbBinPath = (
    env: Record<string, string | undefined> = process.env,
): string | null => {
    const distDir = customBuildDistDir(env);
    if (distDir) {
        const custom = join(distDir, "duckdb");
        if (isExecutableFile(custom)) return custom;
    }

    const fromEnv = env.AX_DUCKDB_BIN;
    if (fromEnv) {
        // Resolve against the launch cwd now -- callers spawn duckdb with a
        // different cwd (e.g. `cwd: workDir` in scripts/bench/run.ts), so a
        // relative AX_DUCKDB_BIN would otherwise be looked up relative to
        // the wrong directory.
        const absolute = resolve(fromEnv);
        return existsSync(absolute) ? absolute : null;
    }

    return Bun.which("duckdb");
};
