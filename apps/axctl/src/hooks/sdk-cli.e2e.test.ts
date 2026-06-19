import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end CLI coverage for issue #564: the two dead-ends a user hit when
 * setting up SDK hooks. These spawn the REAL CLI process so they exercise the
 * full path (arg parse -> command body -> exit code -> stderr), which the
 * in-process installHookFile tests can't.
 *
 * The `hooks` command group provisions the SurrealDB layer eagerly at startup
 * (before the command body, even for --help), so every assertion here needs a
 * live DB. Gate on AX_E2E_DB=1 like the repo's other CLI e2e tests so CI
 * without a daemon doesn't fail.
 */

// apps/axctl (cwd-independent: derive from this file's location)
const AXCTL_DIR = join(import.meta.dir, "..", "..");
const CLI_ENTRY = join(AXCTL_DIR, "src", "cli", "index.ts");

const e2eDb = process.env.AX_E2E_DB === "1";

const runCli = (...args: string[]) =>
    spawnSync("bun", [CLI_ENTRY, ...args], { encoding: "utf-8", cwd: AXCTL_DIR });

describe("ax hooks install (issue #564 - file-not-found)", () => {
    test.skipIf(!e2eDb)(
        "missing file exits non-zero with a clear 'file not found' (not the $bunfs import noise)",
        () => {
            const missing = join(mkdtempSync(join(tmpdir(), "ax-hook-e2e-")), "missing.ts");
            const cli = runCli("hooks", "install", missing, "--providers=claude");

            expect(cli.status).not.toBe(0);
            const out = `${cli.stdout}${cli.stderr}`;
            expect(out).toContain("file not found");
            expect(out).toContain("SdkHookFileNotFoundError");
            // the old misleading failure mode must be gone
            expect(out).not.toContain("dynamic import failed");
            expect(out).not.toContain("$bunfs");
        },
    );
});

/**
 * Compiled-binary guidance (papercut #2). Building a --compile binary in CI is
 * too heavy to do per-run, so this only runs when a prebuilt binary path is
 * supplied via AX_E2E_COMPILED_BIN (e.g. `bun run build` then point at
 * dist/axctl). Verified manually on a real compiled binary; see PR #565.
 */
describe("ax hooks init/install (issue #564 - compiled binary)", () => {
    const compiledBin = process.env.AX_E2E_COMPILED_BIN;

    test.skipIf(!compiledBin)(
        "init prints the source-checkout fallback and exits non-zero (not SdkPathNotFoundError)",
        () => {
            const cli = spawnSync(compiledBin!, ["hooks", "init"], { encoding: "utf-8" });
            expect(cli.status).not.toBe(0);
            const out = `${cli.stdout}${cli.stderr}`;
            expect(out).toContain("SDK (TypeScript) hooks need a source checkout");
            expect(out).toContain("git clone https://github.com/Necmttn/ax");
            expect(out).not.toContain("SdkPathNotFoundError");
        },
    );

    test.skipIf(!compiledBin)(
        "install prints the fallback and exits non-zero (not SdkHookImportError)",
        () => {
            const cli = spawnSync(
                compiledBin!,
                ["hooks", "install", "/tmp/whatever.ts", "--providers=claude"],
                { encoding: "utf-8" },
            );
            expect(cli.status).not.toBe(0);
            const out = `${cli.stdout}${cli.stderr}`;
            expect(out).toContain("SDK (TypeScript) hooks need a source checkout");
            expect(out).not.toContain("SdkHookImportError");
        },
    );
});
