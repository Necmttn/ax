import { Schema } from "effect";

/** A normalized OTLP metric data point as stored in otel_metric_point. */
export const OtelMetricPointRow = Schema.Struct({
    harness: Schema.String,
    metric: Schema.String,
    value: Schema.Number,
    unit: Schema.NullOr(Schema.String),
    session_id: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    skill_name: Schema.NullOr(Schema.String),
    agent_name: Schema.NullOr(Schema.String),
    attrs: Schema.NullOr(Schema.String),
    observed_at: Schema.Date,
});
export type OtelMetricPointRow = Schema.Schema.Type<typeof OtelMetricPointRow>;

export const OtelSpanRow = Schema.Struct({
    harness: Schema.String,
    name: Schema.String,
    trace_id: Schema.String,
    span_id: Schema.String,
    parent_span_id: Schema.NullOr(Schema.String),
    session_id: Schema.NullOr(Schema.String),
    started_at: Schema.Date,
    ended_at: Schema.Date,
    duration_ms: Schema.Number,
    attrs: Schema.NullOr(Schema.String),
    observed_at: Schema.Date,
});
export type OtelSpanRow = Schema.Schema.Type<typeof OtelSpanRow>;

/** Deterministic id so re-delivered points UPSERT instead of duplicating. */
export const metricPointKey = (r: OtelMetricPointRow): string => {
    const ts = r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at);
    return `${r.harness}|${r.metric}|${r.session_id ?? ""}|${r.model ?? ""}|${r.skill_name ?? ""}|${ts}`;
};

/** Spans carry a globally-unique span_id; use it directly. */
export const spanKey = (r: Pick<OtelSpanRow, "span_id">): string => r.span_id;
