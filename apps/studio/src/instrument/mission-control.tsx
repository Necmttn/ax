/**
 * Mission Control - the instrument-panel studio home. Wires the locked design
 * system (./instrument.css + ./viz + ./logo-matrix) to the real WrappedProfile
 * from the daemon (api.wrapped()). Phase 2 of the design-system fold-in; spec:
 * docs/superpowers/specs/2026-06-15-ax-instrument-design-system.md
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { WrappedProfile, WrappedUsageDay } from "@ax/lib/shared/dashboard-types";
import { fmtCount } from "@ax/lib/shared/formatters";
import { CellGrid, GlyphReel, Led, Segbar, modelColor } from "./viz.tsx";
import "./instrument.css";

const RAIL = [
    { g: "◢", to: "/", label: "mission control", exact: true },
    { g: "≣", to: "/sessions", label: "sessions" },
    { g: "◷", to: "/workflow", label: "workflow" },
    { g: "⎈", to: "/improve", label: "improve" },
    { g: "✦", to: "/skills", label: "skills" },
    { g: "⚙", to: "/lab", label: "lab" },
] as const;
const p2 = (n: number) => String(n).padStart(2, "0");
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

// TODO(phase-2b): real model split needs a studio cost endpoint. Placeholder so
// the multi-colour data viz reads; favouriteModel anchors the top row.
const MODEL_SPLIT = [
    { name: "claude-fable-5", share: 0.4, cost: "$8.9K", tone: "green" },
    { name: "claude-opus-4-8", share: 0.3, cost: "$6.7K", tone: "blue" },
    { name: "gpt-5.5", share: 0.22, cost: "$4.9K", tone: "gold" },
    { name: "claude-opus-4-7", share: 0.064, cost: "$1.4K", tone: "violet" },
    { name: "claude-sonnet-4-6", share: 0.022, cost: "$496", tone: "rose" },
] as const;
const litFor = (share: number, total: number) => Math.max(1, Math.round(share * total));

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
                <div className="rdx-metric v-mc-bottom">{u.totalTokens == null ? "n/a" : fmtCount(u.totalTokens)}</div>
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

            <section className="rdx-card span2 v-mc-split" style={{ animationDelay: "0.36s" }}>
                <div className="v-mc-meta rdx-label"><span>model split · window</span><span>cost (est.)</span></div>
                <div className="nf-list">
                    {MODEL_SPLIT.map((m) => (
                        <div className="v-mc-split-row" key={m.name}>
                            <span style={{ color: "var(--pri)" }}><span className="nf-swatch" style={{ background: modelColor(m.tone) }} />{m.name}</span>
                            <span>{Math.round(m.share * 100)}% · {m.cost}</span>
                            <span className="segwrap"><Segbar total={24} on={litFor(m.share, 24)} color={modelColor(m.tone)} /></span>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}

export function MissionControl() {
    const q = useQuery({ queryKey: ["wrapped"], queryFn: () => api.wrapped() });
    const data = q.data ?? null;
    const ready = Boolean(data?.usage && data?.primaryArchetype);
    return (
        <div className="rdx" data-theme="dark">
            <div className="v-mc">
                <nav className="v-mc-rail">
                    <div className="logo">ax</div>
                    {RAIL.map((r) => (
                        <Link key={r.to} to={r.to} title={r.label} aria-label={r.label}
                            activeOptions={{ exact: (r as { exact?: boolean }).exact ?? false }}
                            activeProps={{ className: "on" }}>
                            {r.g}
                        </Link>
                    ))}
                </nav>
                <main className="v-mc-main">
                    {q.isLoading && !data ? <div className="rdx-label" style={{ padding: 24 }}>loading…</div> : null}
                    {ready && data ? (<><ClockHero profile={data} /><Bento profile={data} /></>) : null}
                    {data && !ready ? <div className="rdx-label" style={{ padding: 24 }}>profile not ready - ingest more sessions.</div> : null}
                </main>
            </div>
        </div>
    );
}
