import { describe, expect, test } from "bun:test";
import { gatedTest } from "@ax/lib/testing/gated-test";
import { spawnSync } from "node:child_process";
import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

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
        // The dynamic-library smoke must call a resolvable Bun binary, not a
        // hardcoded `bun` that only exists on the invoking user's PATH - a
        // `sudo unshare --net` caller runs under root's PATH, which does not
        // carry Bun.
        expect(script).toContain("bun_bin=${BUN_BIN:-bun}");
        expect(script).toContain('"$bun_bin" "$repo_root/scripts/smoke-duckdb-dylib.ts"');
        expect(script).not.toMatch(/[^"]bun "\$repo_root\/scripts\/smoke-duckdb-dylib\.ts"/);
        // A combined mode lets a caller run both smokes as a single unit
        // (e.g. inside one `sudo unshare --net` process) instead of two
        // separate invocations that would each need their own isolation.
        expect(script).toContain("--smoke-artifacts");
        expect(script).toContain("usage: $0 --smoke-only <duckdb-shell>");
        expect(script).toContain("usage: $0 --smoke-artifacts <duckdb-shell> <libduckdb>");
    });

    test("--smoke-artifacts runs both the shell and dylib smokes, and honors BUN_BIN over PATH", () => {
        const workDir = mkdtempSync(join(tmpdir(), "ax-duckdb-smoke-artifacts-"));
        try {
            const shellPath = join(workDir, "fake-duckdb-shell");
            writeFileSync(
                shellPath,
                "#!/bin/sh\nprintf '%s\\n' 'fts=1:hello static world' 'json=42' \"shell-home=$HOME\"\n",
            );
            chmodSync(shellPath, 0o755);

            const dylibPath = join(workDir, "fake-libduckdb.so");
            writeFileSync(dylibPath, "placeholder");

            // A real `bun` planted early on PATH must NOT be the one invoked -
            // only BUN_BIN's absolute path should run.
            const wrongBinDir = join(workDir, "wrong-bin");
            mkdirSync(wrongBinDir);
            const wrongBun = join(wrongBinDir, "bun");
            writeFileSync(wrongBun, "#!/bin/sh\nprintf '%s\\n' 'WRONG BUN INVOKED'\nexit 1\n");
            chmodSync(wrongBun, 0o755);

            const honoredBunDir = join(workDir, "honored-bin");
            mkdirSync(honoredBunDir);
            const honoredBun = join(honoredBunDir, "bun-marker");
            writeFileSync(
                honoredBun,
                "#!/bin/sh\nprintf '%s\\n' \"dylib-home=$HOME\" 'DuckDB dynamic library air-gap smoke passed'\n",
            );
            chmodSync(honoredBun, 0o755);

            const parentHome = join(workDir, "parent-home");
            mkdirSync(parentHome);

            const result = spawnSync(
                join(repoRoot, "scripts/build-duckdb.sh"),
                ["--smoke-artifacts", shellPath, dylibPath],
                {
                    cwd: repoRoot,
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        PATH: `${wrongBinDir}:${process.env.PATH ?? ""}`,
                        BUN_BIN: honoredBun,
                        HOME: parentHome,
                    },
                },
            );

            expect(result.status).toBe(0);
            expect(result.stdout).toContain("DuckDB air-gap smoke passed");
            expect(result.stdout).toContain("DuckDB dynamic library air-gap smoke passed");
            expect(result.stdout).not.toContain("WRONG BUN INVOKED");
            expect(result.stderr).not.toContain("WRONG BUN INVOKED");

            const shellHome = result.stdout.match(/^shell-home=(.+)$/m)?.[1];
            const dylibHome = result.stdout.match(/^dylib-home=(.+)$/m)?.[1];
            expect(shellHome).toBeDefined();
            expect(dylibHome).toBeDefined();
            expect(shellHome).not.toBe(parentHome);
            expect(dylibHome).not.toBe(parentHome);
            expect(shellHome).not.toBe(dylibHome);
            expect(existsSync(shellHome!)).toBe(false);
            expect(existsSync(dylibHome!)).toBe(false);
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    test("--smoke-artifacts requires exactly a duckdb-shell and a libduckdb argument", () => {
        const result = spawnSync(join(repoRoot, "scripts/build-duckdb.sh"), ["--smoke-artifacts", "one-arg-only"], {
            cwd: repoRoot,
            encoding: "utf8",
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("usage:");
        expect(result.stderr).toContain("--smoke-artifacts <duckdb-shell> <libduckdb>");
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

    test("installs workspace dependencies before the build, and isolates the post-build smoke under a Linux-only network namespace", () => {
        const workflowPath = join(repoRoot, ".github/workflows/build-duckdb.yml");
        const workflow = parse(readFileSync(workflowPath, "utf8")) as {
            jobs: Record<string, { steps: WorkflowStep[] }>;
        };
        const steps = workflow.jobs.build.steps;

        const installIdx = steps.findIndex(
            (s) => (s.run ?? "").trim() === "bun install --frozen-lockfile",
        );
        const buildIdx = steps.findIndex(
            (s) => (s.run ?? "").includes("scripts/build-duckdb.sh") && !(s.run ?? "").includes("--"),
        );
        expect(installIdx).toBeGreaterThanOrEqual(0);
        expect(buildIdx).toBeGreaterThan(installIdx);

        // The build (make) itself must never run inside the network
        // namespace - only an ADDITIONAL post-build smoke, Linux-only since
        // `unshare --net` is a Linux syscall with no macOS equivalent.
        const isolatedSmokeIdx = steps.findIndex((s) => (s.run ?? "").includes("sudo unshare --net"));
        expect(isolatedSmokeIdx).toBeGreaterThan(buildIdx);
        const isolatedSmoke = steps[isolatedSmokeIdx];
        expect(isolatedSmoke?.if).toBe("runner.os == 'Linux'");
        expect(isolatedSmoke?.run).toContain("--smoke-artifacts");
        expect(isolatedSmoke?.run).toContain("BUN_BIN=");

        // Bun must be resolved to an absolute path BEFORE the sudo call - a
        // `command -v bun` issued inside the sudo'd process would see root's
        // PATH, which does not carry Bun.
        const runLines = (isolatedSmoke?.run ?? "").split("\n");
        const resolveIdx = runLines.findIndex((l) => l.includes("command -v bun"));
        const sudoIdx = runLines.findIndex((l) => l.includes("sudo unshare --net"));
        expect(resolveIdx).toBeGreaterThanOrEqual(0);
        expect(sudoIdx).toBeGreaterThan(resolveIdx);
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

type WorkflowStep = {
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
};

describe("provision-duckdb composite action restores/builds/smokes/saves the DuckDB build", () => {
    const actionPath = join(repoRoot, ".github/actions/provision-duckdb/action.yml");
    const action = parse(readFileSync(actionPath, "utf8")) as {
        runs: { using: string; steps: WorkflowStep[] };
        outputs?: Record<string, { value: string }>;
    };
    const steps = action.runs.steps;

    const restoreStep = steps.find((s) => s.uses?.startsWith("actions/cache/restore"));
    const saveStep = steps.find((s) => s.uses?.startsWith("actions/cache/save"));
    const buildStep = steps.find((s) => (s.run ?? "").trim() === "scripts/build-duckdb.sh");
    const smokeStep = steps.find((s) => (s.run ?? "").includes("--smoke-artifacts"));

    test("is a composite action with the DuckDB steps to guard", () => {
        // A parse/lookup mistake here would make every case below vacuously
        // true - the same trap check-ci-duckdb.test.ts guards against.
        expect(action.runs.using).toBe("composite");
        expect(restoreStep).toBeDefined();
        expect(saveStep).toBeDefined();
        expect(buildStep).toBeDefined();
        expect(smokeStep).toBeDefined();
    });

    test("the cache is scoped per platform and keyed on every DuckDB build and compatibility input", () => {
        expect(restoreStep?.with?.path).toBe("dist/duckdb");
        // The restore/save `key:` reference the computed value by step
        // output, so the hashFiles inputs live in the step that computes it.
        const keyStep = steps.find(
            (s) => (s.run ?? "").includes("GITHUB_OUTPUT") && (s.run ?? "").includes("hashFiles"),
        );
        expect(keyStep?.id).toBeDefined();
        expect(restoreStep?.with?.key).toContain(`steps.${keyStep?.id}.outputs`);

        const key = keyStep?.run ?? "";
        expect(key).toContain("runner.os");
        expect(key).toContain("runner.arch");
        expect(key).toContain("scripts/build-duckdb.sh");
        expect(key).toContain("scripts/duckdb/extension_config_local.cmake");
        expect(key).toContain("scripts/smoke-duckdb-dylib.ts");
        expect(key).toContain(".github/actions/provision-duckdb/action.yml");
        expect(key).toContain("@duckdb/node-api");
        expect(key).toContain("@duckdb/node-bindings");
        // Read only the two exact catalog versions. Hashing package.json or
        // bun.lock would rebuild native DuckDB after unrelated dependency or
        // release-version changes.
        expect(key).toContain('Bun.file("package.json").json()');
        expect(key).not.toContain("bun.lock");
    });

    test("save uses the identical key and path as restore", () => {
        expect(saveStep?.with?.key).toBe(restoreStep?.with?.key);
        expect(saveStep?.with?.path).toBe("dist/duckdb");
    });

    test("restores the cache, and builds on a miss, before the smoke step", () => {
        const restoreIdx = steps.indexOf(restoreStep!);
        const buildIdx = steps.indexOf(buildStep!);
        const smokeIdx = steps.indexOf(smokeStep!);
        expect(restoreIdx).toBeGreaterThanOrEqual(0);
        expect(buildIdx).toBeGreaterThan(restoreIdx);
        expect(buildIdx).toBeLessThan(smokeIdx);
    });

    test("only builds DuckDB from scratch on a cache miss", () => {
        expect(buildStep?.if).toContain("cache-hit");
        expect(buildStep?.if).toContain("!=");
    });

    test("passes STATIC_LIBCPP on Linux only, not on the macOS legs", () => {
        const staticLibcpp = String(buildStep?.env?.STATIC_LIBCPP ?? "");
        expect(staticLibcpp).toContain("runner.os == 'Linux'");
        expect(staticLibcpp).toContain("'1'");
    });

    test("smokes both the restored shell and the correct dylib unconditionally - restore or build, never skipped on a hit", () => {
        expect(smokeStep?.if).toBeUndefined();
        expect(smokeStep?.run).toContain("chmod +x dist/duckdb/duckdb");
        expect(smokeStep?.run).toContain("build-duckdb.sh --smoke-artifacts");
    });

    test("resolves the platform-specific library rather than hardcoding one extension", () => {
        const fullText = readFileSync(actionPath, "utf8");
        expect(fullText).toContain("libduckdb.dylib");
        expect(fullText).toContain("libduckdb.so");
        expect(smokeStep?.run).toMatch(/libduckdb\.(dylib|so)|duckdb-lib/);
    });

    test("Linux smokes under a real network namespace with an absolute, pre-sudo-resolved Bun; macOS runs the combined smoke directly (no unshare)", () => {
        const run = smokeStep?.run ?? "";
        expect(run).toContain("sudo unshare --net");
        expect(run).toContain("BUN_BIN=");
        expect(run).toContain("runner.os");
        expect(run).toContain("Linux");

        const lines = run.split("\n");
        const resolveIdx = lines.findIndex((l) => l.includes("command -v bun"));
        const sudoIdx = lines.findIndex((l) => l.includes("sudo unshare --net"));
        expect(resolveIdx).toBeGreaterThanOrEqual(0);
        expect(sudoIdx).toBeGreaterThan(resolveIdx);

        // macOS has no `unshare` syscall - its leg must still run the
        // combined smoke, just without namespace isolation, and never fall
        // back to a weaker smoke when Linux's isolation "fails".
        const nonLinuxRunsCombinedSmoke = /else|macOS/.test(run) && run.includes("--smoke-artifacts");
        expect(nonLinuxRunsCombinedSmoke).toBe(true);
    });

    test("saves only after the smoke passes, and never on a cache hit", () => {
        const smokeIdx = steps.indexOf(smokeStep!);
        const saveIdx = steps.indexOf(saveStep!);
        expect(saveIdx).toBeGreaterThan(smokeIdx);
        expect(saveStep?.if).toContain("cache-hit");
        expect(saveStep?.if).toContain("!=");
    });

    test("records a provisioning timing receipt via a cross-step start value, labeled by the caller", () => {
        const timerStep = steps.find(
            (s) => (s.run ?? "").includes("GITHUB_OUTPUT") && (s.run ?? "").includes("date +%s"),
        );
        expect(timerStep?.id).toBeDefined();

        const summaryStep = steps.find((s) => (s.run ?? "").includes("GITHUB_STEP_SUMMARY"));
        expect(summaryStep).toBeDefined();
        expect(summaryStep?.run).toContain(`steps.${timerStep?.id}.outputs`);
        expect(summaryStep?.run).toContain("cache-hit");
        expect(summaryStep?.run).toContain("inputs.label");
        expect(summaryStep?.run).toContain('echo "$receipt"');
        expect(steps.indexOf(summaryStep!)).toBeGreaterThan(steps.indexOf(smokeStep!));
    });

    test("exposes cache-hit as an output for callers to key logic off", () => {
        expect(action.outputs?.["cache-hit"]?.value ?? "").toContain("duckdb-restore.outputs.cache-hit");
    });
});

describe("release-please.yml: a trusted default-branch prime primes the same cache release tags restore from", () => {
    const workflowPath = join(repoRoot, ".github/workflows/release-please.yml");
    const workflow = parse(readFileSync(workflowPath, "utf8")) as {
        jobs: Record<
            string,
            {
                needs?: string | string[];
                if?: string;
                "timeout-minutes"?: number;
                outputs?: Record<string, string>;
                strategy?: { matrix?: { include?: Array<{ runner: string; artifact: string }> } };
                steps?: WorkflowStep[];
            }
        >;
    };
    const releasePleaseJob = workflow.jobs["release-please"];
    const primeJob = workflow.jobs["prime-duckdb-cache"];
    const buildJob = workflow.jobs["build-artifacts"];
    const publishJob = workflow.jobs["publish-artifacts"];
    const provisionUses = "./.github/actions/provision-duckdb";

    test("build-artifacts and prime-duckdb-cache both exist and invoke the identical composite action path", () => {
        // Cache-key identity between the two jobs comes from literally calling
        // the same action file, not from two hand-copied formulas that could
        // drift apart - this is the structural guarantee that a key the prime
        // job saves is the exact key a release tag will look up.
        expect(buildJob).toBeDefined();
        expect(primeJob).toBeDefined();
        const buildProvisionStep = buildJob?.steps?.find((s) => s.uses === provisionUses);
        const primeProvisionStep = primeJob?.steps?.find((s) => s.uses === provisionUses);
        expect(buildProvisionStep).toBeDefined();
        expect(primeProvisionStep).toBeDefined();
    });

    test("build-artifacts carries 90 minutes of timeout headroom above recent 12m-33m cold builds", () => {
        expect(buildJob?.["timeout-minutes"]).toBe(90);
    });

    test("build-artifacts restores/builds via the composite action before the CLI binary build", () => {
        const steps = buildJob?.steps ?? [];
        const provisionIdx = steps.findIndex((s) => s.uses === provisionUses);
        const buildAxctlIdx = steps.findIndex((s) => (s.run ?? "").includes("scripts/build-axctl.ts"));
        expect(provisionIdx).toBeGreaterThanOrEqual(0);
        expect(buildAxctlIdx).toBeGreaterThan(provisionIdx);
    });

    test("prime-duckdb-cache is gated on release-please's own releases_created output, not guessed from the event", () => {
        expect(primeJob?.needs).toBe("release-please");
        expect(primeJob?.if ?? "").toContain("needs.release-please.outputs.releases_created");
        expect(primeJob?.if ?? "").toContain("== 'true'");
        // A typo'd output name here would leave the condition permanently
        // false and the prime job would silently never fire - pin it back to
        // release-please's actual output wiring.
        expect(releasePleaseJob?.outputs?.releases_created ?? "").toContain(
            "steps.release.outputs.releases_created",
        );
    });

    test("prime-duckdb-cache's matrix mirrors build-artifacts' matrix runners exactly, so it seeds the same (os, arch) cache keys build-artifacts will look up", () => {
        const buildRunners = (buildJob?.strategy?.matrix?.include ?? []).map((m) => m.runner).sort();
        const primeRunners = (primeJob?.strategy?.matrix?.include ?? []).map((m) => m.runner).sort();
        expect(buildRunners.length).toBeGreaterThan(0);
        expect(primeRunners).toEqual(buildRunners);
    });

    test("prime-duckdb-cache never publishes release artifacts - no CLI build, packaging, upload, or gh release calls", () => {
        const primeText = JSON.stringify(primeJob?.steps ?? []);
        expect(primeText).not.toContain("build-axctl.ts");
        expect(primeText).not.toContain("upload-artifact");
        expect(primeText).not.toContain("gh release");
        expect(primeText).not.toContain("tar -czf");
    });

    test("prime-duckdb-cache installs workspace dependencies before the dynamic library smoke", () => {
        const steps = primeJob?.steps ?? [];
        const installIdx = steps.findIndex(
            (s) => (s.run ?? "").trim() === "bun install --frozen-lockfile",
        );
        const provisionIdx = steps.findIndex((s) => s.uses === provisionUses);
        expect(installIdx).toBeGreaterThanOrEqual(0);
        expect(provisionIdx).toBeGreaterThan(installIdx);
    });

    test("the release publish-race protection is unchanged: publish-artifacts still gates on the release/tag-dispatch event only", () => {
        expect(publishJob?.needs).toBe("build-artifacts");
        expect(publishJob?.if ?? "").not.toContain("prime-duckdb-cache");
        expect(publishJob?.if ?? "").toContain("github.event_name == 'release'");
    });
});
