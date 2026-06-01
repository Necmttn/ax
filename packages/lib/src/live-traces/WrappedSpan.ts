/**
 * WrappedSpan — Span decorator that intercepts lifecycle events.
 *
 * Implements the full Tracer.Span interface by delegating to an inner span
 * (OTel or native) while emitting TraceEvents to a TraceSink.
 *
 * Detection: Use `isWrappedSpan(span)` to check if a span is wrapped.
 * The Symbol brand avoids instanceof checks across package boundaries.
 */
import type * as Context from "effect/Context";
import type * as Exit from "effect/Exit";
import type * as Option from "effect/Option";
import type { AnySpan, Span, SpanKind, SpanLink, SpanStatus } from "effect/Tracer";

import type { TraceSinkHandle } from "./Sink.ts";
import type { TraceScope } from "./types.ts";

export const LiveTraceSymbol: unique symbol = Symbol.for("@live-traces/WrappedSpan");

export class WrappedSpan implements Span {
    readonly _tag = "Span" as const;
    readonly [LiveTraceSymbol] = true;

    /** The logical trace ID for routing (e.g., "doc:abc123") */
    readonly liveTraceId: string;

    /** Scope for stream routing */
    readonly liveScope: TraceScope;

    /**
     * Snapshot of inner.status.startTime captured at construction.
     *
     * Both call sites (`LiveTrace.withTrace` and `Tracer.span`) construct
     * WrappedSpan from an inner span that has just been started by the
     * runtime, so `inner.status._tag === "Started"` here. We snapshot
     * `startTime` immediately so `end()` no longer depends on the inner span
     * mutating its own `status` to `Ended` during `inner.end(...)` -- some
     * non-native (e.g. OTel-bridged) spans skip that transition, which used
     * to leave `startTime = 0n` and produce nonsense (~1.7e15 ms) durations.
     */
    private readonly startTimeNs: bigint;

    constructor(
        readonly inner: Span,
        readonly sink: TraceSinkHandle,
        liveTraceId: string,
        liveScope: TraceScope,
    ) {
        this.liveTraceId = liveTraceId;
        this.liveScope = liveScope;
        // Inner span is freshly started here; both variants of SpanStatus
        // expose `startTime`, so this is safe regardless of _tag.
        this.startTimeNs = inner.status.startTime;
    }

    // -- Delegated reads --

    get name(): string {
        return this.inner.name;
    }
    get spanId(): string {
        return this.inner.spanId;
    }
    get traceId(): string {
        return this.inner.traceId;
    }
    get parent(): Option.Option<AnySpan> {
        return this.inner.parent;
    }
    get annotations(): Context.Context<never> {
        return this.inner.annotations;
    }
    get status(): SpanStatus {
        return this.inner.status;
    }
    get attributes(): ReadonlyMap<string, unknown> {
        return this.inner.attributes;
    }
    get links(): ReadonlyArray<SpanLink> {
        return this.inner.links;
    }
    get sampled(): boolean {
        return this.inner.sampled;
    }
    get kind(): SpanKind {
        return this.inner.kind;
    }

    // -- Intercepted mutations --

    attribute(key: string, value: unknown): void {
        this.inner.attribute(key, value);

        // Forward attribute mutations as SpanEvents so they land in the trace stream.
        // In effect@4 the runtime calls span.attribute() AFTER tracer.span() returns
        // for each entry in Effect.withSpan's `attributes` option; bridging here keeps
        // attribute updates visible to downstream consumers.
        this.sink.emit({
            _tag: "SpanEvent",
            traceId: this.liveTraceId,
            spanId: this.spanId,
            name: `attribute:${key}`,
            attributes: { value },
            timestamp: Date.now(),
        });
    }

    event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
        this.inner.event(name, startTime, attributes);

        // Emit as SpanEvent to sink
        const level = attributes?.["effect.logLevel"] as string | undefined;
        this.sink.emit({
            _tag: "SpanEvent",
            traceId: this.liveTraceId,
            spanId: this.spanId,
            name,
            level: normalizeLevel(level),
            attributes,
            timestamp: Date.now(),
        });
    }

    end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
        this.inner.end(endTime, exit);

        // Use the startTime captured at construction (see `startTimeNs` doc).
        // This decouples duration computation from any post-end status
        // mutation on `inner`, which OTel-bridged spans may not perform.
        const durationMs = Number(endTime - this.startTimeNs) / 1_000_000;
        const status = exit._tag === "Success" ? ("ok" as const) : ("error" as const);

        this.sink.emit({
            _tag: "SpanEnd",
            traceId: this.liveTraceId,
            spanId: this.spanId,
            status,
            durationMs,
            timestamp: Date.now(),
        });
    }

    addLinks(links: ReadonlyArray<SpanLink>): void {
        this.inner.addLinks(links);
    }
}

export const isWrappedSpan = (span: AnySpan): span is WrappedSpan => LiveTraceSymbol in span;

function normalizeLevel(level: string | undefined): "Debug" | "Info" | "Warning" | "Error" | undefined {
    if (!level) return undefined;
    switch (level) {
        case "DEBUG":
            return "Debug";
        case "INFO":
            return "Info";
        case "WARNING":
        case "WARN":
            return "Warning";
        case "ERROR":
            return "Error";
        default:
            return undefined;
    }
}
