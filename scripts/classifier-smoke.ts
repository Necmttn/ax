#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { Surreal } from "surrealdb";
import { envConfig } from "@ax/lib/db";
import { classifierThemesSql, harnessCandidatesSql } from "../src/queries/insights.ts";

export interface ClassifierSmokeArgs {
    readonly days: number;
    readonly limit: number;
    readonly json: boolean;
    readonly skipIngest: boolean;
}

export interface SmokeCount {
    readonly count: number;
}

export interface EvidenceCount {
    readonly target_table?: string;
    readonly kind?: string | null;
    readonly count: number;
}

export interface ClassifierSmokeReport {
    readonly days: number;
    readonly sourceTurns: number;
    readonly classifierFacts: number;
    readonly evidenceEdges: number;
    readonly evidenceByTarget: readonly EvidenceCount[];
    readonly themeRows: number;
    readonly candidateRows: number;
    readonly topCandidates: readonly Record<string, unknown>[];
    readonly failures: readonly string[];
}

const usage = (code = 0): never => {
    console.error(`Usage:
  bun scripts/classifier-smoke.ts [options]

Options:
  --days=N         Look back N days for source turns and classifier facts. Default: 7
  --limit=N        Limit insight rows used in the report. Default: 10
  --skip-ingest    Do not run classifier-results ingest first
  --json           Print JSON report
`);
    process.exit(code);
};

const parsePositiveInt = (raw: string | undefined, name: string, fallback: number): number => {
    if (raw === undefined || raw.length === 0) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
    return parsed;
};

export function parseArgs(argv: readonly string[]): ClassifierSmokeArgs {
    let days = 7;
    let limit = 10;
    let json = false;
    let skipIngest = false;

    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") usage(0);
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg === "--skip-ingest") {
            skipIngest = true;
            continue;
        }
        if (arg.startsWith("--days=")) {
            days = parsePositiveInt(arg.slice("--days=".length), "--days", days);
            continue;
        }
        if (arg.startsWith("--limit=")) {
            limit = parsePositiveInt(arg.slice("--limit=".length), "--limit", limit);
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    return { days, limit, json, skipIngest };
}

const countOf = (rows: readonly SmokeCount[] | undefined): number =>
    rows?.[0]?.count ?? 0;

export function evaluateSmokeReport(input: Omit<ClassifierSmokeReport, "failures">): ClassifierSmokeReport {
    const failures: string[] = [];
    if (input.sourceTurns > 0 && input.classifierFacts === 0) {
        failures.push("source turns exist but classifier_result rows are empty");
    }
    if (input.classifierFacts > 0 && input.evidenceEdges === 0) {
        failures.push("classifier facts exist but classifier evidence edges are empty");
    }
    if (input.classifierFacts > 0 && input.themeRows === 0) {
        failures.push("classifier facts exist but classifier themes are empty");
    }
    if (input.classifierFacts > 0 && input.candidateRows === 0) {
        failures.push("classifier facts exist but harness candidates are empty");
    }
    return { ...input, failures };
}

function runIngest(days: number): void {
    const proc = spawnSync("bun", [
        "src/cli/index.ts",
        "ingest",
        "--stages=classifier-results",
        `--since=${days}`,
        "--progress=plain",
    ], { stdio: "inherit" });
    if (proc.status !== 0) {
        throw new Error(`classifier-results ingest failed with exit code ${proc.status ?? "unknown"}`);
    }
}

async function queryReport(args: ClassifierSmokeArgs): Promise<ClassifierSmokeReport> {
    const cfg = envConfig();
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    try {
        const sourceSql = `SELECT count() AS count FROM turn WHERE role = "user" AND ts > time::now() - ${args.days}d GROUP ALL;`;
        const factsSql = `SELECT count() AS count FROM classifier_result WHERE ts > time::now() - ${args.days}d GROUP ALL;`;
        const evidenceSql = `
SELECT
    type::table(out) AS target_table,
    kind,
    count() AS count
FROM cites_evidence
WHERE type::string(in) CONTAINS "classifier_result:"
GROUP BY target_table, kind
ORDER BY target_table, kind;`.trim();
        const [
            sourceResult,
            factsResult,
            evidenceResult,
            themesResult,
            candidatesResult,
        ] = await Promise.all([
            db.query<[SmokeCount[]]>(sourceSql),
            db.query<[SmokeCount[]]>(factsSql),
            db.query<[EvidenceCount[]]>(evidenceSql),
            db.query<[Record<string, unknown>[]]>(classifierThemesSql(args.limit)),
            db.query<[Record<string, unknown>[]]>(harnessCandidatesSql(args.limit)),
        ]);

        const evidenceByTarget = evidenceResult[0] ?? [];
        return evaluateSmokeReport({
            days: args.days,
            sourceTurns: countOf(sourceResult[0]),
            classifierFacts: countOf(factsResult[0]),
            evidenceEdges: evidenceByTarget.reduce((sum, row) => sum + (row.count ?? 0), 0),
            evidenceByTarget,
            themeRows: themesResult[0]?.length ?? 0,
            candidateRows: candidatesResult[0]?.length ?? 0,
            topCandidates: candidatesResult[0]?.slice(0, 3) ?? [],
        });
    } finally {
        await db.close();
    }
}

function printReport(report: ClassifierSmokeReport, json: boolean): void {
    if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    console.log("classifier smoke report");
    console.log(`days: ${report.days}`);
    console.log(`source turns: ${report.sourceTurns}`);
    console.log(`classifier facts: ${report.classifierFacts}`);
    console.log(`classifier evidence edges: ${report.evidenceEdges}`);
    console.log(`classifier themes: ${report.themeRows}`);
    console.log(`harness candidates: ${report.candidateRows}`);
    console.log("evidence:");
    for (const row of report.evidenceByTarget) {
        console.log(`  - ${row.target_table ?? "unknown"} / ${row.kind ?? "unknown"}: ${row.count}`);
    }
    if (report.topCandidates.length > 0) {
        console.log("top candidates:");
        for (const [index, row] of report.topCandidates.entries()) {
            const layer = String(row.proposed_layer ?? "unknown");
            const action = String(row.proposed_action ?? "unknown");
            const facts = String(row.facts ?? "?");
            const signature = Array.isArray(row.dedupe_signature)
                ? row.dedupe_signature.join("/")
                : String(row.dedupe_signature ?? "");
            console.log(`  ${index + 1}. ${layer} -> ${action} facts=${facts} ${signature}`);
        }
    }
    if (report.failures.length > 0) {
        console.error("failures:");
        for (const failure of report.failures) console.error(`  - ${failure}`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));
    if (!args.skipIngest) runIngest(args.days);
    const report = await queryReport(args);
    printReport(report, args.json);
    if (report.failures.length > 0) process.exit(1);
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
