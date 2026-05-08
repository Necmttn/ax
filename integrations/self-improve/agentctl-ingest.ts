#!/usr/bin/env bun
/**
 * agentctl-ingest step for ~/.claude/self-improve/ pipeline.
 *
 * Refreshes the agentctl SurrealDB by running `agentctl ingest --since=14`
 * (14 days = past 2 weeks for safety / catching any missed runs).
 *
 * Usage from run.sh:
 *   bun lib/agentctl-ingest.ts <RUN_DIR> <HOME_DIR>
 *
 * Behavior:
 * - Logs progress to <RUN_DIR>/agentctl-ingest.log
 * - Exits 0 if `agentctl` is not on PATH (graceful fallback - integration is optional)
 * - Exits 0 on successful ingest
 * - Exits non-zero only if `agentctl` exists AND fails
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const SINCE_DAYS = Number(process.env.AGENTCTL_INGEST_SINCE_DAYS ?? 14);

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

async function runIngest(logPath: string, agentctlPath: string): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(agentctlPath, ["ingest", `--since=${SINCE_DAYS}`], {
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
        console.error("usage: bun agentctl-ingest.ts <runDir> [homeDir]");
        process.exit(2);
    }
    await mkdir(runDirArg, { recursive: true });
    const logPath = join(runDirArg, "agentctl-ingest.log");

    const startedAt = new Date().toISOString();
    await writeFile(logPath, `[agentctl-ingest] started_at=${startedAt} since_days=${SINCE_DAYS}\n`);

    const agentctlPath = await which("agentctl");
    if (!agentctlPath) {
        const msg = "[agentctl-ingest] 'agentctl' not on PATH; skipping (integration is optional)\n";
        await appendFile(logPath, msg);
        console.log(msg.trim());
        process.exit(0);
    }
    await appendFile(logPath, `[agentctl-ingest] using ${agentctlPath}\n`);

    const code = await runIngest(logPath, agentctlPath);
    const finishedAt = new Date().toISOString();
    await appendFile(logPath, `\n[agentctl-ingest] finished_at=${finishedAt} exit_code=${code}\n`);

    if (code !== 0) {
        console.error(`[agentctl-ingest] failed with exit code ${code}; see ${logPath}`);
        process.exit(code);
    }
    console.log(`[agentctl-ingest] done; log at ${logPath}`);
}

if (import.meta.main) {
    await main();
}
