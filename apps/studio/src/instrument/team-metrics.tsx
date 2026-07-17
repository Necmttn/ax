/**
 * Team Boards - the studio /team page, backed by the daemon's team rollup.
 *
 * The real path fetches `GET /api/team` (aggregate of `ax team push` snapshots
 * compiled by @ax/community-compile `compileTeam`) and renders adoption /
 * skill-matrix / spend panels. `?demo` keeps the seeded, self-contained
 * dev-adoption board - the public "click around" surface iframed by the
 * marketing site (/design-partners) - which never touches live queries.
 * Design system: ./instrument.css (.v-tm-*, .v-team-*) + ./viz BarChart.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { WrappedUsageDay } from "@ax/lib/shared/dashboard-types";
import { fmtCount } from "@ax/lib/shared/formatters";
import { BarChart } from "./viz.tsx";
import { buildTeamView, fmtBig, fmtUsd } from "./team-boards-model.ts";

// ---- range model ----------------------------------------------------------
type DailyRange = 7 | 30 | 90;
type WeeklyRange = 4 | 8 | 12;
const DAILY: ReadonlyArray<DailyRange> = [7, 30, 90];
const WEEKLY: ReadonlyArray<WeeklyRange> = [4, 8, 12];

// ---- formatting -----------------------------------------------------------
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

// ---- unified roster + compare model (demo board) ---------------------------
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
    tokens: number;
    cost: number;
    metrics: CompareMetric[]; // compare-panel rows (consistent within a tab)
}

const levelize = (spark: number[]): number[] => {
    const peak = Math.max(1, ...spark);
    return spark.map((c) => (c <= 0 ? 0 : c / peak > 0.66 ? 4 : c / peak > 0.4 ? 3 : c / peak > 0.15 ? 2 : 1));
};

// ===========================================================================
// DEMO org dataset - the clean, fully-visible `?demo` board. Tells the
// DEV-ADOPTION story from the /design-partners pitch: a git-native team
// rollup for AI coding agents. Framing is adoption + routable spend + skill
// diffusion. All numbers echo the pitch's RollupMock so the two never
// contradict. Fabricated + deterministic; no live queries, renders daemon-up
// or down - the marketing site iframes this route.
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

// ---- demo hero (dev-adoption tiles) ---------------------------------------
/** Four adoption tiles for the `?demo` board - active seats, active-days,
 *  routable spend, workflows ready to spread. */
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

// ---- tabbed, selectable roster (demo board) --------------------------------
function RosterCard({
    tab, onTab, entities, selected, onToggle, midHead,
}: {
    tab: RosterTab; onTab: (t: RosterTab) => void;
    entities: RosterEntity[];
    selected: ReadonlySet<string>; onToggle: (id: string) => void;
    midHead: string;
}) {
    const noun = tab === "members" ? "seat" : tab === "projects" ? "project" : "harness";
    // Demo seats are anonymized + unranked - say so where a leaderboard is implied.
    const headNote = tab === "members"
        ? "aggregate view · no per-person ranking"
        : selected.size >= 1 ? `${selected.size} selected` : "click rows · compare 2+";
    return (
        <section className="rdx-card v-team-roster">
            <div className="v-tm-roster-head">
                <div className="v-tm-tabs">
                    {TABS.map((t) => (
                        <button key={t.id} type="button" className={t.id === tab ? "on" : ""} onClick={() => onTab(t.id)}>
                            {t.label}
                        </button>
                    ))}
                </div>
                <span className="rdx-label">{headNote}</span>
            </div>
            <div className="nf-list">
                <table className="v-team-rt">
                    <thead>
                        <tr>
                            <th>{noun}</th>
                            <th>{midHead}</th>
                            <th className="r">model</th>
                            <th className="r">sessions</th>
                            <th className="r">cost</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entities.length === 0 ? (
                            <tr><td colSpan={5} className="rdx-label">{`no ${noun}s yet`}</td></tr>
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
                                <td className="r v-team-num">{fmtCount(e.sessions)}</td>
                                <td className="r v-team-num">{e.cost > 0 ? fmtUsd(e.cost) : "-"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
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

/** The seeded `?demo` board - fabricated data only, no live queries. */
function DemoBoard() {
    const [daily, setDaily] = useState<DailyRange>(30);
    const [weeks, setWeeks] = useState<WeeklyRange>(8);

    const days = DEMO_DAYS;
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

    const channels = DEMO_CHANNELS;
    const costTotal = DEMO_ORG.spendUsd;

    // tabbed roster (projects | members | harnesses) + side-by-side compare.
    const [tab, setTab] = useState<RosterTab>("projects");
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const switchTab = (t: RosterTab) => { setTab(t); setSelected(new Set()); };
    const toggleSel = (id: string) => setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });
    const entities = tab === "projects" ? DEMO_PROJECTS : tab === "members" ? DEMO_MEMBERS : DEMO_HARNESSES;
    const midHead = tab === "members" ? "harnesses" : "last 7d";
    const selectedEntities = entities.filter((e) => selected.has(e.id));

    return (
        <>
            <header className="v-tm-mast">
                <div className="v-team-org">
                    <span className="name"><b>{DEMO_ORG.label}</b> team adoption</span>
                    <span className="ring">team rollup</span>
                    <span className="v-tm-demo-badge">demo · sample data</span>
                </div>
                <div className="v-tm-ranges">
                    <Toggle label="daily" values={DAILY} value={daily} onChange={(v) => setDaily(v)} suffix="d" />
                    <Toggle label="weekly" values={WEEKLY} value={weeks} onChange={(v) => setWeeks(v)} suffix="w" />
                </div>
            </header>
            <p className="rdx-label v-tm-sub">
                How AI adoption is spreading across the team - active seats, routable spend, and the skills & workflows that land. Every number is a team-level aggregate; no per-person ranking.
            </p>

            <DemoHero />

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
                <RosterCard tab={tab} onTab={switchTab} entities={entities}
                    selected={selected} onToggle={toggleSel} midHead={midHead} />

                <section className="rdx-card v-mc-split">
                    <div className="v-mc-meta rdx-label">
                        <span style={{ color: "var(--pri)" }}>MODEL SPEND · this month</span>
                        <span>{fmtUsd(costTotal)}/mo · {fmtUsd(DEMO_ORG.routableUsd)} routable</span>
                    </div>
                    <div className="nf-list">
                        {channels.map((r) => {
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

            <DemoAdoptionRow />

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

// ---- the real team boards (GET /api/team) ----------------------------------

/** Renders the daemon's TeamBoards rollup: adoption hero tiles, the skill
 *  matrix, and spend/model-mix - or clean loading / empty / error states. */
function TeamBoardsPanel() {
    const q = useQuery({ queryKey: ["team", "boards"], queryFn: () => api.team() });

    if (q.isLoading && !q.data) {
        return <Notice title="loading team boards" detail="Fetching the org rollup from your local daemon." />;
    }
    if (q.error && !q.data) {
        const msg = String((q.error as Error)?.message ?? q.error);
        return (
            <Notice title="team boards unavailable"
                detail={`${msg} - the /api/team endpoint needs a current ax daemon. Start it with \`ax serve\`, and push snapshots with \`ax team push\`.`} />
        );
    }
    if (!q.data) {
        return <Notice title="no team data yet" detail="No snapshots pushed. Run `ax team push` from a repo bound to your team." />;
    }

    const boards = q.data;
    const view = buildTeamView(boards);
    if (view.empty) {
        return (
            <Notice title="no team data yet"
                detail="No dev snapshots in the rollup. Each teammate runs `ax team push` from a bound repo; the boards fill in as snapshots land." />
        );
    }

    const maxSkillDevs = Math.max(...view.skills.map((s) => s.devs), 1);
    return (
        <>
            <header className="v-tm-mast">
                <div className="v-team-org">
                    <span className="name"><b>ax</b> team boards</span>
                    <span className="ring">org rollup</span>
                </div>
            </header>
            <p className="rdx-label v-tm-sub">
                {view.activation} - aggregated from pushed snapshots. Anonymous pushes count toward every board; cost only where a dev shares it.
            </p>

            <div className="v-tm-hero v-tm-hero--demo">
                {view.hero.map((t) => (
                    <section className="rdx-card v-tm-herotile" key={t.label}>
                        <div className="rdx-label">{t.label}</div>
                        <div className="rdx-num v-tm-herostat">{t.value}{t.small ? <small> {t.small}</small> : null}</div>
                        <div className="v-tm-trend"><span className="rdx-led accent" /> {t.sub}</div>
                    </section>
                ))}
            </div>

            <div className="v-tm-grid">
                <section className="rdx-card v-team-roster">
                    <div className="v-tm-roster-head">
                        <div className="rdx-label" style={{ color: "var(--pri)" }}>SKILL MATRIX · devs using</div>
                        <span className="rdx-label">{view.skills.length} skills</span>
                    </div>
                    <div className="nf-list">
                        <table className="v-team-rt">
                            <thead>
                                <tr>
                                    <th>skill</th>
                                    <th>devs</th>
                                    <th className="r">runs</th>
                                    <th className="r">sessions</th>
                                    <th className="r">median runs</th>
                                </tr>
                            </thead>
                            <tbody>
                                {view.skills.length === 0 ? (
                                    <tr><td colSpan={5} className="rdx-label">no skill invocations pushed yet</td></tr>
                                ) : view.skills.map((s) => (
                                    <tr key={s.skill}>
                                        <td><span className="v-team-who"><span className="h">{s.skill}</span></span></td>
                                        <td>
                                            <span className="v-tm-share">
                                                <span className="v-tm-bar"><span style={{ width: `${Math.max(6, (s.devs / maxSkillDevs) * 100)}%`, background: "var(--accent)" }} /></span>
                                                <b>{s.devs}</b>
                                            </span>
                                        </td>
                                        <td className="r v-team-num">{fmtCount(s.runs)}</td>
                                        <td className="r v-team-num">{fmtCount(s.sessions)}</td>
                                        <td className="r v-team-num">{fmtBig(s.medianRuns)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="rdx-card v-mc-split">
                    <div className="v-mc-meta rdx-label">
                        <span style={{ color: "var(--pri)" }}>MODEL MIX · by tokens</span>
                        <span>{boards.spend.costContributors > 0 ? `${fmtUsd(boards.spend.costUsd)} total` : "no cost data"}</span>
                    </div>
                    <div className="nf-list">
                        {view.models.length === 0 ? (
                            <span className="rdx-label" style={{ marginTop: 8 }}>no model usage pushed yet</span>
                        ) : view.models.map((r) => {
                            const c = toneFor(r.model);
                            return (
                                <div className="v-mc-split-row" key={r.model}>
                                    <span style={{ color: "var(--pri)" }}>
                                        <span className="nf-swatch" style={{ background: c }} />{shortModel(r.model)}
                                    </span>
                                    <span>{Math.round(r.share * 100)}% · {r.tokens} tok{r.cost !== "-" ? ` · ${r.cost}` : ""}</span>
                                    <span className="segwrap">
                                        <span className="v-tm-bar"><span style={{ width: `${Math.max(2, r.share * 100)}%`, background: c }} /></span>
                                    </span>
                                </div>
                            );
                        })}
                        <p className="rdx-label" style={{ margin: "10px 2px 2px", lineHeight: 1.5, textTransform: "none", letterSpacing: 0 }}>
                            tokens · {view.tokens.prompt} prompt · {view.tokens.completion} completion · {view.tokens.total} total
                            <br />
                            tools · {view.efficiency.toolCalls} calls · {view.efficiency.failureRate} fail · {view.efficiency.verificationShare} verification
                            {view.costNote ? <><br />cost · {view.costNote}</> : null}
                        </p>
                    </div>
                </section>
            </div>
        </>
    );
}

// `?demo` renders the clean, fully-visible, seeded dev-adoption board - no
// live queries. It's the public "click around" surface linked (and iframed)
// from /design-partners, distinct from the live daemon-backed board.
function isDemo(): boolean {
    return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
}

export function TeamMetricsRoute() {
    // Demo wins: it's the shareable, self-contained board.
    if (isDemo()) {
        return (
            <div className="v-tm">
                <DemoBoard />
            </div>
        );
    }
    return (
        <div className="v-tm">
            <TeamBoardsPanel />
        </div>
    );
}
