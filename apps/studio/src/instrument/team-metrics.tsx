/**
 * Team Metrics - a dense, nullframe-styled metrics board modelled on the
 * HumanLayer "Team Metrics" page, mapped onto ax's LOCAL graph. ax is
 * single-user, so the "team" is the set of agents on your graph: the 5
 * harnesses (the roster), the models they run (the channels), and the daily /
 * weekly telemetry series they produce.
 *
 * Phase 1 (this file): wires the real daemon data we already have - wrapped
 * usage.days (per-day sessions/turns/tokens) + cost models + the sessions list
 * (aggregated client-side into a per-harness roster). Range toggles slice the
 * window. Design system: ./instrument.css (.v-tm-*, .v-team-*) + ./viz BarChart.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { WrappedUsageDay } from "@ax/lib/shared/dashboard-types";
import type { SessionListRow } from "@ax/lib/shared/api-contract";
import { fmtCount } from "@ax/lib/shared/formatters";
import { fetchMembers, type MemberProfile } from "@ax/lib/shared/community";
import { BarChart } from "./viz.tsx";

// ---- range model ----------------------------------------------------------
type DailyRange = 7 | 30 | 90;
type WeeklyRange = 4 | 8 | 12;
const DAILY: ReadonlyArray<DailyRange> = [7, 30, 90];
const WEEKLY: ReadonlyArray<WeeklyRange> = [4, 8, 12];

// ---- formatting -----------------------------------------------------------
const fmtUsd = (n: number): string =>
    n >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : n >= 1 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
const fmtBig = (n: number | null | undefined): string => {
    if (n == null) return "0";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return n.toLocaleString("en-US");
};
const shortModel = (m: string): string => m.replace(/-\d{6,}$/, "");
const mdLabel = (iso: string): string => {
    const d = new Date(iso + (iso.length <= 10 ? "T00:00:00" : ""));
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** Map a model/harness name to a stable channel colour (by family). */
const toneFor = (m: string): string => {
    const s = m.toLowerCase();
    if (s.includes("fable")) return "var(--green)";
    if (s.includes("opus")) return "var(--blue)";
    if (s.includes("sonnet")) return "#e0556f";
    if (s.includes("haiku")) return "var(--violet)";
    if (s.includes("gpt") || s.includes("o3") || s.includes("o4") || s.includes("codex")) return "var(--gold)";
    return "var(--accent)";
};

// ---- harness roster (the "active users" table) ----------------------------
interface HarnessRow {
    source: string;
    sessions: number;
    cost: number;
    model: string | null;
    spark: number[]; // 0-4 levels, last 7 buckets
    online: boolean;
}

/** ISO-ish week key (year-week) from a yyyy-mm-dd date string. */
const weekKey = (iso: string): string => {
    const d = new Date(iso + "T00:00:00");
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()}-${String(week).padStart(2, "0")}`;
};

/** Aggregate per-day series into weekly buckets (chronological). */
function weekly(days: ReadonlyArray<WrappedUsageDay>): { labels: string[]; sessions: number[]; turns: number[] } {
    const buckets = new Map<string, { sessions: number; turns: number; first: string }>();
    for (const d of days) {
        const k = weekKey(d.date);
        const b = buckets.get(k) ?? { sessions: 0, turns: 0, first: d.date };
        b.sessions += d.sessions;
        b.turns += d.turns;
        if (d.date < b.first) b.first = d.date;
        buckets.set(k, b);
    }
    const ordered = [...buckets.values()].sort((a, b) => a.first.localeCompare(b.first));
    return {
        labels: ordered.map((b) => mdLabel(b.first)),
        sessions: ordered.map((b) => b.sessions),
        turns: ordered.map((b) => b.turns),
    };
}

/** Build the per-harness roster from the recent sessions list. */
function buildRoster(rows: ReadonlyArray<SessionListRow>): HarnessRow[] {
    const now = Date.now();
    const dayMs = 86400000;
    const by = new Map<string, HarnessRow & { lastTs: number }>();
    for (const r of rows) {
        const src = r.source || "unknown";
        const cur = by.get(src) ?? {
            source: src, sessions: 0, cost: 0, model: null, spark: [0, 0, 0, 0, 0, 0, 0], online: false, lastTs: 0,
        };
        cur.sessions += 1;
        cur.cost += r.cost_usd ?? 0;
        const ts = r.started_at ? Date.parse(r.started_at) : NaN;
        if (!Number.isNaN(ts)) {
            if (ts > cur.lastTs) { cur.lastTs = ts; cur.model = r.model ?? cur.model; }
            const ageDays = Math.floor((now - ts) / dayMs);
            if (ageDays >= 0 && ageDays < 7) cur.spark[6 - ageDays] += 1;
        }
        by.set(src, cur);
    }
    const list = [...by.values()];
    // normalize spark counts → 0-4 levels per row
    for (const h of list) {
        const peak = Math.max(1, ...h.spark);
        h.spark = h.spark.map((c) => (c <= 0 ? 0 : c / peak > 0.66 ? 4 : c / peak > 0.4 ? 3 : c / peak > 0.15 ? 2 : 1));
        h.online = now - h.lastTs < dayMs;
    }
    return list.sort((a, b) => b.sessions - a.sessions);
}

// ---- unified roster + compare model ---------------------------------------
type RosterTab = "projects" | "members" | "harnesses";
const TABS: ReadonlyArray<{ id: RosterTab; label: string }> = [
    { id: "projects", label: "projects" },
    { id: "members", label: "members" },
    { id: "harnesses", label: "harnesses" },
];

interface CompareMetric { label: string; value: string; n: number }
interface RosterEntity {
    id: string;
    label: string;
    online: boolean;
    spark: number[]; // 0-4 levels (empty → render `mid` instead)
    mid?: ReactNode; // override for the middle cell (e.g. member team chips)
    model: string | null;
    sessions: number;
    tokens: number; // token consumption (the headline org metric for members)
    cost: number;
    metrics: CompareMetric[]; // compare-panel rows (consistent within a tab)
    // Outcome fields - the org scoreboard (teaser only). Sell value, not spend.
    // Unit is "tasks" (AI-assisted work items completed) so it generalizes
    // across functions - PRs for eng, tickets for support, accounts for sales -
    // unlike $/PR, which only makes sense for teams that ship code.
    outcome?: {
        taskShare: number; // 0-1, share of company's AI-assisted work items
        tasks: number; // work items completed / mo
        perTask: number; // $ per completed task
        firstPass: number; // 0-1, % completed without a redo
    };
}

const basename = (p: string | null): string => {
    if (!p) return "unknown";
    const parts = p.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || p;
};
const topModel = (counts: Map<string, number>): string | null => {
    let best: string | null = null, max = 0;
    for (const [m, c] of counts) if (c > max) { max = c; best = m; }
    return best;
};
const levelize = (spark: number[]): number[] => {
    const peak = Math.max(1, ...spark);
    return spark.map((c) => (c <= 0 ? 0 : c / peak > 0.66 ? 4 : c / peak > 0.4 ? 3 : c / peak > 0.15 ? 2 : 1));
};

/** Aggregate the sessions list into a per-project (repo) roster. */
function buildProjects(rows: ReadonlyArray<SessionListRow>): RosterEntity[] {
    const now = Date.now(), dayMs = 86400000;
    interface Acc {
        sessions: number; cost: number; added: number; removed: number; friction: number;
        models: Map<string, number>; spark: number[]; lastTs: number;
    }
    const by = new Map<string, Acc>();
    for (const r of rows) {
        const key = basename(r.cwd);
        const a = by.get(key) ?? { sessions: 0, cost: 0, added: 0, removed: 0, friction: 0, models: new Map(), spark: [0, 0, 0, 0, 0, 0, 0], lastTs: 0 };
        a.sessions += 1;
        a.cost += r.cost_usd ?? 0;
        a.added += r.lines_added ?? 0;
        a.removed += r.lines_removed ?? 0;
        if (r.signal === "friction") a.friction += 1;
        if (r.model) a.models.set(r.model, (a.models.get(r.model) ?? 0) + 1);
        const ts = r.started_at ? Date.parse(r.started_at) : NaN;
        if (!Number.isNaN(ts)) {
            if (ts > a.lastTs) a.lastTs = ts;
            const age = Math.floor((now - ts) / dayMs);
            if (age >= 0 && age < 7) a.spark[6 - age] += 1;
        }
        by.set(key, a);
    }
    return [...by.entries()].map(([id, a]) => {
        const model = topModel(a.models);
        return {
        id, label: id, online: now - a.lastTs < dayMs, spark: levelize(a.spark),
        model, sessions: a.sessions, tokens: 0, cost: a.cost,
        metrics: [
            { label: "sessions", value: fmtCount(a.sessions), n: a.sessions },
            { label: "cost", value: a.cost > 0 ? fmtUsd(a.cost) : "-", n: a.cost },
            { label: "top model", value: model ? shortModel(model) : "-", n: 0 },
            { label: "lines +", value: fmtCount(a.added), n: a.added },
            { label: "lines -", value: fmtCount(a.removed), n: a.removed },
            { label: "friction sessions", value: fmtCount(a.friction), n: a.friction },
        ],
        };
    }).sort((x, y) => y.sessions - x.sessions);
}

/** Adapt the per-harness roster into the unified shape. */
function harnessEntities(rows: HarnessRow[]): RosterEntity[] {
    return rows.map((h) => ({
        id: h.source, label: h.source, online: h.online, spark: h.spark,
        model: h.model, sessions: h.sessions, tokens: 0, cost: h.cost,
        metrics: [
            { label: "sessions", value: fmtCount(h.sessions), n: h.sessions },
            { label: "cost", value: h.cost > 0 ? fmtUsd(h.cost) : "-", n: h.cost },
            { label: "top model", value: h.model ? shortModel(h.model) : "-", n: 0 },
            { label: "active (7d)", value: h.online ? "yes" : "no", n: h.online ? 1 : 0 },
        ],
    }));
}

/** Adapt fetched community profiles into the unified shape. */
function memberEntities(profiles: ReadonlyArray<MemberProfile>): RosterEntity[] {
    return profiles.map((p) => {
        const top = [...p.models].sort((a, b) => b.share - a.share)[0]?.name ?? null;
        return {
            id: p.github, label: p.github, online: false, spark: [],
            mid: (
                <span className="v-tm-chips">
                    {p.harnesses.slice(0, 4).map((h) => <span key={h} className="v-tm-chip">{h}</span>)}
                    {p.harnesses.length === 0 ? <span className="rdx-dim">-</span> : null}
                </span>
            ),
            model: top, sessions: p.sessions, tokens: p.tokens_total, cost: p.cost_usd ?? 0,
            metrics: [
                { label: "sessions", value: fmtCount(p.sessions), n: p.sessions },
                { label: "cost", value: p.cost_usd ? fmtUsd(p.cost_usd) : "-", n: p.cost_usd ?? 0 },
                { label: "tokens", value: fmtBig(p.tokens_total), n: p.tokens_total },
                { label: "streak", value: `${p.streak_days}d`, n: p.streak_days },
                { label: "active days", value: fmtCount(p.active_days), n: p.active_days },
                { label: "harnesses", value: String(p.harnesses.length), n: p.harnesses.length },
                { label: "top model", value: top ? shortModel(top) : "-", n: 0 },
            ],
        };
    });
}

// ===========================================================================
// MOCK org dataset - the blurred paywall teaser. Models a company's agent spend
// broken down BY FUNCTION (Engineering, Support, Sales…) - the exact view eng
// leadership pays for: who consumes the tokens, $/person, $/mo, spend share.
// All fabricated + deterministic: never leaks the operator's real numbers and
// renders fully even when the daemon is down.
// ===========================================================================
// Each function carries spend AND outcome. Output is counted in "tasks" -
// AI-assisted work items completed (PRs for eng, tickets for support, accounts
// for sales) - a unit that's comparable across every function. The story: by
// volume, Support is the standout (more AI-assisted work than engineering);
// Engineering is a fifth of the tasks but the majority of the spend.
interface MockFn {
    name: string; head: number; monthly: number; tokens: number; model: string;
    skills: number; workflows: number; tasks: number; firstPass: number; adopt: number;
}
const MOCK_FN_RAW: MockFn[] = [
    { name: "Engineering", head: 24, monthly: 74_556, tokens: 8_320_000_000, model: "claude-opus-4-8", skills: 31, workflows: 12, tasks: 793, firstPass: 0.86, adopt: 7 },
    { name: "Support", head: 11, monthly: 16_940, tokens: 1_880_000_000, model: "claude-sonnet-4-6", skills: 18, workflows: 7, tasks: 1_420, firstPass: 0.83, adopt: 1 },
    { name: "Sales", head: 44, monthly: 10_120, tokens: 1_120_000_000, model: "claude-haiku-4-5", skills: 9, workflows: 3, tasks: 880, firstPass: 0.71, adopt: 0 },
    { name: "Customer Success", head: 12, monthly: 8_280, tokens: 920_000_000, model: "claude-sonnet-4-6", skills: 11, workflows: 4, tasks: 612, firstPass: 0.85, adopt: 3 },
    { name: "Marketing", head: 8, monthly: 9_120, tokens: 1_010_000_000, model: "claude-sonnet-4-6", skills: 13, workflows: 5, tasks: 240, firstPass: 0.74, adopt: 2 },
    { name: "Founders", head: 4, monthly: 6_400, tokens: 710_000_000, model: "claude-opus-4-8", skills: 16, workflows: 6, tasks: 64, firstPass: 0.78, adopt: 6 },
];
const MOCK_FN_TOTAL = MOCK_FN_RAW.reduce((s, f) => s + f.monthly, 0);
const MOCK_FN_TASKS = MOCK_FN_RAW.reduce((s, f) => s + f.tasks, 0);

/** Org-level hero numbers (the scoreboard headline). */
const MOCK_ORG = {
    tasksPerMo: MOCK_FN_TASKS,
    perTask: Math.round(MOCK_FN_TOTAL / MOCK_FN_TASKS),
    perTaskPrev: 52, // 90d ago - the "it gets cheaper" trend
    monthly: MOCK_FN_TOTAL,
    activePct: 0.88,
    activePctPrev: 0.41,
    firstPass: MOCK_FN_RAW.reduce((s, f) => s + f.tasks * f.firstPass, 0) / MOCK_FN_TASKS,
};

const MOCK_MEMBERS: RosterEntity[] = MOCK_FN_RAW.map((f) => {
    const share = f.monthly / MOCK_FN_TOTAL;
    const taskShare = f.tasks / MOCK_FN_TASKS;
    const perTask = Math.round(f.monthly / f.tasks);
    const perPerson = Math.round(f.monthly / f.head);
    return {
        id: f.name, label: f.name, online: true, spark: [],
        mid: <span className="v-tm-chips"><span className="v-tm-chip team">{f.head} ppl</span></span>,
        model: f.model, sessions: f.head, tokens: f.tokens, cost: f.monthly,
        outcome: { taskShare, tasks: f.tasks, perTask, firstPass: f.firstPass },
        // Compare panel: OUTCOME first, spend demoted to the bottom rows.
        metrics: [
            { label: "task share", value: `${Math.round(taskShare * 100)}%`, n: taskShare },
            { label: "tasks / mo", value: fmtCount(f.tasks), n: f.tasks },
            { label: "$ / task", value: fmtUsd(perTask), n: -perTask },
            { label: "first-pass", value: `${Math.round(f.firstPass * 100)}%`, n: f.firstPass },
            { label: "skills adopted", value: String(f.skills), n: f.skills },
            { label: "adoption Δ 30d", value: `${f.adopt >= 0 ? "+" : ""}${f.adopt}`, n: f.adopt },
            { label: "spend $ / mo", value: fmtUsd(f.monthly), n: -f.monthly },
            { label: "spend share", value: `${Math.round(share * 100)}%`, n: -share },
            { label: "$ / person", value: fmtUsd(perPerson), n: -perPerson },
        ],
    };
});

function mockProject(
    name: string, sessions: number, cost: number, added: number, removed: number,
    friction: number, model: string,
): RosterEntity {
    return {
        id: name, label: name, online: true, spark: levelize([3, 5, 2, 6, 4, 7, 5]),
        model, sessions, tokens: 0, cost,
        metrics: [
            { label: "sessions", value: fmtCount(sessions), n: sessions },
            { label: "cost", value: fmtUsd(cost), n: cost },
            { label: "top model", value: shortModel(model), n: 0 },
            { label: "lines +", value: fmtCount(added), n: added },
            { label: "lines -", value: fmtCount(removed), n: removed },
            { label: "friction sessions", value: fmtCount(friction), n: friction },
        ],
    };
}

const MOCK_PROJECTS: RosterEntity[] = [
    mockProject("checkout-service", 842, 9120, 184_300, 41_200, 173, "claude-opus-4-8"),
    mockProject("web-app", 731, 6240, 142_800, 38_900, 142, "claude-sonnet-4-6"),
    mockProject("data-pipeline", 519, 5380, 98_400, 22_100, 121, "gpt-5.4"),
    mockProject("mobile", 388, 3110, 67_200, 19_400, 88, "claude-sonnet-4-6"),
    mockProject("infra", 247, 2740, 31_900, 12_800, 54, "claude-haiku-4-5"),
];

const MOCK_HARNESSES: RosterEntity[] = [
    { id: "claude", label: "claude", online: true, spark: levelize([6, 5, 7, 6, 7, 6, 7]), model: "claude-opus-4-8", sessions: 1840, tokens: 0, cost: 21300,
        metrics: [{ label: "sessions", value: "1,840", n: 1840 }, { label: "cost", value: fmtUsd(21300), n: 21300 }, { label: "top model", value: "claude-opus-4-8", n: 0 }, { label: "active (7d)", value: "yes", n: 1 }] },
    { id: "codex", label: "codex", online: true, spark: levelize([3, 4, 2, 5, 3, 4, 3]), model: "gpt-5.4", sessions: 612, tokens: 0, cost: 7200,
        metrics: [{ label: "sessions", value: "612", n: 612 }, { label: "cost", value: fmtUsd(7200), n: 7200 }, { label: "top model", value: "gpt-5.4", n: 0 }, { label: "active (7d)", value: "yes", n: 1 }] },
    { id: "cursor", label: "cursor", online: false, spark: levelize([1, 0, 2, 1, 0, 1, 0]), model: "claude-sonnet-4-6", sessions: 203, tokens: 0, cost: 1810,
        metrics: [{ label: "sessions", value: "203", n: 203 }, { label: "cost", value: fmtUsd(1810), n: 1810 }, { label: "top model", value: "claude-sonnet-4-6", n: 0 }, { label: "active (7d)", value: "no", n: 0 }] },
];

const MOCK_CHANNELS = [
    { model: "claude-opus-4-8", cost_usd: 14200 },
    { model: "claude-fable-5", cost_usd: 8600 },
    { model: "gpt-5.4", cost_usd: 6300 },
    { model: "claude-sonnet-4-6", cost_usd: 4100 },
    { model: "claude-haiku-4-5", cost_usd: 1200 },
];
const MOCK_COST_TOTAL = MOCK_CHANNELS.reduce((s, r) => s + r.cost_usd, 0);

/** Deterministic ~9-week org-wide daily series (sessions/turns/tokens). */
function mockDays(): WrappedUsageDay[] {
    const out: WrappedUsageDay[] = [];
    const today = new Date();
    const N = 63;
    for (let i = N - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dow = d.getDay();
        const weekday = dow >= 1 && dow <= 5 ? 1 : 0.35; // quiet weekends
        const wave = 0.62 + 0.38 * Math.sin((N - i) / 6.2);
        const sessions = Math.round((120 + 90 * wave) * weekday);
        out.push({
            date: d.toISOString().slice(0, 10),
            sessions,
            turns: sessions * (38 + Math.round(14 * wave)),
            tokens: sessions * 9_400_000,
        });
    }
    return out;
}
const MOCK_DAYS: WrappedUsageDay[] = mockDays();

// ===========================================================================
// DEMO org dataset - the clean, fully-visible `?demo` board. Tells the
// DEV-ADOPTION story from the /design-partners pitch: a git-native team
// rollup for AI coding agents. Framing is adoption + routable spend + skill
// diffusion, NOT the exec business-functions view (which stays on the locked
// teaser). All numbers echo the pitch's RollupMock so the two never contradict.
// Fabricated + deterministic; no live queries, renders daemon-up or down.
// ===========================================================================
const DEMO_ORG = {
    label: "acme",
    seats: 8,
    activeThisWeek: 8,
    activePct: 0.82, // team active-days
    activePctPrev: 0.61, // 8 weeks ago (matches pitch "up from 61%")
    spendUsd: 2140, // total agent spend / mo
    routableUsd: 605, // routine sub-tasks on the expensive default
    workflowsReady: 3, // above the cohort floor (seen on 5+ seats)
};

/** Model spend for the month - opus is the expensive default; the routable
 *  slice ($605) is routine work that belongs on cheaper tiers. Sums to $2,140. */
const DEMO_CHANNELS = [
    { model: "claude-opus-4-8", cost_usd: 1205 },
    { model: "claude-sonnet-4-6", cost_usd: 520 },
    { model: "claude-haiku-4-5", cost_usd: 210 },
    { model: "gpt-5.4", cost_usd: 205 },
];

/** A repo in the acme org. `joined` = opted in via `ax team join` (drives the
 *  status dot); a not-joined repo pushes nothing, so it reads as dashes. */
function demoProject(
    name: string, joined: boolean, sessions: number, cost: number,
    added: number, removed: number, model: string,
): RosterEntity {
    return {
        id: name, label: name, online: joined,
        spark: joined ? levelize([2, 3, 3, 4, 5, 5, 6]) : [0, 0, 0, 0, 0, 0, 0],
        model: joined ? model : null, sessions, tokens: 0, cost,
        metrics: [
            { label: "opt-in", value: joined ? "joined" : "not joined", n: joined ? 1 : 0 },
            { label: "sessions", value: joined ? fmtCount(sessions) : "-", n: sessions },
            { label: "cost / mo", value: joined ? fmtUsd(cost) : "-", n: cost },
            { label: "top model", value: joined ? shortModel(model) : "-", n: 0 },
            { label: "lines +", value: joined ? fmtCount(added) : "-", n: added },
            { label: "lines -", value: joined ? fmtCount(removed) : "-", n: removed },
        ],
    };
}

// joined repos sum to the $2,140/mo org total; acme-infra is opted out.
const DEMO_PROJECTS: RosterEntity[] = [
    demoProject("acme-web", true, 312, 940, 41_200, 9_800, "claude-opus-4-8"),
    demoProject("acme-api", true, 268, 720, 33_100, 7_400, "claude-sonnet-4-6"),
    demoProject("acme-mobile", true, 141, 310, 18_600, 4_100, "claude-sonnet-4-6"),
    demoProject("acme-billing", true, 96, 170, 9_200, 2_300, "claude-haiku-4-5"),
    demoProject("acme-infra", false, 0, 0, 0, 0, "claude-sonnet-4-6"),
];

/** An anonymized seat (eng-01…eng-08). No names, no per-person spend, no
 *  ranking metric - just adoption signals. Reinforces k-anonymity. */
interface DemoSeat { id: string; activeDays: number; sessions: number; harnesses: string[]; model: string; skills: number }
const DEMO_SEATS: DemoSeat[] = [
    { id: "eng-01", activeDays: 26, sessions: 41, harnesses: ["claude", "codex"], model: "claude-opus-4-8", skills: 9 },
    { id: "eng-02", activeDays: 24, sessions: 38, harnesses: ["claude"], model: "claude-sonnet-4-6", skills: 8 },
    { id: "eng-03", activeDays: 23, sessions: 34, harnesses: ["claude", "cursor"], model: "claude-opus-4-8", skills: 7 },
    { id: "eng-04", activeDays: 21, sessions: 30, harnesses: ["claude", "codex"], model: "claude-sonnet-4-6", skills: 7 },
    { id: "eng-05", activeDays: 19, sessions: 27, harnesses: ["claude"], model: "claude-sonnet-4-6", skills: 6 },
    { id: "eng-06", activeDays: 18, sessions: 24, harnesses: ["claude", "cursor"], model: "claude-haiku-4-5", skills: 5 },
    { id: "eng-07", activeDays: 15, sessions: 19, harnesses: ["claude"], model: "claude-sonnet-4-6", skills: 5 },
    { id: "eng-08", activeDays: 12, sessions: 14, harnesses: ["codex"], model: "gpt-5.4", skills: 4 },
];
const DEMO_MEMBERS: RosterEntity[] = DEMO_SEATS.map((s) => ({
    id: s.id, label: s.id, online: s.activeDays >= 7, spark: [],
    mid: (
        <span className="v-tm-chips">
            {s.harnesses.map((h) => <span key={h} className="v-tm-chip">{h}</span>)}
        </span>
    ),
    model: s.model, sessions: s.sessions, tokens: 0, cost: 0,
    metrics: [
        { label: "active days", value: `${s.activeDays} / 30`, n: s.activeDays },
        { label: "sessions", value: fmtCount(s.sessions), n: s.sessions },
        { label: "harnesses", value: String(s.harnesses.length), n: s.harnesses.length },
        { label: "skills adopted", value: String(s.skills), n: s.skills },
        { label: "top model", value: shortModel(s.model), n: 0 },
    ],
}));

const DEMO_HARNESSES: RosterEntity[] = [
    { id: "claude", label: "claude", online: true, spark: levelize([5, 6, 6, 7, 6, 7, 7]), model: "claude-opus-4-8", sessions: 612, tokens: 0, cost: 1610,
        metrics: [{ label: "sessions", value: "612", n: 612 }, { label: "cost / mo", value: fmtUsd(1610), n: 1610 }, { label: "seats", value: "7", n: 7 }, { label: "active (7d)", value: "yes", n: 1 }] },
    { id: "codex", label: "codex", online: true, spark: levelize([2, 3, 2, 3, 4, 3, 4]), model: "gpt-5.4", sessions: 138, tokens: 0, cost: 205,
        metrics: [{ label: "sessions", value: "138", n: 138 }, { label: "cost / mo", value: fmtUsd(205), n: 205 }, { label: "seats", value: "3", n: 3 }, { label: "active (7d)", value: "yes", n: 1 }] },
    { id: "cursor", label: "cursor", online: true, spark: levelize([1, 2, 1, 2, 2, 1, 2]), model: "claude-sonnet-4-6", sessions: 67, tokens: 0, cost: 325,
        metrics: [{ label: "sessions", value: "67", n: 67 }, { label: "cost / mo", value: fmtUsd(325), n: 325 }, { label: "seats", value: "2", n: 2 }, { label: "active (7d)", value: "yes", n: 1 }] },
];

/** Skills spreading across seats - the diffusion story. Seat counts match the
 *  pitch's "Skills spreading" list (effect-kit 6, ship-checklist 5, ...). */
const DEMO_SKILLS: { name: string; seats: number; runs: number }[] = [
    { name: "effect-kit", seats: 6, runs: 214 },
    { name: "ship-checklist", seats: 5, runs: 168 },
    { name: "ax-extract-workflow", seats: 5, runs: 132 },
    { name: "design-taste-frontend", seats: 4, runs: 88 },
    { name: "cta-design", seats: 3, runs: 54 },
];

/** Workflows (ordered skill arcs) that recur on 5+ seats - "ready to spread". */
const DEMO_WORKFLOWS: { arc: string; seats: number }[] = [
    { arc: "plan → implement → ship-checklist", seats: 6 },
    { arc: "recall → extract-workflow → improve", seats: 5 },
    { arc: "gather → design-taste → review", seats: 5 },
];

/** Deterministic ~9-week daily series with a gently RISING adoption ramp
 *  (seats coming online) - the "adoption, last N days" trend from the pitch. */
function demoDays(): WrappedUsageDay[] {
    const out: WrappedUsageDay[] = [];
    const today = new Date();
    const N = 63;
    for (let i = N - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dow = d.getDay();
        const weekday = dow >= 1 && dow <= 5 ? 1 : 0.3; // quiet weekends
        const t = (N - 1 - i) / (N - 1); // 0 → 1 over the window
        const ramp = 0.42 + 0.58 * t; // adoption climbs
        const wobble = 0.92 + 0.08 * Math.sin((N - i) / 3.1);
        const sessions = Math.round((12 + 30 * ramp) * weekday * wobble);
        out.push({
            date: d.toISOString().slice(0, 10),
            sessions,
            turns: sessions * (26 + Math.round(12 * ramp)),
            tokens: sessions * 4_100_000,
        });
    }
    return out;
}
const DEMO_DAYS: WrappedUsageDay[] = demoDays();

// ---- range toggle group ---------------------------------------------------
function Toggle<T extends number>({
    label, values, value, onChange, suffix,
}: { label: string; values: ReadonlyArray<T>; value: T; onChange: (v: T) => void; suffix: string }) {
    return (
        <div className="v-tm-toggle">
            <span className="rdx-label">{label}</span>
            {values.map((v) => (
                <button key={v} type="button" className={v === value ? "on" : ""} onClick={() => onChange(v)}>
                    {v} {suffix}
                </button>
            ))}
        </div>
    );
}

// ---- chart card -----------------------------------------------------------
function ChartCard({
    title, range, total, data, labels, color, kind = "bar",
}: {
    title: string; range: string; total: string;
    data: ReadonlyArray<number>; labels: ReadonlyArray<string>; color: string; kind?: "bar" | "line";
}) {
    return (
        <section className="rdx-card v-tm-chart">
            <div className="v-tm-chart-head">
                <div className="rdx-label" style={{ color: "var(--pri)", letterSpacing: "0.06em" }}>{title}</div>
                <div className="rdx-num v-tm-chart-total">{total}</div>
                <div className="rdx-label">{range}</div>
            </div>
            <BarChart data={data} labels={labels} color={color} kind={kind} height={120} />
        </section>
    );
}

// ---- hero scoreboard strip (teaser) ---------------------------------------
/** Three outcome tiles - the band that reads above the paywall card. Sells
 *  return-on-agent (output + leverage + momentum), not the bill. */
function HeroStrip() {
    // The surprising cross-function insight: by AI-assisted work volume, Support
    // leads - while Engineering is the spend leader. (mirrors the LinkedIn post)
    const byTasks = [...MOCK_FN_RAW].sort((a, b) => b.tasks - a.tasks)[0];
    const bySpend = [...MOCK_FN_RAW].sort((a, b) => b.monthly - a.monthly)[0];
    const topTaskShare = Math.round((byTasks.tasks / MOCK_FN_TASKS) * 100);
    const topPerTask = Math.round(byTasks.monthly / byTasks.tasks);
    const spendTaskShare = Math.round((bySpend.tasks / MOCK_FN_TASKS) * 100);
    const spendShare = Math.round((bySpend.monthly / MOCK_FN_TOTAL) * 100);
    const drop = Math.round((1 - MOCK_ORG.perTask / MOCK_ORG.perTaskPrev) * 100);
    return (
        <div className="v-tm-hero">
            <section className="rdx-card v-tm-herotile">
                <div className="rdx-label">$ / task · org-wide</div>
                <div className="rdx-num v-tm-herostat">{fmtUsd(MOCK_ORG.perTask)}</div>
                <div className="v-tm-trend down"><span className="arr">▼</span> {drop}% vs 90d ago · was {fmtUsd(MOCK_ORG.perTaskPrev)}</div>
            </section>
            <section className="rdx-card v-tm-herotile">
                <div className="rdx-label">tasks shipped · / mo</div>
                <div className="rdx-num v-tm-herostat">{fmtCount(MOCK_ORG.tasksPerMo)}</div>
                <div className="v-tm-trend"><span className="rdx-led accent" /> {Math.round(MOCK_ORG.firstPass * 100)}% done first-pass</div>
            </section>
            <section className="rdx-card v-tm-herotile">
                <div className="rdx-label">people active · this week</div>
                <div className="rdx-num v-tm-herostat">{Math.round(MOCK_ORG.activePct * 100)}<small>%</small></div>
                <div className="v-tm-trend up"><span className="arr">▲</span> from {Math.round(MOCK_ORG.activePctPrev * 100)}% · 8 weeks ago</div>
            </section>
            <p className="v-tm-hero-cap rdx-label">
                <b>{byTasks.name}</b> does <b>{topTaskShare}%</b> of the company's AI-assisted work at {fmtUsd(topPerTask)}/task &mdash; more than engineering.
                <b> {bySpend.name}</b> is {spendTaskShare}% of the tasks but {spendShare}% of the spend. A cost report wouldn't tell you that.
            </p>
        </div>
    );
}

// ---- demo hero (dev-adoption tiles) ---------------------------------------
/** Four adoption tiles for the `?demo` board - active seats, active-days,
 *  routable spend, workflows ready to spread. Replaces the exec HeroStrip. */
function DemoHero() {
    const routablePct = Math.round((DEMO_ORG.routableUsd / DEMO_ORG.spendUsd) * 100);
    const activeDelta = Math.round((DEMO_ORG.activePct - DEMO_ORG.activePctPrev) * 100);
    return (
        <div className="v-tm-hero v-tm-hero--demo">
            <section className="rdx-card v-tm-herotile">
                <div className="rdx-label">devs active · this week</div>
                <div className="rdx-num v-tm-herostat">{DEMO_ORG.activeThisWeek}<small> / {DEMO_ORG.seats}</small></div>
                <div className="v-tm-trend"><span className="rdx-led accent" /> across 4 joined repos</div>
            </section>
            <section className="rdx-card v-tm-herotile">
                <div className="rdx-label">team active-days</div>
                <div className="rdx-num v-tm-herostat">{Math.round(DEMO_ORG.activePct * 100)}<small>%</small></div>
                <div className="v-tm-trend up"><span className="arr">▲</span> +{activeDelta}% from {Math.round(DEMO_ORG.activePctPrev * 100)}% · 8 weeks ago</div>
            </section>
            <section className="rdx-card v-tm-herotile">
                <div className="rdx-label">routable spend · / mo</div>
                <div className="rdx-num v-tm-herostat">{fmtUsd(DEMO_ORG.routableUsd)}</div>
                <div className="v-tm-trend"><span className="rdx-led accent" /> {routablePct}% of {fmtUsd(DEMO_ORG.spendUsd)} on the pricey default</div>
            </section>
            <section className="rdx-card v-tm-herotile">
                <div className="rdx-label">workflows ready to spread</div>
                <div className="rdx-num v-tm-herostat">{DEMO_ORG.workflowsReady}</div>
                <div className="v-tm-trend"><span className="rdx-led accent" /> settled arcs seen on 5+ seats</div>
            </section>
        </div>
    );
}

/** Skills-spreading + workflows-ready cards - the diffusion story (demo only).
 *  Reuses the model-channels list styling (.v-mc-split / .v-mc-split-row). */
function DemoAdoptionRow() {
    const maxSeats = Math.max(...DEMO_SKILLS.map((s) => s.seats), 1);
    return (
        <div className="v-tm-grid">
            <section className="rdx-card v-mc-split">
                <div className="v-mc-meta rdx-label">
                    <span style={{ color: "var(--pri)" }}>SKILLS SPREADING · seats using</span>
                    <span>{DEMO_SKILLS.length} skills</span>
                </div>
                <div className="nf-list">
                    {DEMO_SKILLS.map((s) => (
                        <div className="v-mc-split-row" key={s.name}>
                            <span style={{ color: "var(--pri)" }}>
                                <span className="nf-swatch" style={{ background: "var(--accent)" }} />{s.name}
                            </span>
                            <span>{s.seats} seats · {fmtCount(s.runs)} runs</span>
                            <span className="segwrap">
                                <span className="v-tm-bar"><span style={{ width: `${Math.max(6, (s.seats / maxSeats) * 100)}%`, background: "var(--accent)" }} /></span>
                            </span>
                        </div>
                    ))}
                </div>
            </section>

            <section className="rdx-card v-mc-split">
                <div className="v-mc-meta rdx-label">
                    <span style={{ color: "var(--pri)" }}>WORKFLOWS READY TO SPREAD</span>
                    <span>{DEMO_WORKFLOWS.length} above floor</span>
                </div>
                <div className="nf-list">
                    {DEMO_WORKFLOWS.map((w) => (
                        <div className="v-mc-split-row" key={w.arc}>
                            <span style={{ color: "var(--pri)" }}>{w.arc}</span>
                            <span>{w.seats} seats</span>
                        </div>
                    ))}
                    <p className="rdx-label" style={{ margin: "10px 2px 2px", lineHeight: 1.5, textTransform: "none", letterSpacing: 0 }}>
                        The workflows your team settles into, seen on 5+ seats - ready to package and share.
                    </p>
                </div>
            </section>
        </div>
    );
}

// ---- tabbed, selectable roster --------------------------------------------
function RosterCard({
    tab, onTab, entities, loading, selected, onToggle, midHead, orgMode = false, demo = false,
}: {
    tab: RosterTab; onTab: (t: RosterTab) => void;
    entities: RosterEntity[]; loading: boolean;
    selected: ReadonlySet<string>; onToggle: (id: string) => void;
    midHead: string; orgMode?: boolean; demo?: boolean;
}) {
    // orgMode (the paid teaser) frames the members tab as company FUNCTIONS.
    const tabLabel = (t: RosterTab) => (orgMode && t === "members" ? "functions" : TABS.find((x) => x.id === t)?.label ?? t);
    const noun = tab === "members" ? (orgMode ? "function" : demo ? "seat" : "member") : tab === "projects" ? "project" : "harness";
    // Members/functions are the org roster - lead with token consumption. In the
    // demo, seats lead with sessions (no per-person spend → no ranking).
    const tokenLed = tab === "members" && !demo;
    // Demo seats are anonymized + unranked - say so where a leaderboard is implied.
    const headNote = demo && tab === "members"
        ? "aggregate view · no per-person ranking"
        : selected.size >= 1 ? `${selected.size} selected` : "click rows · compare 2+";
    return (
        <section className="rdx-card v-team-roster">
            <div className="v-tm-roster-head">
                <div className="v-tm-tabs">
                    {TABS.map((t) => (
                        <button key={t.id} type="button" className={t.id === tab ? "on" : ""} onClick={() => onTab(t.id)}>
                            {tabLabel(t.id)}
                        </button>
                    ))}
                </div>
                <span className="rdx-label">{headNote}</span>
            </div>
            <div className="nf-list">
                {orgMode
                    ? <OutcomeTable entities={entities} loading={loading} selected={selected} onToggle={onToggle} />
                    : (
                        <table className="v-team-rt">
                            <thead>
                                <tr>
                                    <th>{noun}</th>
                                    <th>{midHead}</th>
                                    <th className="r">model</th>
                                    <th className="r">{tokenLed ? "tokens" : "sessions"}</th>
                                    <th className="r">cost</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entities.length === 0 ? (
                                    <tr><td colSpan={5} className="rdx-label">{loading ? "loading…" : `no ${noun}s yet`}</td></tr>
                                ) : entities.map((e) => (
                                    <tr key={e.id} className={`v-tm-row${selected.has(e.id) ? " sel" : ""}`} onClick={() => onToggle(e.id)}>
                                        <td>
                                            <span className="v-team-who">
                                                <span className={`v-tm-check${selected.has(e.id) ? " on" : ""}`} />
                                                <span className={`dot${e.online ? " on" : ""}`} />
                                                <span className="h">{e.label}</span>
                                            </span>
                                        </td>
                                        <td>
                                            {e.spark.length > 0 ? (
                                                <span className="v-team-spark">
                                                    {e.spark.map((lvl, i) => <i key={i} className={lvl ? `lvl-${lvl}` : ""} />)}
                                                </span>
                                            ) : (e.mid ?? <span className="rdx-dim">-</span>)}
                                        </td>
                                        <td className="r"><span className="v-team-model">{e.model ? shortModel(e.model) : "-"}</span></td>
                                        <td className="r v-team-num">{tokenLed ? fmtBig(e.tokens) : fmtCount(e.sessions)}</td>
                                        <td className="r v-team-num">{e.cost > 0 ? fmtUsd(e.cost) : "-"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
            </div>
        </section>
    );
}

/** The org scoreboard table - output-led (tasks), spend demoted to the last
 *  column. "Tasks" = AI-assisted work items, comparable across all functions. */
function OutcomeTable({
    entities, loading, selected, onToggle,
}: { entities: RosterEntity[]; loading: boolean; selected: ReadonlySet<string>; onToggle: (id: string) => void }) {
    const ranked = [...entities].sort((a, b) => (b.outcome?.taskShare ?? 0) - (a.outcome?.taskShare ?? 0));
    return (
        <table className="v-team-rt v-tm-out">
            <thead>
                <tr>
                    <th>function</th>
                    <th>share of AI work</th>
                    <th className="r">tasks/mo</th>
                    <th className="r">$/task</th>
                    <th className="r">first-pass</th>
                    <th className="r dim">$/mo</th>
                </tr>
            </thead>
            <tbody>
                {ranked.length === 0 ? (
                    <tr><td colSpan={6} className="rdx-label">{loading ? "loading…" : "no functions yet"}</td></tr>
                ) : ranked.map((e) => {
                    const o = e.outcome;
                    return (
                        <tr key={e.id} className={`v-tm-row${selected.has(e.id) ? " sel" : ""}`} onClick={() => onToggle(e.id)}>
                            <td>
                                <span className="v-team-who">
                                    <span className={`v-tm-check${selected.has(e.id) ? " on" : ""}`} />
                                    <span className="h">{e.label}</span>
                                </span>
                            </td>
                            <td>
                                <span className="v-tm-share">
                                    <span className="v-tm-bar"><span style={{ width: `${Math.max(3, (o?.taskShare ?? 0) * 100)}%`, background: "var(--accent)" }} /></span>
                                    <b>{Math.round((o?.taskShare ?? 0) * 100)}%</b>
                                </span>
                            </td>
                            <td className="r v-team-num">{fmtCount(o?.tasks ?? 0)}</td>
                            <td className="r v-team-num">{fmtUsd(o?.perTask ?? 0)}</td>
                            <td className="r v-team-num">{Math.round((o?.firstPass ?? 0) * 100)}%</td>
                            <td className="r v-team-num dim">{fmtUsd(e.cost)}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

// ---- side-by-side compare panel -------------------------------------------
function ComparePanel({ entities, onClear }: { entities: RosterEntity[]; onClear: () => void }) {
    if (entities.length < 2) return null;
    // metric labels come from the first entity; every entity in a tab shares
    // the same ordered metric set, so columns align row-for-row.
    const labels = entities[0].metrics.map((m) => m.label);
    return (
        <section className="rdx-card v-tm-compare">
            <div className="v-tm-roster-head">
                <div className="rdx-label" style={{ color: "var(--pri)" }}>COMPARE · {entities.length} selected</div>
                <button type="button" className="v-tm-clear" onClick={onClear}>clear</button>
            </div>
            <div className="v-tm-compare-scroll">
                <table className="v-tm-compare-table">
                    <thead>
                        <tr>
                            <th>metric</th>
                            {entities.map((e) => <th key={e.id} className="r">{e.label}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {labels.map((label, ri) => {
                            const cells = entities.map((e) => e.metrics[ri]);
                            const max = Math.max(...cells.map((c) => c?.n ?? 0));
                            return (
                                <tr key={label}>
                                    <td className="v-tm-compare-k">{label}</td>
                                    {cells.map((c, ci) => (
                                        <td key={entities[ci].id} className={`r v-team-num${c && c.n > 0 && c.n === max ? " lead" : ""}`}>
                                            {c?.value ?? "-"}
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function Board({ days: liveDays, teaser = false, demo = false }: { days: ReadonlyArray<WrappedUsageDay>; teaser?: boolean; demo?: boolean }) {
    const [daily, setDaily] = useState<DailyRange>(30);
    const [weeks, setWeeks] = useState<WeeklyRange>(8);

    // Both the teaser and the demo run on fabricated, self-contained data (no
    // live queries) - the difference is framing, not the data source.
    const mock = teaser || demo;
    const days = demo ? DEMO_DAYS : teaser ? MOCK_DAYS : liveDays;
    const dWin = useMemo(() => days.slice(-daily), [days, daily]);
    const wAll = useMemo(() => weekly(days), [days]);
    const wWin = useMemo(
        () => ({
            labels: wAll.labels.slice(-weeks),
            sessions: wAll.sessions.slice(-weeks),
            turns: wAll.turns.slice(-weeks),
        }),
        [wAll, weeks],
    );

    const dayLabels = (arr: ReadonlyArray<WrappedUsageDay>): string[] => {
        if (arr.length === 0) return [];
        const step = Math.max(1, Math.floor(arr.length / 4));
        return arr.map((d, i) => (i % step === 0 || i === arr.length - 1 ? mdLabel(d.date) : ""));
    };
    const labelsD = dayLabels(dWin);

    const sessionsD = dWin.map((d) => d.sessions);
    const turnsD = dWin.map((d) => d.turns);
    const sum = (a: ReadonlyArray<number>) => a.reduce((s, n) => s + n, 0);

    // roster + channels. In teaser mode everything is mock (no live queries) so
    // the paywall background never leaks real numbers and never depends on the
    // daemon being up.
    const sessQ = useQuery({ queryKey: ["sessions", "roster"], queryFn: () => api.sessions({ limit: 500 }), enabled: !mock });
    const sessions = sessQ.data?.sessions ?? [];
    const costQ = useQuery({ queryKey: ["cost", "models"], queryFn: () => api.costModels(), enabled: !mock });
    const channels = demo ? DEMO_CHANNELS : teaser ? MOCK_CHANNELS : (costQ.data?.rows ?? []).filter((r) => r.cost_usd > 0).slice(0, 8);
    const costTotal = demo ? DEMO_ORG.spendUsd : teaser ? MOCK_COST_TOTAL : (costQ.data?.total_cost_usd || channels.reduce((s, r) => s + r.cost_usd, 0) || 1);

    // tabbed roster (projects | members | harnesses) + side-by-side compare.
    // Teaser opens on members (the company org roster, ranked by tokens).
    const [tab, setTab] = useState<RosterTab>(teaser ? "members" : "projects");
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const switchTab = (t: RosterTab) => { setTab(t); setSelected(new Set()); };
    const toggleSel = (id: string) => setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });
    // Members are public gists - only fetch when that tab is opened (live only).
    const memQ = useQuery({ queryKey: ["members"], queryFn: () => fetchMembers(), enabled: !mock && tab === "members", staleTime: 300_000 });
    const projects = useMemo(() => demo ? DEMO_PROJECTS : teaser ? MOCK_PROJECTS : buildProjects(sessions), [demo, teaser, sessions]);
    const harnesses = useMemo(() => demo ? DEMO_HARNESSES : teaser ? MOCK_HARNESSES : harnessEntities(buildRoster(sessions)), [demo, teaser, sessions]);
    const members = useMemo(() => demo ? DEMO_MEMBERS : teaser ? MOCK_MEMBERS : memberEntities(memQ.data ?? []), [demo, teaser, memQ.data]);
    const entities = tab === "projects" ? projects : tab === "members" ? members : harnesses;
    const rosterLoading = mock ? false : tab === "members" ? memQ.isLoading : sessQ.isLoading;
    const midHead = tab === "members" ? (teaser ? "headcount" : "harnesses") : "last 7d";
    const selectedEntities = entities.filter((e) => selected.has(e.id));

    // Teaser: auto-select the top 2 of the current tab so the blurred compare
    // panel behind the paywall shows a head-to-head (two engineers by default).
    useEffect(() => {
        if (teaser && selected.size === 0 && entities.length >= 2) {
            setSelected(new Set([entities[0].id, entities[1].id]));
        }
    }, [teaser, selected.size, entities]);

    return (
        <>
            <header className="v-tm-mast">
                <div className="v-team-org">
                    <span className="name">
                        {demo ? <><b>{DEMO_ORG.label}</b> team adoption</> : <><b>ax</b> team metrics</>}
                    </span>
                    <span className="ring">{demo ? "team rollup" : "local graph"}</span>
                    {demo && <span className="v-tm-demo-badge">demo · sample data</span>}
                </div>
                <div className="v-tm-ranges">
                    <Toggle label="daily" values={DAILY} value={daily} onChange={(v) => setDaily(v)} suffix="d" />
                    <Toggle label="weekly" values={WEEKLY} value={weeks} onChange={(v) => setWeeks(v)} suffix="w" />
                </div>
            </header>
            <p className="rdx-label v-tm-sub">
                {demo
                    ? "How AI adoption is spreading across the team - active seats, routable spend, and the skills & workflows that land. Every number is a team-level aggregate; no per-person ranking."
                    : teaser
                        ? "Return on every agent dollar - what each team ships, what it costs per task, and who's actually adopting."
                        : "Where your agent spend goes and which skills & workflows get adopted. Compare projects, harnesses, or community members side-by-side - pick 2+ rows."}
            </p>

            {teaser && <HeroStrip />}
            {demo && <DemoHero />}

            <div className="v-tm-charts">
                <ChartCard title="SESSIONS / DAY" range={`last ${daily}d`} total={fmtCount(sum(sessionsD))}
                    data={sessionsD} labels={labelsD} color="var(--accent)" />
                <ChartCard title="SESSIONS / WEEK" range={`last ${weeks}w`} total={fmtCount(sum(wWin.sessions))}
                    data={wWin.sessions} labels={wWin.labels} color="var(--gold)" />
                <ChartCard title="TURNS / DAY" range={`last ${daily}d`} total={fmtBig(sum(turnsD))}
                    data={turnsD} labels={labelsD} color="var(--violet)" kind="line" />
                <ChartCard title="TURNS / WEEK" range={`last ${weeks}w`} total={fmtBig(sum(wWin.turns))}
                    data={wWin.turns} labels={wWin.labels} color="var(--blue)" />
            </div>

            <div className="v-tm-grid">
                <RosterCard tab={tab} onTab={switchTab} entities={entities} loading={rosterLoading}
                    selected={selected} onToggle={toggleSel} midHead={midHead} orgMode={teaser} demo={demo} />

                <section className="rdx-card v-mc-split">
                    <div className="v-mc-meta rdx-label">
                        <span style={{ color: "var(--pri)" }}>{demo ? "MODEL SPEND · this month" : "MODEL CHANNELS · 365d"}</span>
                        <span>{demo ? `${fmtUsd(costTotal)}/mo · ${fmtUsd(DEMO_ORG.routableUsd)} routable` : `~${fmtUsd(costTotal)} total`}</span>
                    </div>
                    <div className="nf-list">
                        {channels.length === 0 ? (
                            <span className="rdx-label" style={{ marginTop: 8 }}>{costQ.isLoading ? "loading…" : "no cost data"}</span>
                        ) : channels.map((r) => {
                            const share = r.cost_usd / costTotal;
                            const c = toneFor(r.model);
                            return (
                                <div className="v-mc-split-row" key={r.model}>
                                    <span style={{ color: "var(--pri)" }}>
                                        <span className="nf-swatch" style={{ background: c }} />{shortModel(r.model)}
                                    </span>
                                    <span>{Math.round(share * 100)}% · {fmtUsd(r.cost_usd)}</span>
                                    <span className="segwrap">
                                        <span className="v-tm-bar"><span style={{ width: `${Math.max(2, share * 100)}%`, background: c }} /></span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </section>
            </div>

            {demo && <DemoAdoptionRow />}

            <ComparePanel entities={selectedEntities} onClear={() => setSelected(new Set())} />
        </>
    );
}

function Notice({ title, detail }: { title: string; detail: string }) {
    return (
        <section className="rdx-card" style={{ padding: 24, maxWidth: 520 }}>
            <div className="rdx-label" style={{ color: "var(--pri)" }}>{title}</div>
            <div className="rdx-label" style={{ marginTop: 8, lineHeight: 1.5 }}>{detail}</div>
        </section>
    );
}

// cal.com booking - the single source of truth for the sales CTA.
const BOOK_A_CALL_URL = "https://cal.com/necmttn/30min";

const Check = () => (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ flex: "none" }}>
        <path d="M3 8.5l3 3 7-8" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

/** The fake paywall: a glass card over the blurred team board. The paid pitch
 *  is "ax for teams" for engineering leadership - cost reduction (CTO/CEO) and
 *  skill/workflow adoption (EM) - gated behind a sales call. */
function TeamPaywall() {
    return (
        <div className="v-tm-paywall" role="dialog" aria-label="ax for teams">
            <div className="v-tm-paywall-card rdx-card">
                <div className="v-tm-paywall-kicker rdx-label">
                    <span className="rdx-led accent" /> ax for teams · private beta
                </div>
                <h2 className="v-tm-paywall-h">Who's shipping<br />with the&nbsp;agents</h2>
                <p className="v-tm-paywall-lede">
                    Not what AI costs &mdash; what it <i>returns</i>. Work shipped, $/task and
                    adoption per team, from real sessions.
                </p>
                <ul className="v-tm-paywall-feats">
                    <li><Check /> Output per team &mdash; share of AI work, $/task <span className="v-tm-persona">CTO · CEO</span></li>
                    <li><Check /> Adoption &mdash; the skills &amp; workflows that land <span className="v-tm-persona">EM</span></li>
                    <li><Check /> Your daemon &mdash; org rollup, nothing leaves</li>
                </ul>
                <div className="v-tm-paywall-cta">
                    <a className="v-tm-paywall-btn" href={BOOK_A_CALL_URL} target="_blank" rel="noopener noreferrer">
                        Book a 30-min walkthrough →
                    </a>
                </div>
                <div className="v-tm-paywall-foot rdx-label">live sample · your own daemon · no card</div>
            </div>
        </div>
    );
}

/**
 * Team Metrics is a fake-paywalled feature in PRODUCTION builds: the real
 * community-compare board renders blurred behind a sales CTA. Dev keeps full
 * access (so the feature is buildable); a `?unlock` query or the
 * `ax:team-unlock` localStorage flag also bypasses for demos.
 */
function isUnlocked(): boolean {
    if (import.meta.env.DEV) return true;
    if (typeof window === "undefined") return false;
    if (new URLSearchParams(window.location.search).has("unlock")) return true;
    try { return window.localStorage.getItem("ax:team-unlock") === "1"; } catch { return false; }
}
// `?paywall` forces the locked state even in dev, to preview the paywall.
function isForcedLock(): boolean {
    return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("paywall");
}
// `?demo` renders the clean, fully-visible, seeded dev-adoption board - no blur,
// no paywall, no live queries. It's the public "click around" surface linked
// from /design-partners, distinct from the locked sales teaser and the live
// (DEV/`?unlock`) board.
function isDemo(): boolean {
    return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
}

export function TeamMetricsRoute() {
    // Demo wins over everything: it's the shareable, self-contained board.
    if (isDemo()) {
        return (
            <div className="v-tm">
                <Board days={DEMO_DAYS} demo />
            </div>
        );
    }
    const locked = isForcedLock() || !isUnlocked();
    // Locked: the blurred teaser is a self-contained mock org board - no live
    // queries, so it always renders fully (daemon up or down) and never leaks
    // the operator's real numbers behind the glass.
    if (locked) {
        return (
            <div className="v-tm v-tm-locked">
                <div className="v-tm-blur" aria-hidden="true" inert>
                    <div className="v-tm"><Board days={MOCK_DAYS} teaser /></div>
                </div>
                <TeamPaywall />
            </div>
        );
    }
    return <UnlockedBoard />;
}

/** The real, unlocked feature - live local + community data. */
function UnlockedBoard() {
    const q = useQuery({ queryKey: ["wrapped"], queryFn: () => api.wrapped() });
    const data = q.data ?? null;
    // Render bare: the studio root Shell already wraps non-instrument routes in
    // the InstrumentShell rail + live/offline chrome (see Shell.tsx).
    return (
        <div className="v-tm">
            {q.isLoading && !data ? (
                <Notice title="building profile" detail="Cold graph scans can take about 20s on large local datasets." />
            ) : q.error && !data ? (
                <Notice title="team metrics failed" detail={String((q.error as Error)?.message ?? q.error)} />
            ) : data?.usage ? (
                <Board days={data.usage.days ?? []} />
            ) : (
                <Notice title="profile not ready" detail="Ingest more sessions to build the team metrics board." />
            )}
        </div>
    );
}
