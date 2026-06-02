import { Effect, Layer } from "effect";
import { TraceTransportTag, type TraceTransport } from "@ax/lib/live-traces/Sink";
import { createProgressReporter, type ProgressMode, type ProgressReporter, type ProgressStage } from "./progress.ts";
import { initTuiProgress, type TuiProgressHandle } from "./progress-tui.tsx";

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
export const pipelineTraceTransportLayer = (
    mode: ProgressMode = "pipeline",
): Layer.Layer<TraceTransportTag> => Layer.sync(
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
                                    mode,
                                    // PipelineProgress/PlainProgress auto-add a row per
                                    // stage as its span starts, so start empty.
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

/**
 * Live-trace transport rendering the ingest pipeline through the OpenTUI + React
 * renderer (`initTuiProgress`) - a pinned split-footer board that repaints in
 * place without corrupting scrollback. Interactive-TTY only.
 *
 * `initTuiProgress` is async (it spins up an OpenTUI renderer), but the trace
 * transport's `send` is synchronous, so we buffer reporter calls until the
 * handle is ready, then flush them. The renderer is torn down in a scope
 * finalizer when the ingest run's scope closes. `stages` is passed up front so
 * the fixed-height footer is sized for the run's stage count.
 */
export const tuiTraceTransportLayer = (
    stages: readonly ProgressStage[],
): Layer.Layer<TraceTransportTag> =>
    Layer.effect(TraceTransportTag)(
        Effect.gen(function* () {
            const state = {
                handle: null as TuiProgressHandle | null,
                started: false,
                cancelled: false,
            };
            const spanNames = new Map<string, string>();
            const queue: Array<(r: ProgressReporter) => void> = [];
            const apply = (fn: (r: ProgressReporter) => void): void => {
                if (state.handle) fn(state.handle.progress);
                else queue.push(fn);
            };

            // Tear down the renderer when the ingest scope closes. Also covers the
            // race where the run finishes before init resolves (cancelled flag).
            yield* Effect.addFinalizer(() =>
                Effect.promise(async () => {
                    state.cancelled = true;
                    if (state.handle) {
                        try {
                            state.handle.progress.stop();
                            await state.handle.teardown();
                        } catch {
                            /* terminal cleanup best-effort */
                        }
                        state.handle = null;
                    }
                })
            );

            const stageOf = (name: string): ProgressStage => ({ source: "ingest", stage: name });

            const transport: TraceTransport = {
                send: (events) =>
                    Effect.sync(() => {
                        for (const event of events) {
                            switch (event._tag) {
                                case "TraceStart": {
                                    if (state.started) break;
                                    state.started = true;
                                    void initTuiProgress({
                                        command: "ingest",
                                        runId: event.traceId.replace(/^ingest:/, ""),
                                        stages,
                                    })
                                        .then((handle) => {
                                            // Scope already closed while we were initializing:
                                            // tear the fresh renderer straight back down.
                                            if (state.cancelled) {
                                                void handle.teardown();
                                                return;
                                            }
                                            state.handle = handle;
                                            for (const fn of queue) fn(handle.progress);
                                            queue.length = 0;
                                        })
                                        .catch(() => {
                                            /* OpenTUI failed to init - render nothing rather than crash */
                                        });
                                    break;
                                }
                                case "SpanStart": {
                                    if (!event.parentSpanId) break;
                                    spanNames.set(event.spanId, event.name);
                                    apply((r) => r.start(stageOf(event.name)));
                                    break;
                                }
                                case "SpanEnd": {
                                    const name = spanNames.get(event.spanId);
                                    if (name === undefined) break;
                                    spanNames.delete(event.spanId);
                                    if (event.status === "error") apply((r) => r.fail(stageOf(name), "failed"));
                                    else apply((r) => r.finish(stageOf(name), {}));
                                    break;
                                }
                                case "TraceEnd": {
                                    apply((r) => r.stop());
                                    break;
                                }
                                default:
                                    break;
                            }
                        }
                    }),
            };

            return transport;
        })
    );
