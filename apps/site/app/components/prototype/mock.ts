/* THROWAWAY prototype mock data - plausible ax telemetry for the redesign. */

export const PROFILE = {
    handle: "necmttn",
    archetype: { id: "night-owl-builder", label: "Night-Owl Builder", confidence: "high", line: "Ships hardest after midnight - long, focused build sessions with the lights off." },
    window: { days: 30, compiled: "2026-06-13" },
    harnesses: ["claude", "codex", "pi", "cursor"],
    sessions: 412,
    messages: 8930,
    tokens: "41.8M",
    cost: "$571",
    streak: 14,
    longest: 41,
    activeDays: 92,
    peakHour: "11 PM",
    topModel: "claude-fable-5",
    ingestRate: 10.2, // MB/s feel
};

// 98 days of activity → 0..4 levels (deterministic weave).
export const ACTIVITY: number[] = Array.from({ length: 98 }, (_, i) => {
    if (i % 19 === 0) return 0;
    const w = Math.sin(i * 0.7) + Math.sin(i * 0.27) * 0.6 + Math.cos(i * 1.3) * 0.4;
    const v = (w + 1.4) / 2.8;
    return v > 0.72 ? 4 : v > 0.5 ? 3 : v > 0.28 ? 2 : v > 0.08 ? 1 : 0;
});

export const MODELS = [
    { name: "claude-fable-5", share: 0.4, cost: "$8.9K", tone: "green" },
    { name: "claude-opus-4-8", share: 0.3, cost: "$6.7K", tone: "blue" },
    { name: "gpt-5.5", share: 0.22, cost: "$4.9K", tone: "gold" },
    { name: "claude-opus-4-7", share: 0.064, cost: "$1.4K", tone: "violet" },
    { name: "claude-sonnet-4-6", share: 0.022, cost: "$496", tone: "red" },
] as const;

export const SKILLS = [
    { name: "superpowers:brainstorming", runs: 142, role: "ideate" },
    { name: "tdd", runs: 98, role: "verify" },
    { name: "using-git-worktrees", runs: 87, role: "isolate" },
    { name: "systematic-debugging", runs: 64, role: "diagnose" },
    { name: "code-review", runs: 51, role: "review" },
    { name: "writing-plans", runs: 44, role: "plan" },
] as const;

export const FEED = [
    { msg: "feat: nullframe instrument board", t: "06:50:37", kind: "feat" },
    { msg: "chore: cap canvas DPR at 2", t: "06:50:30", kind: "chore" },
    { msg: "fix: glyph reel pause-on-hidden", t: "06:50:23", kind: "fix" },
    { msg: "feat: Doto vitals on /u profile", t: "06:48:02", kind: "feat" },
    { msg: "test: cell-grid slam stagger", t: "06:41:55", kind: "test" },
] as const;

export const CARDS = [
    { q: "How many agents at once?", a: "3", s: "Your busiest session fanned out to three parallel subagents.", tone: "violet" },
    { q: "What did you lean on most?", a: "superpowers", s: "Fired in 41% of sessions - brainstorming, TDD, worktrees led.", tone: "green" },
    { q: "Your longest unbroken run?", a: "41 days", s: "A six-week streak from March into April.", tone: "blue" },
] as const;

/** Token-share → segbar lit count over `total`. */
export const litFor = (share: number, total: number) => Math.max(1, Math.round(share * total));

/* ---- teams / "ring" mock ---------------------------------------------- */

/** Deterministic 14-cell activity sparkline (0..4) seeded from a handle. */
const spark = (seed: string): number[] => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Array.from({ length: 14 }, (_, i) => {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
        const v = (h % 100) / 100;
        if (i % 11 === 3) return 0;
        return v > 0.72 ? 4 : v > 0.5 ? 3 : v > 0.25 ? 2 : v > 0.08 ? 1 : 0;
    });
};

export interface Member {
    handle: string;
    archetype: string;
    sessions: number;
    tokens: string;
    streak: number;
    cost: string;
    topModel: string;
    online: boolean;
    spark: number[];
}

export const TEAM = {
    org: "acme",
    ring: "engineering",
    members: 6,
    onlineNow: 4,
    sessions: 1500,
    tokens: "145M",
    spend: "$2.0K",
    saved: "$640",
    windowDays: 30,
    roster: ([
        ["necmttn", "Night-Owl Builder", 412, "41.8M", 14, "$571", "claude-fable-5", true],
        ["dax", "Test-First Surgeon", 318, "28.2M", 31, "$402", "claude-opus-4-8", true],
        ["kano", "Parallel Dispatcher", 198, "33.1M", 22, "$511", "claude-fable-5", true],
        ["lena", "Refactor Archaeologist", 256, "19.7M", 7, "$288", "claude-sonnet-4-6", false],
        ["mir", "Spec-Driven Planner", 174, "12.4M", 4, "$146", "gpt-5.5", true],
        ["juno", "Debug Bloodhound", 142, "9.8M", 11, "$98", "claude-haiku-4-5", false],
    ] as const).map(([handle, archetype, sessions, tokens, streak, cost, topModel, online]) => ({
        handle, archetype, sessions, tokens, streak, cost, topModel, online, spark: spark(handle),
    })) satisfies Member[],
    // team-wide model split
    models: [
        { name: "claude-fable-5", share: 0.44, cost: "$880", tone: "green" },
        { name: "claude-opus-4-8", share: 0.27, cost: "$540", tone: "blue" },
        { name: "gpt-5.5", share: 0.18, cost: "$360", tone: "gold" },
        { name: "claude-sonnet-4-6", share: 0.11, cost: "$220", tone: "violet" },
    ] as const,
    // shared rig adoption (skill → % of team using it)
    rig: [
        { name: "superpowers:brainstorming", pct: 1.0 },
        { name: "using-git-worktrees", pct: 0.83 },
        { name: "tdd", pct: 0.66 },
        { name: "systematic-debugging", pct: 0.5 },
        { name: "efficient-dispatch", pct: 0.33 },
    ] as const,
};

/** Aggregate team activity heatmap (sum of member sparks, re-bucketed). */
export const TEAM_ACTIVITY: number[] = ACTIVITY.map((v, i) => Math.min(4, v + (i % 5 === 0 ? 1 : 0)));
