import { useEffect, useReducer } from "react";
import { stream, type StreamResponse } from "@durable-streams/client";
import { Option } from "effect";
import {
    decodeIngestStreamEventOption,
    type IngestFileFailure,
    type IngestStreamEvent,
} from "@ax/lib/shared/ingest-stream-events";

/**
 * Live ingest view over Durable Streams.
 *
 * `useIngestStream(streamUrl)` subscribes to the FULL Durable Streams sidecar
 * URL returned by `POST /api/ingest` and folds the newline/JSON
 * `IngestStreamEvent` objects into a small, render-friendly state machine.
 *
 * Refresh-rehydrate: we subscribe with the DEFAULT offset ("-1" = replay from
 * the start of the stream), so on mount/refresh the full history replays
 * (stages that already finished show as done) and live deltas continue after.
 * The fold is idempotent, so replaying a finished stage is a no-op. We persist
 * the latest offset (alongside the stream URL) only as a checkpoint hint; we
 * deliberately do NOT resume from a saved mid-offset for the rehydrate case,
 * because that would miss earlier history on refresh.
 */

export type StageStatus = "running" | "ok" | "error";
export type RunStatus = "running" | "completed" | "failed";

/** Live per-stage metering folded from `stage_progress` events. */
export interface StageProgress {
    readonly current: number;
    readonly total: number;
    readonly ratePerSec: number;
    readonly etaLeftMs: number | null;
}

/** Per-stage skipped-file state folded from `stage_file_failures` events.
 *  Each event carries the cumulative snapshot, so the latest one wins -
 *  `failures` is the capped detail list (25), `total` the uncapped count. */
export interface StageFileFailures {
    readonly total: number;
    readonly failures: ReadonlyArray<IngestFileFailure>;
}

export interface IngestStreamState {
    readonly stages: Record<string, StageStatus>;
    /** Per-stage live progress (current/total/rate/eta), keyed by stage name. */
    readonly progress: Record<string, StageProgress>;
    /** Per-stage skipped-file failures, keyed by stage name. Empty on a clean run. */
    readonly fileFailures: Record<string, StageFileFailures>;
    readonly order: ReadonlyArray<string>;
    readonly finished: boolean;
    readonly runStatus: RunStatus;
    readonly label?: string;
    /** Last delivered Durable Streams offset (checkpoint hint, persisted). */
    readonly offset?: string;
    /** Surfaced when the subscription fails (e.g. stale URL after a serve
     *  restart). The view can show this without crashing. */
    readonly error?: string;
}

const IDLE: IngestStreamState = {
    stages: {},
    progress: {},
    fileFailures: {},
    order: [],
    finished: false,
    runStatus: "running",
};

type Action =
    | { readonly type: "reset" }
    | { readonly type: "event"; readonly event: IngestStreamEvent; readonly offset?: string }
    | { readonly type: "error"; readonly message: string };

export interface DecodedStreamItems {
    readonly events: ReadonlyArray<IngestStreamEvent>;
    readonly invalidCount: number;
}

export function decodeStreamItems(items: ReadonlyArray<unknown>): DecodedStreamItems {
    const events: IngestStreamEvent[] = [];
    let invalidCount = 0;
    for (const item of items) {
        Option.match(decodeIngestStreamEventOption(item), {
            onSome: (event) => {
                events.push(event);
            },
            onNone: () => {
                invalidCount += 1;
            },
        });
    }
    return { events, invalidCount };
}

/** Fold one ingest event into state. Idempotent: re-applying a finished stage
 *  (or a duplicate run_started) leaves state unchanged. Exported for tests. */
export function applyEvent(state: IngestStreamState, event: IngestStreamEvent): IngestStreamState {
    switch (event.kind) {
        case "run_started":
            return { ...state, label: event.label, runStatus: "running" };
        case "stage_started": {
            const known = event.stage in state.stages;
            // Don't downgrade an already-finished stage back to "running" on
            // replay (idempotent rehydrate).
            const current = state.stages[event.stage];
            if (current === "ok" || current === "error") return state;
            return {
                ...state,
                stages: { ...state.stages, [event.stage]: "running" },
                order: known ? state.order : [...state.order, event.stage],
            };
        }
        case "stage_progress": {
            const known = event.stage in state.stages;
            const current = state.stages[event.stage];
            // Don't resurrect a finished stage's bar on replay.
            if (current === "ok" || current === "error") return state;
            return {
                ...state,
                stages: { ...state.stages, [event.stage]: "running" },
                progress: {
                    ...state.progress,
                    [event.stage]: {
                        current: event.current,
                        total: event.total,
                        ratePerSec: event.ratePerSec,
                        etaLeftMs: event.etaLeftMs,
                    },
                },
                order: known ? state.order : [...state.order, event.stage],
            };
        }
        case "stage_file_failures": {
            // Snapshots are cumulative; the latest one supersedes. Replaying a
            // finished run re-applies the same snapshots in order, converging
            // on the identical final state (idempotent rehydrate). Unlike
            // progress bars, the failure list stays visible after the stage
            // (and run) finishes - it's the post-run report.
            if (event.total <= 0) return state;
            return {
                ...state,
                fileFailures: {
                    ...state.fileFailures,
                    [event.stage]: { total: event.total, failures: event.failures },
                },
            };
        }
        case "stage_finished": {
            const next: StageStatus = event.status === "ok" ? "ok" : "error";
            const known = event.stage in state.stages;
            return {
                ...state,
                stages: { ...state.stages, [event.stage]: next },
                order: known ? state.order : [...state.order, event.stage],
            };
        }
        case "run_finished":
            return { ...state, finished: true, runStatus: event.status };
        default:
            return state;
    }
}

function reducer(state: IngestStreamState, action: Action): IngestStreamState {
    switch (action.type) {
        case "reset":
            return IDLE;
        case "error":
            return { ...state, error: action.message };
        case "event": {
            const next = applyEvent(state, action.event);
            return action.offset !== undefined ? { ...next, offset: action.offset } : next;
        }
        default:
            return state;
    }
}

export function useIngestStream(streamUrl: string | null): IngestStreamState {
    const [state, dispatch] = useReducer(reducer, IDLE);

    useEffect(() => {
        if (!streamUrl) {
            dispatch({ type: "reset" });
            return;
        }

        dispatch({ type: "reset" });

        let cancelled = false;
        let receivedAny = false;
        const controller = new AbortController();
        let unsubscribe: (() => void) | null = null;
        let session: StreamResponse<unknown> | null = null;

        (async () => {
            try {
                // Default offset ("-1") => replay from start, then live deltas.
                const res = await stream<unknown>({
                    url: streamUrl,
                    live: true,
                    signal: controller.signal,
                    // The client already applied backoff retries (network/5xx/429)
                    // before calling us. Returning `{}` retries; returning void
                    // STOPS and propagates the error. So: tolerate a transient blip
                    // on a healthy run (events already flowed) by retrying, but for a
                    // stale/dead sidecar (a prior serve session's port - nothing ever
                    // arrives) surface the error and stop instead of retrying forever.
                    onError: (err) => {
                        if (cancelled) return;
                        if (receivedAny) return {};
                        dispatch({
                            type: "error",
                            message: err instanceof Error ? err.message : String(err),
                        });
                        return undefined;
                    },
                });
                if (cancelled) {
                    res.cancel();
                    return;
                }
                session = res;
                unsubscribe = res.subscribeJson((batch) => {
                    if (cancelled) return;
                    if (batch.items.length > 0) receivedAny = true;
                    const decoded = decodeStreamItems(batch.items);
                    if (decoded.invalidCount > 0) {
                        dispatch({
                            type: "error",
                            message: `received ${decoded.invalidCount} invalid ingest stream event${decoded.invalidCount === 1 ? "" : "s"}`,
                        });
                    }
                    for (const event of decoded.events) {
                        dispatch({ type: "event", event, offset: batch.offset });
                    }
                });
            } catch (err) {
                if (cancelled) return;
                dispatch({
                    type: "error",
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            if (unsubscribe) unsubscribe();
            if (session) session.cancel();
        };
    }, [streamUrl]);

    return state;
}
