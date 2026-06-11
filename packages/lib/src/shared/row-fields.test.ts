import { describe, expect, test } from "bun:test";
import { isRecord, stringField, dateField, numberFieldOrNull, countField, recordIdString } from "./row-fields.ts";

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
