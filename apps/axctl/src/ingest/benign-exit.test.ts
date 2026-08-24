import { describe, expect, test } from "bun:test";
import { isBenignSearchMiss } from "./benign-exit.ts";

describe("isBenignSearchMiss (#1022)", () => {
    test("rg/grep/fd/find exit 1 is a benign no-match", () => {
        for (const cmd of ["rg needle", "grep -r foo", "fd '\\.ts$'", "find . -name x"]) {
            expect(isBenignSearchMiss(cmd, 1, "")).toBe(true);
        }
    });

    test("no-match evidence text counts even without exit 1", () => {
        expect(isBenignSearchMiss("rg needle", null, "no matches found")).toBe(true);
        expect(isBenignSearchMiss("grep foo", 0, "0 results")).toBe(true);
    });

    test("a search tool that failed for a real reason is NOT benign", () => {
        // exit 2 = rg usage error, and no no-match text -> a genuine failure.
        expect(isBenignSearchMiss("rg --bad-flag", 2, "unknown option")).toBe(false);
    });

    test("non-search commands are never benign, whatever the exit code", () => {
        expect(isBenignSearchMiss("bun test", 1, "1 fail")).toBe(false);
        expect(isBenignSearchMiss("tsc --noEmit", 1, "type error")).toBe(false);
        // Word-boundary: a path that merely contains "find" is not the tool.
        expect(isBenignSearchMiss("cargo findutils-build", 1, "")).toBe(false);
    });
});
