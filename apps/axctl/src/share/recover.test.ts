import { describe, expect, it } from "bun:test";
import { sinceDaysForMtime } from "./recover.ts";

const DAY_MS = 86_400_000;

describe("sinceDaysForMtime", () => {
    it("uses the 1-day minimum for a transcript modified just now (live session)", () => {
        const now = Date.now();
        expect(sinceDaysForMtime(now, now)).toBe(1);
    });

    it("adds a day of margin past the mtime so the cutoff cannot exclude the file", () => {
        const now = Date.now();
        expect(sinceDaysForMtime(now - 3 * DAY_MS, now)).toBe(4);
    });

    it("never returns less than 1 even for a future mtime (clock skew)", () => {
        const now = Date.now();
        expect(sinceDaysForMtime(now + DAY_MS, now)).toBe(1);
    });
});
