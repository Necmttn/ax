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
});
