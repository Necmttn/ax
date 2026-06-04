import { describe, expect, test } from "bun:test";
import { Effect, Layer, Path } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import {
    __testExtractCodexJsonlLines,
    __testStreamCodexFileBatches,
    DEFAULT_CODEX_FLUSH_EVERY,
} from "./codex.ts";

// Honesty test for the streaming-batch migration: the FileSystem.stream reader
// must thread the `flushEvery` cadence into its per-line Effect so a large
// session is drained in MULTIPLE batches (bounding memory) - NOT buffered whole
// and flushed once. We seed a fixture with MORE lines than `flushEvery`,
// stream it through the SAME reader path the production code uses, and assert:
//   (1) more than one batch was flushed (proves the cadence fires mid-file),
//   (2) concatenating every flushed batch + the final drain is output-equivalent
//       to a single-pass `__testExtractCodexJsonlLines` over the same lines
//       (proves streaming did NOT change the extracted counts).
describe("codex streaming flush cadence", () => {
    const sessionMeta = JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00.000Z",
        payload: {
            id: "codex-flush-cadence",
            cwd: "/Users/necmttn/Projects/ax",
            timestamp: "2026-06-01T10:00:00.000Z",
        },
    });

    // Each response_item with a fresh seq produces one turn + one provider event;
    // function_call items also produce a tool call + invocation. We emit enough
    // lines to cross at least two flush boundaries.
    const flushEvery = DEFAULT_CODEX_FLUSH_EVERY;
    const lineCount = flushEvery * 2 + 5;

    const bodyLines = Array.from({ length: lineCount }, (_, i) => {
        const ts = new Date(Date.UTC(2026, 5, 1, 10, 0, 0) + (i + 1) * 1000).toISOString();
        // Alternate plain messages and function calls so batches carry a mix
        // of turns / tool calls / invocations.
        if (i % 2 === 0) {
            return JSON.stringify({
                type: "response_item",
                timestamp: ts,
                payload: {
                    type: "message",
                    id: `msg-${i}`,
                    role: "assistant",
                    content: [{ type: "output_text", text: `line ${i}` }],
                },
            });
        }
        return JSON.stringify({
            type: "response_item",
            timestamp: ts,
            payload: {
                type: "function_call",
                name: "exec_command",
                call_id: `call_${i}`,
                arguments: JSON.stringify({ cmd: `echo ${i}` }),
            },
        });
    });

    const allLines = [sessionMeta, ...bodyLines];
    const content = allLines.join("\n");

    test("flushes multiple batches and stays output-equivalent to single-pass", async () => {
        const path = "/codex/sessions/2026/06/big.jsonl";
        const batches = await Effect.runPromise(
            __testStreamCodexFileBatches(path, flushEvery).pipe(
                Effect.provide(Layer.mergeAll(layerTestFileSystem({ [path]: content }), Path.layer)),
            ),
        );

        // (1) The cadence fired mid-file: more than one batch was produced.
        expect(batches.length).toBeGreaterThan(1);

        // (2) Output-equivalence vs the single-pass oracle.
        const single = __testExtractCodexJsonlLines(allLines);
        expect(single).not.toBeNull();

        const sum = (pick: (b: (typeof batches)[number]) => number) =>
            batches.reduce((acc, b) => acc + pick(b), 0);

        expect(sum((b) => b.turns.length)).toBe(single!.turns.length);
        expect(sum((b) => b.toolCalls.length)).toBe(single!.toolCalls.length);
        expect(sum((b) => b.invocations.length)).toBe(single!.invocations.length);
        expect(sum((b) => b.providerEvents.length)).toBe(single!.providerEvents.length);
        expect(sum((b) => b.skillRelations.length)).toBe(single!.skillRelations.length);
        expect(sum((b) => b.planSnapshots.length)).toBe(single!.planSnapshots.length);
        // Parent edges are the ONE count that legitimately differs: when a
        // parent event was flushed in an earlier batch, the streaming drain
        // materializes a cross-batch `parentEdges` row that a single `drain(true)`
        // pass collapses (it never needs the edge because parent + child live in
        // the same final batch). So streaming emits >= single-pass - documented
        // behavior (see the `__testStreamCodexJsonlLines` parent-edge test), not
        // a regression. The cross-batch edges are exactly what proves the cadence
        // fired mid-file.
        expect(sum((b) => b.parentEdges.length)).toBeGreaterThanOrEqual(single!.parentEdges.length);

        // First-batch ordering: the first flushed batch carries the session.
        expect(batches[0]?.session?.id).toBe("codex-flush-cadence");
    });
});
