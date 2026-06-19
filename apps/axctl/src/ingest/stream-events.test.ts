import { describe, expect, test } from "bun:test";
import {
    spanEnd,
    spanEvent,
    spanStart,
    traceEnd,
    type SpanEvent,
    type SpanStart,
} from "@ax/lib/live-traces/types";
import { ingestStreamEventFromTrace, type IngestStreamEvent } from "./stream-events.ts";

describe("ingest stream events", () => {
    test("maps a SpanStart to a stage-started event", () => {
        const ev = ingestStreamEventFromTrace(
            spanStart("ingest:run123", "s1", "skills"),
            { spanNames: new Map() },
        );
        expect(ev).toEqual({ kind: "stage_started", runId: "run123", stage: "skills" } as IngestStreamEvent);
    });

    test("maps a SpanEnd (ok) to a stage-finished event with status", () => {
        const names = new Map([["s1", "skills"]]);
        const ev = ingestStreamEventFromTrace(
            spanEnd("ingest:run123", "s1", "ok", 12),
            { spanNames: names },
        );
        expect(ev).toEqual({ kind: "stage_finished", runId: "run123", stage: "skills", status: "ok", durationMs: 12 });
    });

    test("maps TraceEnd to run_finished", () => {
        const ev = ingestStreamEventFromTrace(
            traceEnd("ingest:run123", "completed", 99),
            { spanNames: new Map() },
        );
        expect(ev).toEqual({ kind: "run_finished", runId: "run123", status: "completed", durationMs: 99 });
    });

    test("returns null for unrelated events", () => {
        expect(ingestStreamEventFromTrace(spanEvent("ingest:x", "s", "n"), { spanNames: new Map() })).toBeNull();
    });

    test("maps an attribute:ingest.fileFailures SpanEvent to stage_file_failures, keyed to the stage span", () => {
        const names = new Map([["s1", "claude"]]);
        const snapshot = {
            total: 27,
            failures: [{ filePath: "/p/a.jsonl", tag: "DbError", message: "boom" }],
        };
        const ev = ingestStreamEventFromTrace(
            spanEvent("ingest:run123", "s1", "attribute:ingest.fileFailures", undefined, { value: JSON.stringify(snapshot) }),
            { spanNames: names },
        );
        expect(ev).toEqual({
            kind: "stage_file_failures",
            runId: "run123",
            stage: "claude",
            total: 27,
            failures: [{ filePath: "/p/a.jsonl", tag: "DbError", message: "boom" }],
        } as IngestStreamEvent);
    });

    test("drops malformed or empty fileFailures payloads instead of crashing", () => {
        const cases: unknown[] = [
            undefined,
            42,
            "not json",
            JSON.stringify({ total: 0, failures: [] }),
            JSON.stringify({ total: 2 }),
            JSON.stringify({ total: 2, failures: [{ filePath: 1, tag: "x", message: "y" }] }),
        ];
        for (const value of cases) {
            const ev = ingestStreamEventFromTrace(
                spanEvent("ingest:run123", "s1", "attribute:ingest.fileFailures", undefined, { value }),
                { spanNames: new Map([["s1", "claude"]]) },
            );
            expect(ev).toBeNull();
        }
    });

    test("drops fileFailures payloads whose failure entries do not match the shared schema", () => {
        const ev = ingestStreamEventFromTrace(
            spanEvent("ingest:run123", "s1", "attribute:ingest.fileFailures", undefined, {
                value: JSON.stringify({
                    total: 2,
                    failures: [{ filePath: "/p/a.jsonl", tag: "DbError", message: 42 }],
                }),
            }),
            { spanNames: new Map([["s1", "claude"]]) },
        );
        expect(ev).toBeNull();
    });

    test("emits stage_progress once current + total are both known, with rate + eta", () => {
        const ctx = {
            spanNames: new Map<string, string>(),
            spanStartedAt: new Map<string, number>(),
            spanCounts: new Map<string, Record<string, number>>(),
            index: { started: 0 },
        };
        const start: SpanStart = {
            _tag: "SpanStart",
            traceId: "ingest:r",
            spanId: "s1",
            name: "claude/transcripts",
            attributes: {},
            timestamp: 1000,
        };
        ingestStreamEventFromTrace(
            start,
            ctx,
        );
        // Total only -> not yet determinate -> null.
        const total: SpanEvent = {
            _tag: "SpanEvent",
            traceId: "ingest:r",
            spanId: "s1",
            name: "attribute:ingest.count.totalFiles",
            attributes: { value: 200 },
            timestamp: 1000,
        };
        const partial = ingestStreamEventFromTrace(
            total,
            ctx,
        );
        expect(partial).toBeNull();
        // Now current arrives 5s in -> 50/200 @ 10/s, 150 left -> 15s.
        const current: SpanEvent = {
            _tag: "SpanEvent",
            traceId: "ingest:r",
            spanId: "s1",
            name: "attribute:ingest.count.currentFile",
            attributes: { value: 50 },
            timestamp: 6000,
        };
        const ev = ingestStreamEventFromTrace(
            current,
            ctx,
        );
        expect(ev).toMatchObject({ kind: "stage_progress", stage: "claude/transcripts", current: 50, total: 200, stageIndex: 1 });
        expect((ev as { ratePerSec: number }).ratePerSec).toBeCloseTo(10, 5);
        expect((ev as { etaLeftMs: number }).etaLeftMs).toBeCloseTo(15000, 0);
    });
});
