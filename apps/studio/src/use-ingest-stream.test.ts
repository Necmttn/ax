import { describe, expect, test } from "bun:test";
import type { IngestStreamEvent } from "@ax/lib/shared/ingest-stream-events";
import { applyEvent, decodeStreamItems, type IngestStreamState } from "./use-ingest-stream.ts";

const IDLE: IngestStreamState = {
    stages: {},
    progress: {},
    fileFailures: {},
    order: [],
    finished: false,
    runStatus: "running",
};

const fold = (events: ReadonlyArray<IngestStreamEvent>): IngestStreamState =>
    events.reduce(applyEvent, IDLE);

const failure = (filePath: string): { filePath: string; tag: string; message: string } => ({
    filePath,
    tag: "DbError",
    message: "boom",
});

describe("decodeStreamItems", () => {
    test("returns valid ingest events and counts malformed items", () => {
        const batch = decodeStreamItems([
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "stage_finished", runId: "r", stage: "claude", status: "completed", durationMs: 1 },
            { kind: "run_finished", runId: "r", status: "completed", durationMs: 2 },
        ]);

        expect(batch.events).toEqual([
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "run_finished", runId: "r", status: "completed", durationMs: 2 },
        ]);
        expect(batch.invalidCount).toBe(1);
    });
});

describe("applyEvent: stage_file_failures", () => {
    test("latest cumulative snapshot wins per stage, keyed by stage name", () => {
        const state = fold([
            { kind: "run_started", runId: "r", label: "ingest" },
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "stage_file_failures", runId: "r", stage: "claude", total: 1, failures: [failure("/a.jsonl")] },
            {
                kind: "stage_file_failures",
                runId: "r",
                stage: "claude",
                total: 2,
                failures: [failure("/a.jsonl"), failure("/b.jsonl")],
            },
            { kind: "stage_file_failures", runId: "r", stage: "codex", total: 1, failures: [failure("/c.jsonl")] },
        ]);
        expect(state.fileFailures.claude).toEqual({
            total: 2,
            failures: [failure("/a.jsonl"), failure("/b.jsonl")],
        });
        expect(state.fileFailures.codex).toEqual({ total: 1, failures: [failure("/c.jsonl")] });
    });

    test("failures survive stage and run completion (post-run report)", () => {
        const state = fold([
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "stage_file_failures", runId: "r", stage: "claude", total: 1, failures: [failure("/a.jsonl")] },
            { kind: "stage_finished", runId: "r", stage: "claude", status: "ok", durationMs: 10 },
            { kind: "run_finished", runId: "r", status: "completed", durationMs: 20 },
        ]);
        expect(state.finished).toBe(true);
        expect(state.fileFailures.claude?.total).toBe(1);
    });

    test("Durable Stream replay reconverges on the same final state", () => {
        const events: IngestStreamEvent[] = [
            { kind: "run_started", runId: "r", label: "ingest" },
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "stage_file_failures", runId: "r", stage: "claude", total: 1, failures: [failure("/a.jsonl")] },
            {
                kind: "stage_file_failures",
                runId: "r",
                stage: "claude",
                total: 2,
                failures: [failure("/a.jsonl"), failure("/b.jsonl")],
            },
            { kind: "stage_finished", runId: "r", stage: "claude", status: "ok", durationMs: 10 },
            { kind: "run_finished", runId: "r", status: "completed", durationMs: 20 },
        ];
        const live = fold(events);
        // Refresh mid-run = full replay from offset -1 into fresh IDLE state.
        const replayed = fold(events);
        expect(replayed).toEqual(live);
        expect(replayed.fileFailures.claude?.total).toBe(2);
    });

    test("a clean run records no fileFailures and a zero-total snapshot is ignored", () => {
        const clean = fold([
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "stage_finished", runId: "r", stage: "claude", status: "ok", durationMs: 10 },
        ]);
        expect(clean.fileFailures).toEqual({});
        const zero = fold([
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "stage_file_failures", runId: "r", stage: "claude", total: 0, failures: [] },
        ]);
        expect(zero.fileFailures).toEqual({});
    });
});
