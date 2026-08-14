import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { customBuildDistDir, duckdbBinPath } from "./duckdb-bin.ts";

const makeExecutable = (path: string): void => {
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
};

describe("duckdbBinPath", () => {
    test("prefers the custom build over AX_DUCKDB_BIN and PATH", () => {
        const distDir = mkdtempSync(join(tmpdir(), "ax-duckdb-dist-"));
        const otherBin = mkdtempSync(join(tmpdir(), "ax-duckdb-other-"));
        try {
            const custom = join(distDir, "duckdb");
            makeExecutable(custom);
            const other = join(otherBin, "duckdb");
            makeExecutable(other);

            const resolved = duckdbBinPath({
                DUCKDB_DIST_DIR: distDir,
                AX_DUCKDB_BIN: other,
                PATH: process.env.PATH,
            });
            expect(resolved).toBe(custom);
        } finally {
            rmSync(distDir, { recursive: true, force: true });
            rmSync(otherBin, { recursive: true, force: true });
        }
    });

    test("skips a DUCKDB_DIST_DIR entry that is not executable", () => {
        const distDir = mkdtempSync(join(tmpdir(), "ax-duckdb-dist-"));
        const otherBin = mkdtempSync(join(tmpdir(), "ax-duckdb-other-"));
        try {
            // Present but not executable (e.g. a stray non-binary file) - must
            // not be handed to a spawn call.
            writeFileSync(join(distDir, "duckdb"), "not a real binary");
            const other = join(otherBin, "duckdb");
            makeExecutable(other);

            const resolved = duckdbBinPath({
                DUCKDB_DIST_DIR: distDir,
                AX_DUCKDB_BIN: other,
                PATH: process.env.PATH,
            });
            expect(resolved).toBe(other);
        } finally {
            rmSync(distDir, { recursive: true, force: true });
            rmSync(otherBin, { recursive: true, force: true });
        }
    });

    test("falls back to AX_DUCKDB_BIN when no custom build is present", () => {
        const distDir = mkdtempSync(join(tmpdir(), "ax-duckdb-dist-empty-"));
        const otherBin = mkdtempSync(join(tmpdir(), "ax-duckdb-other-"));
        try {
            const other = join(otherBin, "duckdb");
            makeExecutable(other);

            const resolved = duckdbBinPath({
                DUCKDB_DIST_DIR: distDir,
                AX_DUCKDB_BIN: other,
                PATH: process.env.PATH,
            });
            expect(resolved).toBe(other);
        } finally {
            rmSync(distDir, { recursive: true, force: true });
            rmSync(otherBin, { recursive: true, force: true });
        }
    });

    test("resolves a relative AX_DUCKDB_BIN against the current cwd", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-relcwd-"));
        const bin = join(dir, "duckdb");
        makeExecutable(bin);
        const prevCwd = process.cwd();
        process.chdir(dir);
        try {
            const resolved = duckdbBinPath({
                DUCKDB_DIST_DIR: join(dir, "no-custom-build-here"),
                AX_DUCKDB_BIN: "duckdb",
                PATH: process.env.PATH,
            });
            // process.chdir resolves symlinks (e.g. macOS /var -> /private/var),
            // so compare through the same node:path resolve rather than the
            // pre-chdir `bin` string.
            expect(resolved).toBe(resolve("duckdb"));
        } finally {
            process.chdir(prevCwd);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("returns null (not a fallback to PATH) when AX_DUCKDB_BIN points nowhere", () => {
        const distDir = mkdtempSync(join(tmpdir(), "ax-duckdb-dist-empty-"));
        try {
            const resolved = duckdbBinPath({
                DUCKDB_DIST_DIR: distDir,
                AX_DUCKDB_BIN: join(tmpdir(), "no-such-duckdb-binary-anywhere"),
                PATH: process.env.PATH,
            });
            expect(resolved).toBeNull();
        } finally {
            rmSync(distDir, { recursive: true, force: true });
        }
    });

    test("falls back to PATH when neither the custom build nor AX_DUCKDB_BIN is set", () => {
        const distDir = mkdtempSync(join(tmpdir(), "ax-duckdb-dist-empty-"));
        try {
            const resolved = duckdbBinPath({
                DUCKDB_DIST_DIR: distDir,
                AX_DUCKDB_BIN: undefined,
                PATH: process.env.PATH,
            });
            expect(resolved).toBe(Bun.which("duckdb", { PATH: process.env.PATH ?? "" }));
        } finally {
            rmSync(distDir, { recursive: true, force: true });
        }
    });

    test("customBuildDistDir prefers the explicit env var over the repo-root default", () => {
        expect(customBuildDistDir({ DUCKDB_DIST_DIR: "/tmp/wherever" })).toBe("/tmp/wherever");
        const fallback = customBuildDistDir({});
        expect(fallback).not.toBeNull();
        expect(fallback).toMatch(/dist\/duckdb$/);
    });
});
