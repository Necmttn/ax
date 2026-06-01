import { Effect, Layer } from "effect";
import { encodeJson } from "../../decode.ts";
import { TraceTransportTag, type TraceTransport } from "../Sink.ts";

/**
 * Console transport - writes one JSON line per event to **stderr**.
 *
 * Writes to `process.stderr` (NOT `process.stdout`) so it never corrupts
 * machine-readable stdout streams (e.g. `axctl ingest --progress=json`).
 *
 * Each event is serialized as a single line: `[live-trace] <tag> <json>\n`.
 *
 * Opt-in only: not wired into `AppLayer`. CLI entrypoints add this layer
 * explicitly when the user passes `--debug`. See `src/cli/index.ts`.
 */
export const ConsoleTransport: TraceTransport = {
    send: (events) =>
        Effect.sync(() => {
            for (const event of events) {
                process.stderr.write(`[live-trace] ${event._tag} ${encodeJson(event)}\n`);
            }
        }),
};

export const ConsoleTransportLayer: Layer.Layer<TraceTransportTag> =
    Layer.succeed(TraceTransportTag, ConsoleTransport);

/**
 * Silent default transport - drops all events on the floor.
 *
 * Used by `AppLayer` so `TraceSinkLive` has a TransportTag available
 * without producing any output. Replace by layering
 * `ConsoleTransportLayer` (or another transport) on top of `AppLayer`.
 */
export const NoopTransport: TraceTransport = {
    send: (_events) => Effect.void,
};

export const NoopTransportLayer: Layer.Layer<TraceTransportTag> =
    Layer.succeed(TraceTransportTag, NoopTransport);
