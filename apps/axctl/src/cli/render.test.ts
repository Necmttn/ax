import { describe, expect, test } from "bun:test";
import { compactPrint, integer, pct, textOf, truncate, truncateText, usd } from "./render.ts";

// These tests snapshot the EXACT strings the formatters produced before they
// were unified out of costs.ts / ax-cost.ts / ax-dispatches.ts / ax-routing.ts /
// profile.ts / insights-format.ts / classifiers-explain-format.ts. The render
// module's contract is byte-identical output - do not "fix" expectations.

describe("usd", () => {
    test("formats numbers with 4 decimals by default", () => {
        expect(usd(0)).toBe("$0.0000");
        expect(usd(0.1234567)).toBe("$0.1235");
        expect(usd(12.5)).toBe("$12.5000");
        expect(usd(-3.21)).toBe("$-3.2100");
    });

    test("coerces numeric strings (costs.ts behaviour)", () => {
        expect(usd("1.5")).toBe("$1.5000");
        expect(usd("not-a-number")).toBe("$0.0000");
    });

    test("non-finite and non-numeric values render zero", () => {
        expect(usd(NaN)).toBe("$0.0000");
        expect(usd(Infinity)).toBe("$0.0000");
        expect(usd(null)).toBe("$0.0000");
        expect(usd(undefined)).toBe("$0.0000");
        expect(usd({})).toBe("$0.0000");
    });

    test("decimals=2 reproduces ax-routing.ts output", () => {
        expect(usd(0, 2)).toBe("$0.00");
        expect(usd(12.345, 2)).toBe("$12.35");
        expect(usd(NaN, 2)).toBe("$0.00");
    });
});

describe("integer", () => {
    test("truncates and groups with en-US separators", () => {
        expect(integer(0)).toBe("0");
        expect(integer(1234567)).toBe("1,234,567");
        expect(integer(12.9)).toBe("12");
        expect(integer(-1234.9)).toBe("-1,234");
    });

    test("coerces numeric strings", () => {
        expect(integer("4200")).toBe("4,200");
    });

    test("non-finite renders 0", () => {
        expect(integer(NaN)).toBe("0");
        expect(integer(Infinity)).toBe("0");
        expect(integer(null)).toBe("0");
        expect(integer(undefined)).toBe("0");
    });
});

describe("pct", () => {
    test("one decimal with percent sign", () => {
        expect(pct(0)).toBe("0.0%");
        expect(pct(12.34)).toBe("12.3%");
        expect(pct(100)).toBe("100.0%");
    });

    test("non-finite renders 0.0%", () => {
        expect(pct(NaN)).toBe("0.0%");
        expect(pct(Infinity)).toBe("0.0%");
    });
});

describe("truncate", () => {
    test("nullish/empty input renders empty string", () => {
        expect(truncate(null, 10)).toBe("");
        expect(truncate("", 10)).toBe("");
    });

    test("short strings pass through unchanged", () => {
        expect(truncate("abc", 5)).toBe("abc");
        expect(truncate("abcde", 5)).toBe("abcde");
    });

    test("overflow replaces the last kept char with an ellipsis", () => {
        expect(truncate("abcdef", 5)).toBe("abcd…");
        expect(truncate("hello world", 8)).toBe("hello w…");
    });

    test("preserves internal whitespace (table-cell variant)", () => {
        expect(truncate("a  b", 10)).toBe("a  b");
    });
});

describe("textOf", () => {
    test("strings pass through, nullish renders empty", () => {
        expect(textOf("x")).toBe("x");
        expect(textOf(null)).toBe("");
        expect(textOf(undefined)).toBe("");
    });

    test("other values stringify", () => {
        expect(textOf(42)).toBe("42");
        expect(textOf(true)).toBe("true");
    });
});

describe("truncateText", () => {
    test("collapses whitespace runs and trims", () => {
        expect(truncateText("  a  b\n\tc  ", 180)).toBe("a b c");
    });

    test("short text passes through after collapsing", () => {
        expect(truncateText("hello", 5)).toBe("hello");
    });

    test("overflow trims trailing space before the ellipsis", () => {
        expect(truncateText("aaaa bbbb", 6)).toBe("aaaa…");
        expect(truncateText("abcdefgh", 5)).toBe("abcd…");
    });

    test("non-string values coerce via textOf", () => {
        expect(truncateText(1234, 10)).toBe("1234");
        expect(truncateText(null, 10)).toBe("");
    });

    test("max=0 renders a bare ellipsis for non-empty text", () => {
        expect(truncateText("abc", 0)).toBe("…");
    });
});

describe("compactPrint", () => {
    test("byte-identical to bare JSON.stringify", () => {
        const value = { b: 1, a: [1, "x", null], nested: { k: true } };
        expect(compactPrint(value)).toBe(JSON.stringify(value));
        expect(compactPrint(value)).toBe('{"b":1,"a":[1,"x",null],"nested":{"k":true}}');
    });

    test("no pretty-print whitespace", () => {
        expect(compactPrint({ a: 1 })).toBe('{"a":1}');
        expect(compactPrint([1, 2])).toBe("[1,2]");
    });
});
