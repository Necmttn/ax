import { describe, it, expect } from "bun:test";
import { Effect, Exit, FileSystem, PlatformError } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { isNotFound, orAbsent, skipNotFound } from "./fs-error.ts";

const run = <A, E>(
    eff: Effect.Effect<A, E, FileSystem.FileSystem>,
    files: Record<string, string>,
    opts?: { readonly errors?: Record<string, PlatformError.PlatformError> },
) => Effect.runPromise(Effect.provide(eff, layerTestFileSystem(files, opts)));

const runExit = <A, E>(
    eff: Effect.Effect<A, E, FileSystem.FileSystem>,
    files: Record<string, string>,
    opts?: { readonly errors?: Record<string, PlatformError.PlatformError> },
) => Effect.runPromiseExit(Effect.provide(eff, layerTestFileSystem(files, opts)));

describe("isNotFound", () => {
    it("true for a NotFound SystemError reason", () => {
        const err = PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: "/gone",
        });
        expect(isNotFound(err)).toBe(true);
    });

    it("false for a non-NotFound (PermissionDenied) reason", () => {
        const err = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: "/locked",
        });
        expect(isNotFound(err)).toBe(false);
    });
});

describe("skipNotFound", () => {
    it("recovers a NotFound read to the fallback", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/nope").pipe(skipNotFound("FALLBACK"));
            }),
            {},
        );
        expect(out).toBe("FALLBACK");
    });

    it("re-raises a non-NotFound PlatformError (never swallows IO/permission errors)", async () => {
        const perm = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: "/locked",
        });
        const exit = await runExit(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/locked").pipe(skipNotFound("FALLBACK"));
            }),
            {},
            { errors: { "/locked": perm } },
        );
        expect(Exit.isFailure(exit)).toBe(true);
    });
});

describe("orAbsent", () => {
    it("recovers a NotFound read to the fallback", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/nope").pipe(orAbsent("FALLBACK"));
            }),
            {},
        );
        expect(out).toBe("FALLBACK");
    });

    it("recovers a non-NotFound PlatformError (PermissionDenied) to the fallback, unlike skipNotFound", async () => {
        const perm = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: "/locked",
        });
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/locked").pipe(orAbsent("FALLBACK"));
            }),
            {},
            { errors: { "/locked": perm } },
        );
        expect(out).toBe("FALLBACK");
    });

    it("recovers a probe (exists) PermissionDenied to the fallback", async () => {
        const perm = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "exists",
            pathOrDescriptor: "/locked/.git",
        });
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.exists("/locked/.git").pipe(orAbsent(false));
            }),
            {},
            { errors: { "/locked/.git": perm } },
        );
        expect(out).toBe(false);
    });
});
