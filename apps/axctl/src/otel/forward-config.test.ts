import { describe, expect, test } from "bun:test";
import {
    parseOtlpHeaders,
    resolveForwardTargets,
    buildForwardConfig,
    signalOfPath,
    asForwardConfig,
    isLoopbackEndpoint,
} from "./forward-config.ts";

describe("forward-config (#1017)", () => {
    describe("parseOtlpHeaders", () => {
        test("parses a comma-separated k=v list", () => {
            expect(parseOtlpHeaders("dd-api-key=abc123,x-team=platform")).toEqual({
                "dd-api-key": "abc123",
                "x-team": "platform",
            });
        });
        test("splits only on the first = so values may contain =", () => {
            expect(parseOtlpHeaders("authorization=Bearer a=b=c")).toEqual({
                authorization: "Bearer a=b=c",
            });
        });
        test("skips blanks and malformed entries", () => {
            expect(parseOtlpHeaders(" , =novalue, k=v ,")).toEqual({ k: "v" });
            expect(parseOtlpHeaders(undefined)).toEqual({});
            expect(parseOtlpHeaders("")).toEqual({});
        });
    });

    describe("resolveForwardTargets", () => {
        const DD = "https://otlp.datadoghq.com";

        test("the reporter's case: explicit foreign logs + metrics, ax diverts logs only", () => {
            // ax overwrites the generic + logs endpoint, but NOT the explicit
            // metrics endpoint - so metrics still flow direct and must NOT be
            // forwarded (double-send), only logs.
            const targets = resolveForwardTargets({
                OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${DD}/v1/metrics`,
                OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${DD}/v1/logs`,
                OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
                OTEL_EXPORTER_OTLP_HEADERS: "dd-api-key=secret",
            });
            expect(targets.map((t) => t.signal)).toEqual(["logs"]);
            expect(targets[0].url).toBe(`${DD}/v1/logs`);
            expect(targets[0].headers).toEqual({ "dd-api-key": "secret" });
        });

        test("a foreign GENERIC endpoint with no explicit per-signal diverts logs+metrics", () => {
            const targets = resolveForwardTargets({
                OTEL_EXPORTER_OTLP_ENDPOINT: DD,
                OTEL_EXPORTER_OTLP_HEADERS: "dd-api-key=secret",
            });
            // traces are opt-in (no exporter) but resolution is signal-agnostic;
            // ax diverts every non-explicit signal off the generic endpoint.
            expect(new Set(targets.map((t) => t.signal))).toEqual(new Set(["logs", "metrics", "traces"]));
            const logs = targets.find((t) => t.signal === "logs");
            expect(logs?.url).toBe(`${DD}/v1/logs`);
            const metrics = targets.find((t) => t.signal === "metrics");
            expect(metrics?.url).toBe(`${DD}/v1/metrics`);
        });

        test("an explicit foreign metrics endpoint is NOT forwarded (ax never diverts it)", () => {
            const targets = resolveForwardTargets({
                OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${DD}/v1/metrics`,
            });
            expect(targets).toEqual([]);
        });

        test("per-signal headers override generic headers", () => {
            const targets = resolveForwardTargets({
                OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${DD}/v1/logs`,
                OTEL_EXPORTER_OTLP_HEADERS: "dd-api-key=generic,shared=1",
                OTEL_EXPORTER_OTLP_LOGS_HEADERS: "dd-api-key=logs-specific",
            });
            expect(targets[0].headers).toEqual({ "dd-api-key": "logs-specific", shared: "1" });
        });

        test("nothing configured / already-ax loopback yields no targets", () => {
            expect(resolveForwardTargets({})).toEqual([]);
            expect(resolveForwardTargets(undefined)).toEqual([]);
            expect(resolveForwardTargets({
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1738",
                OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:1738/v1/logs",
            })).toEqual([]);
            expect(resolveForwardTargets({
                OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4318/v1/logs",
            })).toEqual([]);
        });

        test("trims a trailing slash on the generic endpoint", () => {
            const targets = resolveForwardTargets({ OTEL_EXPORTER_OTLP_ENDPOINT: `${DD}/` });
            expect(targets.find((t) => t.signal === "logs")?.url).toBe(`${DD}/v1/logs`);
        });
    });

    describe("buildForwardConfig / signalOfPath / asForwardConfig", () => {
        test("buildForwardConfig marks enabled by target presence", () => {
            expect(buildForwardConfig([], "2026-08-24T00:00:00Z").enabled).toBe(false);
            const cfg = buildForwardConfig(
                [{ signal: "logs", url: "https://x/v1/logs", headers: {} }],
                "2026-08-24T00:00:00Z",
            );
            expect(cfg.enabled).toBe(true);
            expect(cfg.created_at).toBe("2026-08-24T00:00:00Z");
        });

        test("signalOfPath maps only the three OTLP paths", () => {
            expect(signalOfPath("/v1/logs")).toBe("logs");
            expect(signalOfPath("/v1/metrics")).toBe("metrics");
            expect(signalOfPath("/v1/traces")).toBe("traces");
            expect(signalOfPath("/v1/other")).toBeNull();
            expect(signalOfPath("/health")).toBeNull();
        });

        test("asForwardConfig round-trips and rejects junk", () => {
            const cfg = buildForwardConfig(
                [{ signal: "logs", url: "https://x/v1/logs", headers: { "dd-api-key": "k" } }],
                "2026-08-24T00:00:00Z",
            );
            expect(asForwardConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
            expect(asForwardConfig(null)).toBeNull();
            expect(asForwardConfig({ targets: "no" })).toBeNull();
            // a bad target is dropped, not fatal
            const partial = asForwardConfig({ enabled: true, targets: [{ signal: "bogus", url: "x" }, { signal: "logs", url: "https://x/v1/logs" }] });
            expect(partial?.targets.map((t) => t.signal)).toEqual(["logs"]);
        });

        test("isLoopbackEndpoint recognizes ax hosts on any port", () => {
            expect(isLoopbackEndpoint("http://127.0.0.1:1738")).toBe(true);
            expect(isLoopbackEndpoint("http://localhost:4318/v1/logs")).toBe(true);
            expect(isLoopbackEndpoint("https://otlp.datadoghq.com/v1/logs")).toBe(false);
        });
    });
});
