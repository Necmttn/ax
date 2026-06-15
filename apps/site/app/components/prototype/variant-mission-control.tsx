/* THROWAWAY - Variant A: Mission Control. Dark-first desktop HUD, dense bento. */
import { useEffect, useState } from "react";
import { CellGrid, Doto, GlyphReel, Led, Segbar, modelColor } from "./viz";
import { ACTIVITY, FEED, MODELS, PROFILE, litFor } from "./mock";
import type { Theme } from "./switcher";

const seedFrom = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const p2 = (n: number) => String(n).padStart(2, "0");

/** Live clock hero (nullframe-style): big Doto time + seconds + pulsing dot on
 *  a dot-grid, with a serif day / mono date + last-push footer. */
function ClockHero() {
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
                <span>local time · <b style={{ color: "var(--pri)" }}>@{PROFILE.handle}</b></span>
                <span>sys.v0.29 · live · {PROFILE.window.days}d window</span>
            </div>
            <div className="v-mc-clock-time">
                <Led tone="alert" />
                <span className="rdx-doto t">{p2(now.getHours())}:{p2(now.getMinutes())}</span>
                <span className="rdx-doto s">{p2(now.getSeconds())}</span>
            </div>
            <div className="v-mc-clock-foot">
                <div>
                    <div className="day">{day}</div>
                    <div className="rdx-label">{date} · {PROFILE.sessions} sessions traced</div>
                </div>
                <div className="push">
                    <div className="rdx-label">last push · main</div>
                    <div className="rdx-label" style={{ color: "var(--pri)" }}>feat/redesign-prototype <span className="sq" /></div>
                </div>
            </div>
        </section>
    );
}

export function VariantMissionControl({ theme }: { theme: Theme }) {
    const dim = theme === "dark" ? "#222222" : "#dad7cb";
    const lit = theme === "dark" ? "#ffffff" : "#1a1a1a";
    const RAIL = ["◢", "≣", "◷", "⎈", "✦", "⚙"];
    return (
        <div className="v-mc">
            <nav className="v-mc-rail">
                <div className="logo">ax</div>
                {RAIL.map((g, i) => <button key={i} className={i === 0 ? "on" : ""} type="button">{g}</button>)}
            </nav>
            <main className="v-mc-main">
                <ClockHero />
                <div className="v-mc-bento">
                    {/* hero: archetype + glyph reel */}
                    <section className="rdx-card v-mc-hero span2 row2 acc-violet" style={{ animationDelay: "0s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">archetype · primary</span><span>{PROFILE.archetype.confidence} confidence</span></div>
                        <div className="v-mc-hero-art"><GlyphReel seed={seedFrom(PROFILE.archetype.id)} dim={dim} lit={lit} /></div>
                        <div>
                            <div className="v-mc-hero-name">{PROFILE.archetype.label}</div>
                            <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--sec)", maxWidth: "46ch" }}>{PROFILE.archetype.line}</p>
                        </div>
                    </section>

                    <section className="rdx-card acc-blue" style={{ animationDelay: "0.06s" }}>
                        <div className="rdx-label nf-key">sessions</div>
                        <div className="rdx-metric v-mc-bottom">{PROFILE.sessions}</div>
                        <div className="rdx-label">{PROFILE.messages.toLocaleString()} messages</div>
                    </section>

                    <section className="rdx-card acc-gold" style={{ animationDelay: "0.12s" }}>
                        <div className="rdx-label nf-key">tokens</div>
                        <div className="rdx-metric v-mc-bottom">{PROFILE.tokens}</div>
                        <div className="rdx-label">≈ 418 novels · {PROFILE.cost}</div>
                    </section>

                    {/* activity heatmap */}
                    <section className="rdx-card span2 acc-green" style={{ animationDelay: "0.18s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">activity · daily</span><span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--green)" }}><Led />live</span></div>
                        <div style={{ marginTop: "auto" }}><CellGrid levels={ACTIVITY} cols={26} cell={11} /></div>
                        <div className="v-mc-meta rdx-label"><span>{PROFILE.activeDays} active days</span><span>14 weeks</span></div>
                    </section>

                    {/* streak - the one Doto (dot-matrix) readout in this view */}
                    <section className="rdx-card acc-alert" style={{ animationDelay: "0.24s" }}>
                        <div className="rdx-label nf-key">streak</div>
                        <div className="rdx-num v-mc-bottom">{PROFILE.streak}<small>d</small></div>
                        <Segbar total={Math.max(7, PROFILE.longest)} on={PROFILE.streak} color="var(--alert)" gradient />
                        <div className="rdx-label">best {PROFILE.longest} days</div>
                    </section>

                    <section className="rdx-card acc-rose" style={{ animationDelay: "0.3s" }}>
                        <div className="rdx-label nf-key">peak hour</div>
                        <div className="rdx-metric v-mc-bottom">{PROFILE.peakHour}</div>
                        <div className="rdx-label">most active</div>
                    </section>

                    {/* model split */}
                    <section className="rdx-card span2 v-mc-split acc-blue" style={{ animationDelay: "0.36s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">model split · window</span><span>{PROFILE.cost} total</span></div>
                        <div className="nf-list">
                            {MODELS.map((m) => (
                                <div className="v-mc-split-row" key={m.name}>
                                    <span style={{ color: "var(--pri)" }}><span className="nf-swatch" style={{ background: modelColor(m.tone) }} />{m.name}</span>
                                    <span>{Math.round(m.share * 100)}% · {m.cost}</span>
                                    <span className="segwrap"><Segbar total={24} on={litFor(m.share, 24)} color={modelColor(m.tone)} /></span>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* feed */}
                    <section className="rdx-card span2 v-mc-feed acc-green" style={{ animationDelay: "0.42s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">activity · push · main</span><span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--alert)" }}><Led tone="alert" />rec</span></div>
                        <div className="nf-list" style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
                            {FEED.map((f) => (
                                <div className="v-mc-feed-row" key={f.t}>
                                    <span className={f.kind === "feat" ? "feat" : f.kind === "fix" ? "fix" : ""}>{f.msg}</span>
                                    <span className="k">{f.t}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            </main>
        </div>
    );
}
