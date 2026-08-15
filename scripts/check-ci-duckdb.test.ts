/**
 * The wiring that keeps CI honest about DuckDB.
 *
 * THE INCIDENT (PR #798). ax runs on its own DuckDB v1.5.5 build with the
 * `fts` extension linked STATICALLY; the upstream release artifact cannot
 * `LOAD fts` at all. CI provisioned no DuckDB, so `resolveTestDylib` fell
 * through to its last resort - downloading that upstream artifact - and 36
 * recall / repository-scope / seam / FTS tests failed with
 * `Install it first using "INSTALL fts"`. None of them were about the code
 * they were named after. The same suites were green on developer machines,
 * because a box that has ever run `INSTALL fts` keeps the extension under
 * `~/.duckdb/extensions/<version>/<platform>/`, where any dylib finds it.
 *
 * Both halves of that failure are load-bearing and neither is visible from
 * inside a normal test, so they are asserted here:
 *   1. CI actually builds and hands over the custom artifact, and demands the
 *      FTS suites RUN (`AX_DUCKDB_REQUIRE_FTS`) rather than skip.
 *   2. Every suite that reaches `buildFtsIndexes` declares `requireFts`, so a
 *      new one cannot quietly rejoin the 36.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { requireFtsFromEnv } from "../packages/lib/src/testing/duckdb-dylib.ts";

const repoRoot = join(import.meta.dir, "..");
const ci = parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<
        string,
        {
            needs?: string | string[];
            env?: Record<string, string>;
            steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, string> }>;
        }
    >;
};

const job = (name: string) => {
    const found = ci.jobs[name];
    if (found === undefined) throw new Error(`ci.yml has no "${name}" job`);
    return found;
};

const stepsOf = (name: string) => job(name).steps ?? [];
const runScripts = (name: string) => stepsOf(name).map((s) => s.run ?? "").join("\n");

describe("ci.yml provisions the custom DuckDB", () => {
    test("a dedicated job builds it with scripts/build-duckdb.sh", () => {
        expect(runScripts("duckdb")).toContain("scripts/build-duckdb.sh");
    });

    test("the artifact is air-gap smoked, so a poisoned cache cannot pass as a build", () => {
        // The smoke sets autoload/autoinstall off, which is what makes it a
        // proof of STATIC linkage rather than of a populated ~/.duckdb.
        expect(runScripts("duckdb")).toContain("scripts/smoke-duckdb-dylib.ts");
    });

    test("the build is cached, and saved only after the smoke passes", () => {
        const steps = stepsOf("duckdb");
        const restore = steps.findIndex((s) => s.uses?.startsWith("actions/cache/restore"));
        const smoke = steps.findIndex((s) => (s.run ?? "").includes("smoke-duckdb-dylib.ts"));
        const save = steps.findIndex((s) => s.uses?.startsWith("actions/cache/save"));
        expect(restore).toBeGreaterThanOrEqual(0);
        expect(smoke).toBeGreaterThanOrEqual(0);
        // A save that ran before the smoke would cache an unproven artifact and
        // hand it to every later run.
        expect(save).toBeGreaterThan(smoke);
    });

    test("verify waits for that job and downloads its artifact", () => {
        const needs = job("verify").needs;
        expect(Array.isArray(needs) ? needs : [needs]).toContain("duckdb");

        const uploaded = stepsOf("duckdb").find((s) => s.uses?.startsWith("actions/upload-artifact"));
        const downloaded = stepsOf("verify").find((s) =>
            s.uses?.startsWith("actions/download-artifact"),
        );
        expect(uploaded?.with?.name).toBeDefined();
        // A name mismatch fails at runtime with an empty directory, which then
        // looks exactly like the original bug.
        expect(downloaded?.with?.name).toBe(uploaded?.with?.name);
    });

    test("verify points BOTH resolvers at the downloaded build", () => {
        // DUCKDB_DIST_DIR is the single knob `resolveTestDylib` and
        // `duckdbBinPath` agree on; without it either can reach the upstream
        // download or PATH instead.
        const dist = job("verify").env?.DUCKDB_DIST_DIR;
        expect(dist).toBeDefined();
        expect(dist).toContain("dist/duckdb");

        const downloaded = stepsOf("verify").find((s) =>
            s.uses?.startsWith("actions/download-artifact"),
        );
        expect(downloaded?.with?.path).toBe("dist/duckdb");
    });

    test("verify DEMANDS the FTS suites run instead of letting them skip", () => {
        const flag = job("verify").env?.AX_DUCKDB_REQUIRE_FTS;
        expect(flag).toBeDefined();
        // Asserted through the same predicate the test harness uses, so
        // setting it to "0" or "false" here cannot read as enabled.
        expect(requireFtsFromEnv({ AX_DUCKDB_REQUIRE_FTS: String(flag) })).toBe(true);
    });

    test("the executable bit is restored - upload-artifact drops it", () => {
        // Without this the CLI binary comes back 0644, isExecutableFile()
        // rejects it, and duckdbBinPath falls through to PATH silently.
        expect(runScripts("verify")).toContain("chmod +x dist/duckdb/duckdb");
    });
});

describe("every FTS-dependent suite declares requireFts", () => {
    /** Suites reach `buildFtsIndexes` directly, or through
     *  `publishCacheFixture`, which builds the indexes for EVERY fixture. */
    const FTS_MARKERS = ["buildFtsIndexes", "publishCacheFixture"];

    const ftsSuites = [...new Bun.Glob("{apps,packages}/*/src/**/*.test.ts").scanSync(repoRoot)]
        .map((rel) => ({ rel, text: readFileSync(join(repoRoot, rel), "utf8") }))
        .filter(({ text }) => FTS_MARKERS.some((marker) => text.includes(marker)))
        .filter(({ text }) => text.includes("duckdbTestSetup("));

    test("the guard actually found suites to guard", () => {
        // A glob that silently matches nothing would make every case below
        // vacuously true - the failure mode this whole file exists to prevent.
        expect(ftsSuites.length).toBeGreaterThanOrEqual(4);
    });

    for (const { rel, text } of ftsSuites) {
        test(`${rel} passes requireFts`, () => {
            expect(text).toContain("requireFts: true");
        });
    }
});
