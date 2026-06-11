"use client";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { HeroLogoField, PROVIDERS } from "./supports-strip";
import { ScoreClimb } from "./score-climb";
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

4. LABEL what ax can't classify - run \`ax skills classify\`. It writes one \`.ax/tasks/classify-<skill>.md\` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML at the bottom (\`primary_role:\` is required; \`secondary_roles\`, \`confidence\`, \`rationale\` are optional). Run \`ax roles\` to see labels already in use. Then run \`ax skills lint\` to apply them. If it says "no unclassified skills", that's fine.

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

      {/* ============= demo: dashboard preview ============= */}
      <section className="demo">
        <div className="demo-intro">
          <span className="eyebrow">as you use it, it gets better</span>
          <h2>
            Every applied fix moves the&nbsp;score.
          </h2>
          <p>
            Harness Doctor grades how well your setup is working. ax keeps
            finding small fixes&nbsp;&mdash; you apply the ones you like, and the
            number climbs.
          </p>
        </div>

        <div
          className="browser"
          role="img"
          aria-label="ax dashboard preview at 127.0.0.1:1738"
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

          <div className="dash">
            <p className="dash-head">Harness Doctor &middot; this week</p>

            <ScoreClimb />

            <div className="ministats">
              {/* 1: turns indexed */}
              <div className="mini">
                <div className="mini-label">Turns indexed</div>
                <div className="mini-value">
                  369<span className="unit">k</span>
                </div>
                <div className="mini-chart">
                  <svg
                    className="spark"
                    viewBox="0 0 100 28"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points="0,22 12,20 24,18 36,14 48,16 60,11 72,8 84,5 100,3"
                      fill="none"
                      stroke="#0a0a0a"
                      strokeWidth="1.2"
                    />
                    <polyline
                      points="0,22 12,20 24,18 36,14 48,16 60,11 72,8 84,5 100,3 100,28 0,28"
                      fill="rgba(10,10,10,0.05)"
                      stroke="none"
                    />
                    <circle cx="100" cy="3" r="2" fill="#2f9e44" />
                  </svg>
                </div>
                <div className="mini-sub">
                  <b>14.2M</b> tokens &middot; <span className="pos">+20%</span>
                </div>
              </div>

              {/* 2: skills firing */}
              <div className="mini">
                <div className="mini-label">Skills firing</div>
                <div className="mini-value">
                  11<span className="unit">/ 20</span>
                </div>
                <div className="mini-chart">
                  <div className="dotgrid" aria-hidden="true">
                    <span className="lit"></span>
                    <span className="lit"></span>
                    <span></span>
                    <span className="lit"></span>
                    <span className="lit"></span>
                    <span></span>
                    <span className="lit"></span>
                    <span className="lit"></span>
                    <span></span>
                    <span className="lit"></span>
                    <span className="lit"></span>
                    <span></span>
                    <span className="lit"></span>
                    <span></span>
                    <span className="lit"></span>
                    <span></span>
                    <span></span>
                    <span className="lit"></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
                <div className="mini-sub">
                  <span className="neg">9 unused</span> this week
                </div>
              </div>

              {/* 3: interventions */}
              <div className="mini">
                <div className="mini-label">Interventions</div>
                <div className="mini-value">8</div>
                <div className="mini-chart">
                  <div className="stack-wrap">
                    <div className="stackbar" aria-label="interventions by form">
                      <div
                        className="seg form-skill"
                        style={{ width: "25%" }}
                        title="skill x2"
                      ></div>
                      <div
                        className="seg form-guidance"
                        style={{ width: "25%" }}
                        title="guidance x2"
                      ></div>
                      <div
                        className="seg form-subagent"
                        style={{ width: "12.5%" }}
                        title="subagent x1"
                      ></div>
                      <div
                        className="seg form-hook"
                        style={{ width: "25%" }}
                        title="hook x2"
                      ></div>
                      <div
                        className="seg form-harness"
                        style={{ width: "12.5%" }}
                        title="harness_check x1"
                      ></div>
                    </div>
                    <div className="stack-legend">
                      <span
                        className="sw"
                        style={{ background: "#0a0a0a" }}
                      ></span>
                      SKILL &nbsp;
                      <span
                        className="sw"
                        style={{ background: "#4a4640" }}
                      ></span>
                      GUIDE &nbsp;
                      <span
                        className="sw"
                        style={{ background: "var(--blue)" }}
                      ></span>
                      SUBAGENT
                      <br />
                      <span
                        className="sw"
                        style={{ background: "var(--amber)" }}
                      ></span>
                      HOOK &nbsp;
                      <span
                        className="sw"
                        style={{ background: "var(--green)" }}
                      ></span>
                      AUTO &nbsp;
                      <span
                        className="sw"
                        style={{ background: "var(--claude)" }}
                      ></span>
                      HARNESS
                    </div>
                  </div>
                </div>
                <div className="mini-sub">
                  across <b>6</b> forms &middot; <b>3</b> accepted
                </div>
              </div>

              {/* 4: safety contract */}
              <div className="mini">
                <div className="mini-label">Safety contract</div>
                <div className="mini-value">
                  100<span className="unit">%</span>
                </div>
                <div className="mini-chart">
                  <div className="safety-wrap">
                    <svg
                      className="safety-ring"
                      viewBox="0 0 36 36"
                      aria-hidden="true"
                    >
                      <circle
                        className="track"
                        cx="18"
                        cy="18"
                        r="14"
                      ></circle>
                      <circle
                        className="fill"
                        cx="18"
                        cy="18"
                        r="14"
                        strokeDasharray="87.96 87.96"
                        strokeDashoffset="0"
                      ></circle>
                    </svg>
                    <div className="safety-bullets">
                      <b>recovery_path</b>
                      <br />
                      <b>smoke_test</b>
                      <br />
                      <b>disable_command</b>
                    </div>
                  </div>
                </div>
                <div className="mini-sub">accepted hooks carry full contract</div>
              </div>
            </div>
          </div>
        </div>

        <p className="demo-caption">
          Run <code>ax serve</code> to see yours.
        </p>
      </section>
    </>
  );
}
