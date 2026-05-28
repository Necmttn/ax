import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

describe("axctl improve recommend", () => {
    test("--help lists filter flags", () => {
        const cli = spawnSync("bun", ["src/cli/index.ts", "improve", "recommend", "--help"], { encoding: "utf-8" });
        const merged = cli.stdout + cli.stderr;
        for (const flag of ["--limit", "--form", "--since", "--json", "--no-clipboard"]) {
            expect(merged).toContain(flag);
        }
    });
});
