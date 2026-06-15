import { Effect, Schema } from "effect";
import { MetricsPayload, TracePayload, LogsPayload } from "./otlp-schema.ts";

export class OtelDecodeError extends Schema.TaggedErrorClass<OtelDecodeError>(
    "OtelDecodeError",
)("OtelDecodeError", {
    signal: Schema.String,
    message: Schema.String,
}) {}

export const decodeMetricsPayload = (json: unknown) =>
    Schema.decodeUnknownEffect(MetricsPayload)(json).pipe(
        Effect.mapError((e) => new OtelDecodeError({ signal: "metrics", message: String(e) })),
    );

export const decodeTracePayload = (json: unknown) =>
    Schema.decodeUnknownEffect(TracePayload)(json).pipe(
        Effect.mapError((e) => new OtelDecodeError({ signal: "traces", message: String(e) })),
    );

export const decodeLogsPayload = (json: unknown) =>
    Schema.decodeUnknownEffect(LogsPayload)(json).pipe(
        Effect.mapError((e) => new OtelDecodeError({ signal: "logs", message: String(e) })),
    );
