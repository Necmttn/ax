/**
 * Effect Schema wrappers for TraceEvent types.
 *
 * Used for runtime NDJSON validation. Optional - consumers
 * can use plain types from "./types" if they don't need validation.
 */
import * as Schema from "effect/Schema";

// ============================================================================
// Scope
// ============================================================================

export const TraceScopeSchema = Schema.Struct({
    type: Schema.Union([Schema.Literal("team"), Schema.Literal("org"), Schema.Literal("user")]),
    id: Schema.String,
});

// ============================================================================
// Events
// ============================================================================

export const TraceStartSchema = Schema.Struct({
    _tag: Schema.Literal("TraceStart"),
    traceId: Schema.String,
    label: Schema.String,
    scope: TraceScopeSchema,
    timestamp: Schema.Number,
});

export const SpanStartSchema = Schema.Struct({
    _tag: Schema.Literal("SpanStart"),
    traceId: Schema.String,
    spanId: Schema.String,
    parentSpanId: Schema.optional(Schema.String),
    name: Schema.String,
    attributes: Schema.Record(Schema.String, Schema.Unknown),
    timestamp: Schema.Number,
});

export const SpanEndSchema = Schema.Struct({
    _tag: Schema.Literal("SpanEnd"),
    traceId: Schema.String,
    spanId: Schema.String,
    status: Schema.Union([Schema.Literal("ok"), Schema.Literal("error")]),
    durationMs: Schema.Number,
    timestamp: Schema.Number,
});

export const SpanEventSchema = Schema.Struct({
    _tag: Schema.Literal("SpanEvent"),
    traceId: Schema.String,
    spanId: Schema.String,
    name: Schema.String,
    level: Schema.optional(Schema.Union([Schema.Literal("Debug"), Schema.Literal("Info"), Schema.Literal("Warning"), Schema.Literal("Error")])),
    attributes: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    timestamp: Schema.Number,
});

export const TraceEndSchema = Schema.Struct({
    _tag: Schema.Literal("TraceEnd"),
    traceId: Schema.String,
    status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed")]),
    durationMs: Schema.Number,
    error: Schema.optional(Schema.String),
    timestamp: Schema.Number,
});

export const TraceEventSchema = Schema.Union([TraceStartSchema, SpanStartSchema, SpanEndSchema, SpanEventSchema, TraceEndSchema]);

export type TraceEventEncoded = Schema.Codec.Encoded<typeof TraceEventSchema>;
