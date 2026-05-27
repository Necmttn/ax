import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import {
    TraceSink,
    TraceSinkLive,
    TraceTransportTag,
    type TraceTransport,
} from "../Sink.ts";
import type { TraceEvent } from "../types.ts";

describe("TraceSink", () => {
    it("buffers events and flushes via daemon", async () => {
        const collected: TraceEvent[] = [];
        const TestTransport: TraceTransport = {
            send: (events) => Effect.sync(() => { for (const e of events) collected.push(e); }),
        };
        const Transport = Layer.succeed(TraceTransportTag, TestTransport);
        const program = Effect.gen(function* () {
            const sink = yield* TraceSink;
            sink.emit({
                _tag: "TraceStart",
                traceId: "t1",
                label: "test",
                scope: { type: "user", id: "u1" },
                timestamp: 0,
            });
            // Wait longer than the flush interval so the daemon fires
            yield* Effect.sleep("250 millis");
        });
        await Effect.runPromise(
            program.pipe(
                Effect.provide(TraceSinkLive({ flushIntervalMs: 200 })),
                Effect.provide(Transport),
                Effect.scoped,
            ) as Effect.Effect<void, never, never>,
        );
        expect(collected).toHaveLength(1);
        expect(collected[0]?._tag).toBe("TraceStart");
    });
});
