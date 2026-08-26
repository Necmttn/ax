import { describe, expect, test } from "bun:test";
import type { ProfileInsights } from "@ax/lib/shared/community";
import { buildInsightCards } from "./profile-dossier";

const insights: ProfileInsights = {
    hours_total: 26,
    longest_session_minutes: 1440,
    deep_session_share: 0,
    peak_hour_utc: 6,
    busiest_day: { date: "2026-08-25", sessions: 2 },
    max_parallel_sessions: 2,
    subagents_spawned: 0,
    commits: 0,
    tools_top: [],
};

describe("buildInsightCards duration labels", () => {
    test("defines capped session spans and session-start peak hour", () => {
        const cards = buildInsightCards(insights, []);
        const subtitle = (question: string) => cards.find((card) => card.q === question)?.s;

        expect(subtitle("Longest capped span?")).toContain("capped session span");
        expect(subtitle("Longest capped span?")).toContain("capped at 24h");
        expect(subtitle("Peak session-start hour?")).toContain("peak session-start hour");
        expect(subtitle("Total capped session spans?")).toBe("sum of per-session spans, each capped at 24h");
    });
});
