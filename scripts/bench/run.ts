#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    evaluateGates,
    formatMetricTable,
    loadTargets,
    type BenchMeasurements,
} from "./targets.ts";

export const FIXTURE_TABLES = [
    "turn",
    "tool_call",
    "session",
    "commit",
    "skill",
    "invoked",
    "spawned",
    "telemetry_of",
] as const;

const SCRIPT_DIR = import.meta.dir;
const QUERY_RUNS = 5;

export const resolveFixtureDir = (
    env: Record<string, string | undefined> = process.env,
): string | null => {
    const dir = env.AX_BENCH_FIXTURE;
    if (!dir) return null;
    if (!existsSync(dir)) return null;
    try {
        if (!statSync(dir).isDirectory()) return null;
    } catch {
        return null;
    }
    return dir;
};

export const resolveDuckdbBin = (
    env: Record<string, string | undefined> = process.env,
): string | null => {
    const fromEnv = env.AX_DUCKDB_BIN;
    if (fromEnv) {
        return existsSync(fromEnv) ? fromEnv : null;
    }
    return Bun.which("duckdb");
};

export const lastTimerRealS = (output: string): number | null => {
    const matches = [...output.matchAll(/real\s+([0-9.]+)/g)];
    if (matches.length === 0) return null;
    return Number(matches[matches.length - 1]![1]);
};

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted[mid]!;
};

const readSql = (name: string): string =>
    readFileSync(join(SCRIPT_DIR, name), "utf8");

type DuckRun = {
    status: number;
    stdout: string;
    stderr: string;
    elapsedS: number;
    out: string;
};

const runDuck = (
    bin: string,
    args: string[],
    sql: string,
    cwd: string,
): DuckRun => {
    const start = performance.now();
    const proc = spawnSync(bin, args, {
        cwd,
        input: sql,
        encoding: "utf8",
    });
    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    return {
        status: proc.status ?? 1,
        stdout,
        stderr,
        elapsedS: (performance.now() - start) / 1000,
        out: `${stdout}${stderr}`,
    };
};

const failRun = (label: string, run: DuckRun, write: (line: string) => void): number => {
    write(`ERROR: ${label} failed (exit ${run.status})`);
    if (run.out.trim()) write(run.out.trim());
    return 1;
};

const timeQueryMedian = (
    bin: string,
    sql: string,
    cwd: string,
    write: (line: string) => void,
    label: string,
): number | null => {
    const warmup = runDuck(bin, ["bench.duckdb"], sql, cwd);
    if (warmup.status !== 0) {
        failRun(`${label} warmup`, warmup, write);
        return null;
    }
    const samples: number[] = [];
    for (let i = 0; i < QUERY_RUNS; i++) {
        const run = runDuck(bin, ["bench.duckdb"], sql, cwd);
        if (run.status !== 0) {
            failRun(`${label} run ${i + 1}`, run, write);
            return null;
        }
        const timed = lastTimerRealS(run.out);
        if (timed === null) {
            write(`ERROR: ${label} run ${i + 1} produced no .timer real`);
            write(run.out.trim());
            return null;
        }
        samples.push(timed);
    }
    return median(samples);
};

export const main = async (
    env: Record<string, string | undefined> = process.env,
    write: (line: string) => void = console.log,
): Promise<number> => {
    const fixture = resolveFixtureDir(env);
    if (!fixture) {
        write("SKIP: AX_BENCH_FIXTURE is unset or not a directory");
        return 0;
    }
    const duckdb = resolveDuckdbBin(env);
    if (!duckdb) {
        write(
            "SKIP: duckdb CLI not found (set AX_DUCKDB_BIN or install duckdb on PATH)",
        );
        return 0;
    }

    const missing = FIXTURE_TABLES.filter(
        (name) => !existsSync(join(fixture, `${name}.jsonl`)),
    );
    if (missing.length > 0) {
        write(
            `ERROR: fixture missing ${missing.map((name) => `${name}.jsonl`).join(", ")}`,
        );
        return 1;
    }

    const workDir = join(tmpdir(), `ax-bench-${process.pid}-${Date.now()}`);
    mkdirSync(join(workDir, "jsonl"), { recursive: true });
    for (const name of FIXTURE_TABLES) {
        symlinkSync(
            resolve(fixture, `${name}.jsonl`),
            join(workDir, "jsonl", `${name}.jsonl`),
        );
    }

    const keepWork = env.AX_BENCH_KEEP === "1";
    const cleanup = () => {
        if (!keepWork) rmSync(workDir, { recursive: true, force: true });
    };

    try {
        const ext = runDuck(duckdb, [], "INSTALL fts; LOAD fts;", workDir);
        if (ext.status !== 0) {
            return failRun("INSTALL/LOAD fts", ext, write);
        }

        const loadSql = readSql("02_duckdb_load.sql");
        const load = runDuck(duckdb, ["bench.duckdb"], loadSql, workDir);
        if (load.status !== 0) return failRun("load", load, write);

        const ftsSql = `LOAD fts;\n${readSql("03_fts_build.sql")}`;
        const fts = runDuck(duckdb, ["bench.duckdb"], ftsSql, workDir);
        if (fts.status !== 0) return failRun("FTS rebuild", fts, write);

        const snapSql = readSql("05_snapshot_copy.sql");
        const snap = runDuck(duckdb, [], snapSql, workDir);
        if (snap.status !== 0) return failRun("snapshot copy", snap, write);

        const query = (file: string, label: string): number | null =>
            timeQueryMedian(
                duckdb,
                `LOAD fts;\n${readSql(file)}`,
                workDir,
                write,
                label,
            );

        const bm25S = query("04a_query_bm25.sql", "BM25 top-20");
        if (bm25S === null) return 1;
        const aggS = query("04b_query_agg.sql", "aggregate join");
        if (aggS === null) return 1;
        const lookupS = query("04c_query_lookup.sql", "point lookup");
        if (lookupS === null) return 1;
        const joinDrillS = query("04d_query_join_drill.sql", "join drill");
        if (joinDrillS === null) return 1;
        const traversalInvokedS = query(
            "04e_query_graph_traversal.sql",
            "edge-traversal invoked",
        );
        if (traversalInvokedS === null) return 1;
        const traversalSpawnedS = query(
            "04f_query_spawn_chain.sql",
            "edge-traversal spawned",
        );
        if (traversalSpawnedS === null) return 1;

        const snapshotPath = join(workDir, "snapshot.duckdb");
        const cacheBytes = existsSync(snapshotPath)
            ? statSync(snapshotPath).size
            : statSync(join(workDir, "bench.duckdb")).size;

        const measured: BenchMeasurements = {
            loadS: load.elapsedS,
            ftsS: fts.elapsedS,
            snapshotS: snap.elapsedS,
            bm25S,
            aggS,
            traversalInvokedS,
            traversalSpawnedS,
            cacheBytes,
        };
        const result = evaluateGates(measured, loadTargets(env));
        write(formatMetricTable(result));
        write(
            `lookup=${lookupS}s join_drill=${joinDrillS}s work=${keepWork ? workDir : "deleted"}`,
        );
        if (!result.ok) {
            write(
                `FAIL: ${result.breaches.map((row) => row.metric).join(", ")} exceeded target`,
            );
            return 1;
        }
        return 0;
    } finally {
        cleanup();
    }
};

if (import.meta.main) {
    process.exit(await main());
}
