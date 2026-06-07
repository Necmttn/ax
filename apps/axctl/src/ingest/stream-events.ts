import type { TraceEvent } from "@ax/lib/live-traces/types";
import type { IngestStreamEvent } from "@ax/lib/shared/ingest-stream-events";

// The event contract now lives in @ax/lib/shared so the standalone @ax/studio
// package consumes the same source of truth; re-export keeps this module's
// existing importers (./stream-events.ts) working unchanged.
export type { IngestStreamEvent };

const runIdOf = (traceId: string): string => traceId.replace(/^ingest:/, "");

/** Translate a live-trace event into a coarse ingest progress event, or null. */
export function ingestStreamEventFromTrace(
    event: TraceEvent,
    ctx: { readonly spanNames: Map<string, string> },
): IngestStreamEvent | null {
    switch (event._tag) {
        case "TraceStart":
            return { kind: "run_started", runId: runIdOf(event.traceId), label: event.label };
        case "SpanStart":
            ctx.spanNames.set(event.spanId, event.name);
            return { kind: "stage_started", runId: runIdOf(event.traceId), stage: event.name };
        case "SpanEnd": {
            const stage = ctx.spanNames.get(event.spanId) ?? event.spanId;
            ctx.spanNames.delete(event.spanId);
            return { kind: "stage_finished", runId: runIdOf(event.traceId), stage, status: event.status, durationMs: event.durationMs };
        }
        case "TraceEnd":
            return { kind: "run_finished", runId: runIdOf(event.traceId), status: event.status, durationMs: event.durationMs };
        default:
            return null;
    }
}
