/* THROWAWAY - SURFACE: Landing. The instrument-panel language applied to
   marketing, with the ax uniqueness levers: green accent, serif headline,
   glyph sigil, receipt install block. */
import { CellGrid, GlyphReel, Led, Segbar } from "./viz";
import { ACTIVITY, MODELS, litFor } from "./mock";
import { PROVIDERS } from "~/components/landing-v2/supports-strip";
import type { Theme } from "./switcher";

/** Floating harness-logo tiles framing the hero - kept from the current
 *  landing (ax's "works with 5 harnesses" signature), reusing the real SVGs. */
function HarnessField() {
    return (
        <div className="rdx-logofield" aria-hidden="true">
            {PROVIDERS.map((p) => (
                <span key={p.key} className={`rdx-htile rdx-htile--${p.key}`} title={p.name}>{p.svg}</span>
            ))}
        </div>
    );
}

export function VariantLanding({ theme }: { theme: Theme }) {
    const dim = theme === "dark" ? "#232823" : "#dad7cb";
    const lit = theme === "dark" ? "#eafff0" : "#173a22";
    return (
        <div className="v-land">
            <nav className="v-land-nav">
                <span className="logo">ax<small>agent experience</small></span>
                <span className="spacer" />
                <a>Features</a><a>Profiles</a><a>Leaders</a><a>Docs</a>
                <a className="cta">Install ax</a>
            </nav>

            <header className="v-land-hero">
                <HarnessField />
                <div>
                    <span className="v-land-kicker"><Led />local-first · 5 harnesses · open source</span>
                    <h1 className="v-land-h1">A taste &amp; telemetry graph for your <em>coding agents</em>.</h1>
                    <p className="v-land-lede">
                        ax ingests transcripts from Claude Code, Codex, Cursor, OpenCode, and Pi
                        into one graph on your machine - then shows which skills you actually use,
                        what each session cost, and where the tokens went.
                    </p>
                    <div className="v-land-install">
                        <div className="bar"><span>one command · local only</span><span>macos · linux</span></div>
                        <code><b>curl</b> -fsSL https://ax.necmttn.com/install | sh</code>
                    </div>
                    <ol className="v-land-steps">
                        <li><span className="k">01</span> install the CLI &amp; watcher</li>
                        <li><span className="k">02</span> <code>ax serve</code> ingests your transcripts</li>
                        <li><span className="k">03</span> open the dashboard - sessions, costs, skills, traced</li>
                    </ol>
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
                        <h3>Every session, traced locally</h3>
                        <p>ax reads transcripts from all five harnesses into one graph that never leaves your machine.</p>
                        <div className="viz"><CellGrid levels={ACTIVITY.slice(0, 52)} cols={26} cell={9} gap={2} /></div>
                    </article>
                    <article className="v-land-feat">
                        <span className="ic">≣</span>
                        <h3>Where the tokens go</h3>
                        <p>See cost per session and per model, and the mechanical work worth routing to something cheaper.</p>
                        <div className="viz" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                            {MODELS.slice(0, 3).map((m) => <Segbar key={m.name} total={20} on={litFor(m.share, 20)} tone={m.tone === "green" ? "green" : "pri"} />)}
                        </div>
                    </article>
                    <article className="v-land-feat">
                        <span className="ic">✦</span>
                        <h3>Your agent archetype</h3>
                        <p>A shareable profile of the skills you lean on and the streaks you keep - from real transcripts, not self-report.</p>
                        <div className="viz"><Segbar total={28} on={20} tone="accent" wave /></div>
                    </article>
                </div>
            </section>
        </div>
    );
}
