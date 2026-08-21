import { describe, expect, test } from "bun:test";
import { isFresh } from "./cache.ts";
import type { QuotaSnapshot } from "./schema.ts";

const snapshot = (fetchedAt: string): QuotaSnapshot => ({
    v: 1,
    fetched_at: fetchedAt,
    five_hour: null,
    seven_day: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
});

describe("isFresh", () => {
    test("rejects a future-dated cache entry", () => {
        const now = Date.parse("2026-08-21T00:00:00.000Z");
        expect(isFresh(snapshot("2026-08-22T00:00:00.000Z"), now, 60)).toBe(false);
    });
});
