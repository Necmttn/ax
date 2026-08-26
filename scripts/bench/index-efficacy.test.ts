import { describe, expect, test } from "bun:test";
import { gatedTest } from "@ax/lib/testing/gated-test";
import { duckdbBinPath } from "./duckdb-bin.ts";
import {
    ExplainNotAllowedError,
    InvalidIndexEfficacyConfigError,
    VARIANTS,
    assertNoExplain,
    buildDatasetSql,
    buildIndexSql,
    buildLookupKeys,
    buildLookupSql,
    detectOrderDrift,
    iqrRatio,
    main,
    median,
    parseDuckdbVersion,
    parseIndexEfficacyConfig,
    parseLookupCsv,
    quantile,
    rotateVariants,
    validateLookupRows,
} from "./index-efficacy.ts";

describe("parseIndexEfficacyConfig", () => {
    test("defaults to the #786 spec: 2M rows, 500k distinct, 200 lookups, 1+7 runs", () => {
        const config = parseIndexEfficacyConfig({});
        expect(config.rows).toBe(2_000_000);
        expect(config.distinctInIds).toBe(500_000);
        expect(config.rowsPerInId).toBe(4);
        expect(config.lookupCount).toBe(200);
        expect(config.warmRuns).toBe(1);
        expect(config.measuredRuns).toBe(7);
        expect(config.requiredDuckdbVersion).toBe("1.5.5");
    });

    test("every knob is overridable from env", () => {
        const config = parseIndexEfficacyConfig({
            AX_BENCH_INDEX_ROWS: "40",
            AX_BENCH_INDEX_DISTINCT: "10",
            AX_BENCH_INDEX_LOOKUPS: "5",
            AX_BENCH_INDEX_WARM_RUNS: "0",
            AX_BENCH_INDEX_MEASURED_RUNS: "2",
        });
        expect(config).toEqual({
            rows: 40,
            distinctInIds: 10,
            rowsPerInId: 4,
            lookupCount: 5,
            warmRuns: 0,
            measuredRuns: 2,
            requiredDuckdbVersion: "1.5.5",
        });
    });

    test("rejects a non-integer override with the offending name+value", () => {
        expect(() => parseIndexEfficacyConfig({ AX_BENCH_INDEX_ROWS: "2.5" })).toThrow(
            InvalidIndexEfficacyConfigError,
        );
        try {
            parseIndexEfficacyConfig({ AX_BENCH_INDEX_ROWS: "abc" });
            throw new Error("expected throw");
        } catch (err) {
            expect(String(err)).toContain("AX_BENCH_INDEX_ROWS");
            expect(String(err)).toContain("abc");
        }
    });

    test("rejects rows that are not an exact multiple of distinct in_ids", () => {
        expect(() =>
            parseIndexEfficacyConfig({
                AX_BENCH_INDEX_ROWS: "10",
                AX_BENCH_INDEX_DISTINCT: "3",
            }),
        ).toThrow(InvalidIndexEfficacyConfigError);
    });

    test("rejects a lookup count greater than the distinct in_id space", () => {
        expect(() =>
            parseIndexEfficacyConfig({
                AX_BENCH_INDEX_ROWS: "40",
                AX_BENCH_INDEX_DISTINCT: "10",
                AX_BENCH_INDEX_LOOKUPS: "11",
            }),
        ).toThrow(InvalidIndexEfficacyConfigError);
    });

    test("rejects fewer than 1 measured run", () => {
        expect(() =>
            parseIndexEfficacyConfig({ AX_BENCH_INDEX_MEASURED_RUNS: "0" }),
        ).toThrow(InvalidIndexEfficacyConfigError);
    });
});

describe("median", () => {
    test("returns the middle value for an odd-length sample", () => {
        expect(median([3, 1, 2])).toBe(2);
    });

    test("averages the two middle values for an even-length sample", () => {
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    test("throws on an empty sample set rather than returning NaN/undefined", () => {
        expect(() => median([])).toThrow(InvalidIndexEfficacyConfigError);
    });
});

describe("quantile / iqrRatio", () => {
    test("quantile(0.5) agrees with median", () => {
        expect(quantile([1, 2, 3, 4], 0.5)).toBe(median([1, 2, 3, 4]));
    });

    test("iqrRatio is 0 for identical samples", () => {
        expect(iqrRatio([5, 5, 5, 5, 5])).toBe(0);
    });

    test("iqrRatio grows with spread", () => {
        const tight = iqrRatio([9.9, 10, 10, 10, 10.1]);
        const wide = iqrRatio([5, 8, 10, 12, 15]);
        expect(wide).toBeGreaterThan(tight);
    });
});

describe("detectOrderDrift", () => {
    test("false when position medians are close", () => {
        expect(detectOrderDrift([1.0, 1.05, 0.98])).toBe(false);
    });

    test("true when position medians diverge past the threshold", () => {
        expect(detectOrderDrift([1.0, 2.0, 1.1])).toBe(true);
    });

    test("false when all positions are zero", () => {
        expect(detectOrderDrift([0, 0, 0])).toBe(false);
    });
});

describe("rotateVariants (order rotation)", () => {
    test("run 0 is the identity order", () => {
        expect(rotateVariants(VARIANTS, 0)).toEqual(["none", "composite", "single"]);
    });

    test("rotates by one position per run", () => {
        expect(rotateVariants(VARIANTS, 1)).toEqual(["composite", "single", "none"]);
        expect(rotateVariants(VARIANTS, 2)).toEqual(["single", "none", "composite"]);
    });

    test("wraps around past the variant count", () => {
        expect(rotateVariants(VARIANTS, 3)).toEqual(rotateVariants(VARIANTS, 0));
        expect(rotateVariants(VARIANTS, 4)).toEqual(rotateVariants(VARIANTS, 1));
    });

    test("every rotation is a permutation containing all variants exactly once", () => {
        for (let run = 0; run < 6; run++) {
            const order = rotateVariants(VARIANTS, run);
            expect([...order].sort()).toEqual([...VARIANTS].sort());
        }
    });
});

describe("index SQL", () => {
    test("the none variant creates no index", () => {
        expect(buildIndexSql("none")).toBeNull();
    });

    test("the composite variant indexes all three columns in order", () => {
        expect(buildIndexSql("composite")).toBe(
            "CREATE INDEX idx_composite ON relation(in_id, out_id, args);",
        );
    });

    test("the single variant indexes only in_id", () => {
        expect(buildIndexSql("single")).toBe("CREATE INDEX idx_single ON relation(in_id);");
    });

    test("neither index statement uses EXPLAIN", () => {
        for (const variant of VARIANTS) {
            const sql = buildIndexSql(variant);
            if (sql) expect(() => assertNoExplain(sql)).not.toThrow();
        }
    });
});

describe("buildDatasetSql", () => {
    test("derives in_id from a modulo of the configured distinct count, not a literal loop", () => {
        const sql = buildDatasetSql(
            parseIndexEfficacyConfig({
                AX_BENCH_INDEX_ROWS: "40",
                AX_BENCH_INDEX_DISTINCT: "10",
                AX_BENCH_INDEX_LOOKUPS: "2",
            }),
        );
        expect(sql).toContain("range(40)");
        expect(sql).toContain("i % 10");
        expect(sql).toContain("id VARCHAR PRIMARY KEY");
    });

    test("orders by a deterministic permutation, not natural insertion order", () => {
        const sql = buildDatasetSql(parseIndexEfficacyConfig({}));
        expect(sql).toContain("ORDER BY");
        expect(sql).not.toMatch(/ORDER BY i\b/);
    });

    test("contains no EXPLAIN", () => {
        expect(() => assertNoExplain(buildDatasetSql(parseIndexEfficacyConfig({})))).not.toThrow();
    });
});

describe("buildLookupKeys", () => {
    test("returns exactly lookupCount distinct keys spanning the distinct-id space", () => {
        const keys = buildLookupKeys(
            parseIndexEfficacyConfig({
                AX_BENCH_INDEX_ROWS: "100",
                AX_BENCH_INDEX_DISTINCT: "20",
                AX_BENCH_INDEX_LOOKUPS: "5",
            }),
        );
        expect(keys).toHaveLength(5);
        expect(new Set(keys).size).toBe(5);
        expect(keys[0]).toBe("id_0");
    });
});

describe("buildLookupSql / result parsing / row validation (no-EXPLAIN invariant)", () => {
    test("emits one SELECT per key, each with count(*) and a payload aggregate", () => {
        const sql = buildLookupSql(["id_1", "id_2"]);
        const statements = sql.trim().split("\n");
        expect(statements).toHaveLength(2);
        for (const stmt of statements) {
            expect(stmt).toContain("count(*)");
            expect(stmt).toContain("sum(payload)");
        }
        expect(sql).toContain("in_id = 'id_1'");
        expect(sql).toContain("in_id = 'id_2'");
    });

    test("buildLookupSql refuses to build EXPLAIN'd SQL", () => {
        // assertNoExplain is exercised directly here; buildLookupSql itself
        // never emits EXPLAIN, so this pins the invariant at the guard.
        expect(() => assertNoExplain("EXPLAIN SELECT 1")).toThrow(ExplainNotAllowedError);
        expect(() => assertNoExplain("explain analyze select 1")).toThrow(ExplainNotAllowedError);
        expect(() => assertNoExplain("SELECT 1 -- safe query")).not.toThrow();
    });

    test("parseLookupCsv parses count,sum lines in order", () => {
        const rows = parseLookupCsv("4,1000\n4,2000\n\n");
        expect(rows).toEqual([
            { count: 4, payloadSum: 1000 },
            { count: 4, payloadSum: 2000 },
        ]);
    });

    test("validateLookupRows passes when every key returns the expected row count", () => {
        const keys = ["id_1", "id_2"];
        const rows = parseLookupCsv("4,64\n4,68\n");
        const config = parseIndexEfficacyConfig({
            AX_BENCH_INDEX_ROWS: "40",
            AX_BENCH_INDEX_DISTINCT: "10",
            AX_BENCH_INDEX_LOOKUPS: "2",
        });
        const result = validateLookupRows(keys, rows, config);
        expect(result.ok).toBe(true);
        expect(result.badKeys).toEqual([]);
    });

    test("validateLookupRows flags a key whose row count is wrong", () => {
        const keys = ["id_1", "id_2", "id_3"];
        const rows = parseLookupCsv("4,64\n3,20\n4,72\n");
        const config = parseIndexEfficacyConfig({
            AX_BENCH_INDEX_ROWS: "40",
            AX_BENCH_INDEX_DISTINCT: "10",
            AX_BENCH_INDEX_LOOKUPS: "3",
        });
        const result = validateLookupRows(keys, rows, config);
        expect(result.ok).toBe(false);
        expect(result.badKeys).toEqual(["id_2"]);
    });

    test("validateLookupRows flags a wrong payload sum when the row count is correct", () => {
        const keys = ["id_1", "id_2"];
        const rows = parseLookupCsv("4,64\n4,999\n");
        const config = parseIndexEfficacyConfig({
            AX_BENCH_INDEX_ROWS: "40",
            AX_BENCH_INDEX_DISTINCT: "10",
            AX_BENCH_INDEX_LOOKUPS: "2",
        });
        const result = validateLookupRows(keys, rows, config);
        expect(result.ok).toBe(false);
        expect(result.badKeys).toEqual(["id_2"]);
    });

    test("validateLookupRows flags a missing row as a mismatch, not a silent pass", () => {
        const keys = ["id_1", "id_2"];
        const rows = parseLookupCsv("4,64\n");
        const config = parseIndexEfficacyConfig({
            AX_BENCH_INDEX_ROWS: "40",
            AX_BENCH_INDEX_DISTINCT: "10",
            AX_BENCH_INDEX_LOOKUPS: "2",
        });
        const result = validateLookupRows(keys, rows, config);
        expect(result.ok).toBe(false);
        expect(result.badKeys).toEqual(["id_2"]);
    });
});

describe("parseDuckdbVersion", () => {
    test("extracts the version from `duckdb --version` output", () => {
        expect(parseDuckdbVersion("v1.5.5 abc123def\n")).toBe("1.5.5");
    });

    test("returns null when the output has no v-prefixed version", () => {
        expect(parseDuckdbVersion("not a version string")).toBeNull();
    });
});

describe("index-efficacy integration (gated small-scale)", () => {
    const duckdb = duckdbBinPath();
    const duckdbVersion = duckdb
        ? parseDuckdbVersion(Bun.spawnSync([duckdb, "--version"]).stdout.toString())
        : null;
    const duckdbTest = gatedTest({
        reason:
            duckdbVersion === null
                ? "no duckdb binary resolvable (set AX_DUCKDB_BIN or put duckdb on PATH)"
                : `DuckDB v1.5.5 required, found ${duckdbVersion}`,
        when: !duckdb || duckdbVersion !== "1.5.5",
    });

    duckdbTest(
        "runs all three variants end to end at a tiny scale, validating rows without asserting performance order",
        async () => {
            if (!duckdb) return;
            const lines: string[] = [];
            const exitCode = await main(
                {
                    ...process.env,
                    AX_DUCKDB_BIN: duckdb,
                    AX_BENCH_INDEX_ROWS: "400",
                    AX_BENCH_INDEX_DISTINCT: "100",
                    AX_BENCH_INDEX_LOOKUPS: "10",
                    AX_BENCH_INDEX_WARM_RUNS: "1",
                    AX_BENCH_INDEX_MEASURED_RUNS: "6",
                },
                (line) => lines.push(line),
            );
            const out = lines.join("\n");
            expect(out).toContain("none:");
            expect(out).toContain("composite:");
            expect(out).toContain("single:");
            expect(out).toContain("PASS");
            expect(exitCode).toBe(0);
        },
        60_000,
    );
});
