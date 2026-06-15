import { Schema } from "effect";

/** OTLP/JSON AnyValue (only the scalar variants we read). */
export const AnyValue = Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    intValue: Schema.optional(Schema.String),    // proto3 JSON: int64 as string
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
    asInt: Schema.optional(Schema.String),       // proto3 JSON int64 as string
    timeUnixNano: Schema.optional(Schema.String),
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
    startTimeUnixNano: Schema.String,
    endTimeUnixNano: Schema.String,
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

/** nano-string -> JS Date. */
export const nanoToDate = (nano: string | undefined): Date =>
    new Date(Number(BigInt(nano ?? "0") / 1_000_000n));
