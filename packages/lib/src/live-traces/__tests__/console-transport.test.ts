/**
 * ConsoleTransport stderr behaviour (Task #4).
 *
 * The console transport MUST write to `process.stderr` and never to
 * `process.stdout`, so that machine-readable CLI output (e.g.
 * `axctl ingest --progress=json`) stays clean.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ConsoleTransport } from "../transports/console.ts";
import { traceEnd, traceStart, type TraceEvent } from "../types.ts";

describe("ConsoleTransport", () => {
    let stderrWrites: string[];
    let stdoutWrites: string[];
    let origStderrWrite: typeof process.stderr.write;
    let origStdoutWrite: typeof process.stdout.write;

    beforeEach(() => {
        stderrWrites = [];
        stdoutWrites = [];
        origStderrWrite = process.stderr.write.bind(process.stderr);
        origStdoutWrite = process.stdout.write.bind(process.stdout);
        // Cast: we only need the (chunk) overload; mocking the union signature
        // exactly is noisy and irrelevant to what we assert.
        (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
            stderrWrites.push(String(chunk));
            return true;
        };
        (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
            stdoutWrites.push(String(chunk));
            return true;
        };
    });

    afterEach(() => {
        process.stderr.write = origStderrWrite;
        process.stdout.write = origStdoutWrite;
    });

    it("writes events to stderr, not stdout", async () => {
        const event: TraceEvent = traceStart("test:stderr", "smoke", { type: "user", id: "u1" });
        await Effect.runPromise(ConsoleTransport.send([event]));

        // Captured exactly one stderr line for the one event.
        expect(stderrWrites.length).toBe(1);
        expect(stderrWrites[0]).toContain("[live-trace] TraceStart");
        expect(stderrWrites[0]?.endsWith("\n")).toBe(true);

        // Stdout MUST stay completely untouched - this is the load-bearing
        // contract for `--progress=json` not getting corrupted.
        expect(stdoutWrites.length).toBe(0);
    });

    it("writes one stderr line per event in a batch", async () => {
        const batch: TraceEvent[] = [
            traceStart("t:1", "a", { type: "user", id: "u1" }),
            traceEnd("t:1", "completed", 0),
        ];
        await Effect.runPromise(ConsoleTransport.send(batch));
        expect(stderrWrites.length).toBe(2);
        expect(stdoutWrites.length).toBe(0);
    });
});
