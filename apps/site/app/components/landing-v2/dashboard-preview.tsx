"use client";
import { useState } from "react";
import { HeroLogoField } from "./supports-strip";
import { ScoreClimb } from "./score-climb";
import { RetroTerminal } from "./retro-terminal";

const INSTALL_CMD = "curl -fsSL ax.necmttn.com/install | sh";

// Mirror of packages/lib/src/agent-onboarding.ts (AGENT_ONBOARDING_PROMPT).
// Kept inline so the marketing bundle stays free of the @ax/lib workspace dep.
const AGENT_PROMPT = `Set up ax for me. ax is my local agent-experience graph over my Claude Code + Codex history. Do this end to end:

1. VERIFY - run \`ax doctor\`. If anything isn't ok, diagnose and fix it, then re-run until it is.

2. LABEL what ax can't classify - run \`ax skills classify\`. It writes one \`.ax/tasks/classify-<skill>.md\` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML at the bottom (\`primary_role:\` is required; \`secondary_roles\`, \`confidence\`, \`rationale\` are optional). Run \`ax roles\` to see labels already in use. Then run \`ax skills lint\` to apply them.

3. SHOW me the result - run \`ax skills weighted\` and \`ax skills config\`. Tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.

Then recommend a couple of skills I under-use that you'd reach for, based on what you saw.`;

export function DashboardPreview() {
  const [copied, setCopied] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  function onCopy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(INSTALL_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function onCopyPrompt() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(AGENT_PROMPT).then(() => {
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
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
          <div
            className={`install${copied ? " is-copied" : ""}`}
            id="install"
            role="button"
            tabIndex={0}
            aria-label="copy install command"
            aria-live="polite"
            onClick={onCopy}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCopy();
              }
            }}
          >
            <span className="prompt">$</span>
            <code id="install-code">{INSTALL_CMD}</code>
            <span
              id="copy-btn"
              className={`install-action${copied ? " copied" : ""}`}
              aria-hidden="true"
            >
              <span className="install-action__label">
                {copied ? "copied" : "copy"}
              </span>
            </span>
          </div>
          <p className="install-trust">
            runs locally <span className="sep">·</span> you review every change{" "}
            <span className="sep">·</span> works with the agents you already use
          </p>
        </div>

        <button
          type="button"
          className={`agent-instructions${copiedPrompt ? " is-copied" : ""}`}
          onClick={onCopyPrompt}
          aria-label="copy agent setup instructions"
          aria-live="polite"
        >
          <span className="agent-instructions__label">
            {copiedPrompt ? "copied - paste into your agent" : "▸ copy agent instructions"}
          </span>
          <span className="agent-instructions__hint">
            then your agent installs, labels your skills &amp; verifies
          </span>
        </button>
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
          aria-label="ax dashboard preview at 127.0.0.1:8520"
        >
          <div className="browser-bar">
            <div className="browser-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <div className="browser-url">127.0.0.1:8520</div>
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
