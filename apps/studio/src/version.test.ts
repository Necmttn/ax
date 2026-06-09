import { describe, expect, test } from "bun:test";
import { cmpSemver, STUDIO_VERSION } from "./version.ts";

describe("cmpSemver (studio↔daemon version mismatch)", () => {
    test("equal versions → 0 (no nag)", () => {
        expect(cmpSemver("0.18.0", "0.18.0")).toBe(0);
    });
    test("daemon older than studio → negative (→ run axctl update)", () => {
        expect(cmpSemver("0.16.0", "0.18.0")).toBe(-1);
        expect(cmpSemver("0.17.9", "0.18.0")).toBe(-1);
    });
    test("daemon newer than studio → positive (→ studio bundle stale)", () => {
        expect(cmpSemver("0.19.0", "0.18.0")).toBe(1);
        expect(cmpSemver("1.0.0", "0.18.0")).toBe(1);
    });
    test("compares minor + patch, not just major", () => {
        expect(cmpSemver("0.18.1", "0.18.0")).toBe(1);
        expect(cmpSemver("0.18.0", "0.18.1")).toBe(-1);
    });
    test("tolerates missing / garbage segments (treated as 0)", () => {
        expect(cmpSemver("0.18", "0.18.0")).toBe(0);
        expect(cmpSemver("", "0.0.0")).toBe(0);
        expect(cmpSemver("0.18.x", "0.18.0")).toBe(0);
    });
});

describe("STUDIO_VERSION", () => {
    test("falls back to a semver string when the build-time define is absent", () => {
        // In bun:test there is no vite `define`, so the typeof guard yields the fallback.
        expect(STUDIO_VERSION).toBe("0.0.0");
    });
});
