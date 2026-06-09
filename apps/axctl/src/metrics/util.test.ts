import { describe, expect, test } from "bun:test";
import { fillDefaults, isoMs, sessionRefList } from "./util.ts";

describe("sessionRefList", () => {
    test("builds a comma-joined record-literal IN-list body", () => {
        // Already-formed `session:`key`` ids round-trip to themselves.
        expect(sessionRefList(["session:`a`", "session:`b`"])).toBe("session:`a`, session:`b`");
    });
    test("empty input → empty string", () => {
        expect(sessionRefList([])).toBe("");
    });
});

describe("fillDefaults", () => {
    test("sets only absent ids, leaves present ones untouched, returns the same map", () => {
        const map = new Map<string, number>([["x", 5]]);
        const out = fillDefaults(map, ["x", "y", "z"], 0);
        expect(out).toBe(map);
        expect(out.get("x")).toBe(5);
        expect(out.get("y")).toBe(0);
        expect(out.get("z")).toBe(0);
    });
    test("no-op when all ids present", () => {
        const map = new Map<string, number>([["a", 1], ["b", 2]]);
        fillDefaults(map, ["a", "b"], 99);
        expect(map.get("a")).toBe(1);
        expect(map.get("b")).toBe(2);
    });
});

describe("isoMs", () => {
    test("parses an ISO datetime to epoch ms", () => {
        expect(isoMs("1970-01-01T00:00:00.000Z")).toBe(0);
        expect(isoMs("2020-01-01T00:00:00.000Z")).toBe(Date.UTC(2020, 0, 1));
    });
    test("non-string → null", () => {
        expect(isoMs(null)).toBeNull();
        expect(isoMs(undefined)).toBeNull();
        expect(isoMs(123)).toBeNull();
    });
    test("empty string → null", () => {
        expect(isoMs("")).toBeNull();
    });
    test("unparseable string → null", () => {
        expect(isoMs("not-a-date")).toBeNull();
    });
});
