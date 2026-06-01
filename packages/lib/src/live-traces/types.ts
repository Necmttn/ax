/**
 * effect-live-traces — Wire Format Types
 *
 * Plain TypeScript types with zero dependencies.
 * Any backend (Go, Python, Rust, Node) can emit these as JSON
 * and the React frontend will render them.
 *
 * Import from "effect-live-traces/types" — no Effect required.
 */

// ============================================================================
// Scope — routing target for trace events
// ============================================================================

export interface TraceScope {
    readonly type: "team" | "org" | "user";
    readonly id: string;
}

// ============================================================================
// Trace Events — discriminated union on _tag
// ============================================================================

export interface TraceStart {
    readonly _tag: "TraceStart";
    readonly traceId: string;
    readonly label: string;
    readonly scope: TraceScope;
    readonly timestamp: number;
}

export interface SpanStart {
    readonly _tag: "SpanStart";
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId?: string | undefined;
    readonly name: string;
    readonly attributes: Record<string, unknown>;
    readonly timestamp: number;
}

export interface SpanEnd {
    readonly _tag: "SpanEnd";
    readonly traceId: string;
    readonly spanId: string;
    readonly status: "ok" | "error";
    readonly durationMs: number;
    readonly timestamp: number;
}

export interface SpanEvent {
    readonly _tag: "SpanEvent";
    readonly traceId: string;
    readonly spanId: string;
    readonly name: string;
    readonly level?: "Debug" | "Info" | "Warning" | "Error" | undefined;
    readonly attributes?: Record<string, unknown> | undefined;
    readonly timestamp: number;
}

export interface TraceEnd {
    readonly _tag: "TraceEnd";
    readonly traceId: string;
    readonly status: "completed" | "failed";
    readonly durationMs: number;
    readonly error?: string | undefined;
    readonly timestamp: number;
}

export type TraceEvent = TraceStart | SpanStart | SpanEnd | SpanEvent | TraceEnd;

// ============================================================================
// Factory helpers — plain functions, no Effect import
// ============================================================================

export const traceStart = (traceId: string, label: string, scope: TraceScope): TraceStart => ({
    _tag: "TraceStart",
    traceId,
    label,
    scope,
    timestamp: Date.now(),
});

export const spanStart = (
    traceId: string,
    spanId: string,
    name: string,
    attributes: Record<string, unknown> = {},
    parentSpanId?: string,
): SpanStart => ({
    _tag: "SpanStart",
    traceId,
    spanId,
    parentSpanId,
    name,
    attributes,
    timestamp: Date.now(),
});

export const spanEnd = (traceId: string, spanId: string, status: "ok" | "error", durationMs: number): SpanEnd => ({
    _tag: "SpanEnd",
    traceId,
    spanId,
    status,
    durationMs,
    timestamp: Date.now(),
});

export const spanEvent = (
    traceId: string,
    spanId: string,
    name: string,
    level?: "Debug" | "Info" | "Warning" | "Error",
    attributes?: Record<string, unknown>,
): SpanEvent => ({
    _tag: "SpanEvent",
    traceId,
    spanId,
    name,
    level,
    attributes,
    timestamp: Date.now(),
});

export const traceEnd = (traceId: string, status: "completed" | "failed", durationMs: number, error?: string): TraceEnd => ({
    _tag: "TraceEnd",
    traceId,
    status,
    durationMs,
    error,
    timestamp: Date.now(),
});

// ============================================================================
// Attribute constants — use with Effect.withSpan
// ============================================================================

/** Mark a span as a user-visible step in the trace UI */
export const UI_STEP = "ui.step" as const;

/** Mark a span as internal (excluded from live trace capture) */
export const TRACE_INTERNAL = "trace.internal" as const;

/** Root marker — set automatically by LiveTrace.withTrace() */
export const LIVE_TRACE = "live-trace" as const;
export const LIVE_TRACE_ID = "live-trace.id" as const;
export const LIVE_TRACE_LABEL = "live-trace.label" as const;
export const LIVE_TRACE_SCOPE_TYPE = "live-trace.scope.type" as const;
export const LIVE_TRACE_SCOPE_ID = "live-trace.scope.id" as const;
/** Optional provider key for source/integration filtering (e.g. "notion", "google-drive") */
export const LIVE_TRACE_PROVIDER = "live-trace.provider" as const;
