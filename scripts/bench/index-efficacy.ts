#!/usr/bin/env bun
/**
 * Wall-clock benchmark for issue #786: does a composite (in_id, out_id, args)
 * index serve a `WHERE in_id = ?` point lookup as well as a single-column
 * (in_id) index, on a relation table shaped like ax's edge tables?
 *
 * This is the reproducible source behind the measurement cited in
 * `packages/schema/src/duckdb-schema.test.ts` ("every relation table is
 * indexed on both sides"): a composite index does not serve a leftmost-prefix
 * seek the way a B-tree would, so only a single-column index is actually
 * served by DuckDB's ART index.
 *
 * Three isolated copies of the same 2M-row dataset are built, each with a
 * different index (none / composite / single-column in_id), checkpointed,
 * reopened, and measured with `AX_BENCH_INDEX_MEASURED_RUNS` repetitions of
 * `AX_BENCH_INDEX_LOOKUPS` distinct point lookups run as separate statements
 * inside one DuckDB CLI process. Variant order rotates across runs so a
 * systematic drift (thermal throttling, page-cache warmup) cannot masquerade
 * as an index effect.
 *
 * No EXPLAIN: this measures wall clock, not query plans. No threshold: this
 * is a report, not a gate - `scripts/bench/targets.ts` (ingest/query budgets)
 * is untouched.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duckdbBinPath } from "./duckdb-bin.ts";

export const VARIANTS = ["none", "composite", "single"] as const;
export type Variant = (typeof VARIANTS)[number];

export type IndexEfficacyConfig = {
    readonly rows: number;
    readonly distinctInIds: number;
    readonly rowsPerInId: number;
    readonly lookupCount: number;
    readonly warmRuns: number;
    readonly measuredRuns: number;
    readonly requiredDuckdbVersion: string;
};

export const DEFAULT_INDEX_EFFICACY_CONFIG: IndexEfficacyConfig = {
    rows: 2_000_000,
    distinctInIds: 500_000,
    rowsPerInId: 4,
    lookupCount: 200,
    warmRuns: 1,
    measuredRuns: 7,
    requiredDuckdbVersion: "1.5.5",
};

export class InvalidIndexEfficacyConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidIndexEfficacyConfigError";
    }
}

const parseEnvInt = (
    name: string,
    raw: string | undefined,
    fallback: number,
): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new InvalidIndexEfficacyConfigError(
            `invalid ${name}=${JSON.stringify(raw)}: expected an integer`,
        );
    }
    return n;
};

/** Parse the benchmark configuration from env, falling back to the #786
 *  default (2M rows / 500k distinct in_id / 200 lookups / 1 warm + 7
 *  measured runs). Every knob is overridable so the gated integration test
 *  can run the same code path at a tiny scale. */
export const parseIndexEfficacyConfig = (
    env: Record<string, string | undefined> = process.env,
): IndexEfficacyConfig => {
    const rows = parseEnvInt(
        "AX_BENCH_INDEX_ROWS",
        env.AX_BENCH_INDEX_ROWS,
        DEFAULT_INDEX_EFFICACY_CONFIG.rows,
    );
    const distinctInIds = parseEnvInt(
        "AX_BENCH_INDEX_DISTINCT",
        env.AX_BENCH_INDEX_DISTINCT,
        DEFAULT_INDEX_EFFICACY_CONFIG.distinctInIds,
    );
    const lookupCount = parseEnvInt(
        "AX_BENCH_INDEX_LOOKUPS",
        env.AX_BENCH_INDEX_LOOKUPS,
        DEFAULT_INDEX_EFFICACY_CONFIG.lookupCount,
    );
    const warmRuns = parseEnvInt(
        "AX_BENCH_INDEX_WARM_RUNS",
        env.AX_BENCH_INDEX_WARM_RUNS,
        DEFAULT_INDEX_EFFICACY_CONFIG.warmRuns,
    );
    const measuredRuns = parseEnvInt(
        "AX_BENCH_INDEX_MEASURED_RUNS",
        env.AX_BENCH_INDEX_MEASURED_RUNS,
        DEFAULT_INDEX_EFFICACY_CONFIG.measuredRuns,
    );
    if (rows <= 0 || distinctInIds <= 0) {
        throw new InvalidIndexEfficacyConfigError(
            "AX_BENCH_INDEX_ROWS and AX_BENCH_INDEX_DISTINCT must be positive",
        );
    }
    if (rows % distinctInIds !== 0) {
        throw new InvalidIndexEfficacyConfigError(
            `AX_BENCH_INDEX_ROWS (${rows}) must be an exact multiple of AX_BENCH_INDEX_DISTINCT (${distinctInIds})`,
        );
    }
    const rowsPerInId = rows / distinctInIds;
    if (lookupCount <= 0 || lookupCount > distinctInIds) {
        throw new InvalidIndexEfficacyConfigError(
            `AX_BENCH_INDEX_LOOKUPS (${lookupCount}) must be between 1 and AX_BENCH_INDEX_DISTINCT (${distinctInIds})`,
        );
    }
    if (warmRuns < 0) {
        throw new InvalidIndexEfficacyConfigError(
            "AX_BENCH_INDEX_WARM_RUNS must be >= 0",
        );
    }
    if (measuredRuns < 1) {
        throw new InvalidIndexEfficacyConfigError(
            "AX_BENCH_INDEX_MEASURED_RUNS must be >= 1",
        );
    }

    return {
        rows,
        distinctInIds,
        rowsPerInId,
        lookupCount,
        warmRuns,
        measuredRuns,
        requiredDuckdbVersion: DEFAULT_INDEX_EFFICACY_CONFIG.requiredDuckdbVersion,
    };
};

/** Middle value (average of the two middle values on an even count). */
export const median = (values: readonly number[]): number => {
    if (values.length === 0) {
        throw new InvalidIndexEfficacyConfigError("median of an empty sample set");
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid]!;
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Linear-interpolated quantile (0..1) over a sample set, used for the IQR
 *  check below. */
export const quantile = (values: readonly number[], q: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0]!;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo]!;
    const frac = pos - lo;
    return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
};

/** (Q3 - Q1) / median - the noise check: a value over 0.15 means the 7
 *  measured runs disagree with each other too much to trust the median. */
export const iqrRatio = (values: readonly number[]): number => {
    const m = median(values);
    if (m === 0) return 0;
    return (quantile(values, 0.75) - quantile(values, 0.25)) / m;
};

/** Round-robin rotation of the variant list by `runIndex`, so consecutive
 *  measured runs don't all benchmark the same variant first (a systematic
 *  drift across runs - thermal throttling, page-cache warmup - would
 *  otherwise land entirely on whichever variant always goes first/last). */
export const rotateVariants = (
    variants: readonly Variant[],
    runIndex: number,
): Variant[] => {
    const n = variants.length;
    if (n === 0) return [];
    const offset = ((runIndex % n) + n) % n;
    return [...variants.slice(offset), ...variants.slice(0, offset)];
};

/** DDL for each variant. `null` for "none" - no index is created at all. */
export const buildIndexSql = (variant: Variant): string | null => {
    switch (variant) {
        case "none":
            return null;
        case "composite":
            return "CREATE INDEX idx_composite ON relation(in_id, out_id, args);";
        case "single":
            return "CREATE INDEX idx_single ON relation(in_id);";
    }
};

/** The 2M-row (default) dataset: `rows` rows, `distinctInIds` distinct
 *  `in_id` values with `rowsPerInId` rows each, physically stored in a
 *  deterministic MIXED order (a multiplicative-hash permutation of the
 *  insertion sequence) rather than grouped by `in_id` - a naturally sorted
 *  insert order would flatter a sequential scan and understate what an
 *  index buys on real, interleaved edge-table writes. */
export const buildDatasetSql = (config: IndexEfficacyConfig): string => `
CREATE TABLE relation (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    args VARCHAR NOT NULL,
    payload BIGINT NOT NULL
);
INSERT INTO relation
SELECT
    'edge:' || i AS id,
    'id_' || (i % ${config.distinctInIds}) AS in_id,
    'out_' || i AS out_id,
    'args_' || (i % 97) AS args,
    i AS payload
FROM range(${config.rows}) AS r(i)
ORDER BY (i * 2654435761) % ${config.rows};
`.trim();

/** `lookupCount` distinct in_id values, evenly spaced across the distinct-id
 *  space so the sample isn't clustered in one physical region. */
export const buildLookupKeys = (config: IndexEfficacyConfig): string[] =>
    Array.from({ length: config.lookupCount }, (_, i) => {
        const idx = Math.floor((i * config.distinctInIds) / config.lookupCount);
        return `id_${idx}`;
    });

export class ExplainNotAllowedError extends Error {
    constructor() {
        super("index-efficacy SQL must not use EXPLAIN - this benchmark measures wall clock, not query plans");
        this.name = "ExplainNotAllowedError";
    }
}

/** Throws if the SQL mentions EXPLAIN in any form. Called on every SQL
 *  string this module hands to a DuckDB process. */
export const assertNoExplain = (sql: string): void => {
    if (/\bEXPLAIN\b/i.test(sql)) throw new ExplainNotAllowedError();
};

/** One SELECT per lookup key (never combined into one query) - a payload
 *  aggregate (so the optimizer can't short-circuit on an empty projection)
 *  plus the exact row count (so a wrong index silently returning some other
 *  in_id's rows is caught, not just timed). */
export const buildLookupSql = (keys: readonly string[]): string => {
    const sql = keys
        .map(
            (key) =>
                `SELECT count(*), sum(payload) FROM relation WHERE in_id = '${key}';`,
        )
        .join("\n");
    assertNoExplain(sql);
    return sql;
};

export type LookupRow = { readonly count: number; readonly payloadSum: number };

/** Parses `.mode csv .headers off` output from `buildLookupSql` - one
 *  `count,sum` line per lookup, in order. */
export const parseLookupCsv = (output: string): LookupRow[] =>
    output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
            const idx = line.lastIndexOf(",");
            const count = Number(line.slice(0, idx).trim());
            const payloadSum = Number(line.slice(idx + 1).trim());
            return { count, payloadSum };
        });

export type RowValidation = {
    readonly ok: boolean;
    readonly badKeys: string[];
};

/** Every lookup must return exactly `expectedCount` rows for its key (four,
 *  by default) - a composite index silently returning a partial/degenerate
 *  match would otherwise read as "fast" instead of "wrong". */
export const validateLookupRows = (
    keys: readonly string[],
    rows: readonly LookupRow[],
    config: IndexEfficacyConfig,
): RowValidation => {
    const badKeys = keys.filter((key, i) => {
        const row = rows[i];
        const keyIndex = Number(key.slice("id_".length));
        const expectedPayloadSum =
            config.rowsPerInId * keyIndex +
            config.distinctInIds *
                ((config.rowsPerInId * (config.rowsPerInId - 1)) / 2);
        return (
            row?.count !== config.rowsPerInId ||
            row.payloadSum !== expectedPayloadSum
        );
    });
    return { ok: badKeys.length === 0, badKeys };
};

/** Extracts `"1.5.5"` out of `duckdb --version` output (`v1.5.5 <hash>`). */
export const parseDuckdbVersion = (versionOutput: string): string | null => {
    const m = versionOutput.match(/v(\d+\.\d+\.\d+)/);
    return m ? m[1]! : null;
};

/** True when the early-vs-late portion of a variant's rotated samples
 *  differ by more than `thresholdRatio` - a sign that rotation position
 *  (not the index) is driving the measurement. */
export const detectOrderDrift = (
    positionMedians: readonly number[],
    thresholdRatio = 0.25,
): boolean => {
    if (positionMedians.length < 2) return false;
    const fastest = Math.min(...positionMedians);
    const slowest = Math.max(...positionMedians);
    if (slowest === 0) return false;
    return (slowest - fastest) / slowest > thresholdRatio;
};

// ---------------------------------------------------------------------------
// IO orchestration - not unit tested directly; exercised end to end by the
// gated integration test below at a tiny scale.
// ---------------------------------------------------------------------------

type DuckRun = { status: number; out: string; elapsedS: number };

const runDuck = (bin: string, args: string[], sql: string, cwd: string): DuckRun => {
    const start = performance.now();
    const proc = spawnSync(bin, args, { cwd, input: sql, encoding: "utf8" });
    return {
        status: proc.status ?? 1,
        out: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
        elapsedS: (performance.now() - start) / 1000,
    };
};

const variantFile = (variant: Variant): string => `${variant}.duckdb`;

export const main = async (
    env: Record<string, string | undefined> = process.env,
    write: (line: string) => void = console.log,
): Promise<number> => {
    let config: IndexEfficacyConfig;
    try {
        config = parseIndexEfficacyConfig(env);
    } catch (err) {
        if (err instanceof InvalidIndexEfficacyConfigError) {
            write(`ERROR: ${err.message}`);
            return 1;
        }
        throw err;
    }

    const duckdb = duckdbBinPath(env);
    if (!duckdb) {
        write("SKIP: duckdb CLI not found (set AX_DUCKDB_BIN or install duckdb on PATH)");
        return 0;
    }

    const versionRun = runDuck(duckdb, ["--version"], "", tmpdir());
    const version = parseDuckdbVersion(versionRun.out);
    if (version !== config.requiredDuckdbVersion) {
        write(
            `STOP: duckdb --version reported ${JSON.stringify(version)}, expected ${config.requiredDuckdbVersion} -- this benchmark's numbers do not transfer across DuckDB versions`,
        );
        return 1;
    }

    const workDir = join(tmpdir(), `ax-bench-index-${process.pid}-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const keepWork = env.AX_BENCH_INDEX_KEEP === "1";
    const cleanup = () => {
        if (!keepWork) rmSync(workDir, { recursive: true, force: true });
    };

    try {
        const baseFile = variantFile("none");
        const dataset = runDuck(duckdb, [baseFile], `${buildDatasetSql(config)}\nCHECKPOINT;`, workDir);
        if (dataset.status !== 0) {
            write(`ERROR: dataset build failed\n${dataset.out}`);
            return 1;
        }

        for (const variant of VARIANTS) {
            if (variant === "none") continue;
            cpSync(join(workDir, baseFile), join(workDir, variantFile(variant)));
            const indexSql = buildIndexSql(variant);
            if (!indexSql) continue;
            assertNoExplain(indexSql);
            const built = runDuck(duckdb, [variantFile(variant)], `${indexSql}\nCHECKPOINT;`, workDir);
            if (built.status !== 0) {
                write(`ERROR: index build failed for ${variant}\n${built.out}`);
                return 1;
            }
        }

        const keys = buildLookupKeys(config);
        const lookupSql = `.mode csv\n.headers off\n${buildLookupSql(keys)}`;

        const samples = new Map<Variant, number[]>(VARIANTS.map((v) => [v, []]));
        const positionSamples = new Map<Variant, number[][]>(
            VARIANTS.map((variant) => [
                variant,
                VARIANTS.map(() => [] as number[]),
            ]),
        );
        const totalRuns = config.warmRuns + config.measuredRuns;
        for (let run = 0; run < totalRuns; run++) {
            const order = rotateVariants(VARIANTS, run);
            for (const [position, variant] of order.entries()) {
                if (!existsSync(join(workDir, variantFile(variant)))) continue;
                const result = runDuck(duckdb, [variantFile(variant)], lookupSql, workDir);
                if (result.status !== 0) {
                    write(`ERROR: lookup run failed for ${variant}\n${result.out}`);
                    return 1;
                }
                const rows = parseLookupCsv(result.out);
                const validation = validateLookupRows(keys, rows, config);
                if (!validation.ok) {
                    write(
                        `STOP: ${variant} returned a wrong count or payload sum for ${validation.badKeys.length} lookup key(s) (expected ${config.rowsPerInId} rows each) -- e.g. ${validation.badKeys.slice(0, 5).join(", ")}`,
                    );
                    return 1;
                }
                if (run >= config.warmRuns) {
                    samples.get(variant)!.push(result.elapsedS);
                    positionSamples.get(variant)![position]!.push(result.elapsedS);
                }
            }
        }

        write(`duckdb version: ${version}`);
        write(
            `config: rows=${config.rows} distinctInIds=${config.distinctInIds} rowsPerInId=${config.rowsPerInId} lookups=${config.lookupCount} warmRuns=${config.warmRuns} measuredRuns=${config.measuredRuns}`,
        );

        const medians = new Map<Variant, number>();
        for (const variant of VARIANTS) {
            const values = samples.get(variant)!;
            if (values.length === 0) continue;
            const m = median(values);
            medians.set(variant, m);
            const ratio = iqrRatio(values);
            write(`${variant}: samples=[${values.map((v) => v.toFixed(4)).join(", ")}] median=${m.toFixed(4)}s iqr/median=${(ratio * 100).toFixed(1)}%`);
            if (ratio > 0.15) {
                write(`STOP: ${variant} IQR/median (${(ratio * 100).toFixed(1)}%) exceeds 15% -- samples too noisy to compare`);
                return 1;
            }

            const byPosition = positionSamples.get(variant)!;
            if (byPosition.every((positionValues) => positionValues.length >= 2)) {
                const positionMedians = byPosition.map((positionValues) =>
                    median(positionValues),
                );
                if (detectOrderDrift(positionMedians)) {
                    write(
                        `STOP: ${variant} position medians [${positionMedians.map((value) => value.toFixed(4)).join(", ")}] diverge by more than 25% -- variant order may be driving the result`,
                    );
                    return 1;
                }
            }
        }

        const baseline = medians.get("none");
        if (baseline !== undefined) {
            for (const variant of VARIANTS) {
                const m = medians.get(variant);
                if (m === undefined || variant === "none") continue;
                write(`ratio ${variant}/none: ${(m / baseline).toFixed(3)}x`);
            }
        }

        write("PASS");
        return 0;
    } finally {
        cleanup();
    }
};

if (import.meta.main) {
    process.exit(await main());
}
