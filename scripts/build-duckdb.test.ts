import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("custom DuckDB build", () => {
    test("the build script uses the pinned static extension recipe and verifies both extensions offline", () => {
        const path = join(repoRoot, "scripts/build-duckdb.sh");
        accessSync(path, constants.X_OK);
        const script = readFileSync(path, "utf8");

        expect(script).toContain("--branch v1.5.5");
        expect(script).toContain("extension_config_local.cmake");
        expect(script).toContain("CORE_EXTENSIONS='json'");
        expect(script).toContain("EXTENSION_STATIC_BUILD=1");
        expect(script).toContain("GEN=ninja");
        expect(script).toContain("autoinstall_known_extensions=false");
        expect(script).toContain("autoload_known_extensions=false");
        expect(script).toContain("custom_extension_repository=''");
        expect(script).toContain("LOAD fts");
        expect(script).toContain("LOAD json");
        expect(script).toContain("create_fts_index");
        expect(script).toContain("match_bm25");
        expect(script).toContain("json_extract");
        expect(script).toContain("smoke-duckdb-dylib.ts");
    });

    test("the release workflow builds all three target platforms and uploads each artifact", () => {
        const workflow = readFileSync(
            join(repoRoot, ".github/workflows/build-duckdb.yml"),
            "utf8",
        );

        expect(workflow).toContain("workflow_dispatch:");
        // No consumer wires these artifacts into a release yet, and the full
        // matrix costs ~3 runner-hours per run - manual dispatch only, no
        // push/tag trigger.
        expect(workflow).not.toContain("push:");
        expect(workflow).not.toContain("tags:");
        expect(workflow).toContain("cancel-in-progress: true");
        expect(workflow).toContain("macos-14");
        expect(workflow).toContain("ubuntu-24.04-arm");
        expect(workflow).toContain("ubuntu-24.04");
        expect(workflow).toContain("static_libcpp: 1");
        expect(workflow).toContain("oven-sh/setup-bun@v2");
        expect(workflow).toContain("scripts/build-duckdb.sh");
        expect(workflow).toContain("actions/upload-artifact@v4");
    });

    test.skipIf(!process.env.AX_DUCKDB_SHELL)(
        "the built shell completes the real air-gap FTS and JSON smoke test",
        () => {
            const result = spawnSync(
                join(repoRoot, "scripts/build-duckdb.sh"),
                ["--smoke-only", process.env.AX_DUCKDB_SHELL!],
                { cwd: repoRoot, encoding: "utf8" },
            );

            expect(result.status).toBe(0);
            expect(result.stdout).toContain("fts=1:hello static world");
            expect(result.stdout).toContain("json=42");
            expect(result.stdout).toContain("DuckDB air-gap smoke passed");
        },
    );

    test.skipIf(!process.env.AX_DUCKDB_DYLIB)(
        "the emitted dynamic library completes the real air-gap FTS and JSON smoke test",
        () => {
            // Mirror build-duckdb.sh's smoke_duckdb_dylib: run against a
            // scratch HOME so the real one (extension cache, config) can
            // never leak into or be mutated by the air-gap smoke test.
            const smokeHome = mkdtempSync(join(tmpdir(), "ax-duckdb-dylib-smoke-test-"));
            try {
                const result = spawnSync(
                    "bun",
                    [
                        join(repoRoot, "scripts/smoke-duckdb-dylib.ts"),
                        process.env.AX_DUCKDB_DYLIB!,
                    ],
                    {
                        cwd: repoRoot,
                        encoding: "utf8",
                        env: {
                            ...process.env,
                            HOME: smokeHome,
                            HTTP_PROXY: "http://127.0.0.1:9",
                            HTTPS_PROXY: "http://127.0.0.1:9",
                            ALL_PROXY: "http://127.0.0.1:9",
                            NO_PROXY: "",
                        },
                    },
                );

                expect(result.status).toBe(0);
                expect(result.stdout).toContain("fts=hello static world");
                expect(result.stdout).toContain("json=42");
                expect(result.stdout).toContain("DuckDB dynamic library air-gap smoke passed");
            } finally {
                rmSync(smokeHome, { recursive: true, force: true });
            }
        },
    );
});
