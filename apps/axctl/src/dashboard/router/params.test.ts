import { describe, expect, test } from "bun:test";
import { csvParam, numberParam, optionalNumberParam } from "./params.ts";

const url = (qs: string): URL => new URL(`http://h/api/x${qs}`);

describe("numberParam", () => {
    test("parses finite numbers", () => {
        expect(numberParam(url("?limit=25"), "limit", 50)).toBe(25);
    });
    test("missing -> fallback", () => {
        expect(numberParam(url(""), "limit", 50)).toBe(50);
    });
    test("garbage -> fallback (legacy Number.isFinite guard semantics)", () => {
        expect(numberParam(url("?limit=abc"), "limit", 50)).toBe(50);
    });
});

describe("optionalNumberParam", () => {
    test("present + finite -> number", () => {
        expect(optionalNumberParam(url("?minCount=3"), "minCount")).toBe(3);
    });
    test("missing -> undefined", () => {
        expect(optionalNumberParam(url(""), "minCount")).toBeUndefined();
    });
    test("empty -> undefined", () => {
        expect(optionalNumberParam(url("?minCount="), "minCount")).toBeUndefined();
    });
    test("garbage -> undefined", () => {
        expect(optionalNumberParam(url("?minCount=x"), "minCount")).toBeUndefined();
    });
});

describe("csvParam", () => {
    test("splits, trims, drops empties (sessions/compare ids semantics)", () => {
        expect(csvParam(url("?ids=a,%20b%20,,c"), "ids")).toEqual(["a", "b", "c"]);
    });
    test("missing -> empty array", () => {
        expect(csvParam(url(""), "ids")).toEqual([]);
    });
});
