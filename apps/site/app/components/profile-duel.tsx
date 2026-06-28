// apps/site/app/components/profile-duel.tsx
//
// Bespoke head-to-head "duel" layout for /u/<a>/vs/<b>. Unlike ProfileDossier
// (one full profile with an optional overlay), this page is built entirely
// around the comparison: every aspect rendered twice, A on the left (ax green),
// B on the right (ax blue), with both avatars + names flanking a big "VS" in the
// hero. It reuses the dossier's internals (Avatar/Vital/StackedWindow/
// buildInsightCards/groupSkills/SkillRow/RawTable/AxisLegend) so the two pages
// humanize + render identical pieces; only the two-column framing is new.
//
// Everything fed here is untrusted gist data already validated by
// validateProfileV1; every optional section guards for missing data and renders
// the quiet empty note rather than crashing.

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { WrappedDeck } from "~/components/wrapped-deck";
import { RadarChart, type RadarSeries } from "~/components/radar-chart";
import {
    archetypeFor,
    profileToAxes,
    RADAR_AXES_META,
    RADAR_AXIS_KEYS,
    type RadarAxes,
    type RadarAxisKey,
} from "~/lib/radar";
import { duelPath, duelXIntent } from "~/lib/challenge";
import { type ProfileV1 } from "@ax/lib/shared/community";
import { buildModelColors, sortSkillsByLeverage } from "~/lib/window-chart";
import {
    Avatar,
    buildInsightCards,
    fmtCompact,
    fmtInt,
    fmtMoney,
    fmtPct,
    groupSkills,
    HighlightsBlocks,
    RawTable,
    SectionIntro,
    SkillRow,
    StackedWindow,
    SELF_COLOR,
    VS_COLOR,
} from "~/components/profile-dossier";

/* ---------- small derived helpers (pure) ---------- */

/** Build the StackedWindow inputs for one profile - mirrors ProfileDossier. */
function windowInputs(p: ProfileV1) {
    const daily = p.activity && p.activity.daily.length > 0
        ? [...p.activity.daily].sort((a, b) => (a.date < b.date ? -1 : 1))
        : [];
    const models = [...p.stats.models].sort((a, b) => b.share - a.share);
    const { colorOf } = buildModelColors(models);
    return { daily, models, colorOf };
}

interface AxisResult { readonly key: RadarAxisKey; readonly winner: "a" | "b" | "tie" }
interface ScoreTally {
    readonly aLeads: number;
    readonly bLeads: number;
    readonly total: number;
    readonly per: readonly AxisResult[];
}

/** Per-axis winner over the six radar SCORES (higher wins; ties score nobody). */
function scoreTally(a: RadarAxes, b: RadarAxes): ScoreTally {
    let aLeads = 0;
    let bLeads = 0;
    const per: AxisResult[] = [];
    for (const key of RADAR_AXIS_KEYS) {
        const av = a.scores[key];
        const bv = b.scores[key];
        const winner = av > bv ? "a" : bv > av ? "b" : "tie";
        if (winner === "a") aLeads++;
        else if (winner === "b") bLeads++;
        per.push({ key, winner });
    }
    return { aLeads, bLeads, total: RADAR_AXIS_KEYS.length, per };
}

interface VitalCompare {
    readonly label: string;
    readonly a: string;
    readonly b: string;
    readonly aNum: number | null;
    readonly bNum: number | null;
}

/** One comparable row per headline vital; optional inputs (spend/hours) only
 *  appear when at least one side carries them, "-" on the missing side. */
function vitalRows(a: ProfileV1, b: ProfileV1): VitalCompare[] {
    const rows: VitalCompare[] = [
        { label: "sessions", a: fmtInt(a.stats.sessions), b: fmtInt(b.stats.sessions), aNum: a.stats.sessions, bNum: b.stats.sessions },
        { label: "tokens", a: fmtCompact(a.stats.tokens.total), b: fmtCompact(b.stats.tokens.total), aNum: a.stats.tokens.total, bNum: b.stats.tokens.total },
    ];
    if (a.stats.cost_usd !== undefined || b.stats.cost_usd !== undefined) {
        rows.push({
            label: "est. spend",
            a: a.stats.cost_usd !== undefined ? `~${fmtMoney(a.stats.cost_usd)}` : "-",
            b: b.stats.cost_usd !== undefined ? `~${fmtMoney(b.stats.cost_usd)}` : "-",
            aNum: a.stats.cost_usd ?? null,
            bNum: b.stats.cost_usd ?? null,
        });
    }
    if (a.insights || b.insights) {
        rows.push({
            label: "hours in loop",
            a: a.insights ? `${fmtCompact(a.insights.hours_total)} hrs` : "-",
            b: b.insights ? `${fmtCompact(b.insights.hours_total)} hrs` : "-",
            aNum: a.insights?.hours_total ?? null,
            bNum: b.insights?.hours_total ?? null,
        });
    }
    rows.push(
        { label: "days active", a: `${fmtInt(a.stats.active_days)}/${fmtInt(a.window_days)}`, b: `${fmtInt(b.stats.active_days)}/${fmtInt(b.window_days)}`, aNum: a.stats.active_days, bNum: b.stats.active_days },
        { label: "streak", a: `${fmtInt(a.stats.streak_days)}d`, b: `${fmtInt(b.stats.streak_days)}d`, aNum: a.stats.streak_days, bNum: b.stats.streak_days },
    );
    return rows;
}

const winnerOf = (aNum: number | null, bNum: number | null): "a" | "b" | "tie" => {
    if (aNum === null && bNum === null) return "tie";
    if (bNum === null) return "a";
    if (aNum === null) return "b";
    return aNum > bNum ? "a" : bNum > aNum ? "b" : "tie";
};

/* ---------- the duel ---------- */

export function DuelDossier({ a, b }: { a: ProfileV1; b: ProfileV1 }) {
    const aAxes = profileToAxes(a);
    const bAxes = profileToAxes(b);
    const aArch = archetypeFor(aAxes, a);
    const bArch = archetypeFor(bAxes, b);
    const tally = scoreTally(aAxes, bAxes);
    const rows = vitalRows(a, b);

    const aWin = windowInputs(a);
    const bWin = windowInputs(b);

    const series: RadarSeries[] = [
        { login: a.github, axes: aAxes, color: SELF_COLOR },
        { login: b.github, axes: bAxes, color: VS_COLOR },
    ];

    const minWindow = Math.min(a.window_days, b.window_days);
    const windowNote = a.window_days === b.window_days
        ? `${a.window_days}-day window`
        : `${minWindow}-day window · ${a.window_days}d vs ${b.window_days}d`;

    const origin = typeof window !== "undefined" ? window.location.origin : "https://ax.necmttn.com";
    const duelUrl = `${origin}${duelPath(a.github, b.github)}`;
    const [copied, setCopied] = useState(false);
    const copyDuel = () => {
        void navigator.clipboard?.writeText(duelUrl).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };

    const leadLine = tally.aLeads === tally.bLeads
        ? "dead even"
        : tally.aLeads > tally.bLeads
            ? <>@{a.github} leads <span style={{ color: SELF_COLOR }}>{tally.aLeads}</span>&ndash;<span style={{ color: VS_COLOR }}>{tally.bLeads}</span></>
            : <>@{b.github} leads <span style={{ color: VS_COLOR }}>{tally.bLeads}</span>&ndash;<span style={{ color: SELF_COLOR }}>{tally.aLeads}</span></>;

    // worded verdict for the fight-card (numbers live in the score badge, so the
    // verdict line stays words-only - no redundant restating of the tally).
    const tied = tally.aLeads === tally.bLeads;
    const aWins = tally.aLeads > tally.bLeads;
    const verdict = tied
        ? <>dead even &mdash; <strong>{tally.aLeads}&ndash;{tally.bLeads}</strong> across six axes</>
        : aWins
            ? <><span style={{ color: SELF_COLOR }}>@{a.github}</span> takes the sign, <strong>{aArch.sign}</strong></>
            : <><span style={{ color: VS_COLOR }}>@{b.github}</span> takes the sign, <strong>{bArch.sign}</strong></>;

    return (
        <article className="profile-duel">
            {/* hero: A | VS | B */}
            <section className="duel-hero">
                <span className="eyebrow pv2-eyebrow duel-hero-eyebrow">
                    <span className="pf-live" title="both profiles pulled live from their published gists on load">
                        <span className="pf-live-dot" aria-hidden="true" />live
                    </span>
                    <span aria-hidden="true">·</span>
                    {windowNote}
                </span>
                <div className="duel-hero-grid">
                    <DuelSide login={a.github} arch={aArch} ring={SELF_COLOR} color={SELF_COLOR} side="a" />
                    <div className="duel-vs" aria-hidden="true">VS</div>
                    <DuelSide login={b.github} arch={bArch} ring={VS_COLOR} color={VS_COLOR} side="b" />
                </div>
            </section>

            {/* scoreboard: per-axis lead tally */}
            <section className="pf-section duel-score">
                <SectionIntro eyebrow="the scoreboard" title="The scoreboard" note="six axes, higher score takes the point" />
                <p className="duel-score-line">{leadLine}</p>
                <div className="duel-score-tally" aria-label="per-axis winners">
                    {tally.per.map((r) => {
                        const meta = RADAR_AXES_META.find((m) => m.key === r.key)!;
                        const cls = r.winner === "a" ? "duel-axis duel-axis--a" : r.winner === "b" ? "duel-axis duel-axis--b" : "duel-axis duel-axis--tie";
                        return (
                            <span className={cls} key={r.key}>
                                <span className="duel-axis-dot" aria-hidden="true" />
                                {meta.label}
                            </span>
                        );
                    })}
                </div>
            </section>

            {/* vitals comparison: A-left | label | B-right */}
            <section className="pf-section duel-vitals">
                <SectionIntro eyebrow="the vitals" title="The vitals" note="raw scale, side by side" />
                <div className="duel-vitals-table">
                    {rows.map((row) => {
                        const w = winnerOf(row.aNum, row.bNum);
                        return (
                            <div className="duel-vital-row" key={row.label}>
                                <span className={w === "a" ? "duel-vital-val duel-vital-val--a is-lead" : "duel-vital-val duel-vital-val--a"}>{row.a}</span>
                                <span className="duel-vital-mid">
                                    <span className="duel-vital-label">{row.label}</span>
                                    <span className="duel-vital-marker" aria-hidden="true">
                                        {w === "a" ? <span className="duel-mk duel-mk--a">&#9666;</span> : w === "b" ? <span className="duel-mk duel-mk--b">&#9656;</span> : <span className="duel-mk duel-mk--tie">&middot;</span>}
                                    </span>
                                </span>
                                <span className={w === "b" ? "duel-vital-val duel-vital-val--b is-lead" : "duel-vital-val duel-vital-val--b"}>{row.b}</span>
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* the sign: fight-card verdict + overlaid radar + raw-values table */}
            <section className="pf-section duel-sign">
                <SectionIntro eyebrow="the sign" title="The sign" note="two shapes, one chart" />

                {/* fight-card: A | score | B - the archetype sign is the focal payload */}
                <div className="duel-versus">
                    <div className="duel-versus-side duel-versus-side--a">
                        <Avatar login={a.github} size={40} ring={SELF_COLOR} className="duel-versus-avatar" linked />
                        <span className="duel-versus-handle" style={{ color: SELF_COLOR }}>@{a.github}</span>
                        <span className="duel-versus-sign">{aArch.sign}</span>
                    </div>
                    <div className="duel-vs-badge" aria-label={`score ${tally.aLeads} to ${tally.bLeads}`}>
                        <span className="duel-vs-score" style={{ color: SELF_COLOR }}>{tally.aLeads}</span>
                        <span className="duel-vs-dash" aria-hidden="true">&ndash;</span>
                        <span className="duel-vs-score" style={{ color: VS_COLOR }}>{tally.bLeads}</span>
                    </div>
                    <div className="duel-versus-side duel-versus-side--b">
                        <Avatar login={b.github} size={40} ring={VS_COLOR} className="duel-versus-avatar" linked />
                        <span className="duel-versus-handle" style={{ color: VS_COLOR }}>@{b.github}</span>
                        <span className="duel-versus-sign">{bArch.sign}</span>
                    </div>
                </div>
                <p className="duel-verdict">{verdict}</p>

                <div className="duel-sign-chart">
                    <RadarChart series={series} size={480} />
                    {(aAxes.partial || bAxes.partial) && (
                        <p className="pf-sign-partial">
                            some axes read 0 - they need a newer ax version to populate.
                        </p>
                    )}
                    <p className="pf-sign-method duel-sign-method">
                        Axes are log-anchored to fixed scales (not min-max), so the two
                        shapes compare directly.
                    </p>
                </div>
                <RawTable
                    self={aAxes}
                    selfLogin={a.github}
                    vs={{ axes: bAxes, login: b.github }}
                />
            </section>

            {/* the window: two stacked-bar charts side by side */}
            <section className="pf-section">
                <SectionIntro eyebrow="the window" title="The window" note="daily tokens, model-keyed" />
                <div className="duel-cols">
                    <DuelColumn login={a.github} color={SELF_COLOR} ring={SELF_COLOR}>
                        {aWin.daily.length > 0 ? (
                            <StackedWindow
                                daily={aWin.daily}
                                colorOf={aWin.colorOf}
                                busiest={a.insights?.busiest_day.date}
                                models={aWin.models}
                                sessions={a.stats.sessions}
                                windowDays={a.window_days}
                            />
                        ) : <p className="pf-quiet">no daily activity recorded in this window.</p>}
                    </DuelColumn>
                    <DuelColumn login={b.github} color={VS_COLOR} ring={VS_COLOR}>
                        {bWin.daily.length > 0 ? (
                            <StackedWindow
                                daily={bWin.daily}
                                colorOf={bWin.colorOf}
                                busiest={b.insights?.busiest_day.date}
                                models={bWin.models}
                                sessions={b.stats.sessions}
                                windowDays={b.window_days}
                            />
                        ) : <p className="pf-quiet">no daily activity recorded in this window.</p>}
                    </DuelColumn>
                </div>
            </section>

            {/* the recap deck: two dark wrapped-card bands */}
            <section className="pf-section">
                <SectionIntro eyebrow="wrapped" title="The shape of the work" note="derived from session telemetry" />
                <div className="duel-cols">
                    <DuelColumn login={a.github} color={SELF_COLOR} ring={SELF_COLOR}>
                        {a.insights ? <WrappedDeck cards={buildInsightCards(a.insights, aWin.daily)} /> : <p className="pf-quiet">no insights published yet.</p>}
                    </DuelColumn>
                    <DuelColumn login={b.github} color={VS_COLOR} ring={VS_COLOR}>
                        {b.insights ? <WrappedDeck cards={buildInsightCards(b.insights, bWin.daily)} /> : <p className="pf-quiet">no insights published yet.</p>}
                    </DuelColumn>
                </div>
            </section>

            {/* the rig: leverage-sorted skills, side by side */}
            <section className="pf-section">
                <SectionIntro eyebrow="the rig" title="The rig" note="skills sorted by downstream leverage" />
                <div className="duel-cols">
                    <DuelColumn login={a.github} color={SELF_COLOR} ring={SELF_COLOR}>
                        <RigSkills profile={a} />
                    </DuelColumn>
                    <DuelColumn login={b.github} color={VS_COLOR} ring={VS_COLOR}>
                        <RigSkills profile={b} />
                    </DuelColumn>
                </div>
            </section>

            {/* taste: user-authored highlights (their words) + mined patterns, per side */}
            {(a.highlights || b.highlights
                || (a.taste && a.taste.patterns.length > 0)
                || (b.taste && b.taste.patterns.length > 0)) && (
                <section className="pf-section">
                    <SectionIntro eyebrow="taste" title="Taste" note="in their words, and what ax keeps seeing" />
                    <div className="duel-cols">
                        <DuelColumn login={a.github} color={SELF_COLOR} ring={SELF_COLOR}>
                            <HighlightsBlocks highlights={a.highlights} />
                            <TastePatterns profile={a} />
                        </DuelColumn>
                        <DuelColumn login={b.github} color={VS_COLOR} ring={VS_COLOR}>
                            <HighlightsBlocks highlights={b.highlights} />
                            <TastePatterns profile={b} />
                        </DuelColumn>
                    </div>
                </section>
            )}

            {/* CTA: challenge buttons + compile-your-own */}
            <section className="pf-section pv2-cta duel-cta" aria-label="share + get ax">
                <div className="demo-intro">
                    <span className="eyebrow">settle it</span>
                    <h2>Share the duel.</h2>
                    <p>Both dossiers compiled themselves from local agent transcripts &mdash; nothing left either machine unreviewed.</p>
                </div>
                <div className="pf-share-row duel-share-row">
                    <button type="button" className="pf-share-btn" onClick={copyDuel}>
                        {copied ? "copied ✓" : "copy duel link"}
                    </button>
                    <a
                        className="pf-share-btn"
                        href={duelXIntent({ a: a.github, b: b.github, aLeads: tally.aLeads, total: tally.total, origin })}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        post on X
                    </a>
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
                    <Link className="card" to="/leaders">
                        <span className="num">02</span>
                        <span className="card-title">Leaders <span className="arrow">&rarr;</span></span>
                    </Link>
                    <Link className="card" to="/u/$login" params={{ login: a.github }} search={{ vs: undefined }}>
                        <span className="num">03</span>
                        <span className="card-title">@{a.github} <span className="arrow">&rarr;</span></span>
                    </Link>
                    <Link className="card" to="/u/$login" params={{ login: b.github }} search={{ vs: undefined }}>
                        <span className="num">04</span>
                        <span className="card-title">@{b.github} <span className="arrow">&rarr;</span></span>
                    </Link>
                </div>
            </section>

            <footer className="pv2-colophon">
                <span>compiled by ax from local agent transcripts · nothing leaves the machine unreviewed</span>
                <span>publish yours → <code>ax profile publish</code></span>
            </footer>
        </article>
    );
}

/* ---------- pieces ---------- */

/** One side of the hero: avatar (ring-tinted) + @handle + archetype sign. */
function DuelSide({ login, arch, ring, color, side }: {
    login: string;
    arch: { sign: string; symbol: string };
    ring: string;
    color: string;
    side: "a" | "b";
}) {
    return (
        <div className={`duel-side duel-side--${side}`}>
            <Avatar login={login} size={96} ring={ring} className="duel-side-avatar" linked />
            <h1 className="duel-side-name"><span className="pf-at">@</span>{login}</h1>
            <span className="duel-side-sign" style={{ color }}>
                <span className="duel-side-glyph" aria-hidden="true">{arch.symbol}</span> {arch.sign}
            </span>
        </div>
    );
}

/** A labelled, accent-ringed column wrapper for the two-up sections. */
function DuelColumn({ login, color, ring, children }: {
    login: string;
    color: string;
    ring: string;
    children: React.ReactNode;
}) {
    return (
        <div className="duel-col" style={{ borderTopColor: color }}>
            <div className="duel-col-head">
                <Avatar login={login} size={26} ring={ring} className="pv2-avatar--inline" linked />
                <span className="duel-col-name" style={{ color }}>@{login}</span>
            </div>
            {children}
        </div>
    );
}

/** Leverage-sorted skills for one profile (mirrors the dossier's rig column). */
function RigSkills({ profile: p }: { profile: ProfileV1 }) {
    const groups = groupSkills(p.rig.skills);
    if (p.rig.skills.length === 0) return <p className="pf-quiet">no skills recorded in this window.</p>;
    return (
        <div className="pf-rig-skills">
            {groups.map((g) => {
                const skills = sortSkillsByLeverage(g.skills);
                return (
                    <div className="pf-rig-group" key={g.source}>
                        <div className="pf-rig-group-head">
                            <span>{g.source}</span>
                            <span>{fmtInt(g.skills.length)} skills · {fmtCompact(g.runs)} runs</span>
                        </div>
                        {skills.slice(0, 10).map((s) => <SkillRow key={s.name} skill={s} />)}
                        {g.skills.length > 10 && <div className="pf-rig-more">+ {fmtInt(g.skills.length - 10)} more</div>}
                    </div>
                );
            })}
        </div>
    );
}

/** Taste patterns for one profile (or the quiet note). */
function TastePatterns({ profile: p }: { profile: ProfileV1 }) {
    if (!p.taste || p.taste.patterns.length === 0) return <p className="pf-quiet">no taste patterns published yet.</p>;
    return (
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
    );
}
