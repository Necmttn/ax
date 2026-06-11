import type { TraceEvent } from "@ax/lib/live-traces/types";
import type { IngestFileFailure, IngestStreamEvent } from "@ax/lib/shared/ingest-stream-events";

// Re-export so existing axctl importers (`from ".../ingest/stream-events.ts"`)
// keep resolving the type unchanged after the contract moved to @ax/lib/shared.
export type { IngestStreamEvent };

/** Span-attribute key carrying a stage's cumulative skipped-file snapshot
 *  (JSON-encoded {@link IngestFileFailure} list + uncapped total). Producer:
 *  `stageFileFailureAnnotator` (stage/runner.ts); consumer: the
 *  `attribute:<key>` SpanEvent branch below. Non-numeric, so the CLI progress
 *  transports' count parsers ignore it by construction. */
export const INGEST_FILE_FAILURES_KEY = "ingest.fileFailures";

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

/** Decode the JSON snapshot from an `attribute:ingest.fileFailures` SpanEvent.
 *  Defensive: a malformed payload yields null (the event is dropped) rather
 *  than crashing the transport. */
const readFileFailures = (
    attributes: Record<string, unknown> | undefined,
): { total: number; failures: IngestFileFailure[] } | null => {
    const raw = attributes?.value;
    if (typeof raw !== "string") return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        const { total, failures } = parsed as { total?: unknown; failures?: unknown };
        if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
        if (!Array.isArray(failures)) return null;
        const details: IngestFileFailure[] = [];
        for (const f of failures) {
            if (typeof f !== "object" || f === null) return null;
            const { filePath, tag, message } = f as Record<string, unknown>;
            if (typeof filePath !== "string" || typeof tag !== "string" || typeof message !== "string") return null;
            details.push({ filePath, tag, message });
        }
        return { total, failures: details };
    } catch {
        return null;
    }
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
            // Skipped-file snapshot: forward as its own event so the Live tab
            // can render the per-stage failure list (count climbs live; replay
            // reconverges on the final cumulative snapshot).
            if (event.name === `attribute:${INGEST_FILE_FAILURES_KEY}`) {
                const snapshot = readFileFailures(event.attributes);
                if (!snapshot) return null;
                return {
                    kind: "stage_file_failures",
                    runId: runIdOf(event.traceId),
                    stage: ctx.spanNames.get(event.spanId) ?? event.spanId,
                    total: snapshot.total,
                    failures: snapshot.failures,
                };
            }
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
