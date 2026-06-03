import { describe, expect, test } from "bun:test";
import { Effect, Layer, Path, PlatformError } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { skipNotFound } from "@ax/lib/shared/fs-error";
import { __testStreamCodexFile, __testStreamCodexFileGuarded } from "./codex.ts";

// `__testStreamCodexFile` streams a codex jsonl file through the SAME
// `FileSystem.stream` + `splitLines` + per-line flush-cadence path the
// production reader uses, returning the extractor's `finish()` result. A
// VANISHED session file surfaces as a typed NotFound `PlatformError`; the
// production call site catches it and SKIPS the candidate (does NOT abort the
// run). We replicate that NotFound→null catch here to assert the contract,
// and prove a non-NotFound failure (PermissionDenied) RE-RAISES.
const runWithSkip = (
    eff: Effect.Effect<unknown, PlatformError.PlatformError, never>,
) =>
    eff.pipe(
        skipNotFound(null as unknown),
    );

describe("vanished codex session file", () => {
    test("an absent file SKIPS (Success null), not a fatal failure", async () => {
        const path = "/codex/sessions/2026/06/gone.jsonl";
        const eff = __testStreamCodexFile(path).pipe(
            Effect.provide(Layer.mergeAll(layerTestFileSystem({}), Path.layer)),
        );

        const exit = await Effect.runPromiseExit(runWithSkip(eff));
        expect(exit._tag).toBe("Success");
        if (exit._tag === "Success") {
            expect(exit.value).toBeNull();
        }
    });

    test("a non-NotFound failure (PermissionDenied) RE-RAISES, never swallowed as vanished", async () => {
        const path = "/codex/sessions/2026/06/locked.jsonl";
        const permissionDenied = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "stream",
            pathOrDescriptor: path,
        });
        const eff = __testStreamCodexFile(path).pipe(
            Effect.provide(
                Layer.mergeAll(
                    layerTestFileSystem({}, { errors: { [path]: permissionDenied } }),
                    Path.layer,
                ),
            ),
        );

        const exit = await Effect.runPromiseExit(runWithSkip(eff));
        expect(exit._tag).toBe("Failure");
    });

    test("a present file streams to a parsed extract (session + turns)", async () => {
        const path = "/codex/sessions/2026/06/present.jsonl";
        const content = [
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-06-01T10:00:00.000Z",
                payload: {
                    id: "codex-present",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-06-01T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-06-01T10:00:01.000Z",
                payload: {
                    type: "message",
                    id: "msg-1",
                    role: "user",
                    content: [{ type: "input_text", text: "hello codex" }],
                },
            }),
        ].join("\n");

        const eff = __testStreamCodexFile(path).pipe(
            Effect.provide(Layer.mergeAll(layerTestFileSystem({ [path]: content }), Path.layer)),
        );

        const extract = await Effect.runPromise(eff);
        expect(extract).not.toBeNull();
        expect(extract?.session.id).toBe("codex-present");
        expect(extract?.turns).toHaveLength(1);
        expect(extract?.turns[0]?.text).toBe("hello codex");
    });
});

// Regression for the mid-stream NotFound guard: production flushes batches to
// the DB every `flushEvery` lines. If NotFound strikes AFTER a flush already
// persisted partial rows, the candidate must NOT be reported as a benign
// "skip" (that would leave a partial/incomplete session in the DB while stats
// say it was skipped - a silent partial ingest). It must propagate as a loud
// failure. A NotFound BEFORE any flush stays a benign skip (nothing persisted).
describe("codex mid-stream NotFound after a flush", () => {
    const flushEvery = 2;
    const sessionMeta = JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00.000Z",
        payload: {
            id: "codex-midstream",
            cwd: "/Users/necmttn/Projects/ax",
            timestamp: "2026-06-01T10:00:00.000Z",
        },
    });
    const bodyLine = (i: number) =>
        JSON.stringify({
            type: "response_item",
            timestamp: new Date(Date.UTC(2026, 5, 1, 10, 0, 0) + (i + 1) * 1000).toISOString(),
            payload: {
                type: "message",
                id: `msg-${i}`,
                role: "assistant",
                content: [{ type: "output_text", text: `line ${i}` }],
            },
        });
    // session_meta + enough body lines to cross at least one flush boundary.
    const lines = [sessionMeta, ...Array.from({ length: flushEvery + 4 }, (_, i) => bodyLine(i))];
    const content = lines.join("\n");

    const midStreamNotFound = (path: string) =>
        PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "stream",
            pathOrDescriptor: path,
        });

    test("NotFound AFTER a flush propagates as a Failure, NOT a silent skip", async () => {
        const path = "/codex/sessions/2026/06/midstream-fail.jsonl";
        const eff = __testStreamCodexFileGuarded(path, flushEvery).pipe(
            Effect.provide(
                Layer.mergeAll(
                    layerTestFileSystem(
                        { [path]: content },
                        {
                            // Fail well past the first flush boundary so a batch
                            // (with the session) was already "persisted".
                            streamFailAfter: {
                                [path]: { afterBytes: content.length, error: midStreamNotFound(path) },
                            },
                        },
                    ),
                    Path.layer,
                ),
            ),
        );

        const exit = await Effect.runPromiseExit(eff);
        expect(exit._tag).toBe("Failure");
    });

    test("NotFound BEFORE any flush stays a benign skip", async () => {
        const path = "/codex/sessions/2026/06/midstream-early.jsonl";
        const eff = __testStreamCodexFileGuarded(path, flushEvery).pipe(
            Effect.provide(
                Layer.mergeAll(
                    // Empty seed: `stream` fails immediately with NotFound, so
                    // lineCount === 0 and nothing was persisted -> benign skip.
                    layerTestFileSystem({}),
                    Path.layer,
                ),
            ),
        );

        const outcome = await Effect.runPromise(eff);
        expect(outcome).toBe("skipped");
    });
});
