import { describe, expect, test } from "bun:test";
import { gatedTest } from "@ax/lib/testing/gated-test";
import { spawnSync } from "node:child_process";
import {
    accessSync,
    chmodSync,
    constants,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binTest = gatedTest({
    reason: "AX_DUCKDB_BIN is not set (no built duckdb binary to exercise)",
    when: !process.env.AX_DUCKDB_BIN,
});
const dylibTest = gatedTest({
    reason: "AX_DUCKDB_DYLIB is not set (no built libduckdb to exercise)",
    when: !process.env.AX_DUCKDB_DYLIB,
});

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

    test("passes STATIC_LIBCPP from CI to the DuckDB make process", () => {
        const workDir = mkdtempSync(join(tmpdir(), "ax-duckdb-build-script-"));
        const binDir = join(workDir, "bin");
        const buildRoot = join(workDir, "build");
        const sourceDir = join(buildRoot, "src");
        const distDir = join(workDir, "dist");
        mkdirSync(join(sourceDir, ".git"), { recursive: true });
        mkdirSync(join(sourceDir, "extension"));
        mkdirSync(binDir);

        const writeExecutable = (name: string, body: string) => {
            const path = join(binDir, name);
            writeFileSync(path, body);
            chmodSync(path, 0o755);
        };

        writeExecutable(
            "git",
            `#!/bin/sh
if [ "$3" = "rev-parse" ]; then
    echo d8cdaa33fda8df955cc76ef58a280f68f4cd43fa
fi
`,
        );
        writeExecutable(
            "make",
            `#!/bin/sh
set -eu
test "\${STATIC_LIBCPP:-}" = 1
test "\${GEN:-}" = ninja
test "\${CORE_EXTENSIONS:-}" = json
test "\${EXTENSION_STATIC_BUILD:-}" = 1
test "$1" = -C
mkdir -p "$2/build/release/src"
printf placeholder > "$2/build/release/src/libduckdb.so"
cat > "$2/build/release/duckdb" <<'EOF'
#!/bin/sh
printf '%s\n' 'fts=1:hello static world' 'json=42'
EOF
chmod +x "$2/build/release/duckdb"
`,
        );
        writeExecutable(
            "bun",
            "#!/bin/sh\nprintf '%s\\n' 'DuckDB dynamic library air-gap smoke passed'\n",
        );
        writeExecutable("uname", "#!/bin/sh\nprintf '%s\\n' Linux\n");

        try {
            const result = spawnSync(join(repoRoot, "scripts/build-duckdb.sh"), [], {
                cwd: repoRoot,
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ""}`,
                    DUCKDB_BUILD_ROOT: buildRoot,
                    DUCKDB_DIST_DIR: distDir,
                    STATIC_LIBCPP: "1",
                },
            });

            expect(result.status).toBe(0);
            expect(result.stderr).not.toContain("STATIC_LIBCPP=1: command not found");
            expect(result.stdout).toContain("DuckDB air-gap smoke passed");
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
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

    // Collapsed from the former AX_DUCKDB_SHELL knob onto the one CLI-binary
    // env name (AX_DUCKDB_BIN) - see scripts/bench/duckdb-bin.ts. This test
    // needs to name a SPECIFIC just-built shell to smoke, not "find any
    // duckdb", so it reads the env var directly rather than through the
    // auto-preferring duckdbBinPath() resolver.
    binTest(
        "the built shell completes the real air-gap FTS and JSON smoke test",
        () => {
            const result = spawnSync(
                join(repoRoot, "scripts/build-duckdb.sh"),
                ["--smoke-only", process.env.AX_DUCKDB_BIN!],
                { cwd: repoRoot, encoding: "utf8" },
            );

            expect(result.status).toBe(0);
            expect(result.stdout).toContain("fts=1:hello static world");
            expect(result.stdout).toContain("json=42");
            expect(result.stdout).toContain("DuckDB air-gap smoke passed");
        },
    );

    dylibTest(
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
