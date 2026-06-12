import { describe, expect, test } from "bun:test";
import { deriveInsights } from "./insights.ts";
import type { DailyActivityRow, SessionDurationRow } from "./queries.ts";

const s = (startIso: string, endIso: string): SessionDurationRow => ({
    started_at: startIso,
    ended_at: endIso,
});

describe("deriveInsights", () => {
    const baseDailyFull: DailyActivityRow[] = [
        { date: "2026-06-09", sessions: 31, tokens: 800_000 },
        { date: "2026-06-10", sessions: 8, tokens: 100_000 },
        { date: "2026-06-12", sessions: 12, tokens: 120_000_000 },
    ];

    const baseDurations: SessionDurationRow[] = [
        s("2026-06-12T10:00:00Z", "2026-06-12T12:30:00Z"), // 2.5h = deep
        s("2026-06-12T11:00:00Z", "2026-06-12T11:30:00Z"), // 30min = not deep
        s("2026-06-12T09:00:00Z", "2026-06-12T10:30:00Z"), // 1.5h = deep
    ];

    test("hours_total sums all durations in hours", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 10,
            spawned: 5,
            commits: 20,
            tools: [{ name: "Bash", runs: 100 }],
            daily: baseDailyFull,
        });
        // 2.5 + 0.5 + 1.5 = 4.5h
        expect(r!.hours_total).toBeCloseTo(4.5, 1);
    });

    test("longest_session_minutes finds the longest", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 10,
            spawned: 5,
            commits: 20,
            tools: [],
            daily: baseDailyFull,
        });
        expect(r!.longest_session_minutes).toBe(150);
    });

    test("deep_session_share = sessions >= 90min / total sessions with duration", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 10,
            spawned: 5,
            commits: 20,
            tools: [],
            daily: baseDailyFull,
        });
        expect(r!.deep_session_share).toBeCloseTo(2 / 3, 3);
    });

    test("busiest_day = max sessions in daily", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 13,
            spawned: 5,
            commits: 20,
            tools: [],
            daily: baseDailyFull,
        });
        expect(r!.busiest_day.date).toBe("2026-06-09");
        expect(r!.busiest_day.sessions).toBe(31);
    });

    test("ties in busiest_day -> earliest date wins", () => {
        const tied: DailyActivityRow[] = [
            { date: "2026-06-10", sessions: 10, tokens: 0 },
            { date: "2026-06-09", sessions: 10, tokens: 0 },
        ];
        const r = deriveInsights({
            durations: [],
            peakHour: null,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: tied,
        });
        expect(r!.busiest_day.date).toBe("2026-06-09");
    });

    test("max_parallel_sessions: sweep overlapping intervals", () => {
        const durations: SessionDurationRow[] = [
            s("2026-06-12T10:00:00Z", "2026-06-12T11:00:00Z"),
            s("2026-06-12T10:00:00Z", "2026-06-12T10:30:00Z"),
            s("2026-06-12T10:00:00Z", "2026-06-12T10:20:00Z"),
            s("2026-06-12T10:35:00Z", "2026-06-12T11:30:00Z"), // only 2 overlap here
        ];
        const r = deriveInsights({
            durations,
            peakHour: 10,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 4, tokens: 0 }],
        });
        expect(r!.max_parallel_sessions).toBe(3);
    });

    test("max_parallel_sessions: no overlap -> 1", () => {
        const durations: SessionDurationRow[] = [
            s("2026-06-12T08:00:00Z", "2026-06-12T09:00:00Z"),
            s("2026-06-12T10:00:00Z", "2026-06-12T11:00:00Z"),
        ];
        const r = deriveInsights({
            durations,
            peakHour: 8,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 2, tokens: 0 }],
        });
        expect(r!.max_parallel_sessions).toBe(1);
    });

    test("sessions clamped at 24h each (bad data)", () => {
        const durations: SessionDurationRow[] = [
            s("2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z"), // 9 days -> clamped to 24h
            s("2026-06-12T10:00:00Z", "2026-06-12T12:00:00Z"), // 2h
        ];
        const r = deriveInsights({
            durations,
            peakHour: 10,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 2, tokens: 0 }],
        });
        expect(r!.hours_total).toBeCloseTo(26.0, 1);
        expect(r!.longest_session_minutes).toBe(1440);
    });

    test("passthrough fields: peak_hour_utc, spawned, commits, tools_top", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 13,
            spawned: 420,
            commits: 1000,
            tools: [{ name: "Bash", runs: 5000 }],
            daily: baseDailyFull,
        });
        expect(r!.peak_hour_utc).toBe(13);
        expect(r!.subagents_spawned).toBe(420);
        expect(r!.commits).toBe(1000);
        expect(r!.tools_top[0]!.name).toBe("Bash");
    });

    test("returns null when both durations and daily are empty", () => {
        const r = deriveInsights({
            durations: [],
            peakHour: null,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [],
        });
        expect(r).toBeNull();
    });

    test("daily non-empty but durations empty: zeros + busiest_day still set", () => {
        const r = deriveInsights({
            durations: [],
            peakHour: 9,
            spawned: 3,
            commits: 5,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 5, tokens: 0 }],
        });
        expect(r).not.toBeNull();
        expect(r!.hours_total).toBe(0);
        expect(r!.deep_session_share).toBe(0);
        expect(r!.max_parallel_sessions).toBe(0);
        expect(r!.busiest_day.date).toBe("2026-06-12");
    });

    test("malformed duration rows are skipped", () => {
        const durations: SessionDurationRow[] = [
            s("not-a-date", "2026-06-12T11:00:00Z"),
            s("2026-06-12T11:00:00Z", "2026-06-12T10:00:00Z"), // end before start
            s("2026-06-12T10:00:00Z", "2026-06-12T11:00:00Z"), // valid 1h
        ];
        const r = deriveInsights({
            durations,
            peakHour: 10,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 3, tokens: 0 }],
        });
        expect(r!.hours_total).toBeCloseTo(1.0, 1);
        expect(r!.max_parallel_sessions).toBe(1);
    });
});
