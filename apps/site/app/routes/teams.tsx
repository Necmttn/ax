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
      { title: "ax for teams - see what your AI spend actually buys" },
      {
        name: "description",
        content:
          "One view of every AI seat and harness across your team - deduped, tied to outcomes - without reading anyone's code. Raw stays on the laptop; only aggregates leave.",
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
            See what your AI spend<br />
            is <em>actually</em> buying.
          </h1>
          <p className="hero-human">
            Every seat, every harness, in one place &mdash; without reading
            anyone&rsquo;s code.
          </p>
          <p className="lede">
            Your team swaps models, providers and harnesses every week, and each
            vendor console is a silo. ax unifies them: one view of who uses what,
            which seats are dead, which are paid twice &mdash; and whether the
            spend is producing anything.
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

        {/* ============= the blindness ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">the blindness</span>
            <h2>
              You&rsquo;re paying for AI you <em>can&rsquo;t see</em>.
            </h2>
            <p>
              The invoice is real. The usage isn&rsquo;t visible &mdash; and
              providers will never show you what happens across their
              competitors.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 10h18M8 19v-9" />
                </svg>
              </span>
              <h3>Dead &amp; duplicate seats</h3>
              <p>
                Who actually touches their $200 seat day-to-day? Who has three
                tools doing one job? Dedup the sprawl, kill the waste.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="2.5" />
                  <circle cx="18" cy="6" r="2.5" />
                  <circle cx="12" cy="18" r="2.5" />
                  <path d="M6 8.5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2M12 13.5v2" />
                </svg>
              </span>
              <h3>Harness sprawl, unified</h3>
              <p>
                Claude Code, Codex, Cursor, OpenCode, Pi &mdash; one deduped view
                per person, instead of five consoles that can&rsquo;t see each
                other.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l2.4 5.4 5.6.5-4.2 3.7 1.3 5.6L12 16.8 6.9 18.7l1.3-5.6L4 9.4l5.6-.5z" />
                </svg>
              </span>
              <h3>Hidden gold</h3>
              <p>
                Your best performer built a workflow nobody else has. ax finds
                the siloed skill that&rsquo;s used 40&times; on one laptop &mdash;
                so you can spread it.
              </p>
            </div>
          </div>
        </section>

        {/* ============= dashboard preview ============= */}
        <section className="demo">
          <div className="demo-intro">
            <span className="eyebrow">one screen, the whole team</span>
            <h2>Spend in, outcomes out.</h2>
            <p>
              The same report that shows you the waste shows you the gold &mdash;
              so it&rsquo;s the screen you bring to the team, not the one you hide
              from them.
            </p>
          </div>

          <div className="browser" role="img" aria-label="ax team dashboard preview">
            <div className="browser-bar">
              <div className="browser-dots"><span></span><span></span><span></span></div>
              <div className="browser-url">app.ax / team &middot; this month</div>
              <div className="browser-spacer"></div>
            </div>
            <div className="dash">
              <p className="dash-head">Team spend &amp; adoption &middot; 12 engineers</p>
              <div className="ministats">
                <div className="mini">
                  <div className="mini-label">Monthly AI spend</div>
                  <div className="mini-value">$2.4<span className="unit">k</span></div>
                  <div className="mini-sub"><b>5</b> tools &middot; <span className="neg">+18%</span></div>
                </div>
                <div className="mini">
                  <div className="mini-label">Seats live</div>
                  <div className="mini-value">9<span className="unit">/ 12</span></div>
                  <div className="mini-sub"><span className="neg">3 dead</span> &middot; $600/mo</div>
                </div>
                <div className="mini">
                  <div className="mini-label">Duplicate seats</div>
                  <div className="mini-value">4</div>
                  <div className="mini-sub">2 tools, same job</div>
                </div>
                <div className="mini">
                  <div className="mini-label">Hidden gold</div>
                  <div className="mini-value">3</div>
                  <div className="mini-sub"><b>siloed skills</b> worth spreading</div>
                </div>
              </div>
            </div>
          </div>
          <p className="demo-caption">
            Aggregates only. Nothing here required reading a line of anyone&rsquo;s code.
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
                <li>Per-seat <b>utilization</b> <span className="dim">(tokens, active days &mdash; the seat you pay for)</span></li>
                <li>Skill / tool <b>usage rollups</b> <span className="dim">(names, not contents)</span></li>
                <li><b>Failure shapes</b> <span className="dim">(&ldquo;step 3 fails on input-class Y, 12&times;&rdquo;)</span></li>
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
          <h2>Find the waste. Spread the gold.</h2>
          <p>
            A 20-minute walkthrough on your own data &mdash; we&rsquo;ll show you
            the dead seats and the hidden skills before you decide anything.
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
