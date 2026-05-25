#!/usr/bin/env bun
/**
 * ax-ingest step for ~/.claude/self-improve/ pipeline.
 *
 * Refreshes the ax SurrealDB by running `axctl ingest --since=14`
 * (14 days = past 2 weeks for safety / catching any missed runs).
 *
 * Usage from run.sh:
 *   bun lib/ax-ingest.ts <RUN_DIR> <HOME_DIR>
 *
 * Behavior:
 * - Logs progress to <RUN_DIR>/ax-ingest.log
 * - Exits 0 if `axctl` is not on PATH (graceful fallback - integration is optional)
 * - Exits 0 on successful ingest
 * - Exits non-zero only if `axctl` exists AND fails
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const SINCE_DAYS = Number(process.env.AX_INGEST_SINCE_DAYS ?? 14);

async function which(cmd: string): Promise<string | null> {
    return new Promise((resolve) => {
        const child = spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.on("close", (code) => {
            if (code === 0 && out.trim()) resolve(out.trim());
            else resolve(null);
        });
        child.on("error", () => resolve(null));
    });
}

async function runIngest(logPath: string, axctlPath: string): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(axctlPath, ["ingest", `--since=${SINCE_DAYS}`], {
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        });
        const tee = async (chunk: Buffer) => {
            const s = chunk.toString();
            process.stdout.write(s);
            await appendFile(logPath, s);
        };
        child.stdout.on("data", tee);
        child.stderr.on("data", tee);
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", async (err) => {
            await appendFile(logPath, `\n[error] ${err.message}\n`);
            resolve(1);
        });
    });
}

async function main(): Promise<void> {
    const [, , runDirArg] = process.argv;
    if (!runDirArg) {
        console.error("usage: bun ax-ingest.ts <runDir> [homeDir]");
        process.exit(2);
    }
    await mkdir(runDirArg, { recursive: true });
    const logPath = join(runDirArg, "ax-ingest.log");

    const startedAt = new Date().toISOString();
    await writeFile(logPath, `[ax-ingest] started_at=${startedAt} since_days=${SINCE_DAYS}\n`);

    const axctlPath = await which("axctl");
    if (!axctlPath) {
        const msg = "[ax-ingest] 'axctl' not on PATH; skipping (integration is optional)\n";
        await appendFile(logPath, msg);
        console.log(msg.trim());
        process.exit(0);
    }
    await appendFile(logPath, `[ax-ingest] using ${axctlPath}\n`);

    const code = await runIngest(logPath, axctlPath);
    const finishedAt = new Date().toISOString();
    await appendFile(logPath, `\n[ax-ingest] finished_at=${finishedAt} exit_code=${code}\n`);

    if (code !== 0) {
        console.error(`[ax-ingest] failed with exit code ${code}; see ${logPath}`);
        process.exit(code);
    }
    console.log(`[ax-ingest] done; log at ${logPath}`);
}

if (import.meta.main) {
    await main();
}
