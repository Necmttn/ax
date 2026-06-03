import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { extractFileWithSessionId } from "./transcripts.ts";

// The processing call site (ingestTranscripts ~1382) catches NotFound → null
// so a vanished transcript SKIPS instead of aborting the whole run; the
// watermark is NOT committed for the skipped file. `extractFileWithSessionId`
// itself simply propagates the PlatformError; we replicate the call-site catch
// here to assert the end-to-end skip-vs-reraise contract.
const runWithSkip = (
    eff: Effect.Effect<unknown, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
) =>
    eff.pipe(
        Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(e),
        ),
    );

describe("vanished transcript file", () => {
    test("an absent file SKIPS (Success null), not a fatal failure", async () => {
        const path = "/transcripts/-proj/gone.jsonl";
        const eff = runWithSkip(
            extractFileWithSessionId(path, "-proj", "session-gone"),
        ).pipe(Effect.provide(Layer.mergeAll(layerTestFileSystem({}), Path.layer)));

        const exit = await Effect.runPromiseExit(eff);
        expect(exit._tag).toBe("Success");
        if (exit._tag === "Success") {
            expect(exit.value).toBeNull();
        }
    });

    test("a non-NotFound failure (PermissionDenied) RE-RAISES, never swallowed as vanished", async () => {
        const path = "/transcripts/-proj/locked.jsonl";
        const permissionDenied = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "stream",
            pathOrDescriptor: path,
        });
        const eff = runWithSkip(
            extractFileWithSessionId(path, "-proj", "session-locked"),
        ).pipe(
            Effect.provide(
                Layer.mergeAll(
                    layerTestFileSystem({}, { errors: { [path]: permissionDenied } }),
                    Path.layer,
                ),
            ),
        );

        const exit = await Effect.runPromiseExit(eff);
        expect(exit._tag).toBe("Failure");
    });
});
