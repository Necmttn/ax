#!/usr/bin/env bun
/**
 * Deprecation candidate generator for ~/.claude/self-improve/ pipeline.
 *
 * Calls `axctl unused --days=90`, parses the human-readable output, then
 * cross-references against ~/.claude/self-improve/keep.txt to filter the
 * always-keep list out. Writes structured JSON to:
 *   <RUN_DIR>/deprecation-candidates.json
 *
 * Usage:
 *   bun deprecate-helper.ts <RUN_DIR> <HOME_DIR> [--days=90]
 *
 * Output schema:
 *   {
 *     generated_at: string (ISO),
 *     days: number,
 *     source: "ax",
 *     candidates: Array<{ slug: string; scope: string; total_invocations: number; last_used: string | null }>,
 *     kept: string[]   // slugs that would be candidates but are protected by keep.txt
 *   }
 *
 * Graceful fallback: if `axctl` is not on PATH, writes an empty result
 * with source: "unavailable" and exits 0.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Candidate {
    slug: string;
    scope: string;
    total_invocations: number;
    last_used: string | null;
}

interface Result {
    generated_at: string;
    days: number;
    source: "ax" | "unavailable";
    candidates: Candidate[];
    kept: string[];
}

function parseFlag(name: string, args: string[], fallback: string): string {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    if (!found) return fallback;
    return found.slice(name.length + 3);
}

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

async function runUnused(axctlPath: string, days: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(axctlPath, ["unused", `--days=${days}`], {
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("close", (code) => {
            if (code !== 0) reject(new Error(`axctl unused exited ${code}: ${stderr}`));
            else resolve(stdout);
        });
        child.on("error", (err) => reject(err));
    });
}

/**
 * Parse the human output of `axctl unused`. Each row looks like:
 *   "<name>  [<scope>]  total=<n>  last=<iso|never>"
 * The trailing summary line ("N skills unused in last D days.") is ignored.
 */
function parseUnusedOutput(stdout: string): Candidate[] {
    const out: Candidate[] = [];
    const rowRe = /^(.+?)\s+\[([^\]]+)\]\s+total=(\d+)\s+last=(\S+)\s*$/;
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/skills unused in last/i.test(trimmed)) continue;
        const m = rowRe.exec(trimmed);
        if (!m) continue;
        const [, name, scope, total, last] = m;
        out.push({
            slug: name!.trim(),
            scope: scope!.trim(),
            total_invocations: Number(total),
            last_used: last === "never" ? null : last!,
        });
    }
    return out;
}

async function loadKeepList(homeDir: string): Promise<Set<string>> {
    const keepPath = join(homeDir, "keep.txt");
    try {
        const raw = await readFile(keepPath, "utf8");
        return new Set(
            raw
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith("#")),
        );
    } catch {
        return new Set();
    }
}

async function main(): Promise<void> {
    const [, , runDirArg, homeDirArg, ...rest] = process.argv;
    if (!runDirArg || !homeDirArg) {
        console.error("usage: bun deprecate-helper.ts <runDir> <homeDir> [--days=90]");
        process.exit(2);
    }
    const days = Number(parseFlag("days", rest, "90"));
    await mkdir(runDirArg, { recursive: true });
    const outPath = join(runDirArg, "deprecation-candidates.json");

    const keep = await loadKeepList(homeDirArg);
    const generated_at = new Date().toISOString();

    const axctlPath = await which("axctl");
    if (!axctlPath) {
        const empty: Result = {
            generated_at,
            days,
            source: "unavailable",
            candidates: [],
            kept: [],
        };
        await writeFile(outPath, JSON.stringify(empty, null, 2));
        console.log(`[deprecate-helper] axctl not on PATH; wrote empty result to ${outPath}`);
        return;
    }

    let stdout: string;
    try {
        stdout = await runUnused(axctlPath, days);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deprecate-helper] axctl unused failed: ${msg}`);
        process.exit(1);
    }

    const all = parseUnusedOutput(stdout);
    const kept: string[] = [];
    const candidates: Candidate[] = [];
    for (const row of all) {
        if (keep.has(row.slug)) kept.push(row.slug);
        else candidates.push(row);
    }
    const result: Result = { generated_at, days, source: "ax", candidates, kept };
    await writeFile(outPath, JSON.stringify(result, null, 2));
    console.log(
        `[deprecate-helper] wrote ${outPath}: ${candidates.length} candidate(s), ${kept.length} kept (days=${days})`,
    );
}

if (import.meta.main) {
    await main();
}
