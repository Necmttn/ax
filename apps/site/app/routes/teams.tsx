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
const LEADERS_URL = "/leaders";

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
        <span className="eyebrow">what deeper adoption will look like</span>
        <h2>
          A faster team has a different <em>shape</em>.
        </h2>
        <p>
          Gates open as a workflow goes from one person&rsquo;s trick to team
          practice. The aggregation layer that rolls every seat into this curve
          is what we&rsquo;re building with design partners &mdash; the scroll
          below sketches the shape it will draw.
        </p>
      </div>

      <div ref={panelRef} className="impact-panel">
        <MetricsBars scrollProgress={scrollProgress} />
        <PipelineFlow scrollProgress={scrollProgress} />
        <p className="impact-frame">
          Stuck gates are workflows still trapped in one head &mdash; ax finds
          them per seat today.
        </p>
        <p className="impact-illus">
          sketch of the team view &mdash; in development; per-seat receipts are
          live now (see below)
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
          <span className="eyebrow">ax for engineering teams &middot; early access</span>
          <h1>
            See how your team<br />
            actually ships with <em>AI</em>.
          </h1>
          <p className="hero-human">
            Every engineer tries agents differently. Nobody knows what is
            sticking.
          </p>
          <p className="lede">
            ax is live per seat today &mdash; it turns one engineer&rsquo;s local
            coding-agent sessions into receipts. The team aggregation layer that
            rolls those seats together is in development; we&rsquo;re building it
            with design partners. A walkthrough runs on each engineer&rsquo;s own
            local ax data, today.
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

        {/* ============= per-seat receipts (real, single-seat) ============= */}
        <section className="demo" id="demo">
          <div className="demo-intro">
            <span className="eyebrow">this is what one seat looks like</span>
            <h2>Real receipts, generated locally &mdash; today.</h2>
            <p>
              These are the numbers ax already surfaces from a single
              engineer&rsquo;s history (run <code>ax studio</code> on your own
              machine). The team product aggregates these per-seat receipts into
              one view &mdash; same numbers, rolled up.
            </p>
          </div>

          <div className="browser" role="img" aria-label="ax studio per-seat receipts">
            <div className="browser-bar">
              <div className="browser-dots"><span></span><span></span><span></span></div>
              <div className="browser-url">ax studio &middot; one seat &middot; 14 days</div>
              <div className="browser-spacer"></div>
            </div>
            <div className="dash">
              <p className="dash-head">What ax found on one machine</p>
              <div className="ministats">
                <div className="mini">
                  <div className="mini-label">Redirectable spend</div>
                  <div className="mini-value"><span className="unit">$</span>605</div>
                  <div className="mini-sub"><b>routine sub-tasks</b> on the expensive default</div>
                </div>
                <div className="mini">
                  <div className="mini-label">Top recurring fix</div>
                  <div className="mini-value">26<span className="unit">×</span></div>
                  <div className="mini-sub">same mistake, <b>one proposal</b></div>
                </div>
                <div className="mini">
                  <div className="mini-label">Routing est. savings</div>
                  <div className="mini-value"><span className="unit">$</span>512<span className="unit">.91</span></div>
                  <div className="mini-sub"><span className="pos">repriced</span> from real tokens</div>
                </div>
                <div className="mini">
                  <div className="mini-label">Churn episodes</div>
                  <div className="mini-value">7</div>
                  <div className="mini-sub"><span className="neg">failure → repair</span> loops, 30d</div>
                </div>
              </div>
            </div>
          </div>
          <p className="demo-caption">
            Every number here is per-seat and local. The team layer
            <em> aggregates</em> them &mdash; never per-person behavior, never
            transcripts.
          </p>
        </section>

        {/* ============= one person's trick → team practice ============= */}
        <section className="pitch-section" id="spread">
          <div className="pitch-head">
            <span className="eyebrow">one person&rsquo;s trick → team practice</span>
            <h2>
              The mechanism that spreads a workflow <em>already ships</em>.
            </h2>
            <p>
              You don&rsquo;t need the aggregation layer to move a good pattern
              across the team. Two shipped surfaces already do it.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H16l4 4v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
                  <path d="M15 4v5h5M8 13h8M8 16h5" />
                </svg>
              </span>
              <h3>Skills &amp; hooks SDK</h3>
              <p>
                When ax finds a fix worth keeping, it becomes a skill or a typed
                Effect hook (Claude Code + Codex). Commit it once; everyone&rsquo;s
                agent runs it. That&rsquo;s one person&rsquo;s trick becoming team
                practice, today.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="3.2" />
                  <path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
                </svg>
              </span>
              <h3>Public profiles &amp; leaders</h3>
              <p>
                <code>ax profile publish</code> turns one seat into a shareable
                profile. <a href={LEADERS_URL}>/leaders</a> and
                {" "}<a href="/u/necmttn">/u/&lt;login&gt;</a> are live multi-person
                surfaces on the aggregates-only model &mdash; proof the rollup
                works without sending anyone&rsquo;s code.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
                </svg>
              </span>
              <h3>The improve loop</h3>
              <p>
                ax mines repeated mistakes and proposes a small repo-specific fix,
                reviewed one at a time. Accept it and it&rsquo;s in the repo &mdash;
                no aggregation server required.
              </p>
            </div>
          </div>
        </section>

        {/* ============= impact signal ============= */}
        <ImpactSection />

        {/* ============= the privacy contract ============= */}
        <section className="pitch-section" id="privacy">
          <div className="pitch-head">
            <span className="eyebrow">the privacy contract</span>
            <h2>
              You see the exact JSON <em>before</em> anything leaves.
            </h2>
            <p>
              ax is AGPL-3.0 and runs entirely on each laptop. There is one real
              export today &mdash; <code>ax profile publish</code> &mdash; and it
              shows you the precise JSON in a consent prompt before the first byte
              moves. The team layer keeps that contract and goes further: your
              team&rsquo;s aggregates live in <b>your own private git repo</b>, not
              our database. The dashboard reads them in the browser with each
              viewer&rsquo;s own GitHub login &mdash; repo access is the only key.
              We store <b>zero company data</b>: a breach of ours has nothing of
              yours to leak.
            </p>
          </div>
          <div className="pitch-lanes">
            <div className="pitch-lane is-out">
              <h3><span className="dot"></span> what will leave (after consent)</h3>
              <ul>
                <li>Per-seat <b>adoption signal</b> <span className="dim">(active days, depth of use)</span></li>
                <li>Skill / workflow <b>usage rollups</b> <span className="dim">(names, not contents)</span></li>
                <li><b>Cost &amp; routing aggregates</b> <span className="dim">(the spend worth redirecting)</span></li>
                <li>Team-level <b>aggregates</b> <span className="dim">(never per-person behavior)</span></li>
              </ul>
            </div>
            <div className="pitch-lane is-local">
              <h3><span className="dot"></span> what never leaves</h3>
              <ul>
                <li>Transcript text &amp; <b>prompts</b> <span className="dim">(read locally, never sent)</span></li>
                <li>Your <b>code</b>, diffs and file contents <span className="dim">(stay on disk)</span></li>
                <li><b>What</b> each person is building <span className="dim">(yours to keep)</span></li>
                <li>Anything not in the consent-prompt JSON you approved</li>
              </ul>
            </div>
          </div>
          <p className="demo-caption">
            <b>Per-project, opt-in, default-deny.</b> Nothing is collected until a
            dev runs <code>ax team join</code> inside a specific repo. Personal
            projects and other clients&rsquo; code are <em>never sent</em> &mdash;
            not filtered out, never uploaded. Each dev&rsquo;s choice is private and
            per-repo; a fork or rename can&rsquo;t leak the wrong one.
          </p>
          <p className="demo-caption">
            Verifiable today: <code>ax profile publish</code> prints the full
            payload and waits for your yes. Source is AGPL-3.0 &mdash; read the
            line, don&rsquo;t trust it.
          </p>
        </section>

        {/* ============= pricing ============= */}
        <section className="pitch-section" id="pricing">
          <div className="pitch-head">
            <span className="eyebrow">design-partner pricing</span>
            <h2>
              <em>$12</em> per developer, per month.
            </h2>
            <p>
              Simple per-seat, self-serve, cancel anytime &mdash; a seat is a dev
              who pushes to the team. It rides as an add-on to the $20&ndash;40 per
              dev you already spend on agents, and pays for itself the moment it
              redirects one routine sub-task off the expensive default. Founder
              pricing is locked for design partners.
            </p>
          </div>
          <div className="ministats">
            <div className="mini">
              <div className="mini-label">Per seat</div>
              <div className="mini-value"><span className="unit">$</span>12<span className="unit">/mo</span></div>
              <div className="mini-sub">a seat = a dev who <b>pushes</b></div>
            </div>
            <div className="mini">
              <div className="mini-label">10-dev team</div>
              <div className="mini-value"><span className="unit">$</span>120<span className="unit">/mo</span></div>
              <div className="mini-sub">less than one redirected task</div>
            </div>
            <div className="mini">
              <div className="mini-label">50-dev team</div>
              <div className="mini-value"><span className="unit">$</span>600<span className="unit">/mo</span></div>
              <div className="mini-sub">scales per seat, prorated</div>
            </div>
            <div className="mini">
              <div className="mini-label">Cancel</div>
              <div className="mini-value">anytime</div>
              <div className="mini-sub">self-serve, via Stripe</div>
            </div>
          </div>
          <p className="demo-caption">
            You&rsquo;re paying for the dashboard and the enablement &mdash; never
            for a place to warehouse your code insights. Those stay in <b>your</b>
            git repo; we store none of it.
          </p>
        </section>

        {/* ============= closing CTA ============= */}
        <section className="pitch-cta">
          <h2>What gets measured gets improved.</h2>
          <p>
            Right now AI adoption isn&rsquo;t measured at all. The walkthrough
            runs on each engineer&rsquo;s own local ax data &mdash; live today
            &mdash; and shows what stuck, what stayed shallow, and which workflows
            are ready to spread. We&rsquo;re onboarding design partners for the
            team aggregation layer as we build it.
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
