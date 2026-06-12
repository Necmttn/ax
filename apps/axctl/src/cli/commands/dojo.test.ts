import { describe, expect, test } from "bun:test";
import { untilToIso } from "./dojo.ts";

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
});
