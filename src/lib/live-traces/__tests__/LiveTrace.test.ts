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
});
