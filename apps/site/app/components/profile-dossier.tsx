// apps/site/app/components/profile-dossier.tsx
import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useState, type FormEvent } from "react";
import { HeroLogoField } from "~/components/landing-v2/supports-strip";
import { WrappedDeck, type InsightCard, type VizSpec } from "~/components/wrapped-deck";
import { RadarChart, type RadarSeries } from "~/components/radar-chart";
import {
    archetypeFor,
    dominantPair,
    leadTally,
    profileToAxes,
    RADAR_AXES_META,
    type RadarAxes,
} from "~/lib/radar";
import { duelPath, duelXIntent } from "~/lib/challenge";
import {
    type ProfileV1,
    type ProfileDailyRow,
    type ProfileGuardrailHookReceipt,
    type ProfileGuardrailVerdicts,
    type ProfileHighlights,
    type ProfileInsights,
    type ProfileSkill,
} from "@ax/lib/shared/community";
import {
    buildModelColors,
    buildDayColumns,
    buildDisplayArcs,
    sortSkillsByLeverage,
    OTHER_NAME,
    type DayColumn,
} from "~/lib/window-chart";

// mirrors LOGIN_RE in community.ts - GitHub handles only, sanitised before use.
export const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
// series colours: primary profile = ax green, comparison = ax blue.
// Exported so the bespoke duel layout (profile-duel.tsx) tints A green / B blue
// with the exact same tokens the radar series + overlay use.
export const SELF_COLOR = "var(--green)";
export const VS_COLOR = "#2567a8";

// comparison-profile load state, kept separate from the primary dossier so a
// missing/invalid `?vs=` peer degrades to a quiet inline note, never an error
// page for the profile the visitor actually came to see.
export type VsState =
    | { kind: "none" }
    | { kind: "loading"; login: string }
    | { kind: "not-found"; login: string }
    | { kind: "error"; login: string }
    | { kind: "ready"; login: string; profile: ProfileV1 };

/* ---------- formatting (one helper set, everything humanized) ---------- */

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* These formatters + helpers are exported for reuse by the duel layout
   (profile-duel.tsx) so the two pages humanize numbers identically. */
/** 19_600_000_000 -> "19.6B", 13185 -> "13.2K" */
export const fmtCompact = (n: number): string => COMPACT.format(n);
/** 2021 -> "2,021" */
export const fmtInt = (n: number): string => PLAIN.format(Math.round(n));
/** 22900 -> "$22.9K" */
export const fmtMoney = (n: number): string => `$${COMPACT.format(n)}`;
/** 0.078 -> "7.8%" */
export const fmtPct = (share: number): string => {
    const pct = Math.min(100, Math.max(0, share * 100));
    return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
};
/** 1440 -> "24h", 105 -> "1h 45m", 45 -> "45m" */
const fmtDuration = (minutes: number): string => {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
};
/** 3 -> "03:00" */
const fmtHour = (h: number): string => `${String(Math.min(23, Math.max(0, Math.round(h)))).padStart(2, "0")}:00`;
/** "2026-06-10" -> "Jun 10"; anything else falls back to the raw string (safe: text node). */
const fmtDay = (iso: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${month} ${Number(m[3])}` : iso;
};
export const clampPct = (x: number): number => (Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : 0);

function hookReceiptStatus(r: ProfileGuardrailHookReceipt): string {
    if (r.fires === 0) return "no recent fires";
    return r.blocked + r.warned > 0 ? "still earning" : "watching";
}

function hookReceiptText(r: ProfileGuardrailHookReceipt): string {
    const parts = [`fired ${fmtInt(r.fires)}×`];
    if (r.blocked > 0) parts.push(`blocked ${fmtInt(r.blocked)}`);
    if (r.warned > 0) parts.push(`warned ${fmtInt(r.warned)}`);
    if (r.blocked === 0 && r.warned === 0) parts.push("no blocks/warnings");
    parts.push(hookReceiptStatus(r));
    return parts.join(" · ");
}

function verdictSummaryText(v: ProfileGuardrailVerdicts): string {
    const parts = [
        `${fmtInt(v.worked)} worked`,
        `${fmtInt(v.did_not_work)} didn't`,
    ];
    if ((v.partial ?? 0) > 0) parts.push(`${fmtInt(v.partial ?? 0)} partial`);
    parts.push(`${fmtInt(v.no_longer_needed)} no longer needed (resolved or never fired)`);
    return parts.join(" · ");
}

/** Only http/https links are rendered as anchors; anything else renders as text. */
function safeHttpUrl(raw: string): string | null {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch {
        return null;
    }
}

/**
 * The user-authored highlights blocks (their words → secret weapons → learn
 * the rig → shipped). Shared by the single-profile dossier AND the duel page,
 * so both render the "In their words" layer; renders nothing when there are no
 * highlights or every sub-block is empty. The mined `taste.patterns` cards are
 * rendered separately by each caller (they differ per layout).
 */
export function HighlightsBlocks({ highlights }: { highlights?: ProfileHighlights }) {
    if (!highlights) return null;
    return (
        <>
            {highlights.taste && (
                <blockquote className="pf-words">
                    <p>{highlights.taste}</p>
                    <cite>- In their words</cite>
                </blockquote>
            )}

            {highlights.setup && highlights.setup.length > 0 && (
                <div className="pf-weapons">
                    <h3>Secret weapons</h3>
                    <div className="pf-weapons-grid">
                        {highlights.setup.map((s, i) => {
                            const href = s.link ? safeHttpUrl(s.link) : null;
                            // headline (title) + 2-3 sentence summary (what) stay visible;
                            // the rationale (why) + source link reveal on click (native <details>).
                            return (
                                <details className="pf-weapon" key={`${s.title}-${i}`}>
                                    <summary className="pf-weapon-summary">
                                        <span className="pf-weapon-title">{s.title}</span>
                                        <p className="pf-weapon-what">{s.what}</p>
                                        <span className="pf-toggle" aria-hidden="true" />
                                    </summary>
                                    <div className="pf-weapon-detail">
                                        <p className="pf-weapon-why">{s.why}</p>
                                        {href && (
                                            <a className="pf-weapon-link" href={href} target="_blank" rel="noopener nofollow">
                                                source ↗
                                            </a>
                                        )}
                                    </div>
                                </details>
                            );
                        })}
                    </div>
                </div>
            )}

            {highlights.skills && highlights.skills.length > 0 && (
                <div className="pf-learn">
                    <h3>Learn the rig</h3>
                    {/* headline (name + source) stays visible; the summary reveals on click. */}
                    {highlights.skills.map((s, i) => (
                        <details className="pf-learn-row" key={`${s.name}-${i}`}>
                            <summary className="pf-learn-summary">
                                <span className="pf-learn-name">{s.name}</span>
                                <span className="pf-learn-src">{s.source}</span>
                                <span className="pf-toggle" aria-hidden="true" />
                            </summary>
                            <p className="pf-learn-sum">{s.summary}</p>
                        </details>
                    ))}
                </div>
            )}

            {highlights.wins && highlights.wins.length > 0 && (
                <div className="pf-wins">
                    <h3>Shipped</h3>
                    {highlights.wins.map((w, i) => (
                        <div className="pf-win" key={i}>
                            <span className="pf-win-text">✓ {w.text}</span>
                            {w.evidence && <span className="pf-win-ev">{w.evidence}</span>}
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

/** Harness chips show the real harnesses you run - not internal origins. A
 * "claude-subagent" entry is the same harness as "claude" (just a dispatch
 * origin), so strip the "-subagent" suffix and dedupe, preserving order. */
export const realHarnesses = (harnesses: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of harnesses) {
        const base = h.replace(/-subagents?$/i, "");
        if (seen.has(base)) continue;
        seen.add(base);
        out.push(base);
    }
    return out;
};

/** GitHub avatar by login (same source as the leaders page). `ring` tints the
 *  border for comparison overlays; `size` drives layout + the @2x source.
 *  `linked` wraps it in a link to that person's /u/<login> profile. */
export function Avatar({ login, size, ring, className, linked }: {
    login: string;
    size: number;
    ring?: string;
    className?: string;
    linked?: boolean;
}) {
    const img = (
        <img
            className={className ? `pv2-avatar ${className}` : "pv2-avatar"}
            src={`https://github.com/${login}.png?size=${size * 2}`}
            alt=""
            width={size}
            height={size}
            loading="eager"
            style={ring ? { borderColor: ring } : undefined}
        />
    );
    if (!linked) return img;
    return (
        <Link
            className="pv2-avatar-link"
            to="/u/$login"
            params={{ login }}
            search={{ vs: undefined }}
            aria-label={`@${login} profile`}
        >
            {img}
        </Link>
    );
}

/* ---------- the dossier ---------- */

export function ProfileDossier({ profile: p, vs }: { profile: ProfileV1; vs: VsState }) {
    const daily = p.activity && p.activity.daily.length > 0
        ? [...p.activity.daily].sort((a, b) => (a.date < b.date ? -1 : 1))
        : [];
    const ins = p.insights;
    const models = [...p.stats.models].sort((a, b) => b.share - a.share);
    const { colorOf } = buildModelColors(models);
    const arcs = p.workflow ? buildDisplayArcs(p.workflow.arcs, 5) : [];
    const lede = archetypeFor(profileToAxes(p), p).blurb;
    const hookReceipts = new Map((p.guardrail_receipts?.hooks ?? []).map((r) => [r.name, r]));

    return (
        <article className="profile-v2-doc">
            {/* hero - landing-v2 treatment over the profile's live data */}
            <section className="hero">
                <HeroLogoField />
                <span className="eyebrow pv2-eyebrow">
                    <span className="pf-live" title="pulled live from the published gist on load">
                        <span className="pf-live-dot" aria-hidden="true" />live
                    </span>
                    <span aria-hidden="true">·</span>
                    {p.window_days}-day window · compiled {p.generated_at.slice(0, 10)}
                </span>
                <Avatar login={p.github} size={120} className="pv2-avatar--hero" />
                <h1><span className="pf-at">@</span>{p.github}</h1>
                <p className="lede">{lede}</p>
                <span className="pf-harness-list" aria-label="harnesses">
                    {realHarnesses(p.stats.harnesses).map((h) => <span className="pf-harness" key={h}>{h}</span>)}
                </span>
            </section>

            {/* vitals - a stats strip below the headline (kept OUT of .hero so the
                absolute floating-logo field never overlaps the divider rule) */}
            <div className="pv2-vitals" aria-label="vitals">
                <Vital num={fmtInt(p.stats.sessions)} label="sessions" />
                <Vital num={fmtCompact(p.stats.tokens.total)} label="tokens" />
                {p.stats.cost_usd !== undefined && <Vital num={`~${fmtMoney(p.stats.cost_usd)}`} label="est. spend" />}
                {ins && <Vital num={fmtCompact(ins.hours_total)} unit="hrs" label="in the loop" />}
                <Vital num={`${fmtInt(p.stats.active_days)}/${fmtInt(p.window_days)}`} label="days active" />
                <Vital num={`${fmtInt(p.stats.streak_days)}d`} label="streak" />
            </div>

            {/* the window: one stacked-bar chart, model-keyed, with a legend */}
            <section className="pf-section">
                <SectionIntro eyebrow="the window" title="The window" note={`last ${p.window_days} days`} />
                {daily.length > 0 ? (
                    <StackedWindow
                        daily={daily}
                        colorOf={colorOf}
                        busiest={ins?.busiest_day.date}
                        models={models}
                        sessions={p.stats.sessions}
                        windowDays={p.window_days}
                    />
                ) : (
                    <p className="pf-quiet">no daily activity recorded in this window.</p>
                )}
            </section>

            {/* the shape of the work: studio wrapped-card deck */}
            {ins && (
                <section className="pf-section">
                    <SectionIntro eyebrow="wrapped" title="The shape of the work" note="derived from session telemetry" />
                    <WrappedDeck cards={buildInsightCards(ins, daily)} />
                </section>
            )}

            {/* the sign: radar + agent archetype */}
            <SignSection profile={p} vs={vs} />

            {/* the rig: workflow arcs + leverage-sorted skills + guardrails */}
            <section className="pf-section">
                <SectionIntro eyebrow="the rig" title="The rig" note={`${fmtInt(p.rig.skills.length)} skills · ${fmtInt(p.rig.hooks.length)} hooks`} />
                {arcs.length > 0 && (
                    <div className="pf-workflow">
                        <div className="pf-workflow-head">
                            <span className="pf-workflow-title">The workflow</span>
                            <span className="pf-workflow-note">recurring skill sequences mined from session order</span>
                        </div>
                        <div className="pf-arcs">
                            {arcs.map((arc, i) => (
                                <div className="pf-arc" key={i}>
                                    <span className="pf-arc-chain">
                                        {arc.steps.map((step, j) => (
                                            <span className="pf-arc-step-wrap" key={j}>
                                                {j > 0 && <span className="pf-arc-sep" aria-hidden="true">→</span>}
                                                <span className="pf-arc-chip" title={step.full}>{step.display}</span>
                                            </span>
                                        ))}
                                    </span>
                                    <span className="pf-arc-count">×{fmtInt(arc.count)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div className="pf-rig">
                    <div className="pf-rig-skills">
                        {groupSkills(p.rig.skills).map((g) => {
                            const skills = sortSkillsByLeverage(g.skills);
                            return (
                                <div className="pf-rig-group" key={g.source}>
                                    <div className="pf-rig-group-head">
                                        <span>{g.source}</span>
                                        <span>{fmtInt(g.skills.length)} skills · {fmtCompact(g.runs)} runs</span>
                                    </div>
                                    <div className="pf-rig-group-hint">
                                        sorted by downstream share - how much of the session follows the skill, not how often it fires
                                    </div>
                                    {skills.slice(0, 10).map((s) => (
                                        <SkillRow key={s.name} skill={s} />
                                    ))}
                                    {g.skills.length > 10 && (
                                        <div className="pf-rig-more">+ {fmtInt(g.skills.length - 10)} more</div>
                                    )}
                                </div>
                            );
                        })}
                        {p.rig.skills.length === 0 && <p className="pf-quiet">no skills recorded in this window.</p>}
                    </div>
                    <aside className="pf-guardrails">
                        <h3>Guardrails</h3>
                        <p>The deterministic half of the rig - what fires on every tool call, before taste gets a vote.</p>
                        <div className="pf-guard-row">
                            <span>hooks</span>
                            <span className={p.rig.hooks.length > 0 ? "pf-guard-on" : "pf-guard-off"}>
                                {p.rig.hooks.length > 0 ? `${fmtInt(p.rig.hooks.length)} installed` : "none"}
                            </span>
                        </div>
                        {p.rig.hooks.length > 0 && (
                            <div className="pf-hook-list">
                                {p.rig.hooks.map((h) => (
                                    <HookReceiptLine key={h} name={h} receipt={hookReceipts.get(h)} />
                                ))}
                            </div>
                        )}
                        <div className="pf-guard-row">
                            <span>routing table</span>
                            <span className={p.rig.routing_table ? "pf-guard-on" : "pf-guard-off"}>
                                {p.rig.routing_table ? "compiled" : "not compiled"}
                            </span>
                        </div>
                        <div className="pf-guard-row">
                            <span>rules</span>
                            <span className={p.rig.rules && p.rig.rules.count > 0 ? "pf-guard-on" : "pf-guard-off"}>
                                {p.rig.rules ? fmtInt(p.rig.rules.count) : "-"}
                            </span>
                        </div>
                        {p.guardrail_receipts && (
                            <div className="pf-guard-verdicts">
                                <span>verdicts</span>
                                <span>{verdictSummaryText(p.guardrail_receipts.verdicts)}</span>
                            </div>
                        )}
                    </aside>
                </div>
            </section>

            {/* taste: user-authored highlights (their words) + mined patterns */}
            {(p.highlights || (p.taste && p.taste.patterns.length > 0)) && (
                <section className="pf-section">
                    <SectionIntro eyebrow="taste" title="Taste" note="in their words, and what ax keeps seeing" />

                    <HighlightsBlocks highlights={p.highlights} />

                    {p.taste && p.taste.patterns.length > 0 && (
                        <>
                            <div className="pf-taste-divider">patterns ax keeps seeing</div>
                            <div className="pf-taste">
                                {p.taste.patterns.map((t) => (
                                    <div className="pf-pattern" key={`${t.category}/${t.name}`}>
                                        <span className="pf-pattern-cat">{t.category}{t.slot ? ` · ${t.slot}` : ""}</span>
                                        <div className="pf-pattern-name">{t.name}</div>
                                        {t.summary && <p className="pf-pattern-sum">{t.summary}</p>}
                                        <div className="pf-pattern-ev">
                                            {fmtInt(t.evidence.sessions)} sessions · confidence {fmtPct(t.evidence.confidence)}
                                            {t.evidence.trend ? ` · ${t.evidence.trend}` : ""}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </section>
            )}

            {/* CTA: lead-in + landing footer-cards grid */}
            <section className="pf-section pv2-cta" aria-label="get ax">
                <div className="demo-intro">
                    <span className="eyebrow">get ax</span>
                    <h2>This dossier compiled itself.</h2>
                    <p>ax measures your real agent usage locally and publishes only the aggregate &mdash; to a gist you own.</p>
                </div>
                <div className="pv2-cmds">
                    <code className="pv2-cmd">curl -fsSL ax.necmttn.com/install | bash</code>
                    <code className="pv2-cmd">ax profile publish</code>
                </div>
                <div className="cards-grid">
                    <Link className="card" to="/" hash="install">
                        <span className="num">01</span>
                        <span className="card-title">Install ax <span className="arrow">&rarr;</span></span>
                    </Link>
                    <Link className="card" to="/routing">
                        <span className="num">02</span>
                        <span className="card-title">Routing <span className="arrow">&rarr;</span></span>
                    </Link>
                    <Link className="card" to="/leaders">
                        <span className="num">03</span>
                        <span className="card-title">Leaders <span className="arrow">&rarr;</span></span>
                    </Link>
                    <Link className="card" to="/docs">
                        <span className="num">04</span>
                        <span className="card-title">Docs <span className="arrow">&rarr;</span></span>
                    </Link>
                </div>
            </section>

            {/* colophon */}
            <footer className="pv2-colophon">
                <span>compiled by ax from local agent transcripts · nothing leaves the machine unreviewed</span>
                <span>publish yours → <code>ax profile publish</code></span>
            </footer>
        </article>
    );
}

function HookReceiptLine({ name, receipt }: { name: string; receipt?: ProfileGuardrailHookReceipt }) {
    return (
        <div className="pf-hook-receipt">
            <span className="pf-hook" title={name}>{name}</span>
            <span className={receipt ? "pf-hook-receipt-text" : "pf-hook-receipt-text pf-hook-receipt-text--empty"}>
                {receipt ? hookReceiptText(receipt) : "no recent receipt"}
            </span>
        </div>
    );
}

/* ---------- pieces ---------- */

export function Vital({ num, unit, label }: { num: string; unit?: string; label: string }) {
    return (
        <div className="pf-vital">
            <span className="pf-vital-num">{num}{unit ? <small> {unit}</small> : null}</span>
            <span className="pf-vital-label">{label}</span>
        </div>
    );
}

/** Landing-v2 section intro: mono eyebrow + serif h2 + optional note line. */
export function SectionIntro({ eyebrow, title, note }: { eyebrow: string; title: string; note?: string }) {
    return (
        <div className="demo-intro">
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
            {note && <p>{note}</p>}
        </div>
    );
}

/* ---------- the sign: radar + archetype ---------- */

function SignSection({ profile, vs }: { profile: ProfileV1; vs: VsState }) {
    const navigate = useNavigate({ from: "/u/$login" });
    const [draft, setDraft] = useState("");
    const [copied, setCopied] = useState(false);

    const selfAxes = profileToAxes(profile);
    const selfArch = archetypeFor(selfAxes, profile);

    const vsReady = vs.kind === "ready" ? vs : null;
    const vsAxes = vsReady ? profileToAxes(vsReady.profile) : null;
    const vsArch = vsReady && vsAxes ? archetypeFor(vsAxes, vsReady.profile) : null;

    const tally = vsReady && vsAxes ? leadTally(selfAxes, vsAxes) : null;
    const origin = typeof window !== "undefined" ? window.location.origin : "https://ax.necmttn.com";
    const duelUrl = vsReady ? `${origin}${duelPath(profile.github, vsReady.login)}` : "";
    const copyDuel = () => {
        if (!duelUrl) return;
        void navigator.clipboard?.writeText(duelUrl).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };

    const series: RadarSeries[] = [{ login: profile.github, axes: selfAxes, color: SELF_COLOR }];
    if (vsReady && vsAxes) series.push({ login: vsReady.login, axes: vsAxes, color: VS_COLOR });

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const target = draft.trim().replace(/^@/, "");
        if (!LOGIN_RE.test(target)) return;
        void navigate({ search: { vs: target } });
        setDraft("");
    };
    const clearCompare = () => void navigate({ search: { vs: undefined } });

    return (
        <section className="pf-section">
            <SectionIntro eyebrow="the sign" title="The sign" note="six axes, one archetype" />
            <p className="pf-sign-method">
                Axes are log-anchored to fixed scales (not min-max), so shapes compare
                across any two profiles.
            </p>
            <div className="pf-sign">
                <div className="pf-sign-chart">
                    <RadarChart series={series} size={420} />
                    {selfAxes.partial && (
                        <p className="pf-sign-partial">
                            some axes read 0 - they need a newer ax version to populate.
                        </p>
                    )}
                    <AxisLegend />
                </div>

                <div className="pf-sign-read">
                    {vsArch && vsReady ? (
                        <p className="pf-sign-versus">
                            <Avatar login={profile.github} size={22} ring={SELF_COLOR} className="pv2-avatar--inline" />
                            <span style={{ color: SELF_COLOR }}>@{profile.github}</span> is {selfArch.sign}
                            {" · "}
                            <Avatar login={vsReady.login} size={22} ring={VS_COLOR} className="pv2-avatar--inline" />
                            <span style={{ color: VS_COLOR }}>@{vsReady.login}</span> is {vsArch.sign}
                        </p>
                    ) : (
                        <span className="pf-sign-kicker">your agent sign</span>
                    )}

                    <div className="pf-sign-head">
                        <span className="pf-sign-glyph" aria-hidden="true">{selfArch.symbol}</span>
                        <h3 className="pf-sign-name">{selfArch.sign}</h3>
                    </div>
                    <p className="pf-sign-blurb">{selfArch.blurb}</p>

                    {/* compare mode: the raw-values table below carries the
                        per-axis comparison - one table, not two summaries */}
                    {!(vsReady && vsAxes) && <ScoreList axes={selfAxes} />}

                    {/* compare control */}
                    <div className="pf-sign-compare">
                        {vsReady ? (
                            <div className="pf-share-row">
                                <button type="button" className="pf-share-btn" onClick={copyDuel}>
                                    {copied ? "copied ✓" : "copy duel link"}
                                </button>
                                {tally && (
                                    <a
                                        className="pf-share-btn"
                                        href={duelXIntent({ a: profile.github, b: vsReady.login, aLeads: tally.aLeads, total: tally.total, origin })}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        post on X
                                    </a>
                                )}
                                <button type="button" className="pf-sign-clear" onClick={clearCompare}>clear</button>
                            </div>
                        ) : (
                            <form className="pf-sign-form" onSubmit={submit}>
                                <span className="pf-sign-form-label">Think you out-ship @{profile.github}?</span>
                                <input
                                    className="pf-sign-input"
                                    type="text"
                                    value={draft}
                                    onChange={(e) => setDraft(e.currentTarget.value)}
                                    placeholder="github handle"
                                    aria-label="github handle to challenge"
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                />
                                <button type="submit" className="pf-sign-go">challenge →</button>
                            </form>
                        )}
                        {vs.kind === "loading" && <span className="pf-sign-msg">pulling @{vs.login}…</span>}
                        {vs.kind === "not-found" && <UnclaimedChallenger login={vs.login} />}
                        {vs.kind === "error" && <span className="pf-sign-msg">couldn't load @{vs.login}.</span>}
                    </div>
                </div>
            </div>

            <RawTable
                self={selfAxes}
                selfLogin={profile.github}
                vs={vsReady && vsAxes ? { axes: vsAxes, login: vsReady.login } : undefined}
            />
        </section>
    );
}

/** Compact six-axis legend under the radar: what each spoke abbreviation means. */
export function AxisLegend() {
    return (
        <dl className="pf-axis-legend" aria-label="axis legend">
            {RADAR_AXES_META.map((m) => (
                <div className="pf-axis-legend-row" key={m.key}>
                    <dt className="pf-axis-legend-key">{m.label}</dt>
                    <dd className="pf-axis-legend-note">{m.note}</dd>
                </div>
            ))}
        </dl>
    );
}

function ScoreList({ axes }: { axes: RadarAxes }) {
    const [a, b] = dominantPair(axes);
    return (
        <dl className="pf-sign-scores">
            {RADAR_AXES_META.map((m) => {
                const dom = m.key === a || m.key === b;
                return (
                    <div className={dom ? "pf-sign-score pf-sign-score--dom" : "pf-sign-score"} key={m.key}>
                        <dt>{m.label}</dt>
                        <dd>
                            <span className="pf-sign-bar" aria-hidden="true">
                                <span className="pf-sign-bar-fill" style={{ width: `${clampPct(axes.scores[m.key])}%` }} />
                            </span>
                            <span className="pf-sign-val">{fmtScore(axes.scores[m.key])}</span>
                        </dd>
                    </div>
                );
            })}
        </dl>
    );
}

/**
 * "Raw values" reference table - the un-normalised numbers behind the chart,
 * straight off RadarAxes.raws (never re-derived here). In compare mode each
 * row gets two value columns and the per-metric leader is marked with a small
 * green dot; ties and unmeasurable rows get no dot.
 */
export function RawTable({
    self, selfLogin, vs,
}: {
    self: RadarAxes;
    selfLogin: string;
    vs?: { axes: RadarAxes; login: string };
}) {
    return (
        <div className="pf-rawvals">
            <div className="pf-rawvals-head">
                <span className="pf-rawvals-kicker">raw values</span>
                <span className="pf-rawvals-note">un-normalised numbers behind the chart</span>
            </div>
            <table className="pf-rawvals-table">
                <thead>
                    <tr>
                        <th scope="col">metric</th>
                        <th scope="col" className="pf-rawvals-col">
                            {vs ? (
                                <><Avatar login={selfLogin} size={18} ring={SELF_COLOR} className="pv2-avatar--inline" linked /><span style={{ color: SELF_COLOR }}>@{selfLogin}</span></>
                            ) : "value"}
                        </th>
                        {vs && (
                            <th scope="col" className="pf-rawvals-col">
                                <Avatar login={vs.login} size={18} ring={VS_COLOR} className="pv2-avatar--inline" linked /><span style={{ color: VS_COLOR }}>@{vs.login}</span>
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {RADAR_AXES_META.map((m) => {
                        const a = self.raws[m.key];
                        const b = vs?.axes.raws[m.key];
                        // leader: strictly greater comparable numeric; null never leads
                        const aLeads = vs !== undefined && a.value !== null && (b?.value === null || b === undefined || a.value > b.value);
                        const bLeads = vs !== undefined && b !== undefined && b.value !== null && (a.value === null || b.value > a.value);
                        // magnitude split-bar: each side normalised to that row's
                        // pair-max so a blowout reads visually distinct from a near-tie.
                        const av = a.value;
                        const bv = b?.value ?? null;
                        const pairMax = Math.max(av ?? 0, bv ?? 0, 0);
                        const aPct = pairMax > 0 && av !== null ? Math.min(100, (av / pairMax) * 100) : 0;
                        const bPct = pairMax > 0 && bv !== null ? Math.min(100, (bv / pairMax) * 100) : 0;
                        const ratio = av !== null && bv !== null && av > 0 && bv > 0
                            ? Math.max(av, bv) / Math.min(av, bv)
                            : null;
                        const ratioChip = ratio !== null && ratio >= 1.05
                            ? `${ratio >= 10 ? Math.round(ratio) : (Math.round(ratio * 10) / 10)}×`
                            : null;
                        return (
                            <Fragment key={m.key}>
                                <tr className={vs ? "pf-rawvals-row pf-rawvals-row--pair" : "pf-rawvals-row"}>
                                    <th scope="row" rowSpan={vs ? 2 : 1}>{m.label}</th>
                                    <td className={aLeads ? "pf-rawvals-val pf-rawvals-val--lead" : "pf-rawvals-val"}>
                                        {a.label}
                                        {aLeads && <span className="pf-rawvals-dot" aria-label="leads" />}
                                    </td>
                                    {vs && b && (
                                        <td className={bLeads ? "pf-rawvals-val pf-rawvals-val--lead" : "pf-rawvals-val"}>
                                            {b.label}
                                            {bLeads && <span className="pf-rawvals-dot" aria-label="leads" />}
                                        </td>
                                    )}
                                </tr>
                                {vs && (
                                    <tr className="pf-rawvals-barrow">
                                        <td colSpan={2}>
                                            <div className="pf-rawvals-split" aria-hidden="true">
                                                <span className="pf-rawvals-split-a">
                                                    <span className="pf-rawvals-split-fill pf-rawvals-split-fill--a" style={{ width: `${aPct}%` }} />
                                                </span>
                                                <span className="pf-rawvals-split-mid">{ratioChip}</span>
                                                <span className="pf-rawvals-split-b">
                                                    <span className="pf-rawvals-split-fill pf-rawvals-split-fill--b" style={{ width: `${bPct}%` }} />
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

const fmtScore = (n: number): string => String(Math.round(n));

/* ---------- the window: one model-keyed stacked-bar chart ---------- */

interface ProfileModelLite { readonly name: string; readonly share: number; readonly cost_usd?: number }

/**
 * GitHub-heatmap-style daily bars, but each bar is segmented by model tokens
 * and the whole row carries every daily metric in a hover tooltip. Bar height
 * scales to the busiest token-day; segments are colour-keyed by the same
 * window-level model->colour map the legend uses, so a model reads identically
 * everywhere. Keyboard/touch fallback rides the column's `title` attribute.
 */
export function StackedWindow({
    daily, colorOf, busiest, models, sessions, windowDays,
}: {
    daily: readonly ProfileDailyRow[];
    colorOf: (name: string) => string;
    busiest?: string;
    models: readonly ProfileModelLite[];
    sessions: number;
    windowDays: number;
}) {
    const cols = buildDayColumns(daily, colorOf, { peakDate: busiest });
    const [hover, setHover] = useState<number | null>(null);
    const maxTokens = daily.reduce((m, d) => Math.max(m, d.tokens), 0);
    const first = cols[0];
    const last = cols[cols.length - 1];
    const hovered = hover !== null ? cols[hover] : undefined;

    return (
        <div className="pf-window">
            <div className="pf-stack-wrap">
                <div
                    className="pf-stack"
                    role="img"
                    aria-label={`daily tokens over ${cols.length} days, segmented by model, peaking at ${fmtCompact(maxTokens)} tokens`}
                    onMouseLeave={() => setHover(null)}
                >
                    {cols.map((c, i) => (
                        <button
                            type="button"
                            className={`pf-stack-day${c.isPeak ? " is-peak" : ""}${hover === i ? " is-hover" : ""}`}
                            key={c.date}
                            title={tooltipText(c)}
                            onMouseEnter={() => setHover(i)}
                            onFocus={() => setHover(i)}
                            onBlur={() => setHover(null)}
                            aria-label={tooltipText(c)}
                        >
                            <span
                                className="pf-stack-col"
                                style={{
                                    height: `${Math.max(c.heightShare * 100, c.tokens > 0 ? 2 : 0)}%`,
                                    animationDelay: `${0.15 + i * (0.5 / Math.max(cols.length, 1))}s`,
                                }}
                            >
                                {c.segments.map((s, j) => (
                                    <span
                                        className="pf-stack-seg"
                                        key={`${s.name}-${j}`}
                                        style={{ flexGrow: s.share, background: s.color }}
                                    />
                                ))}
                            </span>
                            {c.isPeak && <span className="pf-stack-peak" aria-hidden="true">▲</span>}
                        </button>
                    ))}
                    {hovered && (
                        <WindowTooltip
                            col={hovered}
                            index={hover!}
                            total={cols.length}
                            colorOf={colorOf}
                        />
                    )}
                </div>
                <div className="pf-chart-axis">
                    <span>{first ? fmtDay(first.date) : ""}</span>
                    <span className="pf-chart-axis-mid">
                        {fmtInt(sessions)} sessions over {windowDays} days · bar height = daily tokens, colour = model{busiest !== undefined ? " · ▲ peak day" : ""}
                    </span>
                    <span>{last ? fmtDay(last.date) : ""}</span>
                </div>
            </div>

            {/* legend: replaces the old model-split rows */}
            {models.length > 0 && (
                <div className="pf-legend" aria-label="model legend">
                    <div className="pf-legend-head">model split · window totals</div>
                    {models.map((m) => (
                        <div className="pf-legend-row" key={m.name}>
                            <span className="pf-legend-chip" style={{ background: colorOf(m.name) }} aria-hidden="true" />
                            <span className="pf-legend-name" title={m.name}>{m.name}</span>
                            <span className="pf-legend-meta">
                                <strong>{fmtPct(m.share)}</strong>
                                {m.cost_usd !== undefined ? ` · ~${fmtMoney(m.cost_usd)}` : ""}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function tooltipText(c: DayColumn): string {
    const parts = [
        fmtDay(c.date),
        `${fmtInt(c.sessions)} sessions`,
        `${fmtCompact(c.tokens)} tokens`,
    ];
    if (c.tool_calls !== undefined) parts.push(`${fmtCompact(c.tool_calls)} tool calls`);
    if (c.commits !== undefined) parts.push(`${fmtInt(c.commits)} commits`);
    return parts.join(" · ");
}

/** Positioned tooltip; clamps to the chart edges via percentage + transform. */
function WindowTooltip({
    col, index, total, colorOf,
}: {
    col: DayColumn;
    index: number;
    total: number;
    colorOf: (name: string) => string;
}) {
    const frac = total > 1 ? index / (total - 1) : 0.5;
    // clamp the anchor so the box never overflows the chart edges
    const leftPct = clampPct(frac * 100);
    const align = frac < 0.18 ? "0%" : frac > 0.82 ? "-100%" : "-50%";
    return (
        <div
            className="pf-tip"
            style={{ left: `${leftPct}%`, transform: `translateX(${align})` }}
            role="tooltip"
        >
            <div className="pf-tip-date">{fmtDay(col.date)}</div>
            <div className="pf-tip-rows">
                <span className="pf-tip-k">sessions</span><span className="pf-tip-v">{fmtInt(col.sessions)}</span>
                <span className="pf-tip-k">tokens</span><span className="pf-tip-v">{fmtCompact(col.tokens)}</span>
                {col.tool_calls !== undefined && (
                    <><span className="pf-tip-k">tool calls</span><span className="pf-tip-v">{fmtCompact(col.tool_calls)}</span></>
                )}
                {col.commits !== undefined && (
                    <><span className="pf-tip-k">commits</span><span className="pf-tip-v">{fmtInt(col.commits)}</span></>
                )}
            </div>
            {col.segments.length > 0 && (
                <div className="pf-tip-models">
                    {col.segments.map((s, j) => (
                        <div className="pf-tip-model" key={`${s.name}-${j}`}>
                            <span className="pf-tip-chip" style={{ background: s.color }} aria-hidden="true" />
                            <span className="pf-tip-model-name">{s.name === OTHER_NAME ? "other" : s.name}</span>
                            <span className="pf-tip-model-tok">{fmtCompact(s.tokens)}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** One leverage-sorted skill: name left, leverage bar + share% + runs right. */
export function SkillRow({ skill }: { skill: ProfileSkill }) {
    const share = skill.downstream_share;
    const display = skill.name.includes(":") ? skill.name.slice(skill.name.indexOf(":") + 1) : skill.name;
    return (
        <div className="pf-skill">
            <span className="pf-skill-name" title={skill.name}>{display}</span>
            <span className="pf-skill-lev">
                <span className="pf-skill-track" aria-hidden="true">
                    {share !== undefined && (
                        <span className="pf-skill-bar" style={{ width: `${clampPct(share * 100)}%` }} />
                    )}
                </span>
                <span className="pf-skill-share">{share !== undefined ? fmtPct(share) : "-"}</span>
                <span className="pf-skill-runs">· {fmtCompact(skill.runs)} runs</span>
            </span>
        </div>
    );
}

/* ----- grounded card-viz specs: each card carries a real chart driven by the
   profile's own numbers (daily series where one exists, scalar gauges otherwise -
   never a fabricated series). Kinds are assigned for SHAPE VARIETY so no two
   adjacent cards share a chart family. Charts render in card-viz.tsx. ----- */

export function buildInsightCards(
    ins: ProfileInsights,
    daily: readonly ProfileDailyRow[],
): readonly InsightCard[] {
    // a daily series for a numeric key - only when >= 2 days actually carry it
    // (else the card falls back to a scalar gauge; we never invent a series).
    const seriesOf = (pick: (d: ProfileDailyRow) => number | undefined): number[] | undefined => {
        const present = daily.filter((d) => typeof pick(d) === "number").length;
        if (present < 2) return undefined;
        return daily.map((d) => pick(d) ?? 0);
    };
    const sessionsSeries = seriesOf((d) => d.sessions);
    const commitsSeries = seriesOf((d) => d.commits);

    // scalar gauges (honest 0..100 / clamped-count readouts; caption holds truth)
    const ringPct = (share: number): VizSpec => ({ kind: "ring", data: [clampPct(share * 100)] });
    const wafflePct = (share: number): VizSpec => ({ kind: "waffle", data: [clampPct(share * 100)] });
    const cometPct = (frac: number): VizSpec => ({ kind: "comet", data: [clampPct(frac * 100)] });
    // signal/ring/comet/waffle all read avg(data) as a 0..100 % strength, so a
    // count must be normalised against a soft ceiling (not passed raw) - else it
    // floors to one lit bar. The caption always carries the true count.
    const signalStrength = (n: number, ceiling: number): VizSpec => ({
        kind: "signal",
        data: [clampPct((n / ceiling) * 100)],
    });
    // bullet reads [target, actual] (first = target tick, last = filled bar), so
    // the goal-line % goes first and the achieved % second.
    const bulletCount = (n: number, scale: number, goalPct = 50): VizSpec => ({
        kind: "bullet",
        data: [goalPct, clampPct((n / scale) * 100)],
    });

    const cards: InsightCard[] = [
        {
            q: "How deep do you go?",
            a: fmtPct(ins.deep_session_share),
            s: "of sessions landed a real, non-reverted commit - shipped, not just chatted",
            viz: ringPct(ins.deep_session_share),
        },
        {
            q: "How many agents at once?",
            a: fmtInt(ins.max_parallel_sessions),
            s: "sessions running in parallel at peak",
            // 10 concurrent agents reads as a full bank
            viz: signalStrength(ins.max_parallel_sessions, 10),
        },
        {
            q: "Longest single run?",
            a: fmtDuration(ins.longest_session_minutes),
            s: "one session, end to end, without letting go",
            // share of a 12-hour marathon, against a 6-hour "deep run" goal line
            viz: bulletCount(ins.longest_session_minutes, 12 * 60),
        },
        {
            q: "When are you most alive?",
            a: <>{fmtHour(ins.peak_hour_utc)}<small> UTC</small></>,
            s: "the hour the graph lights up",
            viz: cometPct(Math.max(0, ins.peak_hour_utc) / 23),
        },
        {
            q: "Busiest day?",
            a: fmtDay(ins.busiest_day.date),
            s: `${fmtInt(ins.busiest_day.sessions)} sessions in a single day`,
            // real daily sessions when we have the series; else a clamped gauge
            viz: sessionsSeries
                ? { kind: "bars", data: sessionsSeries }
                : bulletCount(ins.busiest_day.sessions, 20),
        },
        {
            q: "How many hands?",
            a: fmtCompact(ins.subagents_spawned),
            s: "subagents dispatched to do the legwork",
            // a fleet of ~500 dispatches reads as a full bank
            viz: signalStrength(ins.subagents_spawned, 500),
        },
        {
            q: "What actually shipped?",
            a: fmtCompact(ins.commits),
            s: "commits landed across the window",
            // real daily commit rhythm when present; else a clamped gauge
            viz: commitsSeries
                ? { kind: "line", data: commitsSeries }
                : bulletCount(ins.commits, 100),
        },
        {
            q: "Time in the loop?",
            a: <>{fmtCompact(ins.hours_total)}<small> hrs</small></>,
            s: "of recorded agent time on the clock",
        },
    ];

    // wrapped-style cards - only shown when fields are present
    if (ins.verification_calls !== undefined && ins.tool_calls !== undefined && ins.tool_calls > 0) {
        const share = ins.verification_calls / ins.tool_calls;
        cards.push({
            q: "How often do you verify?",
            a: fmtPct(share),
            s: `of tool calls are tests, checks, and lints`,
            viz: wafflePct(share),
        });
    }
    if (ins.tool_failures !== undefined && ins.tool_calls !== undefined && ins.tool_calls > 0) {
        const share = ins.tool_failures / ins.tool_calls;
        cards.push({
            q: "Tool failure rate?",
            a: fmtPct(share),
            s: `failed calls across ${fmtCompact(ins.tool_calls)} tool runs`,
            accent: "red",
            viz: ringPct(share),
        });
    }
    if (ins.distinct_skills !== undefined && ins.distinct_tools !== undefined) {
        cards.push({
            q: "How wide is the rig?",
            a: `${fmtInt(ins.distinct_skills)} skills`,
            s: `across ${fmtInt(ins.distinct_tools)} distinct tools`,
            // a breadth radar over the real rig dimensions
            viz: {
                kind: "radar",
                data: [
                    ins.distinct_skills,
                    ins.distinct_tools,
                    ins.repos_count ?? 0,
                    ins.subagents_spawned,
                    ins.max_parallel_sessions,
                ],
            },
        });
    }
    if (ins.repos_count !== undefined) {
        cards.push({
            q: "How many repos?",
            a: fmtInt(ins.repos_count),
            s: "repositories touched this window",
            // ~12 repos in a window reads as a full bank
            viz: signalStrength(ins.repos_count, 12),
        });
    }

    return cards;
}

interface SkillGroup { readonly source: string; readonly skills: ProfileSkill[]; readonly runs: number }

export function groupSkills(skills: readonly ProfileSkill[]): SkillGroup[] {
    const by = new Map<string, ProfileSkill[]>();
    for (const s of skills) {
        const list = by.get(s.source);
        if (list) list.push(s);
        else by.set(s.source, [s]);
    }
    return [...by.entries()]
        .map(([source, list]) => ({
            source,
            skills: [...list].sort((a, b) => b.runs - a.runs),
            runs: list.reduce((sum, s) => sum + s.runs, 0),
        }))
        .sort((a, b) => b.runs - a.runs);
}

/* ---------- not-found doubles as the join CTA ---------- */

/** Shown inside SignSection when the challenger is unregistered: a compact dare
 *  echoing the dossier's stamp + command motifs. */
function UnclaimedChallenger({ login }: { login: string }) {
    return (
        <div className="pf-challenge-unclaimed">
            <span className="pf-challenge-stamp" aria-hidden="true">unanswered</span>
            <p className="pf-challenge-line">
                challenge issued · <strong>@{login}</strong> hasn't published a dossier yet.
            </p>
            <code className="pf-empty-cmd">ax profile publish</code>
            <span className="pf-challenge-sub">one command answers the challenge - their transcripts never leave their machine.</span>
        </div>
    );
}

export function UnclaimedDossier({ login }: { login: string }) {
    return (
        <article className="profile-v2-doc">
            <section className="hero pv2-unclaimed">
                <HeroLogoField />
                <span className="eyebrow">unclaimed</span>
                <h1><span className="pf-at">@</span>{login}</h1>
                <p className="lede">No dossier on file for @{login} yet.</p>
                <p className="pv2-unclaimed-copy">
                    ax compiles a public profile from your local agent telemetry - sessions,
                    tokens, model split, the rig you've built, the patterns in how you work.
                    One command. Your transcripts never leave your machine; only the
                    aggregate ships, to a gist you own.
                </p>
                <code className="pv2-cmd">ax profile publish</code>
                <p className="pv2-unclaimed-copy">
                    New to ax? <Link to="/">Start here</Link> - install takes 30 seconds,
                    the first ingest does the rest.
                </p>
            </section>
        </article>
    );
}
