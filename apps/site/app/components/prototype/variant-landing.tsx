/* THROWAWAY - SURFACE: Landing. Instrument language + ax uniqueness levers.
   - Primary get-started is a COPY-SETUP-PROMPT pill: paste into your agent and
     it installs + ingests + analyzes + briefs you (from the current landing).
   - Hero card cycles the real harness logos ("ingesting…") instead of the
     random-morphing dot glyph. */
import { useState, type CSSProperties } from "react";
import { CellGrid, Led, Segbar } from "./viz";
import { LogoMatrix } from "./logo-matrix";
import { ACTIVITY, MODELS, litFor } from "./mock";
import { PROVIDERS } from "~/components/landing-v2/supports-strip";
import type { Theme } from "./switcher";

/** Floating harness-logo tiles with a gentle staggered drift - the fancy
 *  animated logo field kept from the current landing. */
function HarnessField() {
    return (
        <div className="rdx-logofield" aria-hidden="true">
            {PROVIDERS.map((p, i) => (
                <span key={p.key} className={`rdx-htile rdx-htile--${p.key}`} style={{ "--i": i } as CSSProperties} title={p.name}>{p.svg}</span>
            ))}
        </div>
    );
}

const AGENT_PROMPT = `Set up ax for me, end to end. ax is a local agent-experience graph over my coding-agent history (Claude Code, Codex, Cursor, OpenCode, Pi) - it runs locally and I review every change.

1. INSTALL - run \`curl -fsSL https://ax.necmttn.com/install | sh\` to install the ax CLI.
2. INGEST - run \`ax ingest --dry-run\` and tell me how long a full backfill takes, then run \`ax ingest\` in the BACKGROUND (AX_PROGRESS=plain). Tell me I can watch it live: \`ax serve\` → http://127.0.0.1:1738. When it finishes, summarize total sessions, turns, and the skills/tools I actually use.
3. VERIFY - run \`ax doctor\` and fix anything that isn't ok.
4. ANALYZE - run \`ax skills weighted\`, \`ax cost models\`, and \`ax dispatches --candidates\`.
5. BRIEF ME - in plain words: my agent archetype, where my tokens go, 1–2 under-used skills worth adopting, and the single highest-value change to make next - with the exact command to run.`;

/** Hero card content: the 5 harness logos, cycling an "ingesting…" highlight -
 *  meaningful + branded, vs. the old random dot patterns. */
function CopySetupPrompt() {
    const [copied, setCopied] = useState(false);
    const onCopy = () => {
        if (typeof navigator === "undefined" || !navigator.clipboard) return;
        navigator.clipboard.writeText(AGENT_PROMPT).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2200);
        });
    };
    return (
        <div className="v-land-getstarted">
            <span className="rdx-stamp">get started · paste into your agent</span>
            <button type="button" className={`v-land-promptpill${copied ? " copied" : ""}`} onClick={onCopy}>
                <span className="icons" aria-hidden="true">{PROVIDERS.map((p) => <span key={p.key} className="i">{p.svg}</span>)}</span>
                <span className="label">{copied ? "✓ Copied - paste into your coding agent" : "Copy setup prompt"}</span>
            </button>
            <p className="v-land-getstarted-foot">
                Your agent installs ax, ingests your history, analyzes it, and briefs you -
                archetype, token spend, and the next change worth making.
            </p>
            <code className="v-land-altinstall">or, by hand: <b>curl</b> -fsSL https://ax.necmttn.com/install | sh</code>
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
                    <CopySetupPrompt />
                </div>
                <div className="v-land-herocard">
                    <div className="top"><span className="rdx-label" style={{ display: "inline-flex", gap: 7, alignItems: "center" }}><Led />live · @necmttn</span><span className="rdx-stamp">sys.v0.29</span></div>
                    <LogoMatrix dim={dim} lit={lit} />
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
