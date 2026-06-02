import { Effect, Layer } from "effect";
import { TraceTransportTag, type TraceTransport } from "@ax/lib/live-traces/Sink";
import { createProgressReporter, type ProgressReporter, type ProgressStage } from "./progress.ts";

/**
 * Live-trace transport that renders the ingest span pipeline as the animated
 * `PipelineProgress` (spinner + per-stage rows + rows/speed/eta), instead of
 * dropping events (Noop) or dumping JSON (ConsoleTransport / --debug).
 *
 * Each ingest stage runs inside `LiveTrace.step(stageKey)`, so we get a
 * `SpanStart`/`SpanEnd` per stage. We translate those into the
 * `ProgressReporter` lifecycle (start → finish/fail) and let PipelineProgress
 * own the terminal rendering. Output goes to **stderr**, so machine-readable
 * stdout (e.g. `--progress=json` consumers) stays clean.
 *
 * Wired in by `withIngest` only for interactive terminals; piped/CI runs keep
 * the silent Noop transport. PipelineProgress auto-adds stage rows as their
 * spans start, so we don't need the stage list up front.
 */
export const PipelineTraceTransportLayer: Layer.Layer<TraceTransportTag> = Layer.sync(
    TraceTransportTag,
    () => {
        let progress: ProgressReporter | null = null;
        const spanNames = new Map<string, string>();
        const stageOf = (name: string): ProgressStage => ({ source: "ingest", stage: name });

        const transport: TraceTransport = {
            send: (events) =>
                Effect.sync(() => {
                    for (const event of events) {
                        switch (event._tag) {
                            case "TraceStart": {
                                progress = createProgressReporter({
                                    command: "ingest",
                                    runId: event.traceId.replace(/^ingest:/, ""),
                                    mode: "pipeline",
                                    // PipelineProgress auto-adds a row per stage as
                                    // its span starts (stateFor), so start empty.
                                    stages: [],
                                });
                                break;
                            }
                            case "SpanStart": {
                                // Skip the trace root span (no parent): its name is the
                                // whole run label (every stage key joined), which wraps
                                // the terminal and corrupts the in-place animation. Only
                                // render actual per-stage spans.
                                if (!event.parentSpanId) break;
                                spanNames.set(event.spanId, event.name);
                                progress?.start(stageOf(event.name));
                                break;
                            }
                            case "SpanEnd": {
                                // Only stage spans were recorded in spanNames; an unknown
                                // spanId here is the root span (or already cleared) - skip.
                                const name = spanNames.get(event.spanId);
                                if (name === undefined) break;
                                spanNames.delete(event.spanId);
                                if (event.status === "error") progress?.fail(stageOf(name), "failed");
                                else progress?.finish(stageOf(name), {});
                                break;
                            }
                            case "TraceEnd": {
                                progress?.stop();
                                progress = null;
                                spanNames.clear();
                                break;
                            }
                            default:
                                break;
                        }
                    }
                }),
        };

        return transport;
    },
);
