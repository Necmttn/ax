/**
 * Streak math over UTC day keys ("YYYY-MM-DD"). `today` is injected (no
 * Date.now() in pure code) - callers pass the current UTC day. A streak is
 * the run of consecutive days ending today or yesterday (grace: today's
 * sessions may not exist yet when the profile renders in the morning).
 * Inputs must be valid ISO-8601 dates; malformed entries produce
 * unspecified results.
 */
export interface StreakResult {
    readonly active_days: number;
    readonly streak_days: number;
}

const DAY_MS = 86_400_000;

const toUtcMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export function computeStreak(days: ReadonlyArray<string>, today: string): StreakResult {
    const unique = [...new Set(days)].sort();
    if (unique.length === 0) return { active_days: 0, streak_days: 0 };

    const todayMs = toUtcMs(today);
    const lastMs = toUtcMs(unique[unique.length - 1]!);
    // Anchor must be today or yesterday, else streak is dead.
    if (todayMs - lastMs > DAY_MS) return { active_days: unique.length, streak_days: 0 };

    let streak = 1;
    for (let i = unique.length - 1; i > 0; i--) {
        const gap = toUtcMs(unique[i]!) - toUtcMs(unique[i - 1]!);
        if (gap !== DAY_MS) break;
        streak++;
    }
    return { active_days: unique.length, streak_days: streak };
}
