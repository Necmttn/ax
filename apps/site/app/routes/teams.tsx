import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { FooterCards } from "~/components/landing-v2";
import { HeroLogoField } from "~/components/landing-v2/supports-strip";
import "../styles/pitch.css";

const MAILTO =
  "mailto:necmettin.karakaya@gmail.com?subject=ax%20for%20teams%20-%20walkthrough";

export const Route = createFileRoute("/teams")({
  head: () => ({
    meta: [
      { title: "ax for teams - close the gap to your best AI user" },
      {
        name: "description",
        content:
          "Most teams plateau at a fraction of what their AI tooling can do. ax shows the gap between your best AI users and the rest - and the workflows worth spreading - so the whole team ships faster.",
      },
    ],
  }),
  component: Teams,
});

function PitchSwitch() {
  return (
    <div className="pitch-switch" role="tablist" aria-label="positioning">
      <Link to="/teams" className="is-active">
        for managers
      </Link>
      <Link to="/registry">for applied-AI teams</Link>
    </div>
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
            Your team uses a <em>fraction</em><br />
            of what AI can do.
          </h1>
          <p className="hero-human">
            The real cost isn&rsquo;t the spend &mdash; it&rsquo;s the speed
            you&rsquo;re leaving on the table.
          </p>
          <p className="lede">
            A couple of people get great at AI and fly. Everyone else plateaus at
            autocomplete. ax finds the gap between your best AI users and the rest
            &mdash; the workflows that actually ship, and who hasn&rsquo;t picked
            them up &mdash; so you can close it.
          </p>

          <div className="install-wrap">
            <span className="install-label">runs on the laptops you already have</span>
            <div className="cta-row">
              <a className="prompt-pill is-solo" href={MAILTO}>
                <span className="prompt-pill__label">Book a 20-min walkthrough</span>
              </a>
              <a className="cta-secondary" href="#privacy">
                <span className="cta-secondary__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                      d="M12 3.5 5 6.5v5c0 4 3 7 7 9 4-2 7-5 7-9v-5z"
                    />
                  </svg>
                </span>
                How the privacy line works
              </a>
            </div>
            <PitchSwitch />
          </div>
        </section>

        {/* ============= the gap ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">the opportunity</span>
            <h2>
              The upside you <em>can&rsquo;t see</em>.
            </h2>
            <p>
              What you&rsquo;d save trimming dead seats is rounding error next to
              the speed your team isn&rsquo;t getting. That gap stays invisible
              &mdash; until you can compare how people actually work.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19V5M4 19h16M8 19v-5M12 19v-9M16 19V8M20 19v-7" />
                </svg>
              </span>
              <h3>The adoption gap</h3>
              <p>
                A few people are flying; most are barely past autocomplete. See
                who&rsquo;s stuck at the starting line &mdash; and on what.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l3.5 3.5L19 6" />
                  <path d="M5 19h14" />
                </svg>
              </span>
              <h3>What actually works</h3>
              <p>
                Which workflows, skills and harnesses line up with shipping &mdash;
                surfaced from real sessions, not vibes or self-reports.
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
              <h3>Spread the best</h3>
              <p>
                Your top performer&rsquo;s recipe, made repeatable &mdash; level
                the whole team up to your best AI user instead of hoping it rubs
                off.
              </p>
            </div>
          </div>
        </section>

        {/* ============= dashboard preview ============= */}
        <section className="demo">
          <div className="demo-intro">
            <span className="eyebrow">one screen, the whole team</span>
            <h2>See the gap. Close the gap.</h2>
            <p>
              The same view that shows who&rsquo;s underusing AI shows you exactly
              what to hand them &mdash; the workflow that&rsquo;s already working
              two desks over.
            </p>
          </div>

          <div className="browser" role="img" aria-label="ax team dashboard preview">
            <div className="browser-bar">
              <div className="browser-dots"><span></span><span></span><span></span></div>
              <div className="browser-url">app.ax / team &middot; this month</div>
              <div className="browser-spacer"></div>
            </div>
            <div className="dash">
              <p className="dash-head">Team AI adoption &middot; 12 engineers</p>
              <div className="ministats">
                <div className="mini">
                  <div className="mini-label">Team adoption</div>
                  <div className="mini-value">41<span className="unit">%</span></div>
                  <div className="mini-sub"><b>59%</b> still on the table</div>
                </div>
                <div className="mini">
                  <div className="mini-label">At expert tier</div>
                  <div className="mini-value">3<span className="unit">/ 12</span></div>
                  <div className="mini-sub"><span className="neg">9 plateaued</span></div>
                </div>
                <div className="mini">
                  <div className="mini-label">Workflows that ship</div>
                  <div className="mini-value">6</div>
                  <div className="mini-sub"><span className="pos">+2</span> found this week</div>
                </div>
                <div className="mini">
                  <div className="mini-label">Ready to spread</div>
                  <div className="mini-value">3</div>
                  <div className="mini-sub"><b>best-performer</b> skills</div>
                </div>
              </div>
            </div>
          </div>
          <p className="demo-caption">
            Aggregates only &mdash; the point isn&rsquo;t to police anyone,
            it&rsquo;s to level them up.
          </p>
        </section>

        {/* ============= the privacy line ============= */}
        <section className="pitch-section" id="privacy">
          <div className="pitch-head">
            <span className="eyebrow">the privacy line</span>
            <h2>
              The collector is <em>open source</em>. So your team can read exactly
              what leaves.
            </h2>
            <p>
              ax runs locally and computes small derived rows. Raw transcripts,
              prompts and code physically never leave the machine &mdash; and
              because it&rsquo;s OSS, that&rsquo;s verifiable, not a promise.
            </p>
          </div>
          <div className="pitch-lanes">
            <div className="pitch-lane is-out">
              <h3><span className="dot"></span> ships out</h3>
              <ul>
                <li>Per-seat <b>adoption signal</b> <span className="dim">(active days, depth of use)</span></li>
                <li>Skill / workflow <b>usage rollups</b> <span className="dim">(names, not contents)</span></li>
                <li><b>What correlates with shipping</b> <span className="dim">(the patterns worth spreading)</span></li>
                <li>Team-level <b>aggregates</b> <span className="dim">(never per-person behavior)</span></li>
              </ul>
            </div>
            <div className="pitch-lane is-local">
              <h3><span className="dot"></span> stays on the laptop</h3>
              <ul>
                <li>Transcript text &amp; <b>prompts</b></li>
                <li>Your <b>code</b>, diffs and file contents</li>
                <li><b>What</b> you&rsquo;re building, per person</li>
                <li>Everything ax needs for <b>local</b> analytics</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ============= closing CTA ============= */}
        <section className="pitch-cta">
          <h2>Stop leaving speed on the table.</h2>
          <p>
            A 20-minute walkthrough on your own data &mdash; we&rsquo;ll show you
            the adoption gap and the workflows worth spreading before you decide
            anything.
          </p>
          <div className="cta-row">
            <a className="prompt-pill is-solo" href={MAILTO}>
              <span className="prompt-pill__label">Book a 20-min walkthrough</span>
            </a>
            <Link to="/registry" className="cta-secondary">
              See the applied-AI angle
            </Link>
          </div>
        </section>

        <FooterCards />
      </main>
      <SiteFooter />
    </>
  );
}
