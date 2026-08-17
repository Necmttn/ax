import { describe, expect, test, it } from "bun:test";
import {
    // typed row field access
    isRecord,
    stringField,
    stringFieldOr,
    dateField,
    numberFieldOrNull,
    countField,
    numberOrNull,
    numberOrZero,
    stringOrNull,
    recordIdString,
    // record-id key derivation
    isoTimestamp,
    nonEmptyString,
    recordKeyPart,
    safeKeyPart,
} from "./row-fields.ts";

// ============================================================================
// 1. TYPED ROW FIELD ACCESS
// ============================================================================

describe("isRecord", () => {
    test("true for plain object, false for array/null", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
    });
});

describe("stringField", () => {
    test("returns non-empty string, else null", () => {
        expect(stringField({ a: "x" }, "a")).toBe("x");
        expect(stringField({ a: "" }, "a")).toBe(null);
        expect(stringField({ a: 3 }, "a")).toBe(null);
    });
});

describe("dateField", () => {
    test("ISO string passthrough", () => {
        expect(dateField({ t: "2026-01-01T00:00:00.000Z" }, "t")).toBe(
            "2026-01-01T00:00:00.000Z",
        );
    });
    test("Date → ISO", () => {
        expect(dateField({ t: new Date("2026-01-01T00:00:00.000Z") }, "t")).toBe(
            "2026-01-01T00:00:00.000Z",
        );
    });
    test("missing → null", () => {
        expect(dateField({}, "t")).toBe(null);
    });
});

describe("numberFieldOrNull", () => {
    test("finite number passthrough, else null", () => {
        expect(numberFieldOrNull({ n: 3 }, "n")).toBe(3);
        expect(numberFieldOrNull({ n: "3" }, "n")).toBe(null);
    });
});

describe("countField", () => {
    test("coerces numeric-ish values, defaults to 0", () => {
        expect(countField({ n: 3 }, "n")).toBe(3);
        expect(countField({ n: "3" }, "n")).toBe(3);
        expect(countField({}, "n")).toBe(0);
        expect(countField({ n: Number.NEGATIVE_INFINITY }, "n")).toBe(0);
        expect(countField({ n: "junk" }, "n")).toBe(0);
    });
});

describe("recordIdString", () => {
    test("string passthrough", () => {
        expect(recordIdString("session:abc")).toBe("session:abc");
    });
    test("RecordId-like object → toString", () => {
        expect(recordIdString({ toString: () => "session:x" })).toBe("session:x");
    });
    test("null → null", () => {
        expect(recordIdString(null)).toBe(null);
    });
});

// New helpers: stringFieldOr, numberOrNull, numberOrZero, stringOrNull

describe("stringFieldOr", () => {
    test("returns string value unchanged", () => {
        expect(stringFieldOr({ model: "claude-opus" }, "model")).toBe("claude-opus");
    });
    test("coerces a number field to string (key distinguisher: stringField would return null)", () => {
        // String(3 ?? "") = "3" vs stringField = null
        expect(stringFieldOr({ n: 3 }, "n")).toBe("3");
        expect(stringField({ n: 3 }, "n")).toBe(null); // strict comparison
    });
    test("coerces a RecordId-like object via toString (no [object Object] regression)", () => {
        const rid = { toString: () => "session:abc" };
        expect(stringFieldOr({ id: rid }, "id")).toBe("session:abc");
        expect(stringFieldOr({ id: rid }, "id")).not.toContain("[object Object]");
    });
    test("null field → default empty string", () => {
        expect(stringFieldOr({ k: null }, "k")).toBe("");
    });
    test("undefined field (missing key) → default empty string", () => {
        expect(stringFieldOr({}, "k")).toBe("");
    });
    test("custom fallback is used for null/undefined", () => {
        expect(stringFieldOr({ k: null }, "k", "fallback")).toBe("fallback");
        expect(stringFieldOr({}, "k", "(missing)")).toBe("(missing)");
    });
    test("empty string is returned as-is (not null, not fallback)", () => {
        // String("" ?? "") stays "" - different from stringField which needs non-empty
        expect(stringFieldOr({ k: "" }, "k")).toBe("");
    });
    test("boolean field → string", () => {
        expect(stringFieldOr({ v: true }, "v")).toBe("true");
        expect(stringFieldOr({ v: false }, "v")).toBe("false");
    });
});

describe("numberOrNull", () => {
    test("finite number passthrough", () => {
        expect(numberOrNull(3)).toBe(3);
        expect(numberOrNull(0)).toBe(0);
        expect(numberOrNull(-1.5)).toBe(-1.5);
    });
    test("coerces a numeric string to number", () => {
        expect(numberOrNull("3")).toBe(3);
        expect(numberOrNull("0")).toBe(0);
    });
    test("null → null (not 0, unlike countField)", () => {
        expect(numberOrNull(null)).toBe(null);
    });
    test("undefined → null", () => {
        expect(numberOrNull(undefined)).toBe(null);
    });
    test("NaN → null (finite guard)", () => {
        expect(numberOrNull(Number.NaN)).toBe(null);
    });
    test("Infinity → null (finite guard)", () => {
        expect(numberOrNull(Number.POSITIVE_INFINITY)).toBe(null);
        expect(numberOrNull(Number.NEGATIVE_INFINITY)).toBe(null);
    });
    test("non-numeric string → null", () => {
        expect(numberOrNull("junk")).toBe(null);
    });
    test("empty string → 0 (Number('') = 0 is finite)", () => {
        // This is the documented coercing semantics: Number("") = 0
        expect(numberOrNull("")).toBe(0);
    });
});

describe("numberOrZero", () => {
    test("finite number passthrough", () => {
        expect(numberOrZero(5)).toBe(5);
    });
    test("null → 0", () => {
        expect(numberOrZero(null)).toBe(0);
    });
    test("undefined → 0", () => {
        expect(numberOrZero(undefined)).toBe(0);
    });
    test("NaN → 0 (finite guard - the NaN-leak fix)", () => {
        expect(numberOrZero(Number.NaN)).toBe(0);
    });
    test("non-numeric string → 0", () => {
        expect(numberOrZero("junk")).toBe(0);
    });
    test("numeric string → coerced number", () => {
        expect(numberOrZero("42")).toBe(42);
    });
});

describe("stringOrNull", () => {
    test("non-empty string passthrough", () => {
        expect(stringOrNull("x")).toBe("x");
    });
    test("empty string → null", () => {
        expect(stringOrNull("")).toBe(null);
    });
    test("number → null (strict, no coercion; use stringFieldOr for coercion)", () => {
        expect(stringOrNull(3)).toBe(null);
    });
    test("null → null", () => {
        expect(stringOrNull(null)).toBe(null);
    });
    test("undefined → null", () => {
        expect(stringOrNull(undefined)).toBe(null);
    });
    test("object → null", () => {
        expect(stringOrNull({})).toBe(null);
    });
});

// ============================================================================
// 2. RECORD-ID KEY DERIVATION
// ============================================================================

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

    it("handles a DateTime-like object via its toISOString() method", () => {
        class DateTime {
            toISOString() { return "2024-06-01T12:00:00.000Z"; }
        }
        expect(isoTimestamp(new DateTime() as unknown as Date)).toBe("2024-06-01T12:00:00.000Z");
    });

    // #670 regression: `bun build --compile` renames the bundled SDK class
    // (observed as `DateTime3`), so a `constructor.name === "DateTime"` check
    // silently fell through to epoch (1970) ONLY in the compiled binary.
    // Duck-typing on toISOString() is rename-proof.
    it("handles a DateTime whose class was renamed by the bundler (DateTime3)", () => {
        class DateTime3 {
            toISOString() { return "2026-07-08T01:49:50.000Z"; }
        }
        const renamed = new DateTime3();
        expect(renamed.constructor.name).toBe("DateTime3"); // guard the premise
        expect(isoTimestamp(renamed as unknown as Date)).toBe("2026-07-08T01:49:50.000Z");
    });

    it("falls through to epoch for an object with no toISOString()", () => {
        const notADate = { constructor: { name: "DateTime" }, toString() { return "nope"; } };
        expect(isoTimestamp(notADate as unknown as Date)).toBe(new Date(0).toISOString());
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

describe("isoTimestamp - warn on epoch fallback", () => {
    // Helper: capture and restore console.warn around a callback.
    const withWarnSpy = (fn: (calls: unknown[][]) => void): void => {
        const original = console.warn;
        const calls: unknown[][] = [];
        console.warn = (...args: unknown[]) => { calls.push(args); };
        try {
            fn(calls);
        } finally {
            console.warn = original;
        }
    };

    it("does NOT warn for a valid Date", () => {
        withWarnSpy((calls) => {
            isoTimestamp(new Date("2024-01-15T10:30:00.000Z"));
            expect(calls.length).toBe(0);
        });
    });

    it("does NOT warn for a non-empty string", () => {
        withWarnSpy((calls) => {
            isoTimestamp("2024-03-01T00:00:00.000Z");
            expect(calls.length).toBe(0);
        });
    });

    it("does NOT warn for a DateTime-like object", () => {
        withWarnSpy((calls) => {
            const fakeDateTime = {
                toISOString() { return "2024-06-01T12:00:00.000Z"; },
            };
            isoTimestamp(fakeDateTime as unknown as Date);
            expect(calls.length).toBe(0);
        });
    });

    it("warns exactly once and returns epoch for null", () => {
        withWarnSpy((calls) => {
            const result = isoTimestamp(null);
            expect(result).toBe(new Date(0).toISOString());
            expect(calls.length).toBe(1);
            expect(String(calls[0]![0])).toContain("[ax] isoTimestamp");
        });
    });

    it("warns exactly once and returns epoch for undefined", () => {
        withWarnSpy((calls) => {
            const result = isoTimestamp(undefined);
            expect(result).toBe(new Date(0).toISOString());
            expect(calls.length).toBe(1);
            expect(String(calls[0]![0])).toContain("[ax] isoTimestamp");
        });
    });

    it("warns exactly once and returns epoch for empty string", () => {
        withWarnSpy((calls) => {
            const result = isoTimestamp("" as unknown as Date);
            expect(result).toBe(new Date(0).toISOString());
            expect(calls.length).toBe(1);
            expect(String(calls[0]![0])).toContain("[ax] isoTimestamp");
        });
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
