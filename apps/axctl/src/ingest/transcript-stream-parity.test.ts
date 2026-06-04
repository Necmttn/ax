import { describe, expect, test } from "bun:test";
import { Effect, Layer, Path } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import {
    __testExtractClaudeJsonlLines,
    extractFileWithSessionId,
} from "./transcripts.ts";

// Build a transcript with (a) a trailing newline and (b) a multi-byte UTF-8
// char ("café") deliberately positioned so its é (2 bytes) straddles the
// test FileSystem's 3-byte stream chunks. This exercises Stream.decodeText's
// cross-chunk buffering - the one place the streaming reader could diverge
// from node readLines / the pure oracle.
const projectDir = "-Users-necmttn-Projects-ax";
const sessionId = "session-stream-parity";

const lines = [
    JSON.stringify({
        type: "user",
        timestamp: "2026-05-09T09:00:00.000Z",
        message: { role: "user", content: "Find the café files and fix them." },
    }),
    JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-09T09:00:01.000Z",
        cwd: "/Users/necmttn/Projects/ax",
        message: {
            content: [
                {
                    type: "tool_use",
                    id: "toolu_bash",
                    name: "Bash",
                    input: { command: "grep -r café src" },
                },
                {
                    type: "tool_use",
                    id: "toolu_edit",
                    name: "Edit",
                    input: { file_path: "src/café.ts" },
                },
            ],
        },
    }),
];

// Trailing newline ensures splitLines/readLines parity on the final line.
const content = `${lines.join("\n")}\n`;

describe("streaming extractor parity with pure oracle", () => {
    test("streaming reader matches __testExtractClaudeJsonlLines counts", async () => {
        const path = "/transcripts/-Users-necmttn-Projects-ax/sess.jsonl";
        const streamed = await Effect.runPromise(
            extractFileWithSessionId(path, projectDir, sessionId).pipe(
                Effect.provide(
                    Layer.mergeAll(layerTestFileSystem({ [path]: content }), Path.layer),
                ),
            ),
        );

        const oracle = __testExtractClaudeJsonlLines(lines, projectDir, sessionId);

        expect(streamed).not.toBeNull();
        expect(oracle).not.toBeNull();
        if (!streamed || !oracle) return;

        expect(streamed.turns.length).toBe(oracle.turns.length);
        expect(streamed.toolCalls.length).toBe(oracle.toolCalls.length);
        expect(streamed.edits.length).toBe(oracle.edits.length);
        expect(streamed.invocations.length).toBe(oracle.invocations.length);
        expect(streamed.providerEvents.length).toBe(oracle.providerEvents.length);

        // The multi-byte char must survive cross-chunk decoding intact.
        expect(streamed.turns[0]?.text).toBe("Find the café files and fix them.");
        expect(streamed.edits[0]?.path).toBe("/Users/necmttn/Projects/ax/src/café.ts");
    });
});
