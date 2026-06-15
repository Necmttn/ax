/**
 * OTLP HTTP receiver endpoints: POST /v1/metrics, /v1/traces, /v1/logs.
 *
 * All three signals return `{ partialSuccess: {} }` (the OTLP/HTTP ack).
 * The handler is fail-open: a bad body or decode failure logs a warning and
 * returns the ack without writing, so a misconfigured sender never crashes the
 * daemon. Only metrics and traces are written today; logs are accepted and
 * silently dropped (no table yet).
 *
 * `handleOtlp` is a plain Effect (no HTTP layer) so the test suite can drive
 * it directly with a stub DB layer. `OtelGroupLive` wires it into the contract
 * via `handleRaw` so each handler can read the raw `ArrayBuffer` body from
 * `HttpServerRequest.arrayBuffer`.
 */
import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AxApi } from "@ax/lib/shared/api-contract";
import { OtelWriter, OtelWriterLive } from "../../otel/writer.ts";
import { decodeLogsPayload, decodeMetricsPayload, decodeTracePayload } from "../../otel/decode.ts";
import { normalizeLogs, normalizeMetrics, normalizeTrace } from "../../otel/normalize.ts";

// ------------------------------------------------------------------ types

type Signal = "metrics" | "traces" | "logs";
const ACK = { partialSuccess: {} } as const;

// ------------------------------------------------------------------ core

/**
 * Process one OTLP signal payload (already buffered as ArrayBuffer).
 * Fails open on parse/decode errors (warn + return ACK, no write).
 * Requires SurrealClient (transitively, via OtelWriterLive).
 */
export const handleOtlp = (
    signal: Signal,
    body: ArrayBuffer,
    contentEncoding: string | undefined,
) =>
    Effect.gen(function* () {
        const bytes = new Uint8Array(body);
        const raw = contentEncoding === "gzip" ? Bun.gunzipSync(bytes) : bytes;

        // Fail-open: catch parse errors without bubbling them up.
        const json: unknown = yield* Effect.sync(() => {
            try {
                return JSON.parse(new TextDecoder().decode(raw)) as unknown;
            } catch {
                return null;
            }
        });
        if (json === null) return ACK;

        const writer = yield* OtelWriter;

        if (signal === "logs") {
            const payload = yield* decodeLogsPayload(json).pipe(Effect.orElseSucceed(() => null));
            if (payload) yield* writer.writeLogs(normalizeLogs(payload));
        } else if (signal === "metrics") {
            const payload = yield* decodeMetricsPayload(json).pipe(
                Effect.orElseSucceed(() => null),
            );
            if (payload) yield* writer.writeMetrics(normalizeMetrics(payload));
        } else {
            const payload = yield* decodeTracePayload(json).pipe(
                Effect.orElseSucceed(() => null),
            );
            if (payload) yield* writer.writeSpans(normalizeTrace(payload));
        }

        return ACK;
    }).pipe(Effect.provide(OtelWriterLive));

// ------------------------------------------------------------------ group

/** Read the Content-Encoding header from a live request. */
const getEncoding = (req: HttpServerRequest.HttpServerRequest): string | undefined => {
    const ce = req.headers["content-encoding"];
    return typeof ce === "string" ? ce : undefined;
};

/** Build a fail-open raw OTLP handler: body read + process errors → ACK. */
const makeRawHandler = (signal: Signal) => () =>
    Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* req.arrayBuffer.pipe(
            Effect.orElseSucceed(() => new ArrayBuffer(0)),
        );
        return yield* handleOtlp(signal, body, getEncoding(req)).pipe(
            Effect.orElseSucceed(() => ACK),
        );
    });

export const OtelGroupLive = HttpApiBuilder.group(AxApi, "otel", (handlers) =>
    handlers
        .handleRaw("otlpMetrics", makeRawHandler("metrics"))
        .handleRaw("otlpTraces", makeRawHandler("traces"))
        .handleRaw("otlpLogs", makeRawHandler("logs")));
