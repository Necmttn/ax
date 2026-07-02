import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { FooterCards } from "~/components/landing-v2";
import { HeroLogoField } from "~/components/landing-v2/supports-strip";
import "../styles/pitch.css";

const BOOK_URL = "https://cal.com/necmttn/30min";
const CONTACT_URL = "https://github.com/Necmttn/ax/discussions";

export const Route = createFileRoute("/teams")({
  head: () => ({
    meta: [
      { title: "ax for teams - AI visibility without the data-grab" },
      {
        name: "description",
        content:
          "See how AI works across your team without your data leaving your cloud. Telemetry lives in a git repo you own; spread what works to every laptop.",
      },
    ],
  }),
  component: Teams,
});

/* ---- wide architecture diagram: where your telemetry actually lives ---- */
function ArchitectureDiagram() {
  return (
    <figure className="dp-arch">
      <svg
        viewBox="0 0 1120 400"
        className="dp-arch__svg"
        role="img"
        aria-label="Data-flow: your laptops write redacted aggregates to your own private git repo; your browser reads them with your GitHub token; ax runs only a stateless auth broker that stores nothing. Code, prompts and transcripts hit a consent gate and never leave your machine."
      >
        <defs>
          <marker
            id="dp-ah-green"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="var(--green)" />
          </marker>
          <marker
            id="dp-ah-blue"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="var(--blue)" />
          </marker>
          <marker
            id="dp-ah-red"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="var(--red)" />
          </marker>
          <marker
            id="dp-ah-muted"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="var(--soft)" />
          </marker>
        </defs>

        {/* ---- zone 1: your laptops ---- */}
        <g className="dp-arch__zone">
          <rect x="20" y="128" width="248" height="150" rx="10" />
          <text className="dp-arch__kick" x="40" y="156">
            YOUR LAPTOPS
          </text>
          <text className="dp-arch__title" x="40" y="184">
            Claude Code · Codex · Cursor
          </text>
          <text className="dp-arch__code" x="40" y="212">
            ~/.claude · local ax
          </text>
          <text className="dp-arch__note" x="40" y="238">
            transcripts parsed on disk,
          </text>
          <text className="dp-arch__note" x="40" y="256">
            collapsed to daily counts
          </text>
        </g>

        {/* ---- zone 2: your private git repo (the database) ---- */}
        <g className="dp-arch__zone dp-arch__zone--db">
          <rect x="368" y="128" width="248" height="150" rx="10" />
          <text className="dp-arch__kick dp-arch__kick--db" x="388" y="156">
            YOUR PRIVATE GIT REPO
          </text>
          <text className="dp-arch__title" x="388" y="184">
            .ax-team/&lt;login&gt;.json
          </text>
          <text className="dp-arch__code" x="388" y="212">
            one file per dev · redacted
          </text>
          <text className="dp-arch__note" x="388" y="238">
            counts, sums, ratios only.
          </text>
          <text className="dp-arch__badge" x="388" y="262">
            THE DATABASE
          </text>
        </g>

        {/* ---- zone 3: your browser ---- */}
        <g className="dp-arch__zone">
          <rect x="716" y="128" width="248" height="150" rx="10" />
          <text className="dp-arch__kick" x="736" y="156">
            YOUR BROWSER
          </text>
          <text className="dp-arch__title" x="736" y="184">
            the dashboard
          </text>
          <text className="dp-arch__code" x="736" y="212">
            aggregates client-side
          </text>
          <text className="dp-arch__note" x="736" y="238">
            renders with the viewer&rsquo;s
          </text>
          <text className="dp-arch__note" x="736" y="256">
            own GitHub token
          </text>
        </g>

        {/* ---- zone 4: ax cloud (near-empty, off to the side) ---- */}
        <g className="dp-arch__cloud">
          <rect x="1000" y="20" width="112" height="82" rx="9" />
          <text className="dp-arch__kick dp-arch__kick--cloud" x="1016" y="44">
            ax CLOUD
          </text>
          <text className="dp-arch__cloudline" x="1016" y="64">
            stateless auth
          </text>
          <text className="dp-arch__cloudline" x="1016" y="78">
            broker
          </text>
          <text className="dp-arch__cloudnil" x="1016" y="94">
            stores nothing
          </text>
        </g>

        {/* ---- main flow arrows ---- */}
        <line
          className="dp-arch__flow dp-arch__flow--green"
          x1="268"
          y1="200"
          x2="360"
          y2="200"
          markerEnd="url(#dp-ah-green)"
        />
        <text className="dp-arch__flowlabel dp-arch__flowlabel--green" x="314" y="190">
          redacted
        </text>
        <text className="dp-arch__flowlabel dp-arch__flowlabel--green" x="314" y="222">
          aggregates
        </text>

        <line
          className="dp-arch__flow dp-arch__flow--blue"
          x1="616"
          y1="200"
          x2="708"
          y2="200"
          markerEnd="url(#dp-ah-blue)"
        />
        <text className="dp-arch__flowlabel dp-arch__flowlabel--blue" x="662" y="190">
          your token
        </text>
        <text className="dp-arch__flowlabel dp-arch__flowlabel--blue" x="662" y="222">
          reads
        </text>

        {/* ---- thin auth-only line to the cloud ---- */}
        <path
          className="dp-arch__auth"
          d="M900 128 L900 70 L996 62"
          markerEnd="url(#dp-ah-muted)"
        />
        <text className="dp-arch__authlabel" x="908" y="98">
          OAuth handshake only
        </text>

        {/* ---- consent gate + bounce-back dead-end ---- */}
        <path
          className="dp-arch__block"
          d="M120 278 L120 336 L300 336"
          markerEnd="url(#dp-ah-red)"
          fill="none"
        />
        <path
          className="dp-arch__block"
          d="M300 360 L172 360 L172 282"
          markerEnd="url(#dp-ah-red)"
          fill="none"
        />
        {/* the gate barrier */}
        <line className="dp-arch__gate" x1="316" y1="322" x2="316" y2="374" />
        <line className="dp-arch__gate" x1="322" y1="322" x2="322" y2="374" />
        <text className="dp-arch__blocklabel" x="128" y="326">
          code · prompts · transcripts
        </text>
        <text className="dp-arch__gatelabel" x="336" y="344">
          consent gate
        </text>
        <text className="dp-arch__gatelabel dp-arch__gatelabel--sub" x="336" y="360">
          default deny · never sent
        </text>
      </svg>
      <figcaption className="dp-arch__cap">
        Your git repo is the source of truth. ax never holds a copy.
      </figcaption>
    </figure>
  );
}

/* ---- team-rollup dashboard mock (instrument dark) ---- */
function RollupMock() {
  return (
    <div
      className="browser browser--instrument dp-rollup"
      role="img"
      aria-label="Team rollup dashboard mock: adoption, opt-in status, routable spend, spreading skills and anonymized seats"
    >
      <div className="browser-bar">
        <div className="browser-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div className="browser-url">ax team &middot; acme-web &middot; 30 days</div>
        <div className="browser-spacer"></div>
      </div>
      <div className="dash">
        <div className="dp-rollup__top">
          <span className="dp-rollup__title">Team rollup</span>
          <span className="dp-mock-tag">MOCK</span>
        </div>

        <div className="dp-rollup__grid">
          {/* adoption trend */}
          <div className="dp-card dp-card--wide">
            <span className="dp-card__label">Adoption, last 30 days</span>
            <div className="dp-card__row">
              <span className="dp-card__big">6 / 6</span>
              <span className="dp-card__unit">seats active</span>
            </div>
            <svg className="dp-spark" viewBox="0 0 220 44" preserveAspectRatio="none" aria-hidden="true">
              <polyline
                points="0,38 30,34 60,30 90,26 120,20 150,17 180,12 220,9"
                fill="none"
              />
            </svg>
            <span className="dp-card__sub">82% team active-days, up from 61%</span>
          </div>

          {/* routable spend */}
          <div className="dp-card">
            <span className="dp-card__label">Routable spend</span>
            <div className="dp-card__row">
              <span className="dp-card__big">$605</span>
              <span className="dp-card__unit">of $2,140/mo</span>
            </div>
            <div className="dp-bar">
              <span className="dp-bar__fill" style={{ width: "28%" }}></span>
            </div>
            <span className="dp-card__sub">routine sub-tasks on the expensive default</span>
          </div>

          {/* workflows ready to spread */}
          <div className="dp-card">
            <span className="dp-card__label">Workflows ready to spread</span>
            <div className="dp-card__row">
              <span className="dp-card__big">3</span>
              <span className="dp-card__unit">above the cohort floor</span>
            </div>
            <span className="dp-card__sub">the workflows your team settles into, seen on 5+ seats</span>
          </div>

          {/* skills spreading */}
          <div className="dp-card">
            <span className="dp-card__label">Skills spreading</span>
            <ul className="dp-list">
              <li>
                <span>effect-kit</span>
                <span className="dp-list__meta">6 seats</span>
              </li>
              <li>
                <span>ship-checklist</span>
                <span className="dp-list__meta">5 seats</span>
              </li>
              <li>
                <span>ax-extract-workflow</span>
                <span className="dp-list__meta">5 seats</span>
              </li>
            </ul>
          </div>

          {/* per-project opt-in */}
          <div className="dp-card">
            <span className="dp-card__label">Per-project opt-in</span>
            <ul className="dp-list">
              <li>
                <span>acme-web</span>
                <span className="dp-tag dp-tag--on">joined</span>
              </li>
              <li>
                <span>acme-billing</span>
                <span className="dp-tag dp-tag--on">joined</span>
              </li>
              <li>
                <span>acme-infra</span>
                <span className="dp-tag dp-tag--off">not joined</span>
              </li>
            </ul>
          </div>

          {/* anonymized seats */}
          <div className="dp-card dp-card--wide">
            <span className="dp-card__label">Seats (anonymized)</span>
            <div className="dp-chips">
              {["eng-01", "eng-02", "eng-03", "eng-04", "eng-05", "eng-06"].map((s) => (
                <span key={s} className="dp-chip">
                  <span className="dp-chip__dot"></span>
                  {s}
                </span>
              ))}
            </div>
            <span className="dp-card__sub">no per-person ranking, no drilldown</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- live demo embed: lazily swaps the static mock for the real studio ----
   SSR/prerender renders <RollupMock /> (SEO + no-JS fallback). On the client,
   once the section approaches the viewport (and we're on a desktop-width
   screen), it swaps in a non-interactive, scaled iframe of the live demo. The
   iframe stays pointer-events:none so the wrapping <a> remains the click target
   and the landing page never scroll-traps. Mobile keeps the static mock. */
const DEMO_URL = "/studio/team?demo";
const LIVE_LOGICAL_WIDTH = 1440;

function LiveDemoEmbed() {
  const embedRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLAnchorElement>(null);
  const [showIframe, setShowIframe] = useState(false);

  // Mount the iframe lazily when the section nears the viewport (desktop only).
  useEffect(() => {
    const isMobile = window.matchMedia?.("(max-width: 719px)").matches ?? false;
    if (isMobile) return;

    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      // No IO support: still upgrade to the live demo on desktop.
      setShowIframe(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShowIframe(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Keep the desktop-logical iframe scaled to fit the container width.
  useEffect(() => {
    if (!showIframe) return;
    const embed = embedRef.current;
    if (!embed) return;

    const apply = () => {
      const w = embed.clientWidth;
      if (w > 0) {
        embed.style.setProperty("--dp-scale", String(w / LIVE_LOGICAL_WIDTH));
      }
    };
    apply();

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(embed);
    return () => ro.disconnect();
  }, [showIframe]);

  return (
    <a
      ref={rootRef}
      className="dp-rollup-link"
      href={DEMO_URL}
      target="_blank"
      rel="noopener"
      aria-label="Open the ax team rollup live demo in a new tab"
    >
      {showIframe ? (
        <div
          className="browser browser--instrument dp-rollup dp-rollup--live"
          role="img"
          aria-label="ax team rollup live demo, running on sample data"
        >
          <div className="browser-bar">
            <div className="browser-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <div className="browser-url">ax studio &middot; live demo</div>
            <div className="browser-spacer"></div>
          </div>
          <div className="dp-embed" ref={embedRef}>
            <iframe
              className="dp-embed__frame"
              src={DEMO_URL}
              title="ax team rollup live demo"
              loading="lazy"
              tabIndex={-1}
            />
          </div>
        </div>
      ) : (
        <RollupMock />
      )}
      <span className="dp-rollup-cta" aria-hidden="true">
        open the live demo &rarr;
      </span>
    </a>
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
          <span className="reg-badge">ax for teams &middot; founding cohort &middot; 4 of 5 spots open</span>
          <h1>
            Know if <em>AI</em> is working<br />
            across your team.
          </h1>
          <p className="lede">
            Adoption, spend and effectiveness, read straight from a private git
            repo you own. Your data never touches our cloud.
          </p>

          <div className="install-wrap">
            <span className="dp-status">
              <span className="dp-status__chip">
                <b>Live today:</b> per-seat receipts
              </span>
              <span className="dp-status__chip">
                <b>With the cohort:</b> the team rollup
              </span>
            </span>
            <div className="cta-row">
              <a className="prompt-pill is-solo" href={BOOK_URL}>
                <span className="prompt-pill__label">Claim a founding spot</span>
              </a>
              <a className="cta-secondary" href="#see-it">
                See it on your own data first
              </a>
            </div>
          </div>
        </section>

        {/* ============= the rollup mock ============= */}
        <section className="pitch-section" id="see-it">
          <div className="pitch-head">
            <span className="eyebrow">what the team rollup shows</span>
            <h2>
              Adoption, spend and effectiveness, <em>rolled up</em>.
            </h2>
            <p>
              Every number is a team-level aggregate. There is no per-person
              leaderboard and no way to drill into one dev &mdash; the
              what-works detail stays on each seat, below.
            </p>
          </div>

          <LiveDemoEmbed />

          <p className="demo-caption">
            This is the live <code>ax studio</code> team rollup embedded on
            sample data &mdash; the same dashboard your cohort gets, not a
            screenshot. The per-seat surface already renders these numbers for
            one dev today.
          </p>

          <div className="cta-row">
            <a className="cta-secondary" href="/studio/team?demo">
              Prefer to click around? Open the live demo &rarr;
            </a>
          </div>
        </section>

        {/* ============= per-seat insight: what works, not just how much ============= */}
        <section className="pitch-section dp-alt" id="what-works">
          <div className="pitch-head">
            <span className="eyebrow">beyond the aggregates</span>
            <h2>
              It still tells you <em>what works</em> &mdash; on every seat.
            </h2>
            <p>
              The rollup rides on the same engine every dev already runs
              locally. The full-detail answers never leave the laptop; the team
              layer only reports whether the wins spread.
            </p>
          </div>

          <div
            className="pitch-triad"
            role="img"
            aria-label="Three per-seat receipts from a dev's local studio: prompts and skills that pay off, where the agent churns, and which sub-tasks overpay"
          >
            <div className="dp-card">
              <span className="dp-card__label">
                Prompts &amp; skills that pay off
              </span>
              <ul className="dp-list">
                <li>
                  <span>effect-kit</span>
                  <span className="dp-list__meta">&times;41 &middot; 92% landed</span>
                </li>
                <li>
                  <span>ship-checklist</span>
                  <span className="dp-list__meta">&times;28 &middot; 88% landed</span>
                </li>
                <li>
                  <span>&ldquo;plan, then edit&rdquo;</span>
                  <span className="dp-list__meta">2.1&times; lift</span>
                </li>
              </ul>
              <span className="dp-card__sub">
                ax skills weighted &middot; ax directives mine
              </span>
            </div>
            <div className="dp-card">
              <span className="dp-card__label">Where the agent churns</span>
              <div className="dp-card__row">
                <span className="dp-card__big">7</span>
                <span className="dp-card__unit">repair episodes, 30d</span>
              </div>
              <div className="dp-bar">
                <span className="dp-bar__fill" style={{ width: "34%" }}></span>
              </div>
              <span className="dp-card__sub">
                edit-repair loops, failed checks &middot; ax sessions churn
              </span>
            </div>
            <div className="dp-card">
              <span className="dp-card__label">What overpays</span>
              <div className="dp-card__row">
                <span className="dp-card__big">$605</span>
                <span className="dp-card__unit">routable of $2,140</span>
              </div>
              <div className="dp-bar">
                <span className="dp-bar__fill" style={{ width: "28%" }}></span>
              </div>
              <span className="dp-card__sub">
                routine sub-tasks on the frontier default &middot; ax cost
                routability
              </span>
            </div>
          </div>

          <p className="demo-caption">
            Each dev&rsquo;s local studio renders these live today &mdash;
            numbers here illustrative. The rollup above is the same answers,
            aggregated across seats.
          </p>
        </section>

        {/* ============= spread what works (skill mesh) ============= */}
        <section className="pitch-section" id="mesh">
          <div className="pitch-head">
            <span className="eyebrow">spread what works</span>
            <h2>
              Author once, <em>runs on every laptop</em>.
            </h2>
            <p>
              The mechanism that turns one engineer&rsquo;s trick into team
              practice already ships: commit a skill or a typed Effect hook and
              everyone&rsquo;s agent runs it; the improve loop mines repeated
              mistakes into reviewed fixes; public profiles and <code>/leaders</code>{" "}
              already prove an aggregates-only rollup works. The governed team
              registry on top is what we build with the founding cohort.
            </p>
          </div>

          <div className="pitch-lanes">
            <div className="pitch-lane is-out">
              <h3>
                <span className="dot"></span> ships today
              </h3>
              <ul>
                <li>
                  Skills &amp; hooks SDK{" "}
                  <span className="dim">(commit once, every agent runs it)</span>
                </li>
                <li>
                  The improve loop{" "}
                  <span className="dim">(repeated mistakes into a reviewed fix)</span>
                </li>
                <li>
                  Public profiles &amp; <code>/leaders</code>{" "}
                  <span className="dim">(aggregates only, no code sent)</span>
                </li>
              </ul>
            </div>
            <div className="pitch-lane is-local">
              <h3>
                <span className="dot"></span> building with the cohort
              </h3>
              <ul>
                <li>
                  Sync down{" "}
                  <span className="dim">(blessed skills read-only on every laptop)</span>
                </li>
                <li>
                  Suggest up{" "}
                  <span className="dim">(agents send a PII-redacted repro upstream)</span>
                </li>
                <li>
                  Review queue{" "}
                  <span className="dim">(ranked by real usage; your engineers approve)</span>
                </li>
              </ul>
            </div>
          </div>

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
              Mock of the review queue we are building. Numbers illustrative.
            </p>
          </div>

          <p className="demo-caption">
            Consumers&rsquo; agents propose; your engineers approve. Regulated
            mode adds an adversarial recover-pass, a local consent gate and a
            revocable provenance stamp before anything leaves. Built for
            privilege, PII and compliance.
          </p>
        </section>

        {/* ============= zero-data (the differentiator) ============= */}
        <section className="pitch-section dp-alt" id="zero-data">
          <div className="pitch-head">
            <span className="eyebrow">where your data lives</span>
            <h2>
              The dashboard our servers <em>never see</em>.
            </h2>
            <p>
              ax&rsquo;s servers never receive or store your telemetry,
              transcripts, source, prompts, or derived rows. The frontend reads
              your data with the viewer&rsquo;s own GitHub token. The only service
              we run is a stateless auth broker.
            </p>
          </div>

          <ArchitectureDiagram />

          <div className="dp-claims">
            <div className="dp-claim">
              <span className="dp-claim__k">the database is your repo</span>
              <p>
                Aggregates land in a private repo in your own GitHub org, one
                redacted file per dev. GitHub repo membership is team access.
              </p>
            </div>
            <div className="dp-claim">
              <span className="dp-claim__k">the browser does the math</span>
              <p>
                The dashboard aggregates client-side using the viewer&rsquo;s own
                token. If we get breached, there is nothing of yours to leak.
              </p>
            </div>
            <div className="dp-claim">
              <span className="dp-claim__k">opt-in, default deny</span>
              <p>
                Nothing pushes until a dev runs <code>ax team join</code> inside a
                specific repo. Repo identity is pinned, so a fork or rename
                can&rsquo;t leak the wrong one.
              </p>
            </div>
          </div>
        </section>

        {/* ============= sample payload ============= */}
        <section className="pitch-section" id="payload">
          <div className="pitch-head">
            <span className="eyebrow">what actually leaves a laptop</span>
            <h2>
              The <em>entire file</em> that ships.
            </h2>
            <p>
              Names, not contents. No transcripts, no code, no prompts, no paths.
              Daily-collapsed counts, sums and ratios.
            </p>
          </div>

          <div className="dp-payload">
            <div className="dp-payload__bar">
              <span className="dp-payload__path">.ax-team/necmttn.json</span>
              <span className="dp-payload__tag">redacted &middot; aggregates only</span>
            </div>
            <pre className="dp-payload__body">{`{
  "login": "necmttn",
  "window": "2026-06-01/2026-06-30",
  "sessions": 214,
  "active_days": 22,
  "tokens": { "in": 4120000, "out": 385000 },
  "routable_usd": 605,
  "spend_usd": 2140,
  "top_skills": ["effect-kit", "ship-checklist", "ax-extract-workflow"],
  "churn_episodes": 7
}`}</pre>
            <p className="dp-payload__note">
              This is the whole file that leaves. Names, not contents.
            </p>
          </div>
        </section>

        {/* ============= privacy rules (k-anonymity) ============= */}
        <section className="pitch-section dp-alt" id="privacy">
          <div className="pitch-head">
            <span className="eyebrow">the privacy rules</span>
            <h2>
              Aggregate, <em>never</em> surveillance.
            </h2>
          </div>
          <div className="dp-kanon">
            <span className="dp-kanon__mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4.5" y="10.5" width="15" height="9" rx="1.5" />
                <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
              </svg>
            </span>
            <p className="dp-kanon__text">
              Team cells with fewer than <b>5</b> contributors are hidden. No
              individual drilldown. No per-person leaderboard.
            </p>
          </div>
        </section>

        {/* ============= how it works ============= */}
        <section className="pitch-section">
          <div className="pitch-head">
            <span className="eyebrow">how it works</span>
            <h2>
              Setup is <em>minutes</em>. It is just git.
            </h2>
            <p>
              No agents on your infra. No transcripts leaving machines.
            </p>
          </div>
          <div className="pitch-triad">
            <div className="pitch-fcard">
              <h3>1 &middot; A private repo</h3>
              <p>
                Create a private <code>ax-team</code> repo in your GitHub org and
                add your devs. Repo membership is team membership.
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>2 &middot; Each dev opts in</h3>
              <p>
                Inside a work repo: <code>ax team join &lt;org&gt;</code>. A consent
                screen shows exactly what is shared. Personal repos are never
                joined.
              </p>
            </div>
            <div className="pitch-fcard">
              <h3>3 &middot; Open the dashboard</h3>
              <p>
                Log in with GitHub. It reads the repo with your own token and
                renders. Aggregation happens in your browser.
              </p>
            </div>
          </div>
        </section>

        {/* ============= security FAQ ============= */}
        <section className="pitch-section dp-alt" id="security">
          <div className="pitch-head">
            <span className="eyebrow">security, plainly</span>
            <h2>
              The questions your <em>security team</em> asks.
            </h2>
          </div>
          <div className="dp-faq">
            <details className="dp-faq__item">
              <summary>Where does the data live?</summary>
              <p>
                In a private git repo in your own GitHub org. One redacted file
                per dev. We keep no copy.
              </p>
            </details>
            <details className="dp-faq__item">
              <summary>Who can read it?</summary>
              <p>
                Members of that repo, using their own GitHub token in the browser.
                Repo membership is the only access control.
              </p>
            </details>
            <details className="dp-faq__item">
              <summary>What actually leaves a machine?</summary>
              <p>
                Only the redacted aggregate file shown above. No transcripts,
                code, prompts or paths.
              </p>
            </details>
            <details className="dp-faq__item">
              <summary>What if a dev leaves or a token leaks?</summary>
              <p>
                Remove them from the repo and access ends. A leaked token exposes
                only aggregate counts, never source or transcripts.
              </p>
            </details>
            <details className="dp-faq__item">
              <summary>GDPR and deletion?</summary>
              <p>
                Delete the dev&rsquo;s file from the repo. That removes their data
                everywhere, because the repo is the only store.
              </p>
            </details>
            <details className="dp-faq__item">
              <summary>Self-host or exit?</summary>
              <p>
                ax is AGPL-3.0. The data is already yours in git, so there is
                nothing to export and no lock-in.
              </p>
            </details>
          </div>
        </section>

        {/* ============= founding cohort (scarcity) ============= */}
        <section className="pitch-section" id="cohort">
          <div className="pitch-head">
            <span className="eyebrow">the founding cohort</span>
            <h2>
              Five teams, then we <em>close it</em>.
            </h2>
            <p>
              The rollup is real work built around real repos. We can hand-onboard
              and hold a weekly founder call for five teams this quarter, no more.
            </p>
          </div>

          <div className="dp-scarcity">
            <div className="dp-scarcity__meter" role="img" aria-label="1 of 5 founding seats claimed">
              <span className="dp-seat is-filled"></span>
              <span className="dp-seat"></span>
              <span className="dp-seat"></span>
              <span className="dp-seat"></span>
              <span className="dp-seat"></span>
            </div>
            <p className="dp-scarcity__count">1 claimed &middot; 4 open</p>
            <ul className="dp-scarcity__list">
              <li>
                <b>$20/seat locked.</b> Founding price holds as the product grows.
              </li>
              <li>
                <b>Direct founder line.</b> Onboarding by hand, weekly call.
              </li>
              <li>
                <b>Shape the roadmap.</b> We build the rollup around your repos.
              </li>
            </ul>
            <div className="cta-row">
              <a className="prompt-pill is-solo" href={BOOK_URL}>
                <span className="prompt-pill__label">Claim a founding spot</span>
              </a>
            </div>
          </div>
        </section>

        {/* ============= pricing ============= */}
        <section className="pitch-section dp-alt" id="pricing">
          <div className="pitch-head">
            <span className="eyebrow">founding pricing</span>
            <h2>
              <em>$20</em> per developer, per month.
            </h2>
            <p>
              Per-seat, self-serve, cancel anytime. A seat is a dev who pushes.
              It rides as a small add-on to the agent subscriptions you already
              pay for, and pays for itself the moment it redirects one routine
              sub-task off the expensive default.
            </p>
          </div>
          <div className="ministats">
            <div className="mini">
              <div className="mini-label">Per seat</div>
              <div className="mini-value">
                <span className="unit">$</span>20<span className="unit">/mo</span>
              </div>
              <div className="mini-sub">a seat = a dev who <b>pushes</b></div>
            </div>
            <div className="mini">
              <div className="mini-label">10-dev team</div>
              <div className="mini-value">
                <span className="unit">$</span>200<span className="unit">/mo</span>
              </div>
              <div className="mini-sub">less than one redirected task</div>
            </div>
            <div className="mini">
              <div className="mini-label">50-dev team</div>
              <div className="mini-value">
                <span className="unit">$</span>1,000<span className="unit">/mo</span>
              </div>
              <div className="mini-sub">scales per seat, prorated</div>
            </div>
            <div className="mini">
              <div className="mini-label">Cancel</div>
              <div className="mini-value">anytime</div>
              <div className="mini-sub">self-serve, via Stripe</div>
            </div>
          </div>
          <p className="demo-caption">
            You pay for the dashboard and the enablement. Your data stays in{" "}
            <b>your</b> git repo; we store none of it.
          </p>
        </section>

        {/* ============= closing CTA ============= */}
        <section className="pitch-cta">
          <h2>Visibility without the data-grab.</h2>
          <p>
            See it on your own local ax data today, then decide if the team layer
            is worth piloting.
          </p>
          <div className="cta-row">
            <a className="prompt-pill is-solo" href={BOOK_URL}>
              <span className="prompt-pill__label">Claim a founding spot</span>
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
        </section>

        <FooterCards />
      </main>
      <SiteFooter />
    </>
  );
}
