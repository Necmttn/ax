import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    duckdbDistDir,
    writeManifestFromDylib,
    writeManifestReusingBuild,
    writeStub,
} from "./gen-duckdb-embed.ts";

const repoRoot = join(import.meta.dir, "..");

describe("DuckDB embed code generation", () => {
    let workDir: string | undefined;

    afterEach(() => {
        if (workDir) rmSync(workDir, { recursive: true, force: true });
        workDir = undefined;
    });

    test("the committed generated file is the empty stub", () => {
        // Read the file as committed in git, not the working tree - this
        // must never mutate apps/axctl/src/duckdb-embed.gen.ts.
        const committed = spawnSync(
            "git",
            ["show", "HEAD:apps/axctl/src/duckdb-embed.gen.ts"],
            { cwd: repoRoot, encoding: "utf8" },
        );
        expect(committed.status).toBe(0);
        expect(committed.stdout).toContain(
            "export const DUCKDB_DYLIB: string | undefined = undefined;",
        );
        expect(committed.stdout).not.toContain('with { type: "file" }');
    });

    test("writeStub restores a source-safe empty module", () => {
        workDir = mkdtempSync(join(tmpdir(), "ax-duckdb-embed-"));
        const target = join(workDir, "duckdb-embed.gen.ts");
        writeFileSync(target, "// stale content\n");

        writeStub(target);

        expect(readFileSync(target, "utf8")).toContain(
            "export const DUCKDB_DYLIB: string | undefined = undefined;",
        );
    });

    test("the manifest embeds the selected dynamic library as a Bun file", () => {
        workDir = mkdtempSync(join(tmpdir(), "ax-duckdb-embed-"));
        const target = join(workDir, "duckdb-embed.gen.ts");
        const dylib = join(workDir, "libduckdb.dylib");
        writeFileSync(dylib, "fixture");

        writeManifestFromDylib(dylib, target);
        const manifest = readFileSync(target, "utf8");
        expect(manifest).toContain('with { type: "file" }');
        expect(manifest).toContain(
            "export const DUCKDB_DYLIB: string | undefined = duckdbDylib;",
        );
    });

    describe("writeManifestReusingBuild", () => {
        const originalDistDir = process.env.DUCKDB_DIST_DIR;

        afterEach(() => {
            if (originalDistDir === undefined) delete process.env.DUCKDB_DIST_DIR;
            else process.env.DUCKDB_DIST_DIR = originalDistDir;
        });

        test("duckdbDistDir honours DUCKDB_DIST_DIR", () => {
            process.env.DUCKDB_DIST_DIR = "/tmp/some-duckdb-dist";
            expect(duckdbDistDir()).toBe("/tmp/some-duckdb-dist");
        });

        test("reuses an already-provisioned library instead of shelling out to build-duckdb.sh", () => {
            workDir = mkdtempSync(join(tmpdir(), "ax-duckdb-embed-"));
            const distDir = join(workDir, "dist-duckdb");
            const target = join(workDir, "duckdb-embed.gen.ts");
            const libraryName = process.platform === "darwin" ? "libduckdb.dylib" : "libduckdb.so";
            mkdirSync(distDir, { recursive: true });
            writeFileSync(join(distDir, libraryName), "fixture");

            process.env.DUCKDB_DIST_DIR = distDir;
            // If this fell through to writeManifest() it would spawn
            // scripts/build-duckdb.sh (a 20-60 minute real build) and this
            // test would hang/timeout instead of finishing instantly.
            writeManifestReusingBuild(target);

            const manifest = readFileSync(target, "utf8");
            expect(manifest).toContain('with { type: "file" }');
            expect(manifest).toContain(
                "export const DUCKDB_DYLIB: string | undefined = duckdbDylib;",
            );
        });
    });
});
