import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { LiveTrace } from "../index.ts";
import { LiveTraceLayer } from "../Tracer.ts";
import {
    TraceSinkLive,
    TraceTransportTag,
    type TraceTransport,
} from "../Sink.ts";
import type { TraceEvent } from "../types.ts";

describe("LiveTrace.withTrace", () => {
    it("emits TraceStart/SpanStart/SpanEnd/TraceEnd through the tracer", async () => {
        const events: TraceEvent[] = [];
        const Transport: TraceTransport = {
            send: (batch) => Effect.sync(() => { for (const e of batch) events.push(e); }),
        };
        const TransportLayer = Layer.succeed(TraceTransportTag, Transport);
        const Sink = TraceSinkLive({ flushIntervalMs: 10 }).pipe(Layer.provide(TransportLayer));
        // Sink must be visible to BOTH withTrace (in user code) and LiveTraceLayer.
        // Merge them so both surfaces see the same TraceSink instance.
        const TraceLayer = Layer.mergeAll(Sink, LiveTraceLayer.pipe(Layer.provide(Sink)));
        const program = Effect.succeed(42).pipe(
            LiveTrace.withTrace({
                traceId: "test:1",
                label: "smoke",
                scope: { type: "user", id: "u1" },
            }),
            Effect.delay("30 millis"),
        );
        await Effect.runPromise(
            program.pipe(
                Effect.provide(TraceLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown, never, never>,
        );
        const tags = events.map((e) => e._tag);
        expect(tags).toContain("TraceStart");
        expect(tags).toContain("SpanStart");
        expect(tags).toContain("SpanEnd");
        expect(tags).toContain("TraceEnd");
    });

    it("emits child SpanStart/SpanEnd for step() calls inside withTrace", async () => {
        const events: TraceEvent[] = [];
        const Transport: TraceTransport = {
            send: (batch) =>
                Effect.sync(() => {
                    for (const e of batch) events.push(e);
                }),
        };
        const TransportLayer = Layer.succeed(TraceTransportTag, Transport);
        const Sink = TraceSinkLive({ flushIntervalMs: 10 }).pipe(Layer.provide(TransportLayer));
        const TraceLayer = Layer.mergeAll(Sink, LiveTraceLayer.pipe(Layer.provide(Sink)));

        const program = Effect.succeed(42).pipe(
            LiveTrace.step("Parsing"),
            LiveTrace.withTrace({
                traceId: "test:step",
                label: "smoke-with-step",
                scope: { type: "user", id: "u1" },
            }),
            Effect.delay("30 millis"),
        );

        await Effect.runPromise(
            program.pipe(
                Effect.provide(TraceLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown, never, never>,
        );

        // Locate root SpanStart (the one with no parentSpanId; emitted by withTrace itself).
        const spanStarts = events.filter((e): e is Extract<TraceEvent, { _tag: "SpanStart" }> => e._tag === "SpanStart");
        const rootStart = spanStarts.find((e) => e.parentSpanId === undefined);
        expect(rootStart).toBeDefined();

        // There MUST be a child SpanStart for the step, parented to the root.
        const childStart = spanStarts.find((e) => e.name === "Parsing");
        expect(childStart).toBeDefined();
        expect(childStart?.parentSpanId).toBe(rootStart!.spanId);
        expect(childStart?.spanId).not.toBe(rootStart!.spanId);

        // There MUST be a matching SpanEnd for the child span (distinct from root SpanEnd).
        const spanEnds = events.filter((e): e is Extract<TraceEvent, { _tag: "SpanEnd" }> => e._tag === "SpanEnd");
        const childEnd = spanEnds.find((e) => e.spanId === childStart!.spanId);
        expect(childEnd).toBeDefined();
        expect(childEnd?.status).toBe("ok");
    });
});
