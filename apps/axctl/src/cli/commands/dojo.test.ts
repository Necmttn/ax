import { describe, expect, test } from "bun:test";
import { isValidKind, localDate, startOfLocalDay, untilToIso } from "./dojo.ts";

describe("untilToIso", () => {
    const NOW = Date.parse("2026-06-13T10:00:00.000Z");
    test("future time today", () => {
        expect(untilToIso("23:30", NOW)).toMatch(/T\d{2}:30:00/);
    });
    test("past time rolls to tomorrow", () => {
        const iso = untilToIso("01:00", NOW)!;
        expect(Date.parse(iso)).toBeGreaterThan(NOW);
    });
    test("garbage returns null", () => {
        expect(untilToIso("late", NOW)).toBeNull();
    });
    test("out-of-range hours/minutes return null", () => {
        expect(untilToIso("25:00", NOW)).toBeNull();
        expect(untilToIso("0:60", NOW)).toBeNull();
    });
});

describe("isValidKind", () => {
    test("accepts the two supported kinds", () => {
        expect(isValidKind("bug")).toBe(true);
        expect(isValidKind("improvement")).toBe(true);
    });
    test("rejects anything else", () => {
        expect(isValidKind("nonsense")).toBe(false);
        expect(isValidKind("")).toBe(false);
        expect(isValidKind("Bug")).toBe(false);
    });
});

describe("startOfLocalDay / localDate", () => {
    test("startOfLocalDay zeroes the time-of-day in local tz", () => {
        const now = new Date(2026, 5, 13, 14, 37, 9, 123).getTime(); // local 2026-06-13 14:37:09.123
        const start = new Date(startOfLocalDay(now));
        expect(start.getHours()).toBe(0);
        expect(start.getMinutes()).toBe(0);
        expect(start.getSeconds()).toBe(0);
        expect(start.getMilliseconds()).toBe(0);
        expect(start.getFullYear()).toBe(2026);
        expect(start.getMonth()).toBe(5);
        expect(start.getDate()).toBe(13);
        expect(startOfLocalDay(now)).toBeLessThanOrEqual(now);
    });

    test("localDate renders zero-padded local YYYY-MM-DD", () => {
        const now = new Date(2026, 0, 7, 23, 59, 0).getTime(); // local 2026-01-07
        expect(localDate(now)).toBe("2026-01-07");
    });
});
