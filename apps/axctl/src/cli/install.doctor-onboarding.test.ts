import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { CacheRead, CacheUnavailableError, type CacheReadService } from "@ax/lib/duckdb/seam";
import { cacheReadResults } from "../testing/cache-read.ts";
import { collectDoctorReport, formatDoctorReport, otelRedirectDoctorCheck } from "./install.ts";

// `collectDoctorReport` is an Effect requiring FileSystem + Path + CacheRead.
// Run it against the REAL Bun-backed platform layers, exactly as the
// production CLI does via `withoutDb`/`withCache`, plus a CacheRead test
// double (`../testing/cache-read.ts` - an "honest transform stub": it
// decodes nothing, so it proves nothing about database behavior, only about
// collectDoctorReport's own branching - which is exactly what these tests
// are about).
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

// Doctor issues its two CacheRead queries in a fixed order: the "ingest-runs"
// stuck-row probe first, then the "cache" last-successful-ingest freshness
// probe (see collectDoctorReport in install.ts). `cacheReadResults` hands
// back canned rows strictly in call order, so the two slots below must line
// up with that order, not with which check happens to read more naturally
// first in prose.
const cacheLayer = (
    opts: { readonly ingestRunsRows?: unknown[]; readonly lastOkRows?: unknown[] } = {},
): Layer.Layer<CacheRead> => cacheReadResults([opts.ingestRunsRows ?? [], opts.lastOkRows ?? []]);

const unopenableCache: Layer.Layer<CacheRead> = Layer.succeed(CacheRead, {
    snapshotPath: "(test)",
    rows: () => Effect.fail(new CacheUnavailableError({ path: "(test)", message: "no snapshot published" })),
    first: () => Effect.fail(new CacheUnavailableError({ path: "(test)", message: "no snapshot published" })),
    raw: () => Effect.fail(new CacheUnavailableError({ path: "(test)", message: "no snapshot published" })),
} as unknown as CacheReadService);

const runDoctorReport = (cache: Layer.Layer<CacheRead> = cacheLayer()) =>
    Effect.runPromise(collectDoctorReport().pipe(Effect.provide(Layer.merge(BunFsLayer, cache))));

describe("doctor includes onboarding harness-tracking checks", () => {
    test("report contains a check whose name starts with 'onboarding:'", async () => {
        const report = await runDoctorReport();
        const names = report.checks.map((c) => c.name);
        expect(names.some((n) => n.startsWith("onboarding:"))).toBe(true);
    });

    test("text format lists harness-tracking lines", async () => {
        const text = formatDoctorReport(await runDoctorReport(), false);
        expect(text).toContain("onboarding:");
    });
});

// #daemon-subtraction silent-failure guard: "a doctor that lost its
// db-listener check and gained nothing in its place says 'all good' on a
// machine with no cache file at all. Assert the report's check COUNT and the
// exact check ids, not just its exit code." These tests are that assertion.
describe("doctor's fixed non-onboarding check set", () => {
    test("always emits exactly these check ids, in this order, before onboarding checks", async () => {
        const report = await runDoctorReport();
        const fixedNames = report.checks.map((c) => c.name).filter((n) => !n.startsWith("onboarding:"));
        expect(fixedNames).toEqual([
            "platform",
            "binary",
            "data-dir",
            "logs-dir",
            "cache",
            "ingest-runs",
            "otlpd",
            "otel",
            "agent-event-index",
        ]);
    });

    test("'cache' and 'ingest-runs' are present - not silently omitted - when the cache cannot be opened at all", async () => {
        const report = await runDoctorReport(unopenableCache);
        const names = report.checks.map((c) => c.name);
        expect(names).toContain("cache");
        expect(names).toContain("ingest-runs");
        expect(report.checks.find((c) => c.name === "cache")?.ok).toBe(false);
        expect(report.checks.find((c) => c.name === "ingest-runs")?.ok).toBe(false);
    });

    test("'cache' flags a stale graph and passes a fresh one", async () => {
        const staleAt = new Date(Date.now() - 13 * 86_400_000);
        const staleReport = await runDoctorReport(cacheLayer({ lastOkRows: [{ ended_at: staleAt, started_at: staleAt }] }));
        const staleCheck = staleReport.checks.find((c) => c.name === "cache");
        expect(staleCheck?.ok).toBe(false);
        expect(staleCheck?.detail).toContain("stale");

        const freshAt = new Date(Date.now() - 3_600_000);
        const freshReport = await runDoctorReport(cacheLayer({ lastOkRows: [{ ended_at: freshAt, started_at: freshAt }] }));
        expect(freshReport.checks.find((c) => c.name === "cache")?.ok).toBe(true);
    });

    test("'ingest-runs' flags a stuck 'running' row", async () => {
        const stuckStartedAt = new Date(Date.now() - 3_600_000);
        const report = await runDoctorReport(
            cacheLayer({
                ingestRunsRows: [
                    { id: "r1", command: "ingest", started_at: stuckStartedAt, last_progress_at: null },
                ],
            }),
        );
        const check = report.checks.find((c) => c.name === "ingest-runs");
        expect(check?.ok).toBe(false);
        expect(check?.detail).toContain("stuck");
    });

    test("'otlpd' is always ok=true - consent-gated telemetry is never a doctor failure", async () => {
        const report = await runDoctorReport();
        const check = report.checks.find((c) => c.name === "otlpd");
        expect(check?.ok).toBe(true);
    });

    test("'otel' is always ok=true and present - a legitimate redirect is not a failure", async () => {
        const report = await runDoctorReport();
        const check = report.checks.find((c) => c.name === "otel");
        expect(check).toBeDefined();
        expect(check?.ok).toBe(true);
    });
});

describe("otelRedirectDoctorCheck (#1014)", () => {
    test("names the backup + restore path when a redirect was recorded", () => {
        const check = otelRedirectDoctorCheck({
            backupExists: true,
            backupPath: "/home/u/.ax/otel-previous.json",
            logsEndpoint: "http://127.0.0.1:1738/v1/logs",
        });
        expect(check.name).toBe("otel");
        expect(check.ok).toBe(true);
        expect(check.detail).toContain("redirected");
        expect(check.detail).toContain("/home/u/.ax/otel-previous.json");
        expect(check.detail).toContain("restore");
    });

    test("reports the current endpoint with no redirect when no backup exists", () => {
        const check = otelRedirectDoctorCheck({
            backupExists: false,
            backupPath: "/home/u/.ax/otel-previous.json",
            logsEndpoint: "http://127.0.0.1:1738/v1/logs",
        });
        expect(check.ok).toBe(true);
        expect(check.detail).toContain("http://127.0.0.1:1738/v1/logs");
        expect(check.detail).toContain("no external redirect");
    });

    test("says so when no OTLP endpoint is configured at all", () => {
        const check = otelRedirectDoctorCheck({
            backupExists: false,
            backupPath: "/home/u/.ax/otel-previous.json",
            logsEndpoint: null,
        });
        expect(check.ok).toBe(true);
        expect(check.detail).toContain("no OTLP");
    });
});
