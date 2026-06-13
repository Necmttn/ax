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
