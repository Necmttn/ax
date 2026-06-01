import type { TraceEvent } from "@ax/lib/live-traces/types";

export type IngestStreamEvent =
    | { readonly kind: "run_started"; readonly runId: string; readonly label: string }
    | { readonly kind: "stage_started"; readonly runId: string; readonly stage: string }
    | { readonly kind: "stage_finished"; readonly runId: string; readonly stage: string; readonly status: "ok" | "error"; readonly durationMs: number }
    | { readonly kind: "run_finished"; readonly runId: string; readonly status: "completed" | "failed"; readonly durationMs: number };

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
