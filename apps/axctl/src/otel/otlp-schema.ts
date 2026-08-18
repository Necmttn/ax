import { Schema } from "effect";

/**
 * An OTLP/JSON int64 field, which arrives as EITHER a JSON string or a JSON
 * number.
 *
 * The proto3 JSON mapping says an int64 is *emitted* as a string, and every
 * field below was originally typed `Schema.String` on that basis. But the
 * mapping also requires a parser to ACCEPT both forms, and real exporters use
 * that latitude: measured against a live Claude Code 2.1.233 export, every
 * `/v1/logs` body carries at least one attribute whose `intValue` is a bare
 * number (`"intValue": 83729`). Typed string-only, the decode failed, the
 * receiver counted the body `malformed`, and `otel_log_event` stayed at ZERO
 * while metrics from the same process landed fine - a whole signal silently
 * dropped, on a receiver that is deliberately fail-open and therefore never
 * complained.
 *
 * Consumers already coerce with `Number(...)`, so widening the type is the whole
 * fix. Precision: a JSON number cannot hold a nanosecond timestamp past 2^53
 * exactly, which is precisely why the spec prefers strings - so a number arm is
 * accepted but never manufactured, and {@link nanoToDate} truncates rather than
 * throwing on one.
 */
export const OtlpInt64 = Schema.Union([Schema.String, Schema.Number]);
export type OtlpInt64 = Schema.Schema.Type<typeof OtlpInt64>;

/** OTLP/JSON AnyValue (only the scalar variants we read). */
export const AnyValue = Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    intValue: Schema.optional(OtlpInt64),        // string OR number - see OtlpInt64
    doubleValue: Schema.optional(Schema.Number),
    boolValue: Schema.optional(Schema.Boolean),
});
export type AnyValue = Schema.Schema.Type<typeof AnyValue>;

export const KeyValue = Schema.Struct({
    key: Schema.String,
    value: Schema.optional(AnyValue),
});
export type KeyValue = Schema.Schema.Type<typeof KeyValue>;

/** Collapse an AnyValue to a JS scalar; intValue parses to number. */
export const attrValueToScalar = (v: AnyValue | undefined): string | number | boolean | null => {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.intValue !== undefined) return Number(v.intValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.boolValue !== undefined) return v.boolValue;
    return null;
};

/** Build a flat attr lookup from a KeyValue list. */
export const attrMap = (kvs: readonly KeyValue[] | undefined): Map<string, string | number | boolean | null> => {
    const m = new Map<string, string | number | boolean | null>();
    for (const kv of kvs ?? []) m.set(kv.key, attrValueToScalar(kv.value));
    return m;
};

const Resource = Schema.Struct({ attributes: Schema.optional(Schema.Array(KeyValue)) });

const NumberDataPoint = Schema.Struct({
    asDouble: Schema.optional(Schema.Number),
    asInt: Schema.optional(OtlpInt64),           // string OR number - see OtlpInt64
    timeUnixNano: Schema.optional(OtlpInt64),
    attributes: Schema.optional(Schema.Array(KeyValue)),
});

const Metric = Schema.Struct({
    name: Schema.String,
    unit: Schema.optional(Schema.String),
    sum: Schema.optional(Schema.Struct({ dataPoints: Schema.optional(Schema.Array(NumberDataPoint)) })),
    gauge: Schema.optional(Schema.Struct({ dataPoints: Schema.optional(Schema.Array(NumberDataPoint)) })),
});

export const MetricsPayload = Schema.Struct({
    resourceMetrics: Schema.Array(Schema.Struct({
        resource: Schema.optional(Resource),
        scopeMetrics: Schema.Array(Schema.Struct({
            metrics: Schema.Array(Metric),
        })),
    })),
});
export type MetricsPayload = Schema.Schema.Type<typeof MetricsPayload>;

const Span = Schema.Struct({
    name: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    parentSpanId: Schema.optional(Schema.String),
    startTimeUnixNano: OtlpInt64,
    endTimeUnixNano: OtlpInt64,
    attributes: Schema.optional(Schema.Array(KeyValue)),
});

export const TracePayload = Schema.Struct({
    resourceSpans: Schema.Array(Schema.Struct({
        resource: Schema.optional(Resource),
        scopeSpans: Schema.Array(Schema.Struct({
            spans: Schema.Array(Span),
        })),
    })),
});
export type TracePayload = Schema.Schema.Type<typeof TracePayload>;

const LogRecord = Schema.Struct({
    timeUnixNano: Schema.optional(OtlpInt64),
    observedTimeUnixNano: Schema.optional(OtlpInt64),
    attributes: Schema.optional(Schema.Array(KeyValue)),
    body: Schema.optional(Schema.Unknown),
});

export const LogsPayload = Schema.Struct({
    resourceLogs: Schema.Array(Schema.Struct({
        resource: Schema.optional(Schema.Struct({ attributes: Schema.optional(Schema.Array(KeyValue)) })),
        scopeLogs: Schema.Array(Schema.Struct({
            logRecords: Schema.Array(LogRecord),
        })),
    })),
});
export type LogsPayload = Schema.Schema.Type<typeof LogsPayload>;

/**
 * OTLP unix-nano -> JS Date, from either JSON form.
 *
 * `BigInt()` throws a SyntaxError on a non-integral number, and an exporter that
 * sends nanos as a number can hand us one, so the number arm is floored before
 * conversion rather than trusted. A bad value yields the epoch, matching the
 * previous `?? "0"` behaviour - this converter is on a fail-open receive path
 * and must not throw.
 */
export const nanoToDate = (nano: OtlpInt64 | undefined): Date => {
    if (nano === undefined) return new Date(0);
    try {
        const asBigInt = typeof nano === "number" ? BigInt(Math.floor(nano)) : BigInt(nano);
        return new Date(Number(asBigInt / 1_000_000n));
    } catch {
        return new Date(0);
    }
};
