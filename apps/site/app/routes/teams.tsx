import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { MetricsBars } from "~/components/pitch/MetricsBars";
import { PipelineFlow } from "~/components/pitch/PipelineFlow";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { FooterCards } from "~/components/landing-v2";
import { HeroLogoField } from "~/components/landing-v2/supports-strip";
import "../styles/pitch.css";

const BOOK_URL = "https://cal.com/necmttn/30min";

export const Route = createFileRoute("/teams")({
  head: () => ({
    meta: [
      { title: "ax for teams - see how your team actually ships with AI" },
      {
        name: "description",
        content:
          "Every engineer uses AI differently. ax shows which agent workflows change how your team ships, where adoption is stuck, and what should become standard practice.",
      },
    ],
  }),
  component: Teams,
});

function ImpactSection() {
  const impactRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollProgress = useRef({ value: 0 });

  useEffect(() => {
    const impact = impactRef.current;
    const panel = panelRef.current;
    if (!impact || !panel) return;

    const update = () => {
      const rect = panel.getBoundingClientRect();
      const start = window.innerHeight * 0.72;
      const end = window.innerHeight * 0.28;
      scrollProgress.current.value = Math.max(0, Math.min(1, (start - rect.top) / (start - end)));
    };

    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <section ref={impactRef} className="pitch-section">
      <div className="pitch-head">
        <span className="eyebrow">what deeper adoption looks like</span>
        <h2>
          A faster team has a different <em>shape</em>.
        </h2>
        <p>
          Gates open as a workflow goes from one person&rsquo;s trick to team
          practice. The scroll <em>is</em> your adoption curve.
        </p>
      </div>

      <div ref={panelRef} className="impact-panel">
        <MetricsBars scrollProgress={scrollProgress} />
        <PipelineFlow scrollProgress={scrollProgress} />
        <p className="impact-frame">
          Stuck gates are workflows still trapped in one head &mdash; ax finds
          them.
        </p>
        <p className="impact-illus">
          illustrative &mdash; your numbers render from real sessions
        </p>
      </div>
    </section>
  );
}

function Teams() {
  return (
    <>
      <SiteHeader />
      <main className="landing-v2">
        {/* ============= hero ============= */}
        <section className="hero">
          <HeroLogoField />
          <span className="eyebrow">ax for engineering teams</span>
          <h1>
            See how your team<br />
            actually ships with <em>AI</em>.
          </h1>
          <p className="hero-human">
            Every engineer tries agents differently. Nobody knows what is
            sticking.
          </p>
          <p className="lede">
            ax turns local coding-agent sessions into evidence for your AI
            enablement work: which workflows improve real shipping, where the
            team is stuck, and what should become standard practice.
          </p>

          <div className="install-wrap">
            <span className="install-label">runs on the laptops you already have</span>
            <div className="cta-row">
              <a className="prompt-pill is-solo" href={BOOK_URL}>
                <span className="prompt-pill__label">Book a walkthrough</span>
              </a>
              <a className="cta-secondary" href="#demo">
                <span className="cta-secondary__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 19V5M4 19h16M8 19v-5M12 19v-9M16 19V8M20 19v-7"
                    />
                  </svg>
                </span>
                See what ax finds
              </a>
            </div>
          </div>
        </section>

        {/* ============= the gap ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">the rollout problem</span>
            <h2>
              The first AI rollout does not make a team <em>AI-native</em>.
            </h2>
            <p>
              Copilot, Cursor, Claude Code, ChatGPT &mdash; the tools arrive
              before the operating model. Some engineers build real agentic
              workflows; others stay at autocomplete. Leadership gets demos, not
              a shared way of shipping.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19V5M4 19h16M8 19v-5M12 19v-9M16 19V8M20 19v-7" />
                </svg>
              </span>
              <h3>Tool chaos</h3>
              <p>
                Every engineer has a different stack, habit and prompt folder.
                ax shows the patterns under the sprawl.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l3.5 3.5L19 6" />
                  <path d="M5 19h14" />
                </svg>
              </span>
              <h3>No shared playbook</h3>
              <p>
                The useful workflows stay private until someone turns them into
                team practice. ax finds what is ready to teach or package.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="12" r="2.5" />
                  <circle cx="18" cy="6" r="2.5" />
                  <circle cx="18" cy="18" r="2.5" />
                  <path d="M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8" />
                </svg>
              </span>
              <h3>Shipping feels the same</h3>
              <p>
                If cycle time isn&rsquo;t moving, AI is still a side experiment.
                ax ties agent usage to the work that ships.
              </p>
            </div>
          </div>
        </section>

        {/* ============= dashboard preview ============= */}
        <section className="demo" id="demo">
          <div className="demo-intro">
            <span className="eyebrow">one screen, the whole team</span>
            <h2>The evidence layer for internal AI enablement.</h2>
            <p>
              Your AI lead shouldn&rsquo;t have to guess what stuck after the
              workshop. ax shows where leverage is showing up, where usage stays
              shallow, and which workflows are ready to spread.
            </p>
          </div>

          <div className="browser" role="img" aria-label="ax team dashboard preview">
            <div className="browser-bar">
              <div className="browser-dots"><span></span><span></span><span></span></div>
              <div className="browser-url">app.ax / team &middot; this month</div>
              <div className="browser-spacer"></div>
            </div>
            <div className="dash">
              <p className="dash-head">Shared agent practice &middot; 12 engineers</p>
              <div className="ministats">
                <div className="mini">
                  <div className="mini-label">AI-native workflows</div>
                  <div className="mini-value">41<span className="unit">%</span></div>
                  <div className="mini-sub"><b>59%</b> still shallow</div>
                </div>
                <div className="mini">
                  <div className="mini-label">Power users</div>
                  <div className="mini-value">3<span className="unit">/ 12</span></div>
                  <div className="mini-sub"><span className="neg">9 not using patterns</span></div>
                </div>
                <div className="mini">
                  <div className="mini-label">Shipping workflows</div>
                  <div className="mini-value">6</div>
                  <div className="mini-sub"><span className="pos">+2</span> found this week</div>
                </div>
                <div className="mini">
                  <div className="mini-label">Ready to spread</div>
                  <div className="mini-value">3</div>
                  <div className="mini-sub"><b>proven</b> playbooks</div>
                </div>
              </div>
            </div>
          </div>
          <p className="demo-caption">
            Aggregates only &mdash; not to police anyone, just to see whether AI
            is becoming part of how the team ships.
          </p>
        </section>

        {/* ============= impact signal ============= */}
        <ImpactSection />

        {/* ============= the privacy line ============= */}
        <section className="pitch-section" id="privacy">
          <div className="pitch-head">
            <span className="eyebrow">the privacy line</span>
            <h2>
              The collector is <em>open source</em>, so you can read exactly what
              leaves.
            </h2>
            <p>
              ax runs on each laptop and computes small derived rows. Only those
              aggregates ship; the sensitive work stays put by construction.
              Because it&rsquo;s OSS, you can verify that line instead of
              trusting it.
            </p>
          </div>
          <div className="pitch-lanes">
            <div className="pitch-lane is-out">
              <h3><span className="dot"></span> what leaves the laptop</h3>
              <ul>
                <li>Per-seat <b>adoption signal</b> <span className="dim">(active days, depth of use)</span></li>
                <li>Skill / workflow <b>usage rollups</b> <span className="dim">(names, not contents)</span></li>
                <li><b>What correlates with shipping</b> <span className="dim">(the patterns worth spreading)</span></li>
                <li>Team-level <b>aggregates</b> <span className="dim">(never per-person behavior)</span></li>
              </ul>
            </div>
            <div className="pitch-lane is-local">
              <h3><span className="dot"></span> what never leaves</h3>
              <ul>
                <li>Transcript text &amp; <b>prompts</b> <span className="dim">(read locally, never sent)</span></li>
                <li>Your <b>code</b>, diffs and file contents <span className="dim">(stay on disk)</span></li>
                <li><b>What</b> each person is building <span className="dim">(yours to keep)</span></li>
                <li>Everything else ax touches to compute the rollups</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ============= closing CTA ============= */}
        <section className="pitch-cta">
          <h2>What gets measured gets improved.</h2>
          <p>
            Right now AI adoption isn&rsquo;t measured at all. A walkthrough on
            your own data shows what stuck, what stayed shallow, and which
            workflows are ready to become standard practice.
          </p>
          <div className="cta-row">
            <a className="prompt-pill is-solo" href={BOOK_URL}>
              <span className="prompt-pill__label">Book a walkthrough</span>
            </a>
            <a className="cta-secondary" href="#privacy">
              How the privacy line works
            </a>
          </div>
        </section>

        <FooterCards />
      </main>
      <SiteFooter />
    </>
  );
}
