import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Effect, Exit } from "effect";
import { wantsJson, catchDbErrorAndExit } from "./output.ts";
import { DbError } from "@ax/lib/errors";

// ---------------------------------------------------------------------------
// wantsJson
// ---------------------------------------------------------------------------

describe("wantsJson", () => {
    it("--json arg → true", () => {
        expect(wantsJson(["--json"])).toBe(true);
    });

    it("--json among others → true", () => {
        expect(wantsJson(["--limit=5", "--json", "--verbose"])).toBe(true);
    });

    it("no --json, TTY stdout → false", () => {
        // In test runner stdout is a pipe (isTTY is undefined/false), so we
        // temporarily override to simulate a TTY.
        const original = process.stdout.isTTY;
        Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });
        try {
            expect(wantsJson(["--limit=10"])).toBe(false);
        } finally {
            Object.defineProperty(process.stdout, "isTTY", { value: original, writable: true, configurable: true });
        }
    });

    it("non-TTY (piped) stdout → true", () => {
        const original = process.stdout.isTTY;
        Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true, configurable: true });
        try {
            expect(wantsJson([])).toBe(true);
        } finally {
            Object.defineProperty(process.stdout, "isTTY", { value: original, writable: true, configurable: true });
        }
    });
});

// ---------------------------------------------------------------------------
// catchDbErrorAndExit
// ---------------------------------------------------------------------------

describe("catchDbErrorAndExit", () => {
    let stderrOutput = "";
    let exitCode: number | undefined;
    let originalStderrWrite: typeof process.stderr.write;
    let originalExit: typeof process.exit;

    beforeEach(() => {
        stderrOutput = "";
        exitCode = undefined;
        originalStderrWrite = process.stderr.write.bind(process.stderr);
        originalExit = process.exit.bind(process);
        process.stderr.write = (msg: string | Uint8Array) => {
            stderrOutput += msg.toString();
            return true;
        };
        (process as NodeJS.Process).exit = ((code?: number) => {
            exitCode = code;
            // Don't actually exit - throw to stop execution flow in tests
            throw new Error(`process.exit(${code})`);
        }) as typeof process.exit;
    });

    afterEach(() => {
        process.stderr.write = originalStderrWrite;
        (process as NodeJS.Process).exit = originalExit;
    });

    it("DbError caught → writes correct message to stderr and calls exit(1)", async () => {
        const err = new DbError({ operation: "SELECT", message: "connection refused" });
        const eff: Effect.Effect<never, DbError> = Effect.fail(err);
        await Effect.runPromiseExit(eff.pipe(catchDbErrorAndExit("axctl test-cmd")));
        // process.exit throws in our mock, so the effect surfaces as a Die.
        expect(stderrOutput).toBe("axctl test-cmd: DB error - connection refused\n");
        expect(exitCode).toBe(1);
    });

    it("non-DbError propagates unchanged when effect is cast as DbError channel", async () => {
        // Simulate a real-world non-DbError passing through the handler
        // by fabricating an effect whose channel is DbError at the type level
        // but fails with a different tagged value at runtime.
        const eff: Effect.Effect<never, DbError> = Effect.die(new Error("runtime defect")) as unknown as Effect.Effect<never, DbError>;
        const exit = await Effect.runPromiseExit(eff.pipe(catchDbErrorAndExit("axctl test-cmd")));
        // Die passes through catchTag unchanged (catchTag only handles typed errors)
        expect(Exit.isFailure(exit)).toBe(true);
        expect(stderrOutput).toBe("");
        expect(exitCode).toBeUndefined();
    });

    it("successful effect passes through unchanged", async () => {
        const eff: Effect.Effect<number, DbError> = Effect.succeed(42);
        const result = await Effect.runPromise(eff.pipe(catchDbErrorAndExit("axctl test-cmd")));
        expect(result).toBe(42);
        expect(stderrOutput).toBe("");
        expect(exitCode).toBeUndefined();
    });
});
