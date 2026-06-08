import type { TraceEvent } from "@ax/lib/live-traces/types";

export type IngestStreamEvent =
    | { readonly kind: "run_started"; readonly runId: string; readonly label: string }
    | { readonly kind: "stage_started"; readonly runId: string; readonly stage: string }
    | {
        readonly kind: "stage_progress";
        readonly runId: string;
        readonly stage: string;
        readonly current: number;
        readonly total: number;
        readonly ratePerSec: number;
        readonly etaLeftMs: number | null;
        /** 1-based index of this stage among those started so far. */
        readonly stageIndex: number;
    }
    | { readonly kind: "stage_finished"; readonly runId: string; readonly stage: string; readonly status: "ok" | "error"; readonly durationMs: number }
    | { readonly kind: "run_finished"; readonly runId: string; readonly status: "completed" | "failed"; readonly durationMs: number };

const runIdOf = (traceId: string): string => traceId.replace(/^ingest:/, "");

/** Mutable per-trace state the translator threads across events: span id ->
 *  stage name, start time, and accumulated counts, plus a started-stage counter
 *  for the [n] index. Callers create one and reuse it for the whole trace. */
export interface TraceStreamCtx {
    readonly spanNames: Map<string, string>;
    readonly spanStartedAt?: Map<string, number>;
    readonly spanCounts?: Map<string, Record<string, number>>;
    readonly index?: { started: number };
}

/** Parse an `ingest.*` count SpanEvent into `[key, value]`, mirroring the
 *  terminal renderer. `ingest.records` is the primary count; `ingest.count.<f>`
 *  carries each stat field (incl. currentFile/totalFiles). */
const readCount = (name: string, attributes: Record<string, unknown> | undefined): readonly [string, number] | null => {
    if (!name.startsWith("attribute:ingest.")) return null;
    const value = attributes?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (name === "attribute:ingest.records") return ["records", value];
    if (name.startsWith("attribute:ingest.count.")) return [name.slice("attribute:ingest.count.".length), value];
    return null;
};

const firstFinite = (...vs: Array<number | undefined>): number | undefined => {
    for (const v of vs) if (typeof v === "number" && Number.isFinite(v)) return v;
    return undefined;
};

/** Translate a live-trace event into an ingest progress event, or null. */
export function ingestStreamEventFromTrace(
    event: TraceEvent,
    ctx: TraceStreamCtx,
): IngestStreamEvent | null {
    switch (event._tag) {
        case "TraceStart":
            return { kind: "run_started", runId: runIdOf(event.traceId), label: event.label };
        case "SpanStart": {
            ctx.spanNames.set(event.spanId, event.name);
            ctx.spanStartedAt?.set(event.spanId, event.timestamp);
            if (ctx.index) ctx.index.started += 1;
            return { kind: "stage_started", runId: runIdOf(event.traceId), stage: event.name };
        }
        case "SpanEvent": {
            // Accumulate counts; emit a stage_progress only once current + total
            // are both known (a determinate bar), otherwise stay silent.
            const parsed = readCount(event.name, event.attributes);
            if (!parsed || !ctx.spanCounts) return null;
            const counts = ctx.spanCounts.get(event.spanId) ?? {};
            counts[parsed[0]] = parsed[1];
            ctx.spanCounts.set(event.spanId, counts);
            const current = firstFinite(counts.currentFile, counts.currentSubagent);
            const total = firstFinite(counts.totalFiles, counts.totalSubagents);
            if (current === undefined || total === undefined || total <= 0) return null;
            const startedAt = ctx.spanStartedAt?.get(event.spanId) ?? event.timestamp;
            const secs = Math.max(0, event.timestamp - startedAt) / 1000;
            const ratePerSec = secs > 0 && current > 0 ? current / secs : 0;
            const etaLeftMs = ratePerSec > 0 && total > current ? ((total - current) / ratePerSec) * 1000 : null;
            return {
                kind: "stage_progress",
                runId: runIdOf(event.traceId),
                stage: ctx.spanNames.get(event.spanId) ?? event.spanId,
                current,
                total,
                ratePerSec,
                etaLeftMs,
                stageIndex: ctx.index?.started ?? 0,
            };
        }
        case "SpanEnd": {
            const stage = ctx.spanNames.get(event.spanId) ?? event.spanId;
            ctx.spanNames.delete(event.spanId);
            ctx.spanStartedAt?.delete(event.spanId);
            ctx.spanCounts?.delete(event.spanId);
            return { kind: "stage_finished", runId: runIdOf(event.traceId), stage, status: event.status, durationMs: event.durationMs };
        }
        case "TraceEnd":
            return { kind: "run_finished", runId: runIdOf(event.traceId), status: event.status, durationMs: event.durationMs };
        default:
            return null;
    }
}
