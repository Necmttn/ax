import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { FooterCards } from "~/components/landing-v2";
import { HeroLogoField } from "~/components/landing-v2/supports-strip";
import "../styles/pitch.css";

const MAILTO =
  "mailto:necmettin.karakaya@gmail.com?subject=ax%20registry%20-%20early%20access";

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
          <span className="eyebrow">ax skill registry</span>
          <h1>
            Ship curated skills<br />
            to your <em>whole team</em>.
          </h1>
          <p className="hero-human">
            Authored by your engineers. Used by everyone. Never polluted.
          </p>
          <p className="lede">
            A few engineers build the skills; a lot of people use them. ax syncs
            your blessed skills down to every laptop, read-only &mdash; and when a
            consumer&rsquo;s agent hits an edge case, it sends a fix back upstream
            for you to review. The repo stays clean without locking anyone out.
          </p>

          <div className="install-wrap">
            <span className="install-label">git &amp; npm stay your pipe &mdash; ax adds the brain</span>
            <div className="cta-row">
              <a className="prompt-pill is-solo" href={MAILTO}>
                <span className="prompt-pill__label">Request early access</span>
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
              <p>Blessed skills land read-only on every consumer&rsquo;s laptop, current.</p>
            </div>
            <div className="pitch-step">
              <span className="n">03</span>
              <h4>Use</h4>
              <p>A consumer&rsquo;s agent runs the skill and hits a real edge case.</p>
            </div>
            <div className="pitch-step">
              <span className="n">04</span>
              <h4>Suggest up</h4>
              <p>The agent sends back a PII-redacted repro test &mdash; the failure, not the matter.</p>
            </div>
            <div className="pitch-step">
              <span className="n">05</span>
              <h4>Review</h4>
              <p>ax ranks suggestions by real usage; your engineer accepts, it re-syncs.</p>
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
            <a className="prompt-pill is-solo" href={MAILTO}>
              <span className="prompt-pill__label">Request early access</span>
            </a>
            <Link to="/teams" className="cta-secondary">
              See the manager angle
            </Link>
          </div>
        </section>

        <FooterCards />
      </main>
      <SiteFooter />
    </>
  );
}
