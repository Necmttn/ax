import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("axctl improve lint", () => {
    test("--help mentions --json and --stale-days", () => {
        const source = readFileSync("apps/axctl/src/cli/index.ts", "utf8");
        const commandBlock = source.slice(
            source.indexOf("const improveLintCommand"),
            source.indexOf("const improveListCommand"),
        );
        expect(commandBlock).toContain('json: jsonFlag');
        expect(commandBlock).toContain('Flag.integer("stale-days")');
        expect(commandBlock).toContain("--stale-days");
    });

    // DB is required for the stale-task scan that runs unconditionally in lintFiles.
    // Gate behind AX_E2E_DB=1 so CI without a live SurrealDB doesn't fail.
    const e2eEnabled = process.env.AX_E2E_DB === "1";
    test.skipIf(!e2eEnabled)("clean run on an empty dir exits 0", () => {
        const root = mkdtempSync(join(tmpdir(), "ax-cli-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "no markers");
        const cli = spawnSync("bun", [
            "src/cli/index.ts", "improve", "lint", "--root", root, "--json",
        ], { encoding: "utf-8" });
        expect(cli.status).toBe(0);
        const out = JSON.parse(cli.stdout);
        expect(out.errors).toEqual([]);
    });
});
