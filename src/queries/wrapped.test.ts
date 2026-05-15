import { describe, expect, test } from "bun:test";
import {
    WRAPPED_DAILY_ACTIVITY_SQL,
    WRAPPED_SPAWNED_SQL,
    WRAPPED_USAGE_SQL,
} from "./wrapped.ts";

describe("wrapped queries", () => {
    test("usage query aggregates turn activity in one row", () => {
        expect(WRAPPED_USAGE_SQL).toContain("FROM turn");
        expect(WRAPPED_USAGE_SQL).toContain("GROUP ALL");
        expect(WRAPPED_USAGE_SQL).not.toContain("$parent");
        expect(WRAPPED_USAGE_SQL).not.toContain("array::distinct(time::format(started_at");
    });

    test("daily activity query avoids correlated parent access inside grouped rows", () => {
        expect(WRAPPED_DAILY_ACTIVITY_SQL).toContain("FROM turn");
        expect(WRAPPED_DAILY_ACTIVITY_SQL).toContain("GROUP BY date");
        expect(WRAPPED_DAILY_ACTIVITY_SQL).not.toContain("$parent");
    });

    test("spawned query returns a single aggregate row", () => {
        expect(WRAPPED_SPAWNED_SQL).toContain("GROUP ALL");
    });
});
