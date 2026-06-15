/* THROWAWAY - SURFACE: Teams ("ring"). The org-level instrument board: team
   KPIs + a member roster, in the Mission Control language. This is the
   "protocol/ring for companies & teams" view. */
import { CellGrid, GlyphReel, Led, Segbar, modelColor } from "./viz";
import { TEAM, TEAM_ACTIVITY, litFor } from "./mock";
import type { Theme } from "./switcher";

const RAIL = ["◢", "≣", "◷", "⎈", "✦", "⚙"];

export function VariantTeams({ theme }: { theme: Theme }) {
    const dim = theme === "dark" ? "#232823" : "#dad7cb";
    const lit = theme === "dark" ? "#eafff0" : "#173a22";
    const t = TEAM;
    return (
        <div className="v-mc">
            <nav className="v-mc-rail">
                <div className="logo">ax</div>
                {RAIL.map((g, i) => <button key={i} className={i === 3 ? "on" : ""} type="button">{g}</button>)}
            </nav>
            <main className="v-mc-main">
                <div className="v-mc-top">
                    <div className="v-team-org">
                        <span className="crest"><GlyphReel seed={11} dim={dim} lit={lit} /></span>
                        <span className="name">@<b>{t.org}</b></span>
                        <span className="ring">ring · {t.ring}</span>
                    </div>
                    <span className="rdx-label" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        <Led />{t.onlineNow}/{t.members} online · {t.windowDays}d
                    </span>
                </div>

                <div className="v-mc-bento">
                    <section className="rdx-card acc-blue" style={{ animationDelay: "0s" }}>
                        <div className="rdx-label nf-key">members</div>
                        <div className="rdx-metric v-mc-bottom">{t.members}</div>
                        <div className="rdx-label" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Led />{t.onlineNow} active now</div>
                    </section>
                    {/* sessions - the one Doto readout in this view */}
                    <section className="rdx-card acc-green" style={{ animationDelay: "0.06s" }}>
                        <div className="rdx-label nf-key">sessions</div>
                        <div className="rdx-num v-mc-bottom" style={{ fontSize: 40 }}>{t.sessions.toLocaleString()}</div>
                        <div className="rdx-label">this window</div>
                    </section>
                    <section className="rdx-card acc-gold" style={{ animationDelay: "0.12s" }}>
                        <div className="rdx-label nf-key">team spend</div>
                        <div className="rdx-metric v-mc-bottom">{t.spend}</div>
                        <div className="rdx-label" style={{ color: "var(--accent)" }}>{t.saved} saved by routing</div>
                    </section>
                    <section className="rdx-card acc-violet" style={{ animationDelay: "0.18s" }}>
                        <div className="rdx-label nf-key">tokens</div>
                        <div className="rdx-metric v-mc-bottom">{t.tokens}</div>
                        <div className="rdx-label">across the ring</div>
                    </section>

                    {/* team activity */}
                    <section className="rdx-card span2 acc-green" style={{ animationDelay: "0.24s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">team activity · daily</span><span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--green)" }}><Led />live</span></div>
                        <div style={{ marginTop: "auto" }}><CellGrid levels={TEAM_ACTIVITY} cols={26} cell={11} /></div>
                        <div className="v-mc-meta rdx-label"><span>aggregate across {t.members} members</span><span>14 weeks</span></div>
                    </section>

                    {/* model split */}
                    <section className="rdx-card span2 v-mc-split acc-blue" style={{ animationDelay: "0.3s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">model split · ring</span><span>{t.spend} total</span></div>
                        <div className="nf-list">
                            {t.models.map((m) => (
                                <div className="v-mc-split-row" key={m.name}>
                                    <span style={{ color: "var(--pri)" }}><span className="nf-swatch" style={{ background: modelColor(m.tone) }} />{m.name}</span>
                                    <span>{Math.round(m.share * 100)}% · {m.cost}</span>
                                    <span className="segwrap"><Segbar total={26} on={litFor(m.share, 26)} color={modelColor(m.tone)} /></span>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* roster - the heart of the teams view */}
                    <section className="rdx-card v-team-roster" style={{ gridColumn: "1 / -1", gridRow: "span 2", animationDelay: "0.36s" }}>
                        <div className="v-mc-meta rdx-label" style={{ padding: "16px 18px 12px" }}><span>roster · {t.members}</span><span>by sessions</span></div>
                        <div className="nf-list">
                        <table className="v-team-rt">
                            <thead>
                                <tr><th>member</th><th className="r">sessions</th><th className="r">streak</th><th className="r">spend</th><th>14d</th></tr>
                            </thead>
                            <tbody>
                                {[...t.roster].sort((a, b) => b.sessions - a.sessions).map((m) => (
                                    <tr key={m.handle}>
                                        <td>
                                            <span className="v-team-who">
                                                <span className={`dot ${m.online ? "on" : ""}`} />
                                                <span className="h">@{m.handle}<small>{m.archetype}</small></span>
                                            </span>
                                        </td>
                                        <td className="r"><span className="v-team-num">{m.sessions}</span></td>
                                        <td className="r"><span className="v-team-num">{m.streak}d</span></td>
                                        <td className="r"><span className="v-team-num">{m.cost}</span></td>
                                        <td>
                                            <span className="v-team-spark">
                                                {m.spark.map((lvl, i) => <i key={i} className={lvl ? `lvl-${lvl}` : ""} />)}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        </div>
                    </section>

                    {/* shared rig adoption */}
                    <section className="rdx-card span2 acc-violet" style={{ animationDelay: "0.42s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">shared rig · adoption</span><span>% of ring</span></div>
                        <div className="nf-list" style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 11 }}>
                            {t.rig.map((s) => (
                                <div className="v-team-rig-row" key={s.name}>
                                    <span className="segwrap"><Segbar total={30} on={Math.round(s.pct * 30)} tone="card" /></span>
                                    <span style={{ color: "var(--pri)" }}>{s.name}</span>
                                    <span className="pct">{Math.round(s.pct * 100)}%</span>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* ring pulse - highlights */}
                    <section className="rdx-card span2 acc-rose" style={{ animationDelay: "0.48s" }}>
                        <div className="v-mc-meta rdx-label"><span className="nf-key">ring pulse · this week</span><span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--alert)" }}><Led tone="alert" />rec</span></div>
                        <div className="v-mc-feed nf-list" style={{ marginTop: 8 }}>
                            <div className="v-mc-feed-row"><span><span style={{ color: "var(--accent)" }}>@dax</span> hit a 31-day streak - longest in the ring</span><span className="k">+2d</span></div>
                            <div className="v-mc-feed-row"><span><span className="feat">routing</span> saved the team $640 vs all-fable</span><span className="k">30d</span></div>
                            <div className="v-mc-feed-row"><span><span style={{ color: "var(--accent)" }}>@kano</span> ran 3 parallel agents on one session</span><span className="k">peak</span></div>
                            <div className="v-mc-feed-row"><span><span className="feat">tdd</span> adoption up to 66% of the ring</span><span className="k">+1</span></div>
                        </div>
                    </section>
                </div>
            </main>
        </div>
    );
}
