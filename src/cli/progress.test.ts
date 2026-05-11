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
        progress.finish({ source: "codex", stage: "sessions" }, { sessions: 12 });

        const events = sink.chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
        expect(events[0]).toMatchObject({
            kind: "agentctl.progress",
            command: "ingest",
            event: "started",
            source: "codex",
        });
        expect(events[1]).toMatchObject({
            event: "finished",
            counts: { sessions: 12 },
        });
    });

    test("pipeline auto falls back to plain for non-tty sinks", () => {
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

        expect(sink.chunks.join("")).toContain("[agentctl] git/history started");
    });

    test("pipeline mode falls back when cursor repaint would be unstable", () => {
        const nonTty = memorySink(false);
        const narrowTty = memorySink(true, 80);

        for (const sink of [nonTty, narrowTty]) {
            const progress = createProgressReporter({
                command: "ingest",
                mode: "pipeline",
                runId: "abc123",
                stages: [{ source: "git", stage: "history" }],
                sink,
                now: () => 1_000,
            });
            progress.start({ source: "git", stage: "history" });
            progress.stop();
        }

        expect(nonTty.chunks.join("")).toContain("[agentctl] git/history started");
        expect(narrowTty.chunks.join("")).toContain("[agentctl] git/history started");
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
        progress.finish({ source: "skills", stage: "upsert" }, { skills: 205 });
        progress.stop();

        const output = sink.chunks.join("");
        expect(output).toContain("agentctl ingest");
        expect(output).toContain("stage       progress");
        expect(output).toContain("skills");
        expect(output).toContain("205");
    });
});
