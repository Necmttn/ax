import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Option } from "effect";
import {
    fail,
    parseCsvFlag,
    parseFileHints,
    parseOptionalPositiveDayWindow,
    requirePositiveInt,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------

describe("fail", () => {
    let errorOutput: string[] = [];
    let exitCode: number | undefined;
    let originalConsoleError: typeof console.error;
    let originalExit: typeof process.exit;

    beforeEach(() => {
        errorOutput = [];
        exitCode = undefined;
        originalConsoleError = console.error;
        originalExit = process.exit.bind(process);
        console.error = (...args: unknown[]) => {
            errorOutput.push(args.map(String).join(" "));
        };
        (process as NodeJS.Process).exit = ((code?: number) => {
            exitCode = code;
            // Don't actually exit - throw to stop execution flow in tests
            throw new Error(`process.exit(${code})`);
        }) as typeof process.exit;
    });

    afterEach(() => {
        console.error = originalConsoleError;
        (process as NodeJS.Process).exit = originalExit;
    });

    it("prints the message verbatim to stderr and exits with code 2", () => {
        expect(() => fail("axctl example: something went wrong")).toThrow("process.exit(2)");
        expect(errorOutput).toEqual(["axctl example: something went wrong"]);
        expect(exitCode).toBe(2);
    });

    it("requirePositiveInt delegates to fail with exact legacy wording", () => {
        expect(() => requirePositiveInt("sessions around", "days", 0)).toThrow("process.exit(2)");
        expect(errorOutput).toEqual([
            'axctl sessions around: --days must be a positive integer (got "0")',
        ]);
        expect(exitCode).toBe(2);
    });

    it("requirePositiveInt passes valid values through untouched", () => {
        expect(requirePositiveInt("sessions around", "days", 14)).toBe(14);
        expect(errorOutput).toEqual([]);
        expect(exitCode).toBeUndefined();
    });

    it("parseOptionalPositiveDayWindow accepts bare days and d-suffix days", () => {
        expect(parseOptionalPositiveDayWindow("skills weighted", "window", undefined)).toBeUndefined();
        expect(parseOptionalPositiveDayWindow("skills weighted", "window", "14")).toBe(14);
        expect(parseOptionalPositiveDayWindow("skills weighted", "window", "14d")).toBe(14);
        expect(parseOptionalPositiveDayWindow("skills weighted", "window", "14D")).toBe(14);
    });

    it("parseOptionalPositiveDayWindow rejects malformed windows with a usage error", () => {
        expect(() => parseOptionalPositiveDayWindow("skills weighted", "window", "2w")).toThrow("process.exit(2)");
        expect(errorOutput).toEqual([
            'axctl skills weighted: --window must be a positive integer day window like 14 or 14d (got "2w")',
        ]);
        expect(exitCode).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// parseCsvFlag / parseFileHints
// ---------------------------------------------------------------------------

describe("parseCsvFlag", () => {
    it("splits on commas and trims entries", () => {
        expect(parseCsvFlag("a, b ,c")).toEqual(["a", "b", "c"]);
    });

    it("drops empty entries (leading/trailing/double commas)", () => {
        expect(parseCsvFlag(",a,,b,")).toEqual(["a", "b"]);
    });

    it("returns [] for null, undefined, and empty string", () => {
        expect(parseCsvFlag(null)).toEqual([]);
        expect(parseCsvFlag(undefined)).toEqual([]);
        expect(parseCsvFlag("")).toEqual([]);
    });

    it("keeps = inside entries intact (route-input style values)", () => {
        expect(parseCsvFlag("key=value, flag")).toEqual(["key=value", "flag"]);
    });
});

describe("parseFileHints", () => {
    it("None → []", () => {
        expect(parseFileHints(Option.none())).toEqual([]);
    });

    it("Some csv → trimmed non-empty entries", () => {
        expect(parseFileHints(Option.some(" a.md , b.md "))).toEqual(["a.md", "b.md"]);
    });
});
