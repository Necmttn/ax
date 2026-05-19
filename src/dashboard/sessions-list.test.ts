import { describe, expect, test } from "bun:test";
import { clampSessionListLimit, clampSessionListOffset } from "./sessions-list.ts";

describe("sessions-list pagination", () => {
    test("clampSessionListLimit defaults + bounds", () => {
        expect(clampSessionListLimit(undefined)).toBe(200);
        expect(clampSessionListLimit(0)).toBe(200);
        expect(clampSessionListLimit(-5)).toBe(200);
        expect(clampSessionListLimit(NaN)).toBe(200);
        expect(clampSessionListLimit(50)).toBe(50);
        expect(clampSessionListLimit(500)).toBe(500); // exact max
        expect(clampSessionListLimit(501)).toBe(500); // max+1 still clamps
        expect(clampSessionListLimit(9999)).toBe(500);
    });

    test("clampSessionListOffset defaults + bounds", () => {
        expect(clampSessionListOffset(undefined)).toBe(0);
        expect(clampSessionListOffset(0)).toBe(0);
        expect(clampSessionListOffset(-7)).toBe(0);
        expect(clampSessionListOffset(NaN)).toBe(0);
        expect(clampSessionListOffset(120)).toBe(120);
        expect(clampSessionListOffset(50.9)).toBe(50);
    });
});
