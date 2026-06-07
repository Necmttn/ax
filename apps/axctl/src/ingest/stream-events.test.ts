import { describe, expect, test } from "bun:test";
import { ingestStreamEventFromTrace, type IngestStreamEvent } from "./stream-events.ts";

describe("ingest stream events", () => {
    test("maps a SpanStart to a stage-started event", () => {
        const ev = ingestStreamEventFromTrace(
            { _tag: "SpanStart", traceId: "ingest:run123", spanId: "s1", name: "skills" } as never,
            { spanNames: new Map() },
        );
        expect(ev).toEqual({ kind: "stage_started", runId: "run123", stage: "skills" } as IngestStreamEvent);
    });

    test("maps a SpanEnd (ok) to a stage-finished event with status", () => {
        const names = new Map([["s1", "skills"]]);
        const ev = ingestStreamEventFromTrace(
            { _tag: "SpanEnd", traceId: "ingest:run123", spanId: "s1", status: "ok", durationMs: 12 } as never,
            { spanNames: names },
        );
        expect(ev).toEqual({ kind: "stage_finished", runId: "run123", stage: "skills", status: "ok", durationMs: 12 });
    });

    test("maps TraceEnd to run_finished", () => {
        const ev = ingestStreamEventFromTrace(
            { _tag: "TraceEnd", traceId: "ingest:run123", status: "completed", durationMs: 99 } as never,
            { spanNames: new Map() },
        );
        expect(ev).toEqual({ kind: "run_finished", runId: "run123", status: "completed", durationMs: 99 });
    });

    test("returns null for unrelated events", () => {
        expect(ingestStreamEventFromTrace({ _tag: "SpanEvent", traceId: "ingest:x", spanId: "s", name: "n" } as never, { spanNames: new Map() })).toBeNull();
    });

    test("emits stage_progress once current + total are both known, with rate + eta", () => {
        const ctx = {
            spanNames: new Map<string, string>(),
            spanStartedAt: new Map<string, number>(),
            spanCounts: new Map<string, Record<string, number>>(),
            index: { started: 0 },
        };
        ingestStreamEventFromTrace(
            { _tag: "SpanStart", traceId: "ingest:r", spanId: "s1", name: "claude/transcripts", timestamp: 1000 } as never,
            ctx,
        );
        // Total only -> not yet determinate -> null.
        const partial = ingestStreamEventFromTrace(
            { _tag: "SpanEvent", traceId: "ingest:r", spanId: "s1", name: "attribute:ingest.count.totalFiles", attributes: { value: 200 }, timestamp: 1000 } as never,
            ctx,
        );
        expect(partial).toBeNull();
        // Now current arrives 5s in -> 50/200 @ 10/s, 150 left -> 15s.
        const ev = ingestStreamEventFromTrace(
            { _tag: "SpanEvent", traceId: "ingest:r", spanId: "s1", name: "attribute:ingest.count.currentFile", attributes: { value: 50 }, timestamp: 6000 } as never,
            ctx,
        );
        expect(ev).toMatchObject({ kind: "stage_progress", stage: "claude/transcripts", current: 50, total: 200, stageIndex: 1 });
        expect((ev as { ratePerSec: number }).ratePerSec).toBeCloseTo(10, 5);
        expect((ev as { etaLeftMs: number }).etaLeftMs).toBeCloseTo(15000, 0);
    });
});
