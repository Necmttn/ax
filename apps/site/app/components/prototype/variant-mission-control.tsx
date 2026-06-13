/* THROWAWAY - Variant A: Mission Control. Dark-first desktop HUD, dense bento. */
import { CellGrid, Doto, GlyphReel, Led, Segbar } from "./viz";
import { ACTIVITY, FEED, MODELS, PROFILE, litFor } from "./mock";
import type { Theme } from "./switcher";

const seedFrom = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

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
                <div className="v-mc-top">
                    <span className="v-mc-crumb">mission control · <b>@{PROFILE.handle}</b></span>
                    <span className="rdx-label" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        <Led /> live · {PROFILE.window.days}-day window
                    </span>
                </div>
                <div className="v-mc-bento">
                    {/* hero: archetype + glyph reel */}
                    <section className="rdx-card v-mc-hero span2 row2" style={{ animationDelay: "0s" }}>
                        <div className="v-mc-meta rdx-label"><span>archetype · primary</span><span>{PROFILE.archetype.confidence} confidence</span></div>
                        <div className="v-mc-hero-art"><GlyphReel seed={seedFrom(PROFILE.archetype.id)} dim={dim} lit={lit} /></div>
                        <div>
                            <div className="v-mc-hero-name">{PROFILE.archetype.label}</div>
                            <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--sec)", maxWidth: "46ch" }}>{PROFILE.archetype.line}</p>
                        </div>
                    </section>

                    <section className="rdx-card" style={{ animationDelay: "0.06s" }}>
                        <div className="rdx-label">sessions</div>
                        <div className="rdx-num v-mc-bottom">{PROFILE.sessions}</div>
                        <div className="rdx-label">{PROFILE.messages.toLocaleString()} messages</div>
                    </section>

                    <section className="rdx-card" style={{ animationDelay: "0.12s" }}>
                        <div className="rdx-label">tokens</div>
                        <div className="rdx-metric v-mc-bottom">{PROFILE.tokens}</div>
                        <div className="rdx-label">≈ 418 novels · {PROFILE.cost}</div>
                    </section>

                    {/* activity heatmap */}
                    <section className="rdx-card span2" style={{ animationDelay: "0.18s" }}>
                        <div className="v-mc-meta rdx-label"><span>activity · daily</span><span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--green)" }}><Led />live</span></div>
                        <div style={{ marginTop: "auto" }}><CellGrid levels={ACTIVITY} cols={26} cell={11} /></div>
                        <div className="v-mc-meta rdx-label"><span>{PROFILE.activeDays} active days</span><span>14 weeks</span></div>
                    </section>

                    <section className="rdx-card" style={{ animationDelay: "0.24s" }}>
                        <div className="rdx-label">streak</div>
                        <div className="rdx-num v-mc-bottom">{PROFILE.streak}<small>d</small></div>
                        <Segbar total={Math.max(7, PROFILE.longest)} on={PROFILE.streak} tone="accent" wave />
                        <div className="rdx-label">best {PROFILE.longest} days</div>
                    </section>

                    <section className="rdx-card" style={{ animationDelay: "0.3s" }}>
                        <div className="rdx-label">peak hour</div>
                        <div className="rdx-metric v-mc-bottom">{PROFILE.peakHour}</div>
                        <div className="rdx-label">most active</div>
                    </section>

                    {/* model split */}
                    <section className="rdx-card span2 v-mc-split" style={{ animationDelay: "0.36s" }}>
                        <div className="v-mc-meta rdx-label"><span>model split · window</span><span>{PROFILE.cost} total</span></div>
                        {MODELS.slice(0, 3).map((m) => (
                            <div className="v-mc-split-row" key={m.name}>
                                <span style={{ color: "var(--pri)" }}>{m.name}</span>
                                <span>{Math.round(m.share * 100)}% · {m.cost}</span>
                                <span className="segwrap"><Segbar total={24} on={litFor(m.share, 24)} tone={m.tone === "green" ? "green" : "pri"} /></span>
                            </div>
                        ))}
                    </section>

                    {/* feed */}
                    <section className="rdx-card span2 v-mc-feed" style={{ animationDelay: "0.42s" }}>
                        <div className="v-mc-meta rdx-label"><span>activity · push · main</span><span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--accent)" }}><Led tone="accent" />rec</span></div>
                        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
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
