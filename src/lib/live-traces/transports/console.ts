import { Effect, Layer } from "effect";
import { TraceTransportTag, type TraceTransport } from "../Sink.ts";

export const ConsoleTransport: TraceTransport = {
    send: (events) =>
        Effect.sync(() => {
            for (const event of events) {
                console.log(`[live-trace] ${event._tag}`, JSON.stringify(event));
            }
        }),
};

export const ConsoleTransportLayer: Layer.Layer<TraceTransportTag> =
    Layer.succeed(TraceTransportTag, ConsoleTransport);
