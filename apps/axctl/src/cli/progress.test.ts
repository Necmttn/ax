import { describe, expect, test } from "bun:test";
import { computeStageMetrics, createProgressReporter, parseProgressMode, type ProgressSink } from "./progress.ts";

function memorySink(isTTY = false, columns = 120): ProgressSink & { chunks: string[] } {
    const chunks: string[] = [];
    return {
        isTTY,
        columns,
        chunks,
        write(chunk: string) {
            chunks.push(chunk);
        },
    };
}

describe("cli progress", () => {
    test("parses supported modes", () => {
        expect(parseProgressMode(undefined)).toBe("auto");
        expect(parseProgressMode("pipeline")).toBe("pipeline");
        expect(parseProgressMode("json")).toBe("json");
        expect(() => parseProgressMode("sparkles")).toThrow("unknown progress mode");
    });

    test("plain mode emits stable line logs", () => {
        const sink = memorySink();
        const progress = createProgressReporter({
            command: "ingest",
            mode: "plain",
            runId: "abc123",
            stages: [{ source: "skills", stage: "upsert" }],
            sink,
            now: () => 1_000,
        });

        progress.start({ source: "skills", stage: "upsert" });
        progress.finish({ source: "skills", stage: "upsert" }, { skills: 205 });
        progress.stop();

        expect(sink.chunks.join("")).toContain("[axctl] skills/upsert started");
        expect(sink.chunks.join("")).toContain("skills=205");
    });

    test("computeStageMetrics derives it/s, ratio, and eta-left", () => {
        // 50/200 files in 5s => 10 it/s; 150 left => 15s.
        const m = computeStageMetrics(
            { currentFile: 50, totalFiles: 200, records: 1000 },
            5000,
        );
        expect(m.current).toBe(50);
        expect(m.total).toBe(200);
        expect(m.ratio).toBeCloseTo(0.25, 5);
        expect(m.itemsPerSec).toBeCloseTo(10, 5);
        expect(m.etaLeftMs).toBeCloseTo(15000, 0);
        expect(m.rowsPerSec).toBeCloseTo(200, 5);
    });

    test("computeStageMetrics suppresses rates for sub-100ms elapsed", () => {
        const m = computeStageMetrics({ currentFile: 5, totalFiles: 200 }, 1);
        expect(m.itemsPerSec).toBe(0);
        expect(m.etaLeftMs).toBeUndefined();
    });

    test("plain mode emits live [n/N] progress lines with it/s and eta-left", () => {
        const sink = memorySink();
        let now = 1_000;
        const progress = createProgressReporter({
            command: "ingest",
            mode: "plain",
            runId: "abc123",
            stages: [
                { source: "claude", stage: "transcripts" },
                { source: "codex", stage: "sessions" },
            ],
            sink,
            now: () => now,
        });

        progress.start({ source: "claude", stage: "transcripts" });
        now = 6_000; // 5s elapsed
        progress.update({ source: "claude", stage: "transcripts" }, {
            currentFile: 50,
            totalFiles: 200,
            records: 1000,
        });
        progress.stop();

        const out = sink.chunks.join("");
        expect(out).toContain("[1/2] claude/transcripts  50/200");
        expect(out).toContain("it/s");
        expect(out).toContain("25%");
        expect(out).toContain("left");
    });

    test("plain mode stays quiet on total-less discovery ticks", () => {
        const sink = memorySink();
        const progress = createProgressReporter({
            command: "ingest",
            mode: "plain",
            runId: "abc123",
            stages: [{ source: "signals", stage: "derive" }],
            sink,
            now: () => 1_000,
        });
        progress.start({ source: "signals", stage: "derive" });
        progress.update({ source: "signals", stage: "derive" }, { signals: 12 }); // no current/total
        progress.stop();
        const out = sink.chunks.join("");
        expect(out).toContain("signals/derive started");
        expect(out).not.toContain("[1/1]"); // no live line without a determinate total
    });

    test("json mode emits structured progress events", () => {
        const sink = memorySink();
        const progress = createProgressReporter({
            command: "ingest",
            mode: "json",
            runId: "abc123",
            stages: [{ source: "codex", stage: "sessions" }],
            sink,
            now: () => 1_700_000_000_000,
        });

        progress.start({ source: "codex", stage: "sessions" });
        progress.update({ source: "codex", stage: "sessions" }, { files: 10, sessions: 9 });
        progress.finish({ source: "codex", stage: "sessions" }, { sessions: 12 });

        const events = sink.chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
        expect(events[0]).toMatchObject({
            kind: "axctl.progress",
            command: "ingest",
            event: "started",
            source: "codex",
        });
        expect(events[1]).toMatchObject({
            event: "updated",
            counts: { files: 10, sessions: 9 },
        });
        expect(events[2]).toMatchObject({
            event: "finished",
            counts: { sessions: 12 },
        });
    });

    test("auto mode emits json for non-tty sinks", () => {
        const sink = memorySink(false);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "auto",
            runId: "abc123",
            stages: [{ source: "git", stage: "history" }],
            sink,
            now: () => 1_000,
        });

        progress.start({ source: "git", stage: "history" });

        const event = JSON.parse(sink.chunks.join("").trim());
        expect(event).toMatchObject({
            kind: "axctl.progress",
            command: "ingest",
            event: "started",
            source: "git",
            stage: "history",
        });
    });

    test("explicit pipeline falls back to plain for non-tty sinks", () => {
        const nonTty = memorySink(false);

        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123",
            stages: [{ source: "git", stage: "history" }],
            sink: nonTty,
            now: () => 1_000,
        });
        progress.start({ source: "git", stage: "history" });
        progress.stop();

        expect(nonTty.chunks.join("")).toContain("[axctl] git/history started");
    });

    test("pipeline mode renders a live board for tty sinks", () => {
        const sink = memorySink(true, 120);
        let now = 1_000;
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [
                { source: "skills", stage: "upsert" },
                { source: "codex", stage: "sessions" },
            ],
            sink,
            now: () => now,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "skills", stage: "upsert" });
        now = 2_000;
        progress.update({ source: "skills", stage: "upsert" }, { files: 50, sessions: 49, turns: 500 });
        progress.finish({ source: "skills", stage: "upsert" }, { skills: 205 });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("axctl ingest");
        expect(output).toContain("stage");
        expect(output).toContain("progress");
        expect(output).toContain("skills/upsert");
        expect(output).toContain("codex/sessions");
        expect(output).toContain("skills");
        expect(output).toContain("files=50 sessions=49 turns=500");
        expect(output).toContain("205");
    });

    test("pipeline mode suppresses speed for sub-100ms stages instead of absurd throughput", () => {
        const sink = memorySink(true, 120);
        let now = 1_000;
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "ingest", stage: "pricing" }],
            sink,
            now: () => now,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "ingest", stage: "pricing" });
        now = 1_001; // 1ms bulk insert
        progress.finish({ source: "ingest", stage: "pricing" }, { count: 4339 });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("4,339"); // row count still shown
        expect(output).not.toContain("4,339,000/s"); // not the noise-inflated rate
        expect(output).not.toContain("339,000/s");
    });

    test("pipeline mode shows discovery totals before row counts exist", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "claude", stage: "transcripts" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "claude", stage: "transcripts" });
        progress.update({ source: "claude", stage: "transcripts" }, { totalFiles: 2784, totalBytes: 9_437_184 });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("discovered 2,784 files / 9.0MiB");
    });

    test("pipeline mode treats generic count as row count", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "commands", stage: "upsert" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "commands", stage: "upsert" });
        progress.finish({ source: "commands", stage: "upsert" }, { count: 59 });
        progress.stop();

        expect(sink.chunks.join("")).toContain("59");
    });

    test("pipeline mode shows current file size for large Codex sessions", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "codex", stage: "sessions" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "codex", stage: "sessions" });
        progress.update({ source: "codex", stage: "sessions" }, {
            currentFile: 3,
            totalFiles: 245,
            currentFileBytes: 90_243_914,
            totalBytes: 236_000_000,
            files: 2,
            bytes: 91_000_000,
        });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("processing 3/245 (86.1MiB)");
        expect(output).toContain("bytes=86.8MiB");
    });

    test("pipeline mode uses streamed records for stage row progress", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "codex", stage: "sessions" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "codex", stage: "sessions" });
        progress.update({ source: "codex", stage: "sessions" }, {
            currentFile: 3,
            totalFiles: 251,
            currentFileBytes: 34_049_847,
            files: 2,
            records: 831,
            turns: 612,
            toolCalls: 219,
        });
        progress.stop();

        expect(sink.chunks.join("")).toContain("831");
    });

    test("pipeline mode uses Claude record count instead of file count", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "claude", stage: "transcripts" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "claude", stage: "transcripts" });
        progress.update({ source: "claude", stage: "transcripts" }, {
            currentFile: 117,
            totalFiles: 2_764,
            files: 116,
            records: 31_184,
            turns: 25_580,
            toolCalls: 4_409,
        });
        progress.stop();

        expect(sink.chunks.join("")).toContain("31,184");
    });

    test("pipeline mode keeps Claude record count on finish", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "claude", stage: "transcripts" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "claude", stage: "transcripts" });
        progress.finish({ source: "claude", stage: "transcripts" }, {
            files: 2_764,
            records: 67_084,
            turns: 58_605,
            toolCalls: 4_409,
        });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("67,084");
        expect(output).not.toContain("     2,764");
    });

    test("pipeline mode keeps Codex record count on finish", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "codex", stage: "sessions" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "codex", stage: "sessions" });
        progress.finish({ source: "codex", stage: "sessions" }, {
            files: 259,
            records: 70_184,
            turns: 58_605,
            toolCalls: 7_409,
        });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("70,184");
        expect(output).not.toContain("       259");
    });

    test("pipeline mode shows Claude subagent discovery and processing progress", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [{ source: "claude", stage: "subagents" }],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "claude", stage: "subagents" });
        progress.update({ source: "claude", stage: "subagents" }, {
            totalSubagents: 42,
        });
        progress.update({ source: "claude", stage: "subagents" }, {
            phase: 2,
            currentSubagent: 7,
            totalSubagents: 42,
            subagents: 6,
            written: 5,
            missingParent: 1,
            turns: 200,
            toolCalls: 30,
        });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("discovered 42 subagents");
        expect(output).toContain("writing 7/42 subagents");
        expect(output).toContain("subagents=6 written=5 missingParent=1 turns=200");
    });

    test("pipeline mode renders multiple running stage details", () => {
        const sink = memorySink(true, 120);
        const progress = createProgressReporter({
            command: "ingest",
            mode: "pipeline",
            runId: "abc123456789",
            stages: [
                { source: "claude", stage: "transcripts" },
                { source: "codex", stage: "sessions" },
            ],
            sink,
            now: () => 1_000,
            intervalMs: 10_000,
            env: {},
        });

        progress.start({ source: "claude", stage: "transcripts" });
        progress.start({ source: "codex", stage: "sessions" });
        progress.update({ source: "claude", stage: "transcripts" }, {
            currentFile: 20,
            totalFiles: 100,
            records: 1_200,
            turns: 900,
        });
        progress.update({ source: "codex", stage: "sessions" }, {
            currentFile: 5,
            totalFiles: 40,
            records: 2_400,
            turns: 2_000,
        });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("current=claude/transcripts + codex/sessions");
        expect(output).toContain("current claude/transcripts");
        expect(output).toContain("current codex/sessions");
        expect(output).toContain("processing 20/100");
        expect(output).toContain("processing 5/40");
    });
});
