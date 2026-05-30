#!/usr/bin/env bun
import { Surreal } from "surrealdb";
import { envConfig } from "../src/lib/db.ts";
import { surrealDate, surrealString } from "../src/lib/shared/surql.ts";

interface Args {
    readonly days: number;
    readonly since: Date;
    readonly iterations: number;
    readonly limit: number;
    readonly terms: readonly string[];
    readonly table: string;
    readonly maxTurns: number | null;
    readonly keepTable: boolean;
    readonly skipFullIndex: boolean;
    readonly scan: boolean;
    readonly scanCost: boolean;
    readonly json: boolean;
}

interface Bench {
    readonly name: string;
    readonly rows: number;
    readonly ms: readonly number[];
    readonly minMs: number;
    readonly medianMs: number;
    readonly meanMs: number;
    readonly p95Ms: number;
}

interface PhaseTiming {
    readonly name: string;
    readonly ms: number;
}

const DEFAULT_TERMS = ["live trace", "livetrace", "live-traces"];

const usage = (code = 0): never => {
    console.error(`Usage:
  bun scripts/experiment-turn-fts.ts [options]

Builds a disposable benchmark table from recent turn rows, indexes both
text_excerpt and full text, then compares current and optimized query shapes.

Options:
  --days=N              Look back N days. Default: 30
  --since=YYYY-MM-DD    Override --days with an absolute UTC day
  --iterations=N        Timed iterations per query. Default: 5
  --limit=N             Session limit. Default: 20
  --terms=a,b,c         Search terms. Default: ${DEFAULT_TERMS.join(",")}
  --table=name          Disposable table name. Default: unique turn_fts_experiment_* name
  --max-turns=N         Limit copied turns for a smaller dry run
  --keep-table          Keep the disposable table and indexes
  --skip-full-index     Only build excerpt FTS index
  --scan                Include unindexed full-text scan search
  --scan-cost           Include unindexed full-text scan cost query
  --json                Print only JSON
`);
    process.exit(code);
};

const parsePositive = (raw: string | undefined, name: string, fallback: number): number => {
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
    return parsed;
};

const parseArgs = (argv: readonly string[]): Args => {
    let days = 30;
    let since: Date | null = null;
    let iterations = 5;
    let limit = 20;
    let terms = DEFAULT_TERMS;
    let table = `turn_fts_experiment_${Date.now().toString(36)}`;
    let maxTurns: number | null = null;
    let keepTable = false;
    let skipFullIndex = false;
    let scan = false;
    let scanCost = false;
    let json = false;

    for (const arg of argv) {
        if (arg === "-h" || arg === "--help") usage(0);
        if (arg === "--keep-table") {
            keepTable = true;
            continue;
        }
        if (arg === "--skip-full-index") {
            skipFullIndex = true;
            continue;
        }
        if (arg === "--scan") {
            scan = true;
            continue;
        }
        if (arg === "--scan-cost") {
            scan = true;
            scanCost = true;
            continue;
        }
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg.startsWith("--days=")) {
            days = Math.trunc(parsePositive(arg.slice("--days=".length), "--days", days));
            continue;
        }
        if (arg.startsWith("--since=")) {
            const parsed = new Date(`${arg.slice("--since=".length)}T00:00:00.000Z`);
            if (Number.isNaN(parsed.getTime())) throw new Error("--since must be YYYY-MM-DD");
            since = parsed;
            continue;
        }
        if (arg.startsWith("--iterations=")) {
            iterations = Math.trunc(parsePositive(arg.slice("--iterations=".length), "--iterations", iterations));
            continue;
        }
        if (arg.startsWith("--limit=")) {
            limit = Math.trunc(parsePositive(arg.slice("--limit=".length), "--limit", limit));
            continue;
        }
        if (arg.startsWith("--max-turns=")) {
            maxTurns = Math.trunc(parsePositive(arg.slice("--max-turns=".length), "--max-turns", 1));
            continue;
        }
        if (arg.startsWith("--terms=")) {
            terms = arg.slice("--terms=".length).split(",").map((term) => term.trim()).filter(Boolean);
            if (terms.length === 0) throw new Error("--terms must include at least one term");
            continue;
        }
        if (arg.startsWith("--table=")) {
            table = arg.slice("--table=".length);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("--table must be a simple SurrealDB table name");
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    return {
        days,
        since: since ?? new Date(Date.now() - days * 24 * 60 * 60 * 1000),
        iterations,
        limit,
        terms,
        table,
        maxTurns,
        keepTable,
        skipFullIndex,
        scan,
        scanCost,
        json,
    };
};

const timed = async <T>(name: string, fn: () => Promise<T>, log: boolean): Promise<{ name: string; ms: number; value: T }> => {
    if (log) console.error(`${name}...`);
    const start = performance.now();
    const value = await fn();
    const ms = performance.now() - start;
    if (log) console.error(`${name}: ${ms.toFixed(1)}ms`);
    return { name, ms, value };
};

const isRetryableConflict = (err: unknown): boolean =>
    /transaction conflict|can be retried|try again/i.test(err instanceof Error ? err.message : String(err));

const queryWithRetry = async (db: Surreal, sql: string, attempts = 4): Promise<unknown> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await db.query(sql);
        } catch (err) {
            lastErr = err;
            if (!isRetryableConflict(err) || attempt === attempts) throw err;
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
    throw lastErr;
};

const queryRows = async (db: Surreal, sql: string): Promise<readonly Record<string, unknown>[]> => {
    const result = await db.query<[Record<string, unknown>[]]>(sql);
    return result?.[0] ?? [];
};

const percentile = (values: readonly number[], pct: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
    return sorted[index] ?? 0;
};

const benchStats = (name: string, rows: number, ms: readonly number[]): Bench => ({
    name,
    rows,
    ms,
    minMs: ms.length === 0 ? 0 : Math.min(...ms),
    medianMs: percentile(ms, 50),
    meanMs: ms.reduce((sum, value) => sum + value, 0) / Math.max(ms.length, 1),
    p95Ms: percentile(ms, 95),
});

const runBench = async (db: Surreal, name: string, sql: string, iterations: number): Promise<Bench> => {
    await queryRows(db, sql);
    const ms: number[] = [];
    let rows = 0;
    for (let i = 0; i < iterations; i += 1) {
        const start = performance.now();
        const result = await queryRows(db, sql);
        ms.push(performance.now() - start);
        rows = result.length;
    }
    return benchStats(name, rows, ms);
};

const ftsWhere = (field: "text_excerpt" | "text", terms: readonly string[]): string =>
    terms.map((term) => `${field} @0@ ${surrealString(term)}`).join("\n       OR ");

const scanWhere = (terms: readonly string[]): string =>
    terms.map((term) => `string::lowercase(text ?? "") CONTAINS ${surrealString(term.toLowerCase())}`).join("\n       OR ");

const searchSql = (table: string, where: string, limit: number): string => `
SELECT session
FROM ${table}
WHERE ${where}
GROUP BY session
LIMIT ${limit};`;

const costSubquerySql = (table: string, where: string, since: Date, limit: number): string => `
SELECT type::string(session) AS session, source, model, type::string(session.started_at) AS started_at,
       estimated_tokens, estimated_cost_usd
FROM session_token_usage
WHERE session.started_at >= ${surrealDate(since)}
  AND session IN (
    SELECT VALUE session FROM ${table}
    WHERE ${where}
    GROUP BY session
    LIMIT ${limit}
  )
ORDER BY started_at DESC
LIMIT ${limit};`;

const costDirectSql = (sessions: readonly string[], since: Date, limit: number): string => `
SELECT type::string(session) AS session, source, model, type::string(session.started_at) AS started_at,
       estimated_tokens, estimated_cost_usd
FROM session_token_usage
WHERE session.started_at >= ${surrealDate(since)}
  AND session IN [${sessions.join(", ")}]
ORDER BY started_at DESC
LIMIT ${limit};`;

const rowSession = (row: Record<string, unknown>): string => String(row.session ?? "");

const setupStatements = (args: Args): readonly { readonly name: string; readonly sql: string }[] => [
    { name: "define disposable table", sql: `DEFINE TABLE ${args.table} SCHEMALESS;` },
    {
        name: "copy recent turns",
        sql: `INSERT INTO ${args.table}
    SELECT session, ts, text, text_excerpt
    FROM turn
    WHERE ts >= ${surrealDate(args.since)}
    ${args.maxTurns === null ? "" : "ORDER BY ts DESC"}
    ${args.maxTurns === null ? "" : `LIMIT ${args.maxTurns}`};`,
    },
    { name: "ensure analyzer", sql: "DEFINE ANALYZER IF NOT EXISTS turn_text TOKENIZERS class FILTERS lowercase, ascii;" },
    { name: "index session", sql: `DEFINE INDEX IF NOT EXISTS ${args.table}_session ON ${args.table} FIELDS session;` },
    { name: "index ts", sql: `DEFINE INDEX IF NOT EXISTS ${args.table}_ts ON ${args.table} FIELDS ts;` },
    { name: "index excerpt FTS", sql: `DEFINE INDEX IF NOT EXISTS ${args.table}_excerpt_fts ON ${args.table} FIELDS text_excerpt FULLTEXT ANALYZER turn_text BM25 HIGHLIGHTS;` },
    ...(args.skipFullIndex
        ? []
        : [{ name: "index full text FTS", sql: `DEFINE INDEX IF NOT EXISTS ${args.table}_full_fts ON ${args.table} FIELDS text FULLTEXT ANALYZER turn_text BM25 HIGHLIGHTS;` }]),
];

const countSql = (table: string): string => `
SELECT count() AS turns,
       math::sum(string::len(text_excerpt ?? "")) AS excerpt_chars,
       math::sum(string::len(text ?? "")) AS full_chars
FROM ${table}
GROUP ALL;`;

const formatMs = (value: number): string => `${value.toFixed(1)}ms`;

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const cfg = envConfig();
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    const log = !args.json;

    try {
        const setupTimings: PhaseTiming[] = [];
        for (const statement of setupStatements(args)) {
            const phase = await timed(statement.name, () => queryWithRetry(db, statement.sql), log);
            setupTimings.push({ name: phase.name, ms: phase.ms });
        }
        const setupMs = setupTimings.reduce((sum, phase) => sum + phase.ms, 0);
        const [count] = await queryRows(db, countSql(args.table));
        const excerptWhere = ftsWhere("text_excerpt", args.terms);
        const fullWhere = ftsWhere("text", args.terms);
        const fullScanWhere = scanWhere(args.terms);

        const excerptSearch = searchSql(args.table, excerptWhere, args.limit);
        const fullSearch = searchSql(args.table, fullWhere, args.limit);
        const fullScanSearch = searchSql(args.table, fullScanWhere, args.limit);
        const excerptCostSubquery = costSubquerySql(args.table, excerptWhere, args.since, args.limit);
        const fullCostSubquery = costSubquerySql(args.table, fullWhere, args.since, args.limit);
        const fullScanCostSubquery = costSubquerySql(args.table, fullScanWhere, args.since, args.limit);

        if (log) console.error("fetching candidate session sets...");
        const excerptSessions = (await queryRows(db, excerptSearch)).map(rowSession).filter(Boolean);
        const fullSessions = args.skipFullIndex
            ? []
            : (await queryRows(db, fullSearch)).map(rowSession).filter(Boolean);
        const fullScanSessions = args.scan
            ? (await queryRows(db, fullScanSearch)).map(rowSession).filter(Boolean)
            : [];

        const benches: Bench[] = [];
        benches.push(await runBench(db, "bench.search.excerpt_fts", excerptSearch, args.iterations));
        benches.push(await runBench(db, "bench.cost.subquery.excerpt_fts", excerptCostSubquery, args.iterations));
        if (excerptSessions.length > 0) {
            benches.push(await runBench(db, "bench.cost.two_step.excerpt_fts", costDirectSql(excerptSessions, args.since, args.limit), args.iterations));
        }
        if (!args.skipFullIndex) {
            benches.push(await runBench(db, "bench.search.full_fts", fullSearch, args.iterations));
            benches.push(await runBench(db, "bench.cost.subquery.full_fts", fullCostSubquery, args.iterations));
            if (fullSessions.length > 0) {
                benches.push(await runBench(db, "bench.cost.two_step.full_fts", costDirectSql(fullSessions, args.since, args.limit), args.iterations));
            }
        }
        if (args.scan) {
            benches.push(await runBench(db, "bench.search.full_scan_contains", fullScanSearch, Math.min(args.iterations, 3)));
            if (args.scanCost) {
                benches.push(await runBench(db, "bench.cost.subquery.full_scan_contains", fullScanCostSubquery, Math.min(args.iterations, 1)));
            }
        }

        const excerptSet = new Set(excerptSessions);
        const fullSet = new Set(fullSessions);
        const fullScanSet = new Set(fullScanSessions);
        const output = {
            db: { url: cfg.url, ns: cfg.ns, db: cfg.db },
            table: args.table,
            since: args.since.toISOString(),
            days: args.days,
            terms: args.terms,
            limit: args.limit,
            iterations: args.iterations,
            maxTurns: args.maxTurns,
            setupMs,
            setupTimings,
            count: {
                turns: Number(count?.turns ?? 0),
                excerptChars: Number(count?.excerpt_chars ?? 0),
                fullChars: Number(count?.full_chars ?? 0),
            },
            recall: {
                excerptFtsSessions: excerptSet.size,
                fullFtsSessions: fullSet.size,
                fullScanSessions: fullScanSet.size,
                fullFtsOnly: [...fullSet].filter((session) => !excerptSet.has(session)).length,
                excerptOnlyVsFullFts: [...excerptSet].filter((session) => !fullSet.has(session)).length,
                fullScanOnly: [...fullScanSet].filter((session) => !excerptSet.has(session)).length,
            },
            benches,
            keptTable: args.keepTable,
        };

        if (args.json) {
            console.log(JSON.stringify(output, null, 2));
            return;
        }

        console.log("turn full-text FTS experiment");
        console.log(`table: ${args.table}${args.keepTable ? " (kept)" : " (temporary)"}`);
        console.log(`since: ${output.since}`);
        console.log(`terms: ${args.terms.join(", ")}`);
        console.log(`turns: ${output.count.turns.toLocaleString()}`);
        console.log(`indexed chars: excerpt=${output.count.excerptChars.toLocaleString()} full=${output.count.fullChars.toLocaleString()} (${(output.count.fullChars / Math.max(output.count.excerptChars, 1)).toFixed(1)}x)`);
        console.log(`setup + index build: ${formatMs(output.setupMs)}`);
        console.table(output.setupTimings.map((phase) => ({ phase: phase.name, ms: formatMs(phase.ms) })));
        console.log("");
        console.table(benches.map((bench) => ({
            query: bench.name,
            rows: bench.rows,
            min: formatMs(bench.minMs),
            median: formatMs(bench.medianMs),
            mean: formatMs(bench.meanMs),
            p95: formatMs(bench.p95Ms),
        })));
        console.log("");
        console.log(`recall: excerpt_fts=${output.recall.excerptFtsSessions}, full_fts=${output.recall.fullFtsSessions}, full_scan=${output.recall.fullScanSessions}, full_fts_only=${output.recall.fullFtsOnly}, excerpt_only_vs_full_fts=${output.recall.excerptOnlyVsFullFts}, full_scan_only=${output.recall.fullScanOnly}`);
    } finally {
        if (!args.keepTable) {
            await queryWithRetry(db, `REMOVE TABLE IF EXISTS ${args.table};`);
        }
        await db.close();
    }
};

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
