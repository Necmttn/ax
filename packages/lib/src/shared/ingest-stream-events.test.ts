import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import {
    decodeIngestStreamEventOption,
    encodeIngestStreamEvent,
    encodeIngestStreamEventJson,
    IngestStreamEventJsonSchema,
    IngestStreamEventSchema,
    isIngestStreamEvent,
    type IngestStreamEvent,
} from "./ingest-stream-events.ts";

const validEvents: ReadonlyArray<IngestStreamEvent> = [
    { kind: "run_started", runId: "r1", label: "ingest" },
    { kind: "stage_started", runId: "r1", stage: "claude" },
    {
        kind: "stage_progress",
        runId: "r1",
        stage: "claude",
        current: 10,
        total: 25,
        ratePerSec: 5,
        etaLeftMs: 3000,
        stageIndex: 1,
    },
    {
        kind: "stage_progress",
        runId: "r1",
        stage: "claude",
        current: 25,
        total: 25,
        ratePerSec: 10,
        etaLeftMs: null,
        stageIndex: 1,
    },
    {
        kind: "stage_file_failures",
        runId: "r1",
        stage: "claude",
        total: 2,
        failures: [
            { filePath: "/tmp/a.jsonl", tag: "DbError", message: "boom" },
            { filePath: "/tmp/b.jsonl", tag: "ParseError", message: "bad json" },
        ],
    },
    { kind: "stage_finished", runId: "r1", stage: "claude", status: "ok", durationMs: 42 },
    { kind: "stage_finished", runId: "r1", stage: "codex", status: "error", durationMs: 99 },
    { kind: "run_finished", runId: "r1", status: "completed", durationMs: 120 },
    { kind: "run_finished", runId: "r2", status: "failed", durationMs: 121 },
];

describe("IngestStreamEventSchema", () => {
    test("decodes every valid live-ingest event variant", () => {
        for (const event of validEvents) {
            expect(Schema.decodeUnknownSync(IngestStreamEventSchema)(event)).toEqual(event);
            expect(Option.isSome(decodeIngestStreamEventOption(event))).toBe(true);
            expect(isIngestStreamEvent(event)).toBe(true);
        }
    });

    test("encodes valid events without changing their JSON shape", () => {
        for (const event of validEvents) {
            expect(encodeIngestStreamEvent(event)).toEqual(event);
        }
    });

    test("encodes and decodes valid events at the JSON-string boundary", () => {
        for (const event of validEvents) {
            const json = encodeIngestStreamEventJson(event);

            expect(json).toBe(JSON.stringify(event));
            expect(Schema.decodeUnknownSync(IngestStreamEventJsonSchema)(json)).toEqual(event);
        }
    });

    test("rejects malformed JSON-string events", () => {
        const invalid = JSON.stringify({
            kind: "stage_finished",
            runId: "r1",
            stage: "claude",
            status: "completed",
            durationMs: 1,
        });

        expect(() => Schema.decodeUnknownSync(IngestStreamEventJsonSchema)(invalid)).toThrow();
    });

    test("rejects unknown event kinds and invalid status literals", () => {
        const invalid: ReadonlyArray<unknown> = [
            { kind: "wat", runId: "r1" },
            { kind: "stage_finished", runId: "r1", stage: "s", status: "completed", durationMs: 1 },
            { kind: "run_finished", runId: "r1", status: "ok", durationMs: 1 },
        ];

        for (const value of invalid) {
            expect(Option.isNone(decodeIngestStreamEventOption(value))).toBe(true);
            expect(isIngestStreamEvent(value)).toBe(false);
        }
    });

    test("rejects non-finite JSON numbers", () => {
        const invalid: ReadonlyArray<unknown> = [
            {
                kind: "stage_progress",
                runId: "r1",
                stage: "claude",
                current: 1,
                total: 2,
                ratePerSec: Infinity,
                etaLeftMs: null,
                stageIndex: 1,
            },
            {
                kind: "stage_progress",
                runId: "r1",
                stage: "claude",
                current: 1,
                total: 2,
                ratePerSec: 1,
                etaLeftMs: Number.NaN,
                stageIndex: 1,
            },
            { kind: "run_finished", runId: "r1", status: "completed", durationMs: -Infinity },
        ];

        for (const value of invalid) {
            expect(Option.isNone(decodeIngestStreamEventOption(value))).toBe(true);
        }
    });

    test("rejects malformed stage_file_failures details", () => {
        const invalid: ReadonlyArray<unknown> = [
            { kind: "stage_file_failures", runId: "r", stage: "s", total: 1, failures: [{ filePath: 1, tag: "x", message: "y" }] },
            { kind: "stage_file_failures", runId: "r", stage: "s", total: 1, failures: [{ filePath: "/x", tag: 2, message: "y" }] },
            { kind: "stage_file_failures", runId: "r", stage: "s", total: 1, failures: [{ filePath: "/x", tag: "x", message: null }] },
        ];

        for (const value of invalid) {
            expect(Option.isNone(decodeIngestStreamEventOption(value))).toBe(true);
        }
    });
});
