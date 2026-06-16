import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { TraceTransportTag } from "@ax/lib/live-traces/Sink";
import { spanEnd, spanEvent, spanStart, traceEnd, traceStart, type TraceEvent } from "@ax/lib/live-traces/types";
import { pipelineTraceTransportLayer } from "./ingest-trace-progress.ts";
import { type ProgressSink } from "./progress.ts";

function memorySink(): ProgressSink & { chunks: string[] } {
    const chunks: string[] = [];
    return { isTTY: false, columns: 120, chunks, write: (c) => void chunks.push(c) };
}

// Drive a sequence of trace events through the plain-mode transport and return
// everything it wrote to the sink.
function render(events: readonly TraceEvent[]): string {
    const sink = memorySink();
    const layer = pipelineTraceTransportLayer("plain", [], sink);
    Effect.runSync(
        Effect.gen(function* () {
            const transport = yield* TraceTransportTag;
            yield* transport.send(events);
        }).pipe(Effect.provide(layer)),
    );
    return sink.chunks.join("");
}

const TRACE = "ingest:run1";

describe("pipelineTraceTransportLayer plain mode (issue #479)", () => {
    test("renders stage spans but suppresses nested leaf spans", () => {
        const out = render([
            traceStart(TRACE, "whole-run", { type: "user", id: "u1" }),
            // root span: no parent -> never rendered, just establishes the root id
            spanStart(TRACE, "root", "skills/upsert|signals/derive"),
            // stage span: direct child of root -> rendered
            spanStart(TRACE, "stage1", "skills/upsert", {}, "root"),
            // leaf spans: children of the stage -> the #479 flood, must be silent
            spanStart(TRACE, "leaf1", "process.runCommand", {}, "stage1"),
            spanEnd(TRACE, "leaf1", "ok", 1),
            spanStart(TRACE, "leaf2", "db.chunk", {}, "stage1"),
            spanEnd(TRACE, "leaf2", "ok", 1),
            spanEnd(TRACE, "stage1", "ok", 5),
            traceEnd(TRACE, "completed", 6),
        ]);

        expect(out).toContain("[axctl] ingest/skills/upsert started");
        expect(out).toContain("[axctl] ingest/skills/upsert done");
        // The leaf-span chatter that drowned out the real progress is gone.
        expect(out).not.toContain("process.runCommand");
        expect(out).not.toContain("db.chunk");
    });

    test("stage-span count attributes still surface on finish", () => {
        const out = render([
            traceStart(TRACE, "whole-run", { type: "user", id: "u1" }),
            spanStart(TRACE, "root", "skills/upsert"),
            spanStart(TRACE, "stage1", "skills/upsert", {}, "root"),
            // count annotation rides the STAGE span, not a leaf (records is the
            // primary count, hidden from the summary; count.<field> shows up)
            spanEvent(TRACE, "stage1", "attribute:ingest.count.sessions", "Info", { value: 205 }),
            spanEnd(TRACE, "stage1", "ok", 5),
            traceEnd(TRACE, "completed", 6),
        ]);

        expect(out).toContain("ingest/skills/upsert done");
        expect(out).toContain("sessions=205");
    });

    test("a count event on a LEAF (grandchild) span is dropped, not attributed", () => {
        // Counts that ride a nested span (parent = stage, not root) must not leak
        // into output: the leaf is never tracked, so its SpanEnd is skipped and
        // its count never reaches a finish line. Only the stage span's own
        // SpanEnd (no count here) renders.
        const out = render([
            traceStart(TRACE, "whole-run", { type: "user", id: "u1" }),
            spanStart(TRACE, "root", "skills/upsert"),
            spanStart(TRACE, "stage1", "skills/upsert", {}, "root"),
            spanStart(TRACE, "leaf1", "db.chunk", {}, "stage1"),
            // count annotation arrives on the LEAF span, not the stage
            spanEvent(TRACE, "leaf1", "attribute:ingest.count.sessions", "Info", { value: 999 }),
            spanEnd(TRACE, "leaf1", "ok", 1),
            spanEnd(TRACE, "stage1", "ok", 5),
            traceEnd(TRACE, "completed", 6),
        ]);

        expect(out).toContain("ingest/skills/upsert done");
        // The leaf-attributed count must NOT surface (it would, if leaf spans were tracked).
        expect(out).not.toContain("sessions=999");
        expect(out).not.toContain("db.chunk");
    });
});
