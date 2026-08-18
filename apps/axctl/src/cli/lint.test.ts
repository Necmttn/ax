import { describe, expect, test } from "bun:test";
import { gatedTest } from "@ax/lib/testing/gated-test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** apps/axctl, derived from this file's location so the suite is cwd-independent. */
const AXCTL_DIR = join(import.meta.dir, "..", "..");

describe("axctl improve lint", () => {
    test("--help mentions --json and --stale-days", () => {
        const source = readFileSync(join(AXCTL_DIR, "src", "cli", "commands", "improve.ts"), "utf8");
        const commandBlock = source.slice(
            source.indexOf("const improveLintCommand"),
            source.indexOf("const improveListCommand"),
        );
        expect(commandBlock).toContain('json: jsonFlag');
        expect(commandBlock).toContain('Flag.integer("stale-days")');
        expect(commandBlock).toContain("--stale-days");
    });

    // Spawns the real CLI, so it costs a process per run. `AX_E2E_DB=1` is the
    // repo's opt-in for that class of test; it no longer implies a running
    // server, because none exists to run.
    const e2eEnabled = process.env.AX_E2E_DB === "1";
    const e2eTest = gatedTest({ reason: "AX_E2E_DB=1 is not set", when: !e2eEnabled });
    e2eTest("clean run on an empty dir exits 0", () => {
        const root = mkdtempSync(join(tmpdir(), "ax-cli-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "no markers");
        // cwd-independent: `src/cli/index.ts` resolves only from apps/axctl, and
        // `bun test` is run from the repo root, so a bare relative entry exits 1
        // on a missing file and the assertion below reads as a CLI failure.
        const cli = spawnSync("bun", [
            join(AXCTL_DIR, "src", "cli", "index.ts"), "improve", "lint", "--root", root, "--json",
        ], { encoding: "utf-8", cwd: AXCTL_DIR });
        expect(cli.status).toBe(0);
        const out = JSON.parse(cli.stdout);
        expect(out.errors).toEqual([]);
    });
});
