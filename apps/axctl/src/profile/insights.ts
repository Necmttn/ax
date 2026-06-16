/**
 * Pure session-analytics derivers for the ProfileV1 `insights` section.
 * No IO, no Effect, no Date.now() - all inputs injected. Individual session
 * durations are clamped at 24h to kill bad data (a wedged harness can leave
 * multi-day "sessions" behind). Returns null when there is no data at all
 * (both durations and daily empty) so the renderer can omit the section.
 */
import type { DailyActivityRow, SessionDurationRow, TopToolRow, WrappedCounts } from "./queries.ts";

const MAX_SESSION_MS = 24 * 60 * 60 * 1000; // 24h cap per session

export interface InsightsInput {
    readonly durations: ReadonlyArray<SessionDurationRow>;
    readonly peakHour: number | null;
    readonly spawned: number;
    readonly commits: number;
    readonly tools: ReadonlyArray<TopToolRow>;
    readonly daily: ReadonlyArray<DailyActivityRow>;
    /**
     * Count of "outcome-deep" sessions in the window: sessions that landed a
     * real, non-reverted commit (>0 lines touched). DEPTH measures whether your
     * sessions REACH a clean shipped outcome, not how long they run - wall-clock
     * and turn-count both reward thrash and penalise handoff-compressed work, so
     * depth is graded on the result, not the effort. Omitted -> share is 0.
     */
    readonly deepSessions?: number;
    /**
     * DEPTH denominator: non-subagent sessions in the window. Kept separate from
     * the duration-based session count because subagent sessions (which the
     * numerator excludes) roughly double the raw total. Omitted -> share is 0.
     */
    readonly deepSessionTotal?: number;
    /** Optional wrapped-style window counts; omitted when not fetched. */
    readonly wrapped?: WrappedCounts;
}

export interface InsightsResult {
    readonly hours_total: number;
    readonly longest_session_minutes: number;
    readonly deep_session_share: number;
    readonly peak_hour_utc: number;
    readonly busiest_day: { readonly date: string; readonly sessions: number };
    readonly max_parallel_sessions: number;
    readonly subagents_spawned: number;
    readonly commits: number;
    readonly tools_top: ReadonlyArray<TopToolRow>;
    // wrapped-style window aggregates (all optional for back-compat with old gists)
    readonly turns?: number;
    readonly tool_calls?: number;
    readonly tool_failures?: number;
    readonly distinct_skills?: number;
    readonly distinct_tools?: number;
    readonly repos_count?: number;
    readonly verification_calls?: number;
    readonly context_calls?: number;
}

export function deriveInsights(input: InsightsInput): InsightsResult | null {
    const { durations, peakHour, spawned, commits, tools, daily } = input;
    if (durations.length === 0 && daily.length === 0) return null;

    // --- duration stats (clamped at 24h per session) ------------------------
    let totalMs = 0;
    let longestMs = 0;
    let validCount = 0;
    const events: Array<{ t: number; delta: 1 | -1 }> = [];

    for (const { started_at, ended_at } of durations) {
        const startMs = Date.parse(started_at);
        const endMs = Date.parse(ended_at);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
        validCount++;
        const clampedMs = Math.min(endMs - startMs, MAX_SESSION_MS);
        totalMs += clampedMs;
        longestMs = Math.max(longestMs, clampedMs);
        events.push({ t: startMs, delta: 1 });
        events.push({ t: endMs, delta: -1 });
    }

    const hours_total = Math.round((totalMs / 3_600_000) * 10) / 10;
    const longest_session_minutes = Math.round(longestMs / 60_000);
    // DEPTH = share of (non-subagent) sessions that landed clean work. Both
    // numerator and denominator are subagent-filtered upstream; clamped at 1 for
    // safety. Falls back to 0 when the outcome inputs are absent (old callers).
    const deepTotal = input.deepSessionTotal ?? 0;
    const deep_session_share = deepTotal > 0
        ? Math.min(1, (input.deepSessions ?? 0) / deepTotal)
        : 0;

    // --- max parallel sessions (classic sweep line) --------------------------
    // Sort by time; on ties process ends before starts so back-to-back
    // sessions don't count as overlapping.
    let max_parallel_sessions = 0;
    events.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.delta - b.delta));
    let current = 0;
    for (const { delta } of events) {
        current += delta;
        if (current > max_parallel_sessions) max_parallel_sessions = current;
    }

    // --- busiest day (max sessions; ties -> earliest date) -------------------
    let busiestDate = "";
    let busiestSessions = 0;
    for (const row of daily) {
        if (
            row.sessions > busiestSessions ||
            (row.sessions === busiestSessions && busiestDate !== "" && row.date < busiestDate)
        ) {
            busiestDate = row.date;
            busiestSessions = row.sessions;
        }
    }

    return {
        hours_total,
        longest_session_minutes,
        deep_session_share,
        peak_hour_utc: peakHour ?? 0,
        busiest_day: { date: busiestDate, sessions: busiestSessions },
        max_parallel_sessions,
        subagents_spawned: spawned,
        commits,
        tools_top: tools,
        ...(input.wrapped !== undefined ? {
            turns: input.wrapped.turns,
            tool_calls: input.wrapped.tool_calls,
            tool_failures: input.wrapped.tool_failures,
            distinct_skills: input.wrapped.distinct_skills,
            distinct_tools: input.wrapped.distinct_tools,
            repos_count: input.wrapped.repos_count,
            verification_calls: input.wrapped.verification_calls,
            context_calls: input.wrapped.context_calls,
        } : {}),
    };
}
