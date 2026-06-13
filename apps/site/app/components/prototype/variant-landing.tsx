/* THROWAWAY - SURFACE: Landing. The instrument-panel language applied to
   marketing, with the ax uniqueness levers: green accent, serif headline,
   glyph sigil, receipt install block. */
import { CellGrid, GlyphReel, Led, Segbar } from "./viz";
import { ACTIVITY, MODELS, litFor } from "./mock";
import type { Theme } from "./switcher";

export function VariantLanding({ theme }: { theme: Theme }) {
    const dim = theme === "dark" ? "#232823" : "#dad7cb";
    const lit = theme === "dark" ? "#eafff0" : "#173a22";
    return (
        <div className="v-land">
            <nav className="v-land-nav">
                <span className="logo">ax<small>agent experience</small></span>
                <span className="spacer" />
                <a>Features</a><a>Profiles</a><a>Leaders</a><a>Docs</a>
                <a className="cta">Install →</a>
            </nav>

            <header className="v-land-hero">
                <div>
                    <span className="v-land-kicker"><Led />local-first · 5 harnesses · open source</span>
                    <h1 className="v-land-h1">A taste &amp; telemetry graph for your <em>coding agents</em>.</h1>
                    <p className="v-land-lede">
                        ax ingests every Claude Code, Codex, and Cursor session into a local
                        graph - then shows you what your agents actually do, what it costs,
                        and how to make them better.
                    </p>
                    <div className="v-land-install">
                        <div className="bar"><span>install</span><span>macos · linux</span></div>
                        <code><b>curl</b> -fsSL https://ax.necmttn.com/install | sh</code>
                    </div>
                </div>
                <div className="v-land-herocard">
                    <div className="top"><span className="rdx-label">live · @necmttn</span><span className="rdx-stamp">sys.v0.29</span></div>
                    <div className="v-land-sigilwrap"><GlyphReel seed={7} dim={dim} lit={lit} /></div>
                    <hr className="rdx-tear" />
                    <div className="v-land-herostat">
                        <div><div className="n rdx-doto">412</div><div className="l">sessions</div></div>
                        <div><div className="n rdx-doto">41.8M</div><div className="l">tokens</div></div>
                        <div><div className="n rdx-doto">14<small>d</small></div><div className="l">streak</div></div>
                    </div>
                </div>
            </header>

            <div className="v-land-strip">
                <div className="v-land-stat"><span className="n rdx-doto">5</span><span className="l">harnesses ingested</span></div>
                <div className="v-land-stat"><span className="n rdx-doto">100%</span><span className="l">on your machine</span></div>
                <div className="v-land-stat"><span className="n rdx-doto">$571</span><span className="l">spend, traced</span></div>
                <div className="v-land-stat"><span className="n rdx-doto">38</span><span className="l">skills, weighted</span></div>
            </div>

            <section>
                <div className="v-land-sech"><span className="n">01</span><h2>What you get</h2><span className="rule" /></div>
                <div className="v-land-feats">
                    <article className="v-land-feat">
                        <span className="ic">◷</span>
                        <h3>Every session, traced</h3>
                        <p>Turns, tool calls, and dollars - reconstructed from local transcripts, no cloud.</p>
                        <div className="viz"><CellGrid levels={ACTIVITY.slice(0, 52)} cols={26} cell={9} gap={2} /></div>
                    </article>
                    <article className="v-land-feat">
                        <span className="ic">≣</span>
                        <h3>Spend, by model</h3>
                        <p>See where the tokens go - and route the mechanical work to cheaper models.</p>
                        <div className="viz" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                            {MODELS.slice(0, 3).map((m) => <Segbar key={m.name} total={20} on={litFor(m.share, 20)} tone={m.tone === "green" ? "green" : "pri"} />)}
                        </div>
                    </article>
                    <article className="v-land-feat">
                        <span className="ic">✦</span>
                        <h3>A profile worth sharing</h3>
                        <p>Your agent archetype, streak, and rig - published to a gist, ranked on the leaderboard.</p>
                        <div className="viz"><Segbar total={28} on={20} tone="accent" wave /></div>
                    </article>
                </div>
            </section>
        </div>
    );
}
