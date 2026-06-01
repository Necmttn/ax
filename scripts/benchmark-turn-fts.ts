#!/usr/bin/env bun
import { Surreal } from "surrealdb";
import { envConfig } from "@ax/lib/db";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";

interface Args {
    readonly days: number;
    readonly since: Date;
    readonly iterations: number;
    readonly limit: number;
    readonly terms: readonly string[];
    readonly fullIndex: boolean;
    readonly keepFullIndex: boolean;
    readonly scan: boolean;
    readonly scanCost: boolean;
    readonly charStats: boolean;
    readonly json: boolean;
}

interface TimedRows {
    readonly ms: number;
    readonly rows: readonly Record<string, unknown>[];
}

interface BenchStats {
    readonly name: string;
    readonly rows: number;
    readonly ms: readonly number[];
    readonly minMs: number;
    readonly medianMs: number;
    readonly meanMs: number;
    readonly p95Ms: number;
}

const DEFAULT_TERMS = ["live trace", "livetrace", "live-traces"];

const usage = (code = 0): never => {
    console.error(`Usage:
  bun scripts/benchmark-turn-fts.ts [options]

Options:
  --days=N                 Look back N days. Default: 30
  --since=YYYY-MM-DD       Override --days with an absolute UTC day
  --iterations=N           Timed iterations per query. Default: 7
  --limit=N                Session limit in the subquery and cost query. Default: 100
  --terms=a,b,c            Search terms. Default: ${DEFAULT_TERMS.join(",")}
  --full-index             Build and benchmark a temporary full-text index on turn.text
  --keep-full-index        Leave turn_text_full_fts_bench installed
  --scan                   Also benchmark an unindexed full-text CONTAINS scan
  --scan-cost              Include the unindexed full-scan cost query
  --char-stats             Estimate indexed chars with a full turn scan
  --json                   Print only JSON
`);
    process.exit(code);
};

const parseNumber = (value: string | undefined, name: string, fallback: number): number => {
    if (value === undefined || value.length === 0) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive number`);
    }
    return parsed;
};

const parseArgs = (argv: readonly string[]): Args => {
    let days = 30;
    let since: Date | null = null;
    let iterations = 7;
    let limit = 100;
    let terms = DEFAULT_TERMS;
    let fullIndex = false;
    let keepFullIndex = false;
    let scan = false;
    let scanCost = false;
    let charStats = false;
    let json = false;

    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") usage(0);
        if (arg === "--full-index") {
            fullIndex = true;
            continue;
        }
        if (arg === "--keep-full-index") {
            keepFullIndex = true;
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
        if (arg === "--char-stats") {
            charStats = true;
            continue;
        }
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg.startsWith("--days=")) {
            days = parseNumber(arg.slice("--days=".length), "--days", days);
            continue;
        }
        if (arg.startsWith("--since=")) {
            const raw = arg.slice("--since=".length);
            const parsed = new Date(`${raw}T00:00:00.000Z`);
            if (Number.isNaN(parsed.getTime())) throw new Error("--since must be YYYY-MM-DD");
            since = parsed;
            continue;
        }
        if (arg.startsWith("--iterations=")) {
            iterations = Math.trunc(parseNumber(arg.slice("--iterations=".length), "--iterations", iterations));
            continue;
        }
        if (arg.startsWith("--limit=")) {
            limit = Math.trunc(parseNumber(arg.slice("--limit=".length), "--limit", limit));
            continue;
        }
        if (arg.startsWith("--terms=")) {
            terms = arg
                .slice("--terms=".length)
                .split(",")
                .map((term) => term.trim())
                .filter((term) => term.length > 0);
            if (terms.length === 0) throw new Error("--terms must include at least one term");
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
        fullIndex,
        keepFullIndex,
        scan,
        scanCost,
        charStats,
        json,
    };
};

const timedQuery = async (db: Surreal, sql: string): Promise<TimedRows> => {
    const start = performance.now();
    const result = await db.query<[Record<string, unknown>[]]>(sql);
    const ms = performance.now() - start;
    return { ms, rows: result?.[0] ?? [] };
};

const percentile = (values: readonly number[], pct: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
    return sorted[index] ?? 0;
};

const statsFor = (name: string, rows: number, ms: readonly number[]): BenchStats => ({
    name,
    rows,
    ms,
    minMs: ms.length === 0 ? 0 : Math.min(...ms),
    medianMs: percentile(ms, 50),
    meanMs: ms.reduce((sum, value) => sum + value, 0) / Math.max(ms.length, 1),
    p95Ms: percentile(ms, 95),
});

const ftsWhere = (field: "text_excerpt" | "text", terms: readonly string[]): string =>
    terms.map((term) => `${field} @0@ ${surrealString(term)}`).join("\n       OR ");

const scanWhere = (field: "text", terms: readonly string[]): string =>
    terms
        .map((term) => `string::lowercase(${field} ?? "") CONTAINS ${surrealString(term.toLowerCase())}`)
        .join("\n       OR ");

const turnSearchSql = (where: string, limit: number): string => `
SELECT session
FROM turn
WHERE ${where}
GROUP BY session
LIMIT ${limit};`;

const costSql = (where: string, since: Date, limit: number): string => `
SELECT type::string(session) AS session, source, model, type::string(session.started_at) AS started_at,
       estimated_tokens, estimated_cost_usd
FROM session_token_usage
WHERE session.started_at >= ${surrealDate(since)}
  AND session IN (
    SELECT VALUE session FROM turn
    WHERE ${where}
    GROUP BY session
    LIMIT ${limit}
  )
ORDER BY started_at DESC
LIMIT ${limit};`;

const countSql = (since: Date): string => `
SELECT count() AS turns
FROM turn
WHERE ts >= ${surrealDate(since)}
GROUP ALL;

SELECT count() AS sessions
FROM session
WHERE started_at >= ${surrealDate(since)}
GROUP ALL;`;

const charStatsSql = (since: Date): string => `
SELECT math::sum(string::len(text ?? "")) AS full_chars,
       math::sum(string::len(text_excerpt ?? "")) AS excerpt_chars,
       math::mean(string::len(text ?? "")) AS avg_full_chars,
       math::mean(string::len(text_excerpt ?? "")) AS avg_excerpt_chars
FROM turn
WHERE ts >= ${surrealDate(since)}
GROUP ALL;`;

const runBench = async (
    db: Surreal,
    name: string,
    sql: string,
    iterations: number,
): Promise<BenchStats> => {
    await timedQuery(db, sql);
    const ms: number[] = [];
    let rows = 0;
    for (let i = 0; i < iterations; i += 1) {
        const result = await timedQuery(db, sql);
        ms.push(result.ms);
        rows = result.rows.length;
    }
    return statsFor(name, rows, ms);
};

const rowValue = (row: unknown): string => {
    if (typeof row === "string") return row;
    if (row && typeof row === "object" && "session" in row) return String((row as { session: unknown }).session);
    return String(row ?? "");
};

const fetchSessionSet = async (db: Surreal, sql: string): Promise<Set<string>> => {
    const rows = (await timedQuery(db, sql)).rows;
    return new Set(rows.map(rowValue).filter((value) => value.length > 0));
};

const formatMs = (value: number): string => `${value.toFixed(1)}ms`;

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const cfg = envConfig();
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });

    const defineFullIndex = `
DEFINE INDEX IF NOT EXISTS turn_text_full_fts_bench
    ON turn FIELDS text
    FULLTEXT ANALYZER turn_text BM25 HIGHLIGHTS;`;
    const removeFullIndex = "REMOVE INDEX IF EXISTS turn_text_full_fts_bench ON turn;";

    let createFullIndexMs: number | null = null;
    try {
        if (!args.json) console.error("loading 30-day counts...");
        const [countsRows, sessionsRows] = await db.query<[Record<string, unknown>[], Record<string, unknown>[]]>(countSql(args.since));
        let charsRows: Record<string, unknown>[] = [];
        if (args.charStats) {
            if (!args.json) console.error("estimating indexed chars with a full turn scan...");
            [charsRows] = await db.query<[Record<string, unknown>[]]>(charStatsSql(args.since));
        }
        if (args.fullIndex) {
            if (!args.json) console.error("building temporary full-text index on turn.text...");
            const created = await timedQuery(db, defineFullIndex);
            createFullIndexMs = created.ms;
        }

        const excerptWhere = ftsWhere("text_excerpt", args.terms);
        const fullWhere = ftsWhere("text", args.terms);
        const fullScanWhere = scanWhere("text", args.terms);

        const searchExcerptSql = turnSearchSql(excerptWhere, args.limit);
        const searchFullSql = turnSearchSql(fullWhere, args.limit);
        const costExcerptSql = costSql(excerptWhere, args.since, args.limit);
        const costFullSql = costSql(fullWhere, args.since, args.limit);
        const searchFullScanSql = turnSearchSql(fullScanWhere, args.limit);
        const costFullScanSql = costSql(fullScanWhere, args.since, args.limit);

        if (!args.json) console.error("checking matched-session coverage...");
        const excerptSessions = await fetchSessionSet(db, searchExcerptSql);
        const fullSessions = args.fullIndex
            ? await fetchSessionSet(db, searchFullSql)
            : args.scan
                ? await fetchSessionSet(db, searchFullScanSql)
                : new Set<string>();
        const fullOnly = [...fullSessions].filter((session) => !excerptSessions.has(session));
        const excerptOnly = [...excerptSessions].filter((session) => !fullSessions.has(session));

        const benches: BenchStats[] = [];
        if (!args.json) console.error("timing excerpt FTS...");
        benches.push(await runBench(db, "turn.search.excerpt_fts", searchExcerptSql, args.iterations));
        benches.push(await runBench(db, "costs.for.excerpt_fts", costExcerptSql, args.iterations));
        if (args.fullIndex) {
            if (!args.json) console.error("timing full-text FTS...");
            benches.push(await runBench(db, "turn.search.full_fts", searchFullSql, args.iterations));
            benches.push(await runBench(db, "costs.for.full_fts", costFullSql, args.iterations));
        }
        if (args.scan) {
            if (!args.json) console.error("timing unindexed full-text scan...");
            benches.push(await runBench(db, "turn.search.full_scan_contains", searchFullScanSql, Math.min(args.iterations, 3)));
            if (args.scanCost) {
                benches.push(await runBench(db, "costs.for.full_scan_contains", costFullScanSql, Math.min(args.iterations, 3)));
            }
        }

        const output = {
            db: { url: cfg.url, ns: cfg.ns, db: cfg.db },
            since: args.since.toISOString(),
            days: args.days,
            terms: args.terms,
            iterations: args.iterations,
            limit: args.limit,
            counts: {
                turns: Number(countsRows?.[0]?.turns ?? 0),
                sessions: Number(sessionsRows?.[0]?.sessions ?? 0),
                fullChars: Number(charsRows?.[0]?.full_chars ?? 0),
                excerptChars: Number(charsRows?.[0]?.excerpt_chars ?? 0),
                avgFullChars: Number(charsRows?.[0]?.avg_full_chars ?? 0),
                avgExcerptChars: Number(charsRows?.[0]?.avg_excerpt_chars ?? 0),
                charStats: args.charStats,
            },
            createFullIndexMs,
            recall: {
                excerptSessions: excerptSessions.size,
                fullSessions: fullSessions.size,
                overlapSessions: [...excerptSessions].filter((session) => fullSessions.has(session)).length,
                fullOnlySessions: fullOnly.length,
                excerptOnlySessions: excerptOnly.length,
                fullOnlySample: fullOnly.slice(0, 10),
                fullMode: args.fullIndex ? "full_fts" : args.scan ? "full_scan_contains" : "not_measured",
            },
            benches,
            keptFullIndex: args.fullIndex && args.keepFullIndex,
        };

        if (args.json) {
            console.log(JSON.stringify(output, null, 2));
            return;
        }

        console.log(`30-day-ish turn FTS benchmark`);
        console.log(`since: ${output.since}`);
        console.log(`terms: ${args.terms.join(", ")}`);
        console.log(`turns: ${output.counts.turns.toLocaleString()} | sessions: ${output.counts.sessions.toLocaleString()}`);
        if (args.charStats) {
            console.log(`indexed chars: excerpt=${output.counts.excerptChars.toLocaleString()} full=${output.counts.fullChars.toLocaleString()} (${(output.counts.fullChars / Math.max(output.counts.excerptChars, 1)).toFixed(1)}x)`);
        }
        if (createFullIndexMs !== null) console.log(`temporary full-text index build: ${formatMs(createFullIndexMs)}`);
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
        console.log(`recall: excerpt=${output.recall.excerptSessions}, full=${output.recall.fullSessions}, overlap=${output.recall.overlapSessions}, full_only=${output.recall.fullOnlySessions}, excerpt_only=${output.recall.excerptOnlySessions}`);
        if (output.recall.fullOnlySample.length > 0) {
            console.log(`full-only sample: ${output.recall.fullOnlySample.join(", ")}`);
        }
    } finally {
        if (args.fullIndex && !args.keepFullIndex) {
            await db.query(removeFullIndex);
        }
        await db.close();
    }
};

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
