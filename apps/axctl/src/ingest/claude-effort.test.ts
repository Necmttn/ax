/**
 * Tests for claude-effort.ts: settings parsing + freshness-gated stamping.
 */
import { describe, expect, it } from "bun:test";

import { claudeEffortStamp, parseEffortLevel } from "./claude-effort.ts";

describe("parseEffortLevel", () => {
    it("extracts effortLevel from settings.json", () => {
        expect(parseEffortLevel(JSON.stringify({ effortLevel: "high", model: "fable" }))).toBe("high");
        expect(parseEffortLevel(JSON.stringify({ effortLevel: " medium " }))).toBe("medium");
    });

    it("returns null for missing, empty, or non-string effortLevel", () => {
        expect(parseEffortLevel(JSON.stringify({}))).toBeNull();
        expect(parseEffortLevel(JSON.stringify({ effortLevel: "" }))).toBeNull();
        expect(parseEffortLevel(JSON.stringify({ effortLevel: 3 }))).toBeNull();
    });

    it("returns null for unparseable input", () => {
        expect(parseEffortLevel("not json {")).toBeNull();
    });
});

describe("claudeEffortStamp", () => {
    const now = Date.parse("2026-06-13T04:30:00.000Z");

    it("stamps sessions active within the freshness window", () => {
        expect(claudeEffortStamp("high", "2026-06-13T04:25:00.000Z", now)).toBe("high");
        // Exactly at the 30min boundary still counts.
        expect(claudeEffortStamp("high", "2026-06-13T04:00:00.000Z", now)).toBe("high");
    });

    it("never backstamps stale sessions", () => {
        expect(claudeEffortStamp("high", "2026-06-13T03:00:00.000Z", now)).toBeUndefined();
        expect(claudeEffortStamp("high", "2026-05-01T00:00:00.000Z", now)).toBeUndefined();
    });

    it("returns undefined for missing effort, missing endedAt, or bad dates", () => {
        expect(claudeEffortStamp(null, "2026-06-13T04:25:00.000Z", now)).toBeUndefined();
        expect(claudeEffortStamp("high", null, now)).toBeUndefined();
        expect(claudeEffortStamp("high", "garbage-date", now)).toBeUndefined();
    });

    it("honors a custom freshness window", () => {
        expect(claudeEffortStamp("low", "2026-06-13T04:29:30.000Z", now, 60_000)).toBe("low");
        expect(claudeEffortStamp("low", "2026-06-13T04:20:00.000Z", now, 60_000)).toBeUndefined();
    });
});
