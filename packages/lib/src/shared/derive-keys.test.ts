import { describe, expect, it } from "bun:test";
import { isoTimestamp, nonEmptyString, recordKeyPart, safeKeyPart } from "./derive-keys.ts";

describe("safeKeyPart", () => {
    it("replaces colons with double underscores", () => {
        expect(safeKeyPart("foo:bar")).toBe("foo__bar");
    });

    it("replaces non-alphanumeric characters with underscores", () => {
        expect(safeKeyPart("hello world")).toBe("hello_world");
    });

    it("collapses runs of 3+ underscores to double underscore", () => {
        // colon becomes __ then _ from non-alnum, giving ___ → __
        expect(safeKeyPart("a: b")).toBe("a__b");
    });

    it("trims leading and trailing underscores", () => {
        expect(safeKeyPart("_foo_bar_")).toBe("foo_bar");
    });

    it("slices output at 96 chars", () => {
        const long = "a".repeat(200);
        const result = safeKeyPart(long);
        expect(result.length).toBe(96);
    });

    it("returns exactly 96 chars when sanitized result is longer than 96", () => {
        const long = "x".repeat(100);
        expect(safeKeyPart(long).length).toBe(96);
    });

    it("returns a hash when sanitized result is empty", () => {
        // Only special chars → sanitized = "" → hash
        const result = safeKeyPart("---");
        expect(result).toBe(Bun.hash("---").toString(16));
    });

    it("handles plugin-namespaced names (colon)", () => {
        expect(safeKeyPart("plugin:skill-name")).toBe("plugin__skill_name");
    });
});

describe("recordKeyPart", () => {
    it("strips expected table prefix", () => {
        expect(recordKeyPart("session:abc123", "session")).toBe("abc123");
    });

    it("strips any table prefix when expectedTable not given", () => {
        expect(recordKeyPart("turn:xyz", undefined)).toBe("xyz");
    });

    it("strips backtick quoting from key part", () => {
        expect(recordKeyPart("session:`my-key`", "session")).toBe("my-key");
    });

    it("strips angle-bracket quoting from key part", () => {
        expect(recordKeyPart("session:⟨my-key⟩", "session")).toBe("my-key");
    });

    it("handles .id objects", () => {
        expect(recordKeyPart({ id: "abc" })).toBe("abc");
    });

    it("returns null for .id objects with null id", () => {
        expect(recordKeyPart({ id: null })).toBeNull();
    });

    it("returns null for null input", () => {
        expect(recordKeyPart(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
        expect(recordKeyPart(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
        expect(recordKeyPart("   ")).toBeNull();
    });

    it("returns null when key part after stripping is empty", () => {
        expect(recordKeyPart("session:", "session")).toBeNull();
    });

    it("strips unexpected table prefix generically", () => {
        expect(recordKeyPart("tool:abc", "session")).toBe("abc");
    });
});

describe("isoTimestamp", () => {
    it("returns ISO string for a Date object", () => {
        const d = new Date("2024-01-15T10:30:00.000Z");
        expect(isoTimestamp(d)).toBe("2024-01-15T10:30:00.000Z");
    });

    it("passes through a non-empty string unchanged", () => {
        expect(isoTimestamp("2024-03-01T00:00:00.000Z")).toBe("2024-03-01T00:00:00.000Z");
    });

    it("handles SurrealDB DateTime objects via constructor name check", () => {
        const fakeDateTime = {
            constructor: { name: "DateTime" },
            toString() { return "2024-06-01T12:00:00.000Z"; },
        };
        // Cast to satisfy TS - at runtime this is an object with the right constructor name
        expect(isoTimestamp(fakeDateTime as unknown as Date)).toBe("2024-06-01T12:00:00.000Z");
    });

    it("returns epoch ISO for null", () => {
        expect(isoTimestamp(null)).toBe(new Date(0).toISOString());
    });

    it("returns epoch ISO for undefined", () => {
        expect(isoTimestamp(undefined)).toBe(new Date(0).toISOString());
    });

    it("returns epoch ISO for empty string", () => {
        // empty string → not a non-empty string → falls through to epoch
        expect(isoTimestamp("" as unknown as Date)).toBe(new Date(0).toISOString());
    });
});

describe("nonEmptyString", () => {
    it("returns the trimmed string when non-empty", () => {
        expect(nonEmptyString("  hello  ")).toBe("hello");
    });

    it("returns null for a blank string", () => {
        expect(nonEmptyString("   ")).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(nonEmptyString("")).toBeNull();
    });

    it("returns null for null", () => {
        expect(nonEmptyString(null)).toBeNull();
    });

    it("returns null for undefined", () => {
        expect(nonEmptyString(undefined)).toBeNull();
    });

    it("returns null for a number", () => {
        expect(nonEmptyString(42)).toBeNull();
    });

    it("returns null for an object", () => {
        expect(nonEmptyString({ x: 1 })).toBeNull();
    });
});
