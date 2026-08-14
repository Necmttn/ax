import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeMiniFixture } from "./gen-mini-fixture.ts";
import { FIXTURE_TABLES, resolveDuckdbBin } from "./run.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(import.meta.dir, "run.ts");

const runBench = (envOverrides: Record<string, string | undefined>) => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(envOverrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    const proc = spawnSync("bun", [SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
    });
    return {
        exitCode: proc.status ?? -1,
        out: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
    };
};

const makeEmptyFixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "ax-bench-empty-"));
    for (const name of FIXTURE_TABLES) {
        writeFileSync(join(dir, `${name}.jsonl`), "", "utf8");
    }
    return dir;
};

const temps: string[] = [];
afterEach(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    temps.length = 0;
});

describe("bench runner skip", () => {
    test("exits 0 with a SKIP notice when AX_BENCH_FIXTURE is absent", () => {
        const r = runBench({
            AX_BENCH_FIXTURE: undefined,
            AX_DUCKDB_BIN: "/usr/bin/true",
        });
        expect(r.exitCode).toBe(0);
        expect(r.out).toContain("SKIP");
        expect(r.out.toLowerCase()).toContain("fixture");
    });

    test("exits 0 with a SKIP notice when duckdb CLI is not found", () => {
        const fixture = makeEmptyFixture();
        temps.push(fixture);
        const bunDir = dirname(Bun.which("bun") ?? process.execPath);
        // Deliberately exclude /usr/bin and /bin: a system-installed duckdb
        // there would satisfy Bun.which("duckdb") and break this SKIP
        // assertion. Only the bun dir (needed to spawn the script) plus a
        // guaranteed-empty dir (in case an empty PATH misbehaves) are on PATH.
        const emptyPathDir = mkdtempSync(join(tmpdir(), "ax-bench-emptypath-"));
        temps.push(emptyPathDir);
        const r = runBench({
            AX_BENCH_FIXTURE: fixture,
            AX_DUCKDB_BIN: undefined,
            PATH: [bunDir, emptyPathDir].join(":"),
        });
        expect(r.exitCode).toBe(0);
        expect(r.out).toContain("SKIP");
        expect(r.out.toLowerCase()).toContain("duckdb");
    });

    test("exits 0 with SKIP when AX_DUCKDB_BIN points at a missing file", () => {
        const fixture = makeEmptyFixture();
        temps.push(fixture);
        const r = runBench({
            AX_BENCH_FIXTURE: fixture,
            AX_DUCKDB_BIN: join(tmpdir(), "no-such-duckdb-bin"),
        });
        expect(r.exitCode).toBe(0);
        expect(r.out).toContain("SKIP");
        expect(r.out.toLowerCase()).toContain("duckdb");
    });
});

describe("bench runner suite", () => {
    const duckdb = resolveDuckdbBin();

    test.skipIf(!duckdb)("prints the metric table and exits 0 against the mini fixture", () => {
        if (!duckdb) return;
        const fixture = mkdtempSync(join(tmpdir(), "ax-bench-mini-"));
        temps.push(fixture);
        writeMiniFixture(fixture);
        const r = runBench({
            AX_BENCH_FIXTURE: fixture,
            AX_DUCKDB_BIN: duckdb,
        });
        expect(r.out).toContain("full re-derive write path");
        expect(r.out).toContain("FTS rebuild");
        expect(r.out).toContain("snapshot copy");
        expect(r.out).toContain("BM25 top-20");
        expect(r.out).toContain("aggregate join");
        expect(r.out).toContain("edge-traversal");
        expect(r.out).toContain("cache file");
        expect(r.out).toContain("PASS");
        expect(r.exitCode).toBe(0);
    }, 120_000);

    test.skipIf(!duckdb)("exits non-zero when a target is tightened past the measured value", () => {
        if (!duckdb) return;
        const fixture = mkdtempSync(join(tmpdir(), "ax-bench-tight-"));
        temps.push(fixture);
        writeMiniFixture(fixture);
        const r = runBench({
            AX_BENCH_FIXTURE: fixture,
            AX_DUCKDB_BIN: duckdb,
            AX_BENCH_MAX_BM25_MS: "0",
        });
        expect(r.exitCode).not.toBe(0);
        expect(r.out).toContain("FAIL");
        expect(r.out).toContain("BM25 top-20");
    }, 120_000);

    test.skipIf(!duckdb)("rejects a fixture where every table is empty instead of silently passing", () => {
        if (!duckdb) return;
        const fixture = makeEmptyFixture();
        temps.push(fixture);
        const r = runBench({
            AX_BENCH_FIXTURE: fixture,
            AX_DUCKDB_BIN: duckdb,
        });
        expect(r.exitCode).not.toBe(0);
        expect(r.out).toContain("ERROR");
        expect(r.out.toLowerCase()).toContain("empty");
    }, 60_000);
});

describe("bench runner target validation", () => {
    test("exits non-zero with the offending name+value when a target override is not a number", () => {
        const fixture = makeEmptyFixture();
        temps.push(fixture);
        const r = runBench({
            AX_BENCH_FIXTURE: fixture,
            AX_DUCKDB_BIN: "/usr/bin/true",
            AX_BENCH_MAX_BM25_MS: "10ms",
        });
        expect(r.exitCode).not.toBe(0);
        expect(r.out).toContain("ERROR");
        expect(r.out).toContain("AX_BENCH_MAX_BM25_MS");
        expect(r.out).toContain("10ms");
    });
});
