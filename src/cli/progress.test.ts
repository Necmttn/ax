import { describe, expect, test } from "bun:test";
import { createProgressReporter, parseProgressMode, type ProgressSink } from "./progress.ts";

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

        expect(sink.chunks.join("")).toContain("[agentctl] skills/upsert started");
        expect(sink.chunks.join("")).toContain("skills=205");
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
            kind: "agentctl.progress",
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
            kind: "agentctl.progress",
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

        expect(nonTty.chunks.join("")).toContain("[agentctl] git/history started");
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
        expect(output).toContain("agentctl ingest");
        expect(output).toContain("stage       progress");
        expect(output).toContain("skills");
        expect(output).toContain("files=50 sessions=49 turns=500");
        expect(output).toContain("205");
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
});
