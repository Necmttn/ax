import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
 * Compiled binary: SDK hooks WORK from embedded bundles (issue #573). Building a
 * --compile binary in CI is too heavy per-run, so these run only when a prebuilt
 * binary path is supplied via AX_E2E_COMPILED_BIN (`bun run build`, then point at
 * dist/axctl). They also need a live DB (the hooks group provisions it eagerly),
 * so gate on AX_E2E_DB=1 too. A throwaway HOME isolates the writes from the real
 * ~/.ax and ~/.claude.
 */
describe("ax hooks init/install on a compiled binary (issue #573)", () => {
    const compiledBin = process.env.AX_E2E_COMPILED_BIN;
    const enabled = !!compiledBin && e2eDb;

    const runBin = (home: string, ...args: string[]) =>
        spawnSync(compiledBin!, args, {
            encoding: "utf-8",
            env: { ...process.env, HOME: home },
        });

    const initHome = (): string => {
        const home = mkdtempSync(join(tmpdir(), "ax-bin-home-"));
        const cli = runBin(home, "hooks", "init");
        expect(cli.status).toBe(0);
        return home;
    };

    test.skipIf(!enabled)("init writes standalone bundled .js hooks and exits 0", () => {
        const home = mkdtempSync(join(tmpdir(), "ax-bin-home-"));
        const cli = runBin(home, "hooks", "init");
        expect(cli.status).toBe(0);
        const out = `${cli.stdout}${cli.stderr}`;
        expect(out).toContain("bundled hooks for the compiled binary");
        expect(out).not.toContain("SdkPathNotFoundError");
        const rd = join(home, ".ax/hooks/route-dispatch.js");
        expect(existsSync(rd)).toBe(true);
        // standalone bundle = effect inlined, NOT the thin `.ts` wrapper that
        // imports the (absent) @ax/hooks-sdk workspace
        expect(readFileSync(rd, "utf8")).not.toContain('from "@ax/hooks-sdk');
    });

    test.skipIf(!enabled)("a written hook fires standalone via bun (offline, exit 0)", () => {
        const home = initHome();
        const rd = join(home, ".ax/hooks/route-dispatch.js");
        const fired = spawnSync("bun", [rd], {
            encoding: "utf-8",
            input: JSON.stringify({ tool_name: "Agent", tool_input: { description: "map the repo" } }),
        });
        // defects fail OPEN, and a quiet hook emits nothing - the contract here
        // is just "runs to a clean exit with no node_modules present".
        expect(fired.status).toBe(0);
    });

    test.skipIf(!enabled)("install registers a bundled hook (binary imports the .js for meta)", () => {
        const home = initHome();
        const rd = join(home, ".ax/hooks/route-dispatch.js");
        const cli = runBin(home, "hooks", "install", rd, "--providers=claude");
        expect(cli.status).toBe(0);
        const out = `${cli.stdout}${cli.stderr}`;
        expect(out).toContain("installed claude PreToolUse");
        expect(out).not.toContain("SdkHookImportError");
        expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toContain("route-dispatch.js");
    });
});
