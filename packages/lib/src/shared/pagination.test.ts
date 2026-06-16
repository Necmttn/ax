import { describe, expect, test } from "bun:test";
import {
    clampInt,
    clampLimit,
    clampOffset,
    clampPagination,
    type ClampIntConfig,
    type PaginationConfig,
} from "./pagination.ts";

const recallCfg: PaginationConfig = { defaultLimit: 50, maxLimit: 200 };
const sessionsCfg: PaginationConfig = { defaultLimit: 200, maxLimit: 500 };

describe("clampOffset", () => {
    test("undefined → 0", () => expect(clampOffset(undefined)).toBe(0));
    test("zero → 0", () => expect(clampOffset(0)).toBe(0));
    test("negative → 0", () => expect(clampOffset(-7)).toBe(0));
    test("NaN → 0", () => expect(clampOffset(NaN)).toBe(0));
    test("Infinity → 0", () => expect(clampOffset(Infinity)).toBe(0));
    test("-Infinity → 0", () => expect(clampOffset(-Infinity)).toBe(0));
    test("positive int passes through", () => expect(clampOffset(120)).toBe(120));
    test("fractional truncates toward zero", () => expect(clampOffset(50.9)).toBe(50));
});

describe("clampLimit", () => {
    test("undefined → defaultLimit", () => expect(clampLimit(undefined, recallCfg)).toBe(50));
    test("zero → defaultLimit", () => expect(clampLimit(0, recallCfg)).toBe(50));
    test("negative → defaultLimit", () => expect(clampLimit(-5, recallCfg)).toBe(50));
    test("NaN → defaultLimit", () => expect(clampLimit(NaN, recallCfg)).toBe(50));
    test("Infinity → maxLimit", () => expect(clampLimit(Infinity, recallCfg)).toBe(50));
    test("under max passes through", () => expect(clampLimit(20, recallCfg)).toBe(20));
    test("exact max", () => expect(clampLimit(200, recallCfg)).toBe(200));
    test("over max clamps to max", () => expect(clampLimit(201, recallCfg)).toBe(200));
    test("far over max clamps to max", () => expect(clampLimit(9999, recallCfg)).toBe(200));
    test("fractional truncates toward zero", () => expect(clampLimit(75.9, recallCfg)).toBe(75));
    test("respects per-config defaults", () => {
        expect(clampLimit(undefined, sessionsCfg)).toBe(200);
        expect(clampLimit(9999, sessionsCfg)).toBe(500);
    });
});

describe("clampInt", () => {
    const cfg: ClampIntConfig = { default: 14, min: 1 };
    const cfgWithMax: ClampIntConfig = { default: 14, min: 1, max: 30 };
    const cfgNoMin: ClampIntConfig = { default: 14 };

    // --- default ---
    test("undefined → default", () => expect(clampInt(undefined, cfg)).toBe(14));

    // --- min ---
    test("zero (below min) → default", () => expect(clampInt(0, cfg)).toBe(14));
    test("negative (below min) → default", () => expect(clampInt(-3, cfg)).toBe(14));
    test("exactly at min passes through", () => expect(clampInt(1, cfg)).toBe(1));
    test("above min passes through", () => expect(clampInt(7, cfg)).toBe(7));

    // --- max ---
    test("over max clamps to max", () => expect(clampInt(90, cfgWithMax)).toBe(30));
    test("exactly at max passes through", () => expect(clampInt(30, cfgWithMax)).toBe(30));
    test("between min and max passes through", () => expect(clampInt(14, cfgWithMax)).toBe(14));

    // --- non-finite ---
    test("NaN → default", () => expect(clampInt(NaN, cfg)).toBe(14));
    test("Infinity → default", () => expect(clampInt(Infinity, cfg)).toBe(14));
    test("-Infinity → default", () => expect(clampInt(-Infinity, cfg)).toBe(14));

    // --- fractional truncation ---
    test("fractional truncates toward zero", () => expect(clampInt(7.9, cfg)).toBe(7));
    test("fractional below min after trunc → default", () => expect(clampInt(0.9, cfg)).toBe(14));

    // --- no min configured ---
    test("no min: any finite value passes", () => expect(clampInt(0, cfgNoMin)).toBe(0));
    test("no min: negative passes", () => expect(clampInt(-5, cfgNoMin)).toBe(-5));
    test("no min: undefined → default", () => expect(clampInt(undefined, cfgNoMin)).toBe(14));
});

describe("clampPagination", () => {
    test("empty params → defaults", () => {
        expect(clampPagination({}, recallCfg)).toEqual({ offset: 0, limit: 50 });
    });

    test("passes through well-formed params", () => {
        expect(clampPagination({ offset: 40, limit: 100 }, recallCfg)).toEqual({
            offset: 40,
            limit: 100,
        });
    });

    test("clamps both axes independently", () => {
        expect(clampPagination({ offset: -5, limit: 9999 }, sessionsCfg)).toEqual({
            offset: 0,
            limit: 500,
        });
    });

    test("inspector config (default == max) always returns max", () => {
        const insp: PaginationConfig = { defaultLimit: 2000, maxLimit: 2000 };
        expect(clampPagination({}, insp).limit).toBe(2000);
        expect(clampPagination({ limit: 9999 }, insp).limit).toBe(2000);
        expect(clampPagination({ limit: 500 }, insp).limit).toBe(500);
    });
});
