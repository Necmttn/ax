import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { FooterCards } from "~/components/landing-v2";
import { HeroLogoField } from "~/components/landing-v2/supports-strip";
import "../styles/pitch.css";

const BOOK_URL = "https://cal.com/necmttn/30min";
const CONTACT_URL = "https://github.com/Necmttn/ax/discussions";

export const Route = createFileRoute("/design-partners")({
  head: () => ({
    meta: [
      { title: "ax for teams - team AI-agent visibility, with zero of your data in our cloud" },
      {
        name: "description",
        content:
          "See team adoption, skill diffusion and spend for AI coding agents - without ever storing your data. Your telemetry lives in your own private git repo; the dashboard aggregates in the browser. Per-project opt-in, default-deny. $12/seat/mo.",
      },
    ],
  }),
  component: DesignPartners,
});

function DesignPartners() {
  return (
    <>
      <SiteHeader />
      <main className="landing-v2">
        {/* ============= hero ============= */}
        <section className="hero">
          <HeroLogoField />
          <span className="eyebrow">ax for teams &middot; design partners</span>
          <h1>
            See how your team ships with <em>AI</em>.<br />
            We store none of your data.
          </h1>
          <p className="hero-human">
            Your devs are already using agents. You can&rsquo;t see whether
            it&rsquo;s working.
          </p>
          <p className="lede">
            Every tool that promises to show you wants to hoover their transcripts
            into its cloud. ax gives you team-level adoption, skill diffusion and
            spend visibility &mdash; and your telemetry never leaves your own git.
            We hold <b>zero company data</b>.
          </p>

          <div className="install-wrap">
            <span className="install-label">runs on the laptops &amp; git you already have</span>
            <div className="cta-row">
              <a className="prompt-pill is-solo" href={BOOK_URL}>
                <span className="prompt-pill__label">Book a walkthrough</span>
              </a>
              <a className="cta-secondary" href="#guarantees">
                The three guarantees
              </a>
            </div>
          </div>
        </section>

        {/* ============= the problem ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">the problem</span>
            <h2>
              Leadership is <em>flying blind</em> on the AI rollout.
            </h2>
            <p>
              The tools arrived before the operating model. The existing answer is
              a SaaS that ingests everyone&rsquo;s transcripts &mdash; surveillance
              for your devs, and a data-liability for you: their code insights,
              sitting in a third party&rsquo;s database.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <h3>Adoption</h3>
              <p>
                Are devs actually using agents, or is it a few power users? Which
                skills and workflows are spreading?
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>Spend</h3>
              <p>
                Where is the token and subscription budget going? What&rsquo;s
                routable to cheaper models?
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>Effectiveness</h3>
              <p>
                Are agents shipping clean, or churning through failure&ndash;repair
                loops?
              </p>
            </div>
          </div>
        </section>

        {/* ============= three guarantees ============= */}
        <section className="pitch-section" id="guarantees">
          <div className="pitch-head">
            <span className="eyebrow">what makes this different</span>
            <h2>
              Three guarantees, <em>by construction</em>.
            </h2>
            <p>
              Not a privacy policy &mdash; a design. Each one is enforced by where
              the data lives and how it moves, not by our promise to be careful.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <h3>Zero data in our backend</h3>
              <p>
                Snapshots live in <b>your</b> private git repo. The dashboard
                aggregates client-side using the viewer&rsquo;s own GitHub token.
                If we get breached, there&rsquo;s nothing of yours to leak &mdash;
                the only thing we run is a stateless login broker that stores
                nothing.
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>Per-project opt-in, default-deny</h3>
              <p>
                Nothing is collected until a dev binds a specific repo to the team.
                Personal projects and other clients&rsquo; code are invisible
                &mdash; not filtered out, <em>never sent</em>. Repo identity is
                pinned, so a fork or rename can&rsquo;t leak the wrong one.
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>Aggregate, not surveillance</h3>
              <p>
                Boards are team-level: adoption trend, skill adoption, spend,
                workflows. Devs can contribute anonymously and withhold cost. This
                is coaching and ROI, not a keystroke logger &mdash; which is what
                makes devs actually leave it on.
              </p>
            </div>
          </div>
        </section>

        {/* ============= what the team sees ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">what the team sees</span>
            <h2>
              Adoption and performance, <em>rolled up</em>.
            </h2>
          </div>
          <div className="pitch-lanes">
            <div className="pitch-lane is-out">
              <h3><span className="dot"></span> adoption &amp; diffusion</h3>
              <ul>
                <li>Active devs, team active-days + <b>sessions trend</b></li>
                <li>Which <b>skills &amp; workflows</b> spread, with run counts</li>
                <li>Cold-start &ldquo;N of M devs contributing&rdquo;</li>
                <li>The common <b>skill arcs</b> your team converges on</li>
              </ul>
            </div>
            <div className="pitch-lane is-local">
              <h3><span className="dot"></span> spend &amp; efficiency</h3>
              <ul>
                <li>Total / median <b>tokens + cost</b>, model mix</li>
                <li><b>Routable spend</b> &mdash; what to move off the default</li>
                <li>Verification share + <b>tool-failure rate</b></li>
                <li>Team-wide, never per-person behavior</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ============= how it works ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">how it works</span>
            <h2>
              Setup is <em>minutes</em>. It&rsquo;s just git.
            </h2>
            <p>
              No agents installed on your infra. No transcripts leaving machines.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <h3>1 &middot; A private repo</h3>
              <p>
                Create a private <code>ax-team</code> repo in your GitHub org and
                add your devs. Repo membership <em>is</em> team membership.
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>2 &middot; Each dev opts in</h3>
              <p>
                Inside a client repo: <code>ax team join &lt;org&gt;</code>. A
                consent screen shows exactly what&rsquo;s shared. Personal repos are
                never joined.
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>3 &middot; Open the dashboard</h3>
              <p>
                Log in with GitHub. It reads the repo with your own token and
                renders &mdash; aggregation happens in your browser.
              </p>
            </div>
          </div>
        </section>

        {/* ============= the ask ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">the ask</span>
            <h2>
              We&rsquo;re onboarding a few <em>design partners</em>.
            </h2>
            <p>
              We&rsquo;ve built the local, git-native foundation. The hosted
              dashboard is deliberately gated on a real price signal &mdash; we
              won&rsquo;t build the commercial layer speculatively. We&rsquo;re
              looking for a small number of teams who will tell us this is worth
              paying for, and pilot the per-project opt-in with a real team.
            </p>
          </div>
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
          <h2>Visibility without the data-grab.</h2>
          <p>
            Book a walkthrough on your own local ax data today &mdash; then decide
            if the team layer is worth piloting.
          </p>
          <div className="cta-row">
            <a className="prompt-pill is-solo" href={BOOK_URL}>
              <span className="prompt-pill__label">Book a walkthrough</span>
            </a>
            <a
              className="cta-secondary"
              href={CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Talk to us on GitHub
            </a>
          </div>
          <div className="cta-row">
            <Link to="/teams" className="cta-secondary">
              The manager angle
            </Link>
            <Link to="/registry" className="cta-secondary">
              The skills-mesh angle
            </Link>
          </div>
        </section>

        <FooterCards />
      </main>
      <SiteFooter />
    </>
  );
}
