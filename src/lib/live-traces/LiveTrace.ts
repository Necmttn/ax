import type { AnySpan } from "effect/Tracer";

/**
 * LiveTrace - User-facing API for starting traced scopes.
 *
 * Usage:
 * ```ts
 * yield* pipe(
 *   myWorkflow,
 *   LiveTrace.withTrace({
 *     traceId: `doc:${documentId}`,
 *     label: "Processing report.pdf",
 *     scope: { type: "team", id: teamId },
 *   }),
 * )
 * ```
 *
 * Inside the scope, all `Effect.withSpan` and `Effect.log` calls
 * are automatically captured and streamed to the frontend.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { TraceSink } from "./Sink.ts";
import {
    LIVE_TRACE,
    LIVE_TRACE_ID,
    LIVE_TRACE_LABEL,
    LIVE_TRACE_PROVIDER,
    LIVE_TRACE_SCOPE_ID,
    LIVE_TRACE_SCOPE_TYPE,
    type TraceScope,
    UI_STEP,
} from "./types.ts";
import { WrappedSpan } from "./WrappedSpan.ts";

export interface LiveTraceConfig {
    /** Logical trace ID for stream routing (e.g., "doc:abc123") */
    readonly traceId: string;
    /** Human-readable label (e.g., filename) */
    readonly label: string;
    /** Stream routing scope */
    readonly scope: TraceScope;
    /** Optional provider key for source-page filtering (e.g. "notion", "google-drive") */
    readonly provider?: string;
}

/**
 * Context.Reference that holds the current WrappedSpan (if inside a withTrace/step scope).
 * Used by LiveTraceLogger to bridge Effect.log() → SpanEvent automatically.
 * Inherited by child fibers so forked work stays attributed to the correct span.
 *
 * Ported from `FiberRef` (effect v3) → `Context.Reference` (effect v4 beta).
 */
export const LiveSpanRef: Context.Reference<AnySpan | null> = Context.Reference<AnySpan | null>(
    "@live-traces/LiveSpanRef",
    { defaultValue: () => null },
);

/**
 * Wrap an effect in a live-traced scope.
 *
 * Emits TraceStart + root SpanStart immediately, stashes the wrapped root span
 * in `LiveSpanRef` so child spans (created via `Effect.withSpan` or `step`)
 * are detected by `LiveTraceLayer`, and emits SpanEnd + TraceEnd on completion.
 *
 * NOTE: Ported for effect@4.0.0-beta.64. In v4 the runtime calls `span.attribute()`
 * AFTER `tracer.span()` returns, so the tracer decorator can no longer read the
 * `LIVE_TRACE` marker synchronously. Root detection now lives here (Option A
 * from the refactor design notes).
 */
export const withTrace =
    (config: LiveTraceConfig) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | TraceSink> =>
        Effect.withSpan(
            Effect.gen(function* () {
                const innerSpan = yield* Effect.currentSpan;
                const sink = yield* TraceSink;
                const startedAt = Date.now();

                // Emit TraceStart immediately
                sink.emit({
                    _tag: "TraceStart",
                    traceId: config.traceId,
                    label: config.label,
                    scope: config.scope,
                    timestamp: startedAt,
                });

                // Wrap the root span and stash it in LiveSpanRef so children find it
                const wrapped = new WrappedSpan(innerSpan, sink, config.traceId, config.scope);
                sink.emit({
                    _tag: "SpanStart",
                    traceId: config.traceId,
                    spanId: innerSpan.spanId,
                    name: innerSpan.name,
                    attributes: { ...Object.fromEntries(innerSpan.attributes) },
                    timestamp: startedAt,
                });

                return yield* effect.pipe(
                    Effect.provideService(LiveSpanRef, wrapped),
                    Effect.onExit((exit) =>
                        Effect.sync(() => {
                            const durationMs = Date.now() - startedAt;
                            sink.emit({
                                _tag: "SpanEnd",
                                traceId: config.traceId,
                                spanId: innerSpan.spanId,
                                status: exit._tag === "Success" ? "ok" : "error",
                                durationMs,
                                timestamp: Date.now(),
                            });
                            sink.emit({
                                _tag: "TraceEnd",
                                traceId: config.traceId,
                                status: exit._tag === "Success" ? "completed" : "failed",
                                durationMs,
                                error: exit._tag === "Failure" ? String(exit.cause) : undefined,
                                timestamp: Date.now(),
                            });
                        }),
                    ),
                );
            }),
            config.label,
            {
                attributes: {
                    [LIVE_TRACE]: true,
                    [LIVE_TRACE_ID]: config.traceId,
                    [LIVE_TRACE_LABEL]: config.label,
                    [LIVE_TRACE_SCOPE_TYPE]: config.scope.type,
                    [LIVE_TRACE_SCOPE_ID]: config.scope.id,
                    ...(config.provider !== undefined ? { [LIVE_TRACE_PROVIDER]: config.provider } : {}),
                },
            },
        ) as Effect.Effect<A, E, R | TraceSink>;

/**
 * Create a traced step span. Shows as a top-level section in the UI.
 *
 * The tracer decorator (LiveTraceLayer) detects that the parent span is a
 * WrappedSpan and wraps this child automatically, emitting SpanStart/SpanEnd.
 *
 * NOTE: Effect's runtime uses the unwrapped inner span (from `Effect.currentSpan`)
 * as the parent of new child spans by default, so `LiveTraceLayer`'s
 * `isWrappedSpan(parent)` check would miss children of a `withTrace` root. To
 * fix this we read the WrappedSpan stashed in `LiveSpanRef` and pin it as the
 * parent via `Effect.withParentSpan` before delegating to `Effect.withSpan`.
 *
 * ```ts
 * yield* LiveTrace.step("Parsing")(parseDocument(doc))
 * yield* LiveTrace.step("Embedding")(embedChunks(chunks))
 * ```
 */
export const step =
    (name: string, attributes?: Record<string, unknown>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
            const parent = yield* LiveSpanRef;
            // When no live trace is active, fall through to bare withSpan.
            if (parent === null) {
                return yield* Effect.withSpan(effect, name, {
                    attributes: { [UI_STEP]: true, ...attributes },
                });
            }
            // Re-stash the (wrapped) current span as the new LiveSpanRef so any
            // nested step() calls parent to *this* step rather than skipping
            // straight back to the trace root. `currentSpan` is guaranteed to
            // succeed because we're inside `Effect.withSpan`; `orDie` keeps the
            // error channel clean (would only fail as a defect on misuse).
            const inner = Effect.gen(function* () {
                const current = yield* Effect.orDie(Effect.currentSpan);
                return yield* Effect.provideService(effect, LiveSpanRef, current);
            });
            const spanned = Effect.withSpan(inner, name, {
                attributes: { [UI_STEP]: true, ...attributes },
            });
            return yield* Effect.withParentSpan(spanned, parent);
        });
