import { Schema } from "effect";
import { stableId } from "@ax/lib/stable-id";

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

/**
 * Natural key for a metric data point (#1011 fix).
 *
 * MUST include every dimension that distinguishes two OTLP data points, not
 * just the typed columns - `agent_name`, and anything ELSE a data point
 * carries (`type`, `query_source`, an MCP server name, ...), lives in `attrs`
 * (normalize.ts writes it CANONICALIZED - sorted keys - specifically so it
 * can be folded in here without wire-order false positives). The prior key
 * omitted `attrs` and `agent_name` entirely, so distinct points (differing
 * only in a dimension outside the 5 typed columns) collapsed onto one id -
 * ~600-740 collapsed rows per warm ingest, pure wasted UPSERT work.
 *
 * `value` is deliberately EXCLUDED: it is the measurement, not the point's
 * identity, so a corrected value for the same point still overwrites
 * (last-write-win) instead of minting a new row.
 */
export const metricPointKey = (r: OtelMetricPointRow): string => {
    const ts = r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at);
    return [
        r.harness,
        r.metric,
        r.session_id ?? "",
        r.model ?? "",
        r.skill_name ?? "",
        r.agent_name ?? "",
        r.attrs ?? "",
        ts,
    ].join("|");
};

/**
 * Row id: the natural key above, SHA-256-hashed via `stableId` (never
 * `Bun.hash` - see stable-id.ts - so ids stay stable across a bun upgrade).
 * The raw key is never stored verbatim as the id: `attrs` can be arbitrarily
 * large and can itself contain `|`, so hashing is what keeps the id both
 * bounded and collision-safe rather than relying on an unescaped separator.
 */
export const metricPointRowId = (r: OtelMetricPointRow): string =>
    stableId("otel_metric_point", [metricPointKey(r)]);

/** Spans carry a globally-unique span_id; use it directly. */
export const spanKey = (r: Pick<OtelSpanRow, "span_id">): string => r.span_id;

export const OtelLogEventRow = Schema.Struct({
    harness: Schema.String,
    event_name: Schema.String,
    session_id: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    input_tokens: Schema.NullOr(Schema.Number),
    output_tokens: Schema.NullOr(Schema.Number),
    reasoning_tokens: Schema.NullOr(Schema.Number),
    cached_tokens: Schema.NullOr(Schema.Number),
    tool_tokens: Schema.NullOr(Schema.Number),
    duration_ms: Schema.NullOr(Schema.Number),
    status_code: Schema.NullOr(Schema.Number),
    attrs: Schema.NullOr(Schema.String),
    observed_at: Schema.Date,
});
export type OtelLogEventRow = Schema.Schema.Type<typeof OtelLogEventRow>;

/**
 * Deterministic id. Log events repeat by name within a session/second, so the
 * per-payload record `index` is folded in to keep distinct events distinct
 * (idempotent across re-delivery of the SAME payload).
 */
export const logEventKey = (r: OtelLogEventRow, index: number): string => {
    const ts = r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at);
    return `${r.harness}|${r.event_name}|${r.session_id ?? ""}|${ts}|${index}`;
};
