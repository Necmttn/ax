import { describe, expect, test } from "bun:test";
import { Effect, Layer, Path, PlatformError } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { skipNotFound } from "@ax/lib/shared/fs-error";
import { __testStreamCodexFile } from "./codex.ts";

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
