/**
 * LiveTraceLayer - Effect Tracer decorator.
 *
 * Wraps whatever base tracer is in the current context (native or OTel).
 * Intercepts span creation within `LiveTrace.withTrace()` scopes
 * and emits TraceEvents to a TraceSink.
 *
 * - Works standalone (no @effect/opentelemetry needed)
 * - Works alongside OTel (wraps the OTel tracer, both systems run)
 *
 * Ported for effect@4.0.0-beta.64:
 * - `Tracer.span(name, parent, ...)` (positional) → `tracer.span({ options })`
 * - `Layer.unwrapEffect` → `Layer.unwrap`
 * - `Effect.tracerWith(Effect.succeed)` → `Effect.tracer`
 * - `Layer.setTracer(t)` → `Layer.succeed(Tracer.Tracer, t)`
 *
 * Root-span emission (TraceStart + root SpanStart + SpanEnd + TraceEnd) lives
 * in `LiveTrace.withTrace` itself now - the v4 `tracer.span` callback has no
 * `attributes` field, so the LIVE_TRACE marker cannot be detected synchronously
 * during span creation. This layer only wraps **children** of an already-wrapped
 * parent.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { TraceSink } from "./Sink.ts";
import { isWrappedSpan, WrappedSpan } from "./WrappedSpan.ts";

/**
 * Creates a LiveTraceLayer that wraps the current tracer.
 *
 * @example
 * ```ts
 * const EnvLayer = ServerLive.pipe(
 *   Layer.provideMerge(ServicesLayer),
 *   Layer.provideMerge(LiveTraceLayer),
 *   Layer.provideMerge(TelemetryLive),
 * )
 * ```
 */
export const LiveTraceLayer: Layer.Layer<never, never, TraceSink> = Layer.unwrap(
    Effect.gen(function* () {
        const baseTracer = yield* Effect.tracer;
        const sink = yield* TraceSink;

        const wrappedTracer: Tracer.Tracer = {
            span(options) {
                const innerSpan = baseTracer.span(options);

                // If the parent is a WrappedSpan, wrap this child too and emit SpanStart.
                if (Option.isSome(options.parent) && isWrappedSpan(options.parent.value)) {
                    const parentWrapped = options.parent.value;
                    const wrapped = new WrappedSpan(
                        innerSpan,
                        sink,
                        parentWrapped.liveTraceId,
                        parentWrapped.liveScope,
                    );
                    sink.emit({
                        _tag: "SpanStart",
                        traceId: parentWrapped.liveTraceId,
                        spanId: innerSpan.spanId,
                        parentSpanId: parentWrapped.spanId,
                        name: options.name,
                        attributes: {},
                        timestamp: Date.now(),
                    });
                    return wrapped;
                }

                // Not inside a traced scope - pass through unchanged
                return innerSpan;
            },
            context: baseTracer.context,
        };

        return Layer.succeed(Tracer.Tracer, wrappedTracer);
    }),
);
