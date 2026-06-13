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

// Verbatim from the current landing (apps/site/.../dashboard-preview.tsx).
const AGENT_PROMPT = `Set up ax for me, end to end. ax is a local agent-experience graph over my Claude Code + Codex history - it runs locally and I review every change.

1. INSTALL - run \`curl -fsSL ax.necmttn.com/install | sh\` to install the ax CLI. Reference: https://ax.necmttn.com/docs

2. INGEST MY HISTORY - first run \`ax ingest --dry-run\` and tell me, in plain words, how long a full backfill will take. Then start the ingest in the BACKGROUND so we can keep working: run \`ax ingest\` as a background job with AX_PROGRESS=plain, and watch its output for progress and completion. Tell me I can watch it fill live in the dashboard - run \`ax serve\` and open http://127.0.0.1:1738. When the ingest finishes, summarize what landed: total sessions, turns, and the top skills/tools I actually use. Then continue with the steps below.

3. VERIFY - run \`ax doctor\`. If anything isn't ok, diagnose and fix it, then re-run until it is.

4. LABEL what ax can't classify - run \`ax skills classify\`. It writes one \`.ax/tasks/classify-<skill>.md\` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML frontmatter at the top (\`primary_role:\` is required; \`secondary\`, \`confidence\`, \`rationale\` are optional). Run \`ax roles\` to see labels already in use. Then run \`ax skills lint\` to apply them. If it says "no unclassified skills", that's fine.

5. SHOW me the result - run \`ax skills weighted\` and \`ax skills config\`. Tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.

6. GIVE ME A NEXT STEP - recommend 1-2 under-used skills you'd reach for based on what you saw, then end with a concrete CTA: the exact command or prompt I should run next, and what outcome it will produce.`;

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
                <span className="icons" aria-hidden="true">{PROVIDERS.map((p, i) => <span key={p.key} className="i" style={{ "--i": i } as CSSProperties}>{p.svg}</span>)}</span>
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
    const dim = theme === "dark" ? "#1a2019" : "#e0ddd0";
    const mid = theme === "dark" ? "#56b06a" : "#2f9e44";
    const lit = theme === "dark" ? "#eafff0" : "#123a1f";
    return (
        <div className="v-land">
            <nav className="v-land-nav">
                <span className="logo">ax<small>agent experience</small></span>
                <span className="spacer" />
                <a>Features</a><a>Profiles</a><a>Leaders</a><a>Docs</a>
                <a className="cta">Install ax</a>
            </nav>

            <header className="v-land-hero">
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
                    <LogoMatrix dim={dim} mid={mid} lit={lit} />
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
