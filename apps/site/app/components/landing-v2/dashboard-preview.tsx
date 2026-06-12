"use client";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { HeroLogoField, PROVIDERS } from "./supports-strip";
import { RetroTerminal } from "./retro-terminal";

const INSTALL_CMD = "curl -fsSL ax.necmttn.com/install | sh";
const DOCS_URL = "https://ax.necmttn.com/docs";

// Self-contained "give this to your agent" prompt for the landing site: unlike
// packages/lib's AGENT_ONBOARDING_PROMPT (run after ax is installed, by `ax
// setup` / install.sh), this one is pasted by someone who hasn't installed yet,
// so it opens with the install step. Kept inline so the marketing bundle stays
// free of the @ax/lib workspace dep.
const AGENT_PROMPT = `Set up ax for me, end to end. ax is a local agent-experience graph over my Claude Code + Codex history - it runs locally and I review every change.

1. INSTALL - run \`${INSTALL_CMD}\` to install the ax CLI. Reference: ${DOCS_URL}

2. INGEST MY HISTORY - first run \`ax ingest --dry-run\` and tell me, in plain words, how long a full backfill will take. Then start the ingest in the BACKGROUND so we can keep working: run \`ax ingest\` as a background job with AX_PROGRESS=plain, and watch its output for progress and completion. Tell me I can watch it fill live in the dashboard - run \`ax serve\` and open http://127.0.0.1:1738. When the ingest finishes, summarize what landed: total sessions, turns, and the top skills/tools I actually use. Then continue with the steps below.

3. VERIFY - run \`ax doctor\`. If anything isn't ok, diagnose and fix it, then re-run until it is.

4. LABEL what ax can't classify - run \`ax skills classify\`. It writes one \`.ax/tasks/classify-<skill>.md\` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML frontmatter at the top (\`primary_role:\` is required; \`secondary\`, \`confidence\`, \`rationale\` are optional). Run \`ax roles\` to see labels already in use. Then run \`ax skills lint\` to apply them. If it says "no unclassified skills", that's fine.

5. SHOW me the result - run \`ax skills weighted\` and \`ax skills config\`. Tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.

6. GIVE ME A NEXT STEP - recommend 1-2 under-used skills you'd reach for based on what you saw, then end with a concrete CTA: the exact command or prompt I should run next, and what outcome it will produce.`;

export function DashboardPreview() {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [hovered, setHovered] = useState(false);

  function onCopyPrompt() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(AGENT_PROMPT).then(() => {
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2200);
    });
  }

  return (
    <>
      {/* ============= hero ============= */}
      <section className="hero">
        <HeroLogoField />
        <span className="eyebrow">a feedback loop for your coding agent</span>
        <h1>
          Turn every agent session<br />
          into a better <em>next run</em>.
        </h1>
        <p className="hero-human">
          Built because we got tired of guessing what actually works.
        </p>
        <p className="lede">
          ax watches every session your coding harness runs, spots the mistakes
          it repeats, and turns them into small, repo-specific fixes you review
          and apply &mdash; one at a time.
        </p>

        <div className="install-wrap">
          <span className="install-label">install in 30 seconds</span>

          <div className="cta-row">
            <button
              type="button"
              className="prompt-pill"
              onClick={onCopyPrompt}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onFocus={() => setHovered(true)}
              onBlur={() => setHovered(false)}
              aria-label="copy agent setup prompt"
            >
              <span className="prompt-pill__icons" aria-hidden="true">
                {PROVIDERS.map((p) => (
                  <span
                    key={p.key}
                    className={`prompt-pill__icon prompt-pill__icon--${p.key}`}
                  >
                    {p.svg}
                  </span>
                ))}
              </span>
              <span className="prompt-pill__label">Copy setup prompt</span>
            </button>

            <Link to="/docs" className="cta-secondary">
              <span className="cta-secondary__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    d="M6 3.5h7L18 8v12.5H6z"
                  />
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    d="M9 12h6M9 15.5h6"
                  />
                </svg>
              </span>
              Read the docs
            </Link>
          </div>

          <p
            className={`cta-foot${hovered ? " is-hover" : ""}${copiedPrompt ? " is-copied" : ""}`}
            aria-live="polite"
          >
            <span className="cta-foot__hint">
              paste it - your agent installs ax, labels your skills, and tells
              you which ones to actually use
            </span>
            <span className="cta-foot__copied">
              ✓ Copied - paste into your coding agent for the guided setup
            </span>
          </p>
        </div>
      </section>

      {/* ============= retro terminal: the mechanism ============= */}
      <RetroTerminal />

      {/* ============= demo: improve deck (mirrors studio /improve) ============= */}
      <section className="demo">
        <div className="demo-intro">
          <span className="eyebrow">open the dashboard, fixes are waiting</span>
          <h2>
            Your next fixes, already&nbsp;mined.
          </h2>
          <p>
            The Improve deck turns your history into ranked proposals &mdash;
            spend to reroute, failures that recur, tools that keep breaking.
            Accept one, and ax measures your next 30 sessions to see if it
            actually worked.
          </p>
        </div>

        <div
          className="browser"
          role="img"
          aria-label="ax dashboard, Improve view at 127.0.0.1:1738"
        >
          <div className="browser-bar">
            <div className="browser-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <div className="browser-url">127.0.0.1:1738</div>
            <div className="browser-spacer"></div>
          </div>

          <div className="dash dash--improve">
            <div className="dash-tabs" aria-hidden="true">
              <span>Wrapped</span>
              <span className="is-active">Improve</span>
              <span>Sessions</span>
              <span>Skills</span>
              <span>Workflow</span>
            </div>

            <div className="nx-head">
              <div>
                <p className="nx-eyebrow">$ what&apos;s next</p>
                <p className="nx-title">20 actions waiting</p>
                <p className="nx-sub">
                  Mined from your sessions &mdash; savings to route, fixes that
                  recur, verdicts due.
                </p>
              </div>
              <span className="nx-brief">copy analysis brief</span>
            </div>

            <div className="nx-grid">
              <article className="nx-card">
                <p className="nx-tag">$ proposal</p>
                <h3 className="nx-card-title">~$605 redirectable</h3>
                <p className="nx-card-desc">
                  252 model-less dispatches on expensive models matched
                  mechanical routing classes.
                </p>
                <p className="nx-fix">
                  <b>FIX &rarr; NEW HOOK:</b> route mechanical subagent
                  dispatches to cheaper models
                </p>
                <div className="nx-actions">
                  <span className="nx-btn">REVIEW &rarr;</span>
                  <span className="nx-copy">copy brief</span>
                </div>
              </article>

              <article className="nx-card">
                <p className="nx-tag">$ proposal</p>
                <h3 className="nx-card-title">26&times; recurring</h3>
                <p className="nx-card-desc">
                  Feature closure needs stronger same-file follow-up
                  verification.
                </p>
                <p className="nx-fix">
                  <b>FIX &rarr; NEW SKILL:</b> post-feature verification
                  checklist
                </p>
                <div className="nx-actions">
                  <span className="nx-btn">REVIEW &rarr;</span>
                  <span className="nx-copy">copy brief</span>
                </div>
              </article>

              <article className="nx-card nx-card--alert">
                <p className="nx-tag nx-tag--alert">$ failing tool</p>
                <h3 className="nx-card-title">
                  Fix <code>write_stdin</code> cluster
                </h3>
                <p className="nx-card-desc">
                  1,681 failures across 205 sessions &mdash; one flaky tool
                  taxing every run.
                </p>
                <p className="nx-exits">
                  exits [2, 1, 130, -1, 127&hellip;]
                </p>
                <div className="nx-actions">
                  <span className="nx-btn">DETAILS &rarr;</span>
                  <span className="nx-copy">copy brief</span>
                </div>
              </article>
            </div>

            <p className="nx-foot">+17 more in the registry below</p>

            <div className="nx-exp">
              <div className="nx-exp-head">
                <p className="nx-exp-title">
                  <span className="nx-eyebrow">$ experiments</span> Past bets,
                  measured
                </p>
                <span className="nx-exp-meta">
                  checkpoints at +3 / +10 / +30 sessions
                </span>
              </div>
              <div className="nx-exp-empty">
                <div className="nx-exp-empty-copy">
                  <p className="nx-exp-empty-title">No bets placed yet.</p>
                  <p className="nx-exp-note">
                    Every accepted fix becomes a bet. ax watches your next 30
                    sessions &mdash; a trace bar that shrinks to zero is a
                    confirmed win.
                  </p>
                </div>
                <div className="nx-trace" aria-hidden="true">
                  <div className="nx-trace-row">
                    <span className="nx-trace-label">+3</span>
                    <span className="nx-trace-track">
                      <span
                        className="nx-trace-bar"
                        style={{ width: "92%" }}
                      ></span>
                    </span>
                  </div>
                  <div className="nx-trace-row">
                    <span className="nx-trace-label">+10</span>
                    <span className="nx-trace-track">
                      <span
                        className="nx-trace-bar"
                        style={{ width: "44%" }}
                      ></span>
                    </span>
                  </div>
                  <div className="nx-trace-row">
                    <span className="nx-trace-label">+30</span>
                    <span className="nx-trace-track">
                      <span
                        className="nx-trace-bar nx-trace-bar--win"
                        style={{ width: "7%" }}
                      ></span>
                      <span className="nx-trace-win">&#10003; confirmed win</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <p className="demo-caption">
          Run <code>ax serve</code> to see yours &mdash; Improve deck, Agent
          Wrapped, sessions, skill triage.
        </p>
      </section>
    </>
  );
}
