import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts/check-table-coverage.ts");

const runGate = (): { exitCode: number; stdout: string; stderr: string } => {
    const proc = spawnSync("bun", [SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
    });
    return {
        exitCode: proc.status ?? -1,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
    };
};

describe("check-table-coverage gate", () => {
    test("passes on the current tree", () => {
        const r = runGate();
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("[check-table-coverage] OK");
    });
});

describe("check-table-coverage gate FAILS on a synthetic orphan", () => {
    // The test injects a temp .ts file under src/ingest that writes a fake
    // table with no reader. The gate must spot it. Self-test for the gate
    // itself - see Phase D follow-up in the plan.
    const ORPHAN_TABLE = "zzz_synthetic_orphan_for_gate_test";
    const FIXTURE_PATH = join(REPO_ROOT, "apps/axctl/src/ingest/_test_synthetic_orphan.ts");

    beforeEach(() => {
        writeFileSync(
            FIXTURE_PATH,
            `// Fixture for scripts/check-table-coverage.test.ts. Removed in afterEach.\n` +
                `export const sql = \`UPSERT ${ORPHAN_TABLE} SET x = 1;\`;\n`,
            "utf8",
        );
    });

    afterEach(() => {
        rmSync(FIXTURE_PATH, { force: true });
    });

    test("non-zero exit + reports the orphan table name", () => {
        const r = runGate();
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain(ORPHAN_TABLE);
    });
});
