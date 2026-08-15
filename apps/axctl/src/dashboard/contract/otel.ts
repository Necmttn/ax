/**
 * OTLP HTTP receiver endpoints: POST /v1/metrics, /v1/traces, /v1/logs.
 *
 * All three signals return `{ partialSuccess: {} }` (the OTLP/HTTP ack).
 * The database-free receiver owns durable spool writes.
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
import type { Signal } from "../../otel/signal.ts";
import { SIGNALS } from "../../otel/signals.ts";
import { appendOtlpSpool, OTLP_ACK } from "../../otel/spool-server.ts";

// ------------------------------------------------------------------ core

/**
 * Process one OTLP signal payload (already buffered as ArrayBuffer).
 * Fails open on parse/decode errors (warn + return ACK, no write).
 * This effect does not acquire a database service.
 */
export const handleOtlp = (
    signal: Signal,
    body: ArrayBuffer,
    contentEncoding: string | undefined,
    opts: { readonly spoolDir?: string; readonly now?: () => Date } = {},
) =>
    Effect.gen(function* () {
        const bytes = new Uint8Array(body);
        const raw = contentEncoding === "gzip" ? Bun.gunzipSync(bytes) : bytes;

        // Fail-open: catch parse errors without bubbling them up.
        const text = new TextDecoder().decode(raw);
        yield* appendOtlpSpool(`/v1/${signal}`, text, opts).pipe(Effect.ignore);
        const json: unknown = yield* Effect.sync(() => {
            try {
                return JSON.parse(text) as unknown;
            } catch {
                return null;
            }
        });
        if (json === null) return OTLP_ACK;

        const spec = SIGNALS[signal];

        // Fail-open at the dispatch SEAM: the typed `OtelDecodeError` is swallowed
        // to null HERE (never inside decode), so all three signals swallow in
        // exactly one place. A decoded payload normalizes + writes per the spec.
        const payload = yield* spec.decode(json).pipe(Effect.orElseSucceed(() => null));
        if (payload !== null) spec.normalize(payload);

        return OTLP_ACK;
    });

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
            Effect.orElseSucceed(() => OTLP_ACK),
        );
    });

export const OtelGroupLive = HttpApiBuilder.group(AxApi, "otel", (handlers) =>
    handlers
        .handleRaw("otlpMetrics", makeRawHandler("metrics"))
        .handleRaw("otlpTraces", makeRawHandler("traces"))
        .handleRaw("otlpLogs", makeRawHandler("logs")));
