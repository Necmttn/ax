export type BenchTargets = {
    loadS: number;
    ftsS: number;
    snapshotS: number;
    bm25S: number;
    aggS: number;
    traversalS: number;
    cacheBytes: number;
};

export type BenchMeasurements = {
    loadS: number;
    ftsS: number;
    snapshotS: number;
    bm25S: number;
    aggS: number;
    traversalInvokedS: number;
    traversalSpawnedS: number;
    cacheBytes: number;
};

export type GateRow = {
    metric: string;
    measured: number;
    target: number;
    unit: "s" | "ms" | "bytes";
    ok: boolean;
};

export type GateResult = {
    ok: boolean;
    rows: GateRow[];
    breaches: GateRow[];
};

export const DEFAULT_TARGETS: BenchTargets = {
    loadS: 15,
    ftsS: 30,
    snapshotS: 5,
    bm25S: 0.15,
    aggS: 0.2,
    traversalS: 0.05,
    cacheBytes: 1024 * 1024 * 1024,
};

const parseEnvNumber = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
};

export const loadTargets = (
    env: Record<string, string | undefined> = process.env,
): BenchTargets => ({
    loadS: parseEnvNumber(env.AX_BENCH_MAX_LOAD_S, DEFAULT_TARGETS.loadS),
    ftsS: parseEnvNumber(env.AX_BENCH_MAX_FTS_S, DEFAULT_TARGETS.ftsS),
    snapshotS: parseEnvNumber(
        env.AX_BENCH_MAX_SNAPSHOT_S,
        DEFAULT_TARGETS.snapshotS,
    ),
    bm25S: parseEnvNumber(env.AX_BENCH_MAX_BM25_MS, DEFAULT_TARGETS.bm25S * 1000) / 1000,
    aggS: parseEnvNumber(env.AX_BENCH_MAX_AGG_MS, DEFAULT_TARGETS.aggS * 1000) / 1000,
    traversalS:
        parseEnvNumber(
            env.AX_BENCH_MAX_TRAVERSAL_MS,
            DEFAULT_TARGETS.traversalS * 1000,
        ) / 1000,
    cacheBytes: parseEnvNumber(
        env.AX_BENCH_MAX_CACHE_BYTES,
        DEFAULT_TARGETS.cacheBytes,
    ),
});

export const evaluateGates = (
    measured: BenchMeasurements,
    targets: BenchTargets = DEFAULT_TARGETS,
): GateResult => {
    const rows: GateRow[] = [
        {
            metric: "full re-derive write path",
            measured: measured.loadS,
            target: targets.loadS,
            unit: "s",
            ok: measured.loadS < targets.loadS,
        },
        {
            metric: "FTS rebuild",
            measured: measured.ftsS,
            target: targets.ftsS,
            unit: "s",
            ok: measured.ftsS < targets.ftsS,
        },
        {
            metric: "snapshot copy",
            measured: measured.snapshotS,
            target: targets.snapshotS,
            unit: "s",
            ok: measured.snapshotS < targets.snapshotS,
        },
        {
            metric: "BM25 top-20",
            measured: measured.bm25S,
            target: targets.bm25S,
            unit: "ms",
            ok: measured.bm25S < targets.bm25S,
        },
        {
            metric: "aggregate join",
            measured: measured.aggS,
            target: targets.aggS,
            unit: "ms",
            ok: measured.aggS < targets.aggS,
        },
        {
            metric: "edge-traversal invoked",
            measured: measured.traversalInvokedS,
            target: targets.traversalS,
            unit: "ms",
            ok: measured.traversalInvokedS < targets.traversalS,
        },
        {
            metric: "edge-traversal spawned",
            measured: measured.traversalSpawnedS,
            target: targets.traversalS,
            unit: "ms",
            ok: measured.traversalSpawnedS < targets.traversalS,
        },
        {
            metric: "cache file",
            measured: measured.cacheBytes,
            target: targets.cacheBytes,
            unit: "bytes",
            ok: measured.cacheBytes < targets.cacheBytes,
        },
    ];
    const breaches = rows.filter((row) => !row.ok);
    return { ok: breaches.length === 0, rows, breaches };
};

const trimNum = (n: number, digits: number): string =>
    n.toFixed(digits).replace(/\.?0+$/, "");

const formatSeconds = (s: number): string => `${trimNum(s, 3)}s`;

const formatMillis = (s: number): string => `${trimNum(s * 1000, 1)}ms`;

const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) {
        const gb = bytes / (1024 * 1024 * 1024);
        return gb === 1 ? "1GB" : `${trimNum(gb, 2)}GB`;
    }
    if (bytes >= 1024 * 1024) return `${trimNum(bytes / (1024 * 1024), 2)}MB`;
    if (bytes >= 1024) return `${trimNum(bytes / 1024, 1)}KB`;
    return `${bytes}B`;
};

const formatValue = (row: GateRow): string => {
    if (row.unit === "s") return formatSeconds(row.measured);
    if (row.unit === "ms") return formatMillis(row.measured);
    return formatBytes(row.measured);
};

const formatTarget = (row: GateRow): string => {
    if (row.unit === "s") return formatSeconds(row.target);
    if (row.unit === "ms") return formatMillis(row.target);
    return formatBytes(row.target);
};

export const formatMetricTable = (result: GateResult): string => {
    const header = [
        "metric".padEnd(28),
        "measured".padStart(12),
        "target".padStart(12),
        "status".padStart(8),
    ].join("  ");
    const lines = result.rows.map((row) =>
        [
            row.metric.padEnd(28),
            formatValue(row).padStart(12),
            formatTarget(row).padStart(12),
            (row.ok ? "PASS" : "FAIL").padStart(8),
        ].join("  "),
    );
    return [header, ...lines].join("\n");
};
