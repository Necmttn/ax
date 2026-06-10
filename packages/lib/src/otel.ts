/**
 * otel.ts - env-gated OTLP/HTTP telemetry export for axctl.
 *
 * Set `AX_OTLP_URL` (e.g. `http://127.0.0.1:4318`, the default endpoint of a
 * local Maple `maple start` - https://maple.dev/local/) and every Effect span,
 * log, and metric flows to that collector. Unset, this layer is `Layer.empty`
 * and the binary behaves exactly as before - zero overhead, no network.
 *
 * Wired beneath `LiveTraceLayer` in `layers.ts`: LiveTrace DECORATES whatever
 * base tracer is in context at its build time, so providing the OTLP tracer
 * below it means both systems see every span (LiveTrace for the progress
 * UI/dashboard, OTLP for flame-graph inspection in Maple).
 */
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Otlp } from "effect/unstable/observability";

/** Env var holding the OTLP/HTTP base URL. `/v1/traces` etc. are appended by Otlp. */
export const AX_OTLP_URL_ENV = "AX_OTLP_URL";

export interface OtlpTelemetryOptions {
    readonly baseUrl: string;
    /** Resource service.name shown in the collector UI. Default "axctl". */
    readonly serviceName?: string;
}

/**
 * Unconditional OTLP layer: logs + metrics + traces over OTLP/HTTP (JSON),
 * self-contained (brings its own fetch-backed HttpClient).
 *
 * Short export interval + shutdown flush matter here: axctl is a CLI, so most
 * runs exit within seconds of the last span - a server-tuned batching window
 * would drop the tail of the trace.
 */
export const otlpTelemetryLayer = (opts: OtlpTelemetryOptions): Layer.Layer<never> =>
    Otlp.layerJson({
        baseUrl: opts.baseUrl,
        resource: { serviceName: opts.serviceName ?? "axctl" },
        tracerExportInterval: "500 millis",
        loggerExportInterval: "1 second",
        metricsExportInterval: "2 seconds",
        shutdownTimeout: "3 seconds",
    }).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Env-gated variant: real exporter when `AX_OTLP_URL` is set, `Layer.empty`
 * otherwise. Read once at layer build (config snapshot, not reactive).
 */
export const otlpTelemetryFromEnv = (serviceName?: string): Layer.Layer<never> => {
    const baseUrl = process.env[AX_OTLP_URL_ENV];
    return baseUrl && baseUrl.length > 0
        ? otlpTelemetryLayer(serviceName === undefined ? { baseUrl } : { baseUrl, serviceName })
        : Layer.empty;
};
