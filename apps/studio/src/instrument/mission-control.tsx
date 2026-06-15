/**
 * Mission Control - the instrument-panel studio home. Wires the locked design
 * system (./instrument.css + ./viz + ./logo-matrix) to the real WrappedProfile
 * from the daemon (api.wrapped()). Phase 2 of the design-system fold-in; spec:
 * docs/superpowers/specs/2026-06-15-ax-instrument-design-system.md
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { WrappedProfile, WrappedUsageDay } from "@ax/lib/shared/dashboard-types";
import { fmtCount } from "@ax/lib/shared/formatters";
import { CellGrid, GlyphReel, Led, Segbar } from "./viz.tsx";
import { InstrumentShell } from "./shell.tsx";
import { RecapDeck } from "./deck.tsx";

const p2 = (n: number) => String(n).padStart(2, "0");
/** Compact big numbers (25.3B) - full comma form overflows the metric cards. */
const fmtBig = (n: number | null | undefined): string => {
    if (n == null) return "n/a";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return n.toLocaleString("en-US");
};
const seedFrom = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const hourLabel = (h: number | null) => (h == null ? "n/a" : `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`);

/** Daily activity → 0-4 contribution levels (rank by tokens, else sessions). */
const dayLevels = (days: ReadonlyArray<WrappedUsageDay>): number[] => {
    const val = (d: WrappedUsageDay) => (d.tokens != null && d.tokens > 0 ? d.tokens : d.sessions);
    const max = Math.max(1, ...days.map(val));
    return days.map((d) => {
        const r = val(d) / max;
        return r <= 0 ? 0 : r > 0.66 ? 4 : r > 0.4 ? 3 : r > 0.15 ? 2 : 1;
    });
};

/** Map a model name to a stable channel colour (by family). */
const toneFor = (m: string): string => {
    const s = m.toLowerCase();
    if (s.includes("fable")) return "var(--green)";
    if (s.includes("opus")) return "var(--blue)";
    if (s.includes("sonnet")) return "#e0556f";
    if (s.includes("haiku")) return "var(--violet)";
    if (s.includes("gpt") || s.includes("o3") || s.includes("o4")) return "var(--gold)";
    return "var(--accent)";
};
const fmtUsd = (n: number): string =>
    n >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : n >= 1 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
const shortModel = (m: string): string => m.replace(/-\d{6,}$/, "");

function ClockHero({ profile }: { profile: WrappedProfile }) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const iv = window.setInterval(() => { if (!document.hidden) setNow(new Date()); }, 1000);
        return () => window.clearInterval(iv);
    }, []);
    const day = now.toLocaleDateString("en-US", { weekday: "long" });
    const date = now.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
    return (
        <section className="rdx-card v-mc-clock">
            <div className="v-mc-clock-top rdx-label">
                <span>local time · <b style={{ color: "var(--pri)" }}>{profile.period.label}</b></span>
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><Led />live · {profile.usage.activeDays} active days</span>
            </div>
            <div className="v-mc-clock-time">
                <Led tone="alert" />
                <span className="rdx-doto t">{p2(now.getHours())}:{p2(now.getMinutes())}</span>
                <span className="rdx-doto s">{p2(now.getSeconds())}</span>
            </div>
            <div className="v-mc-clock-foot">
                <div>
                    <div className="day">{day}</div>
                    <div className="rdx-label">{date} · {fmtCount(profile.usage.sessions)} sessions traced</div>
                </div>
                <div className="push">
                    <div className="rdx-label">archetype · {profile.primaryArchetype.confidence}</div>
                    <div className="rdx-label" style={{ color: "var(--pri)" }}>{profile.primaryArchetype.label} <span className="sq" /></div>
                </div>
            </div>
        </section>
    );
}

function Bento({ profile: p }: { profile: WrappedProfile }) {
    const u = p.usage;
    const levels = dayLevels(u.days ?? []);
    const cols = Math.min((u.days?.length ?? 1) || 1, 26);
    const streakCap = Math.max(7, u.longestStreakDays || 7);
    return (
        <div className="v-mc-bento">
            <section className="rdx-card v-mc-hero span2 row2" style={{ animationDelay: "0s" }}>
                <div className="v-mc-meta rdx-label"><span className="nf-key">archetype · primary</span><span>{u.favoriteModel ?? ""}</span></div>
                <div className="v-mc-hero-art"><GlyphReel seed={seedFrom(p.primaryArchetype.id || p.primaryArchetype.label)} /></div>
                <div>
                    <div className="v-mc-hero-name">{p.primaryArchetype.label}</div>
                    <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--sec)", maxWidth: "46ch" }}>{p.primaryArchetype.publicLine}</p>
                </div>
            </section>

            <section className="rdx-card" style={{ animationDelay: "0.06s" }}>
                <div className="rdx-label">sessions</div>
                <div className="rdx-metric v-mc-bottom">{fmtCount(u.sessions)}</div>
                <div className="rdx-label">{fmtCount(u.messages)} messages</div>
            </section>

            <section className="rdx-card" style={{ animationDelay: "0.12s" }}>
                <div className="rdx-label">tokens</div>
                <div className="rdx-metric v-mc-bottom">{fmtBig(u.totalTokens)}</div>
                <div className="rdx-label">{u.tokenComparison ?? "all-time"}</div>
            </section>

            <section className="rdx-card span2" style={{ animationDelay: "0.18s" }}>
                <div className="v-mc-meta rdx-label"><span>activity · daily</span><span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--green)" }}><Led />live</span></div>
                <div style={{ marginTop: "auto" }}>{levels.length ? <CellGrid levels={levels} cols={cols} cell={11} /> : <span className="rdx-label">no activity yet</span>}</div>
                <div className="v-mc-meta rdx-label"><span>{fmtCount(u.activeDays)} active days</span><span>{Math.ceil((u.days?.length ?? 0) / 7)} weeks</span></div>
            </section>

            {/* the one Doto readout */}
            <section className="rdx-card" style={{ animationDelay: "0.24s" }}>
                <div className="rdx-label">streak</div>
                <div className="rdx-num v-mc-bottom">{fmtCount(u.currentStreakDays)}<small>d</small></div>
                <Segbar total={streakCap} on={Math.min(streakCap, u.currentStreakDays)} color="var(--alert)" gradient />
                <div className="rdx-label">best {fmtCount(u.longestStreakDays)} days</div>
            </section>

            <section className="rdx-card" style={{ animationDelay: "0.3s" }}>
                <div className="rdx-label">peak hour</div>
                <div className="rdx-metric v-mc-bottom">{hourLabel(u.peakHour)}</div>
                <div className="rdx-label">most active</div>
            </section>

            <ModelSplitCard />
        </div>
    );
}

function ModelSplitCard() {
    const q = useQuery({ queryKey: ["cost", "models"], queryFn: () => api.costModels() });
    const all = (q.data?.rows ?? []).filter((r) => r.cost_usd > 0);
    const total = q.data?.total_cost_usd || all.reduce((s, r) => s + r.cost_usd, 0) || 1;
    const rows = all.slice(0, 8);
    return (
        <section className="rdx-card span2 v-mc-split" style={{ animationDelay: "0.36s" }}>
            <div className="v-mc-meta rdx-label"><span>model split · 365d</span><span>~{fmtUsd(total)} total</span></div>
            <div className="nf-list">
                {rows.length === 0 ? <span className="rdx-label" style={{ marginTop: 8 }}>{q.isLoading ? "loading…" : "no cost data"}</span> : rows.map((r) => {
                    const share = r.cost_usd / total;
                    const c = toneFor(r.model);
                    return (
                        <div className="v-mc-split-row" key={r.model}>
                            <span style={{ color: "var(--pri)" }}><span className="nf-swatch" style={{ background: c }} />{shortModel(r.model)}</span>
                            <span>{Math.round(share * 100)}% · {fmtUsd(r.cost_usd)}</span>
                            <span className="segwrap"><Segbar total={24} on={Math.max(1, Math.round(share * 24))} color={c} /></span>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

export function MissionControl() {
    const q = useQuery({ queryKey: ["wrapped"], queryFn: () => api.wrapped() });
    const data = q.data ?? null;
    const ready = Boolean(data?.usage && data?.primaryArchetype);
    return (
        <InstrumentShell>
            {q.isLoading && !data ? <div className="rdx-label" style={{ padding: 24 }}>loading…</div> : null}
            {ready && data ? (<><ClockHero profile={data} /><Bento profile={data} /><RecapDeck cards={data.cards ?? []} /></>) : null}
            {data && !ready ? <div className="rdx-label" style={{ padding: 24 }}>profile not ready - ingest more sessions.</div> : null}
        </InstrumentShell>
    );
}
