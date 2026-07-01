import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { FooterCards } from "~/components/landing-v2";
import { HeroLogoField } from "~/components/landing-v2/supports-strip";
import "../styles/pitch.css";

const CONTACT_URL = "https://github.com/Necmttn/ax/discussions";

export const Route = createFileRoute("/registry")({
  head: () => ({
    meta: [
      { title: "ax registry - ship curated skills, get fixes back" },
      {
        name: "description",
        content:
          "Authored by your engineers, used by everyone, never polluted. Governed skill sync to your whole team - and their agents send back PII-redacted fixes you review.",
      },
    ],
  }),
  component: Registry,
});

function PitchSwitch() {
  return (
    <div className="pitch-switch" role="tablist" aria-label="positioning">
      <Link to="/teams">for managers</Link>
      <Link to="/registry" className="is-active">
        for applied-AI teams
      </Link>
    </div>
  );
}

function Registry() {
  return (
    <>
      <SiteHeader />
      <main className="landing-v2">
        {/* ============= hero ============= */}
        <section className="hero">
          <HeroLogoField />
          <span className="eyebrow">
            ax for teams: governed skills &middot; early access
          </span>
          <span className="reg-badge">building with design partners</span>
          <h1>
            Ship curated skills<br />
            to your <em>whole team</em>.
          </h1>
          <p className="hero-human">
            Authored by your engineers. Used by everyone. Never polluted.
          </p>
          <p className="lede">
            The vision: a few engineers build the skills; a lot of people use
            them. ax <em>will</em> sync your blessed skills down to every laptop,
            read-only &mdash; and when a consumer&rsquo;s agent hits an edge case,
            send a fix back upstream for you to review. We&rsquo;re building this
            with a handful of design partners. Skills install, the local improve
            loop, and profile publishing all work today.
          </p>

          <div className="install-wrap">
            <span className="install-label">git &amp; npm stay your pipe &mdash; ax adds the brain</span>
            <div className="cta-row">
              <a
                className="prompt-pill is-solo"
                href={CONTACT_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="prompt-pill__label">Talk to us on GitHub</span>
              </a>
              <a className="cta-secondary" href="#loop">
                <span className="cta-secondary__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M20 11a8 8 0 1 0-2.3 5.6M20 5v6h-6"
                    />
                  </svg>
                </span>
                See the loop
              </a>
            </div>
            <PitchSwitch />
          </div>
        </section>

        {/* ============= who it's for ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">built for arming non-engineers</span>
            <h2>
              When your <em>experts</em> aren&rsquo;t the ones who write the skills.
            </h2>
            <p>
              Lawyers, analysts, consultants &mdash; expensive professionals
              running agents your team built. git is the wrong altitude for them,
              and right now you&rsquo;re hand-rolling repo locks to keep them from
              breaking it.
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
              <h3>Curated, always current</h3>
              <p>
                Consumers receive the blessed set, synced read-only. No stale
                copies, no &ldquo;which version are you on?&rdquo; &mdash; and
                nothing they can accidentally clobber.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l8 4v5c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V7z" />
                  <path d="M9.2 12.2l1.9 1.9 3.7-3.8" />
                </svg>
              </span>
              <h3>Can&rsquo;t be polluted</h3>
              <p>
                No more locking the repo by hand. Consumers don&rsquo;t push
                &mdash; their agents <b>propose</b>, your engineers approve. The
                gate does the governing.
              </p>
            </div>
            <div className="pitch-fcard">
              <span className="ic" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
                </svg>
              </span>
              <h3>Fixes flow back</h3>
              <p>
                Every real-world failure becomes a ranked suggestion &mdash; so
                the skill your whole team relies on gets better from the way they
                actually use it.
              </p>
            </div>
          </div>
        </section>

        {/* ============= today vs building ============= */}
        <section className="pitch-section" id="status">
          <div className="pitch-head">
            <span className="eyebrow">where this is</span>
            <h2>
              What works today vs what we&rsquo;re <em>building with partners</em>.
            </h2>
            <p>
              Honest about the line: the local half of this loop is shipped. The
              sync fabric that turns it into a team registry is the design-partner
              work.
            </p>
          </div>
          <div className="pitch-lanes">
            <div className="pitch-lane is-out">
              <h3><span className="dot"></span> works today</h3>
              <ul>
                <li><b>Skills install</b> <span className="dim">(npx skills add Necmttn/ax)</span></li>
                <li><b>Local improve loop</b> <span className="dim">(mine mistakes → reviewed fix)</span></li>
                <li><b>Profile publishing</b> <span className="dim">(ax profile publish → gist, consent-gated)</span></li>
                <li><b>Hooks SDK</b> <span className="dim">(typed Effect hooks, Claude Code + Codex)</span></li>
              </ul>
            </div>
            <div className="pitch-lane is-local">
              <h3><span className="dot"></span> building with design partners</h3>
              <ul>
                <li><b>Sync-down</b> <span className="dim">(blessed skills read-only on every laptop)</span></li>
                <li><b>Suggest-up</b> <span className="dim">(agents propose fixes upstream)</span></li>
                <li><b>Review queue</b> <span className="dim">(ranked by real usage)</span></li>
                <li><b>Regulated mode</b> <span className="dim">(consent gate, provenance, fail-closed)</span></li>
              </ul>
            </div>
          </div>

          {/* ----- one receipt-style preview artifact ----- */}
          <div className="reg-preview" role="img" aria-label="suggestion review queue preview">
            <div className="reg-preview__bar">
              <span className="reg-preview__eyebrow">$ ax suggestions review</span>
              <span className="reg-preview__tag">PREVIEW &middot; in development</span>
            </div>
            <div className="reg-preview__card">
              <div className="reg-preview__head">
                <span className="reg-preview__skill">contract-redline</span>
                <span className="reg-preview__rank">rank 1 / 6</span>
              </div>
              <p className="reg-preview__title">
                Fix flowed back: clause-numbering edge case
              </p>
              <dl className="reg-preview__stats">
                <div>
                  <dt>seats hit</dt>
                  <dd>9</dd>
                </div>
                <div>
                  <dt>failures, 14d</dt>
                  <dd>23</dd>
                </div>
                <div>
                  <dt>repro</dt>
                  <dd>synthetic, PII-free</dd>
                </div>
                <div>
                  <dt>matter</dt>
                  <dd className="reg-preview__never">never sent</dd>
                </div>
              </dl>
              <div className="reg-preview__actions">
                <span className="reg-preview__accept">accept &amp; re-sync</span>
                <span className="reg-preview__reject">reject</span>
              </div>
            </div>
            <p className="reg-preview__note">
              Mock of the review queue we&rsquo;re building. Numbers illustrative.
            </p>
          </div>
        </section>

        {/* ============= the loop ============= */}
        <section className="pitch-section" id="loop">
          <div className="pitch-head">
            <span className="eyebrow">the loop</span>
            <h2>
              One clean repo, made smart by <em>how it&rsquo;s used</em>.
            </h2>
            <p>
              git versions the bytes. ax knows why each change happened and whether
              it worked &mdash; and ranks the noise so your authors only see what
              matters.
            </p>
          </div>
          <div className="pitch-loop">
            <div className="pitch-step">
              <span className="n">01</span>
              <h4>Author</h4>
              <p>Engineers write &amp; bless skills in the repo you already use.</p>
            </div>
            <div className="pitch-step">
              <span className="n">02</span>
              <h4>Sync down</h4>
              <p>ax <em>will</em> land blessed skills read-only on every consumer&rsquo;s laptop, current.</p>
            </div>
            <div className="pitch-step">
              <span className="n">03</span>
              <h4>Use</h4>
              <p>A consumer&rsquo;s agent runs the skill and hits a real edge case.</p>
            </div>
            <div className="pitch-step">
              <span className="n">04</span>
              <h4>Suggest up</h4>
              <p>The agent <em>will</em> send back a PII-redacted repro test &mdash; the failure, not the matter.</p>
            </div>
            <div className="pitch-step">
              <span className="n">05</span>
              <h4>Review</h4>
              <p>ax <em>will</em> rank suggestions by real usage; your engineer accepts, it re-syncs.</p>
            </div>
          </div>
        </section>

        {/* ============= privacy by construction ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">privacy by construction</span>
            <h2>
              The fix travels. The <em>matter</em> never does.
            </h2>
            <p>
              The thing that makes a suggestion useful is the sensitive context
              &mdash; privileged, for a law firm. So the local agent becomes the
              proxy: it ships a synthetic, runnable repro test, never the real
              input.
            </p>
          </div>
          <div className="pitch-lanes">
            <div className="pitch-lane is-out">
              <h3><span className="dot"></span> light mode &middot; default</h3>
              <ul>
                <li>Best-effort redaction, <b>auto-share</b></li>
                <li>Failure-shape + <b>synthetic repro test</b></li>
                <li>Frictionless for non-regulated teams</li>
                <li>A regression suite, built from real use</li>
              </ul>
            </div>
            <div className="pitch-lane is-local">
              <h3><span className="dot"></span> regulated mode</h3>
              <ul>
                <li>Adversarial <b>recover-pass</b> &mdash; fail closed</li>
                <li>Local <b>consent gate</b> before anything leaves</li>
                <li><b>Provenance</b> stamp &mdash; auditable, revocable</li>
                <li>Built for privilege, PII and compliance</li>
              </ul>
            </div>
          </div>
          <p className="demo-caption">
            <b>The registry is your git repo.</b> Blessed skills live in a folder
            you own and version &mdash; ax adds governed sync and trust-gating on
            top, and stores <b>zero company data</b> of its own. A breach of ours
            has nothing of yours to leak.
          </p>
          <p className="demo-caption">
            <b>Per-repo, opt-in, default-deny.</b> A skill lands on a laptop only
            after <code>ax team sync</code> &mdash; and anything executable only
            after an explicit <code>ax team trust</code> review. Never silently,
            never machine-wide; personal projects are untouched.
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
              on the team. Governed skill sync, trust-gating and the upstream-fix
              loop, priced as an add-on to the agent stack you already run. Founder
              pricing is locked for design partners.
            </p>
          </div>
          <div className="ministats">
            <div className="mini">
              <div className="mini-label">Per seat</div>
              <div className="mini-value"><span className="unit">$</span>12<span className="unit">/mo</span></div>
              <div className="mini-sub">a seat = a dev on the team</div>
            </div>
            <div className="mini">
              <div className="mini-label">10-dev team</div>
              <div className="mini-value"><span className="unit">$</span>120<span className="unit">/mo</span></div>
              <div className="mini-sub">one blessed skill pays for it</div>
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
            You&rsquo;re paying for governed distribution and the fix loop &mdash;
            never for a place to warehouse your code. Your skills and telemetry
            stay in <b>your</b> git repo; we store none of it.
          </p>
        </section>

        {/* ============= closing CTA ============= */}
        <section className="pitch-cta">
          <h2>Arm your whole team. Keep the repo clean.</h2>
          <p>
            We&rsquo;re onboarding a handful of applied-AI teams as design
            partners. If you ship skills to people who aren&rsquo;t engineers,
            let&rsquo;s talk.
          </p>
          <div className="cta-row">
            <a
              className="prompt-pill is-solo"
              href={CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="prompt-pill__label">Talk to us on GitHub</span>
            </a>
            <Link to="/teams" className="cta-secondary">
              See the manager angle
            </Link>
            <Link to="/design-partners" className="cta-secondary">
              Read the full pitch
            </Link>
          </div>
        </section>

        <FooterCards />
      </main>
      <SiteFooter />
    </>
  );
}
