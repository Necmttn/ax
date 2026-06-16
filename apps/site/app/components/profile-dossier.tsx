// apps/site/app/components/profile-dossier.tsx
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { CardArt, type CardArtAccent } from "~/components/dossier-card-art";
import { RadarChart, type RadarSeries } from "~/components/radar-chart";
import {
    archetypeFor,
    dominantPair,
    profileToAxes,
    RADAR_AXES_META,
    type RadarAxes,
} from "~/lib/radar";
import {
    type ProfileV1,
    type ProfileDailyRow,
    type ProfileInsights,
    type ProfileSkill,
} from "~/lib/community";
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
const SELF_COLOR = "var(--green)";
const VS_COLOR = "#2567a8";

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

/** 19_600_000_000 -> "19.6B", 13185 -> "13.2K" */
const fmtCompact = (n: number): string => COMPACT.format(n);
/** 2021 -> "2,021" */
const fmtInt = (n: number): string => PLAIN.format(Math.round(n));
/** 22900 -> "$22.9K" */
const fmtMoney = (n: number): string => `$${COMPACT.format(n)}`;
/** 0.078 -> "7.8%" */
const fmtPct = (share: number): string => {
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
const clampPct = (x: number): number => (Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : 0);

/* ---------- the dossier ---------- */

export function ProfileDossier({ profile: p, vs }: { profile: ProfileV1; vs: VsState }) {
    const daily = p.activity && p.activity.daily.length > 0
        ? [...p.activity.daily].sort((a, b) => (a.date < b.date ? -1 : 1))
        : [];
    const ins = p.insights;
    const models = [...p.stats.models].sort((a, b) => b.share - a.share);
    const { colorOf } = buildModelColors(models);
    const arcs = p.workflow ? buildDisplayArcs(p.workflow.arcs, 5) : [];
    let section = 0;
    const nextSection = (): string => String(++section).padStart(2, "0");

    return (
        <article className="pf-dossier">
            {/* nameplate */}
            <header className="pf-mast">
                <div className="pf-mast-kicker">
                    <span className="pf-live" title="pulled live from the published gist on load">
                        <span className="pf-live-dot" aria-hidden="true" />live
                    </span>
                    <span>{p.window_days}-day window · compiled {p.generated_at.slice(0, 10)}</span>
                </div>
                <h1 className="pf-name"><span className="pf-at">@</span>{p.github}</h1>
                <div className="pf-mast-sub">
                    <span className="pf-harness-list">
                        {p.stats.harnesses.map((h) => <span className="pf-harness" key={h}>{h}</span>)}
                    </span>
                    <span className="pf-mast-via">compiled from local transcripts by <Link to="/">ax</Link></span>
                </div>
            </header>

            {/* vitals ledger */}
            <section className="pf-ledger" aria-label="vitals">
                <Vital num={fmtInt(p.stats.sessions)} label="sessions" />
                <Vital num={fmtCompact(p.stats.tokens.total)} label="tokens" />
                {p.stats.cost_usd !== undefined && <Vital num={`~${fmtMoney(p.stats.cost_usd)}`} label="est. spend" />}
                {ins && <Vital num={fmtCompact(ins.hours_total)} unit="hrs" label="in the loop" />}
                <Vital num={`${fmtInt(p.stats.active_days)}/${fmtInt(p.window_days)}`} label="days active" />
                <Vital num={`${fmtInt(p.stats.streak_days)}d`} label="streak" />
            </section>

            {/* the window: one stacked-bar chart, model-keyed, with a legend */}
            <section className="pf-section">
                <Kicker n={nextSection()} title="The window" note={`last ${p.window_days} days`} />
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

            {/* wrapped-style insight cards */}
            {ins && (
                <section className="pf-section">
                    <Kicker n={nextSection()} title="The shape of the work" note="derived from session telemetry" />
                    <div className="pf-cards">
                        {buildInsightCards(ins).map((c) => (
                            <div className="pf-card" key={c.q}>
                                <CardArt seed={c.q} accent={c.accent ?? "green"} />
                                <div className="pf-card-body">
                                    <span className="pf-card-q">{c.q}</span>
                                    <span className="pf-card-a">{c.a}</span>
                                    {c.viz && <div className="pf-card-viz" aria-hidden="true">{c.viz}</div>}
                                    <span className="pf-card-s">{c.s}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* the sign: radar + agent archetype */}
            <SignSection n={nextSection()} profile={p} vs={vs} />

            {/* the rig: workflow arcs + leverage-sorted skills + guardrails */}
            <section className="pf-section">
                <Kicker n={nextSection()} title="The rig" note={`${fmtInt(p.rig.skills.length)} skills · ${fmtInt(p.rig.hooks.length)} hooks`} />
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
                                {p.rig.hooks.map((h) => <span className="pf-hook" key={h}>{h}</span>)}
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
                    </aside>
                </div>
            </section>

            {/* taste patterns */}
            {p.taste && p.taste.patterns.length > 0 && (
                <section className="pf-section">
                    <Kicker n={nextSection()} title="Taste" note="patterns ax keeps seeing" />
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
                </section>
            )}

            <VisitorCTA />

            {/* colophon */}
            <footer className="pf-colophon">
                <span>compiled by ax from local agent transcripts · nothing leaves the machine unreviewed</span>
                <span>publish yours → <code>ax profile publish</code></span>
            </footer>
        </article>
    );
}

/* ---------- pieces ---------- */

function Vital({ num, unit, label }: { num: string; unit?: string; label: string }) {
    return (
        <div className="pf-vital">
            <span className="pf-vital-num">{num}{unit ? <small> {unit}</small> : null}</span>
            <span className="pf-vital-label">{label}</span>
        </div>
    );
}

function Kicker({ n, title, note }: { n: string; title: string; note?: string }) {
    return (
        <div className="pf-kicker">
            <span className="pf-kicker-n">{n}</span>
            <h2>{title}</h2>
            <span className="pf-kicker-rule" aria-hidden="true" />
            {note && <span className="pf-kicker-note">{note}</span>}
        </div>
    );
}

/* ---------- the sign: radar + archetype ---------- */

function SignSection({ n, profile, vs }: { n: string; profile: ProfileV1; vs: VsState }) {
    const navigate = useNavigate({ from: "/u/$login" });
    const [draft, setDraft] = useState("");

    const selfAxes = profileToAxes(profile);
    const selfArch = archetypeFor(selfAxes, profile);

    const vsReady = vs.kind === "ready" ? vs : null;
    const vsAxes = vsReady ? profileToAxes(vsReady.profile) : null;
    const vsArch = vsReady && vsAxes ? archetypeFor(vsAxes, vsReady.profile) : null;

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
            <Kicker n={n} title="The sign" note="six axes, one archetype" />
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
                            <span style={{ color: SELF_COLOR }}>@{profile.github}</span> is {selfArch.sign}
                            {" · "}
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
                            <button type="button" className="pf-sign-clear" onClick={clearCompare}>
                                clear comparison
                            </button>
                        ) : (
                            <form className="pf-sign-form" onSubmit={submit}>
                                <span className="pf-sign-form-label">compare with</span>
                                <input
                                    className="pf-sign-input"
                                    type="text"
                                    value={draft}
                                    onChange={(e) => setDraft(e.currentTarget.value)}
                                    placeholder="github handle"
                                    aria-label="github handle to compare with"
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                />
                                <button type="submit" className="pf-sign-go">overlay</button>
                            </form>
                        )}
                        {vs.kind === "loading" && <span className="pf-sign-msg">pulling @{vs.login}…</span>}
                        {vs.kind === "not-found" && <span className="pf-sign-msg">no dossier on file for @{vs.login}.</span>}
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
function AxisLegend() {
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
function RawTable({
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
                            {vs ? <span style={{ color: SELF_COLOR }}>@{selfLogin}</span> : "value"}
                        </th>
                        {vs && (
                            <th scope="col" className="pf-rawvals-col">
                                <span style={{ color: VS_COLOR }}>@{vs.login}</span>
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
                        return (
                            <tr key={m.key}>
                                <th scope="row">
                                    <span className="pf-rawvals-metric">{m.label}</span>
                                    <span className="pf-rawvals-metric-note">{m.note}</span>
                                </th>
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
function StackedWindow({
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
function SkillRow({ skill }: { skill: ProfileSkill }) {
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

interface InsightCard {
    readonly q: string;
    readonly a: ReactNode;
    readonly s: string;
    readonly accent?: CardArtAccent;
    readonly viz?: ReactNode;
}

/* ----- mini trace-viz: tiny, mono, data-driven ----- */

/** slim horizontal track with a filled segment; for share/ratio cards */
function VizBar({ value, tone = "green" }: { value: number; tone?: "green" | "red" }) {
    const pct = clampPct(value * 100);
    return (
        <span className="pf-viz pf-viz-bar">
            <span
                className={tone === "red" ? "pf-viz-bar-fill pf-viz-bar-fill--red" : "pf-viz-bar-fill"}
                style={{ width: `${pct}%` }}
            />
        </span>
    );
}

/**
 * A row of ticks; caps at `cap`. When the real count exceeds the cap the last
 * few ticks fade out and a dashed rail follows - signalling "more than fits"
 * without misrepresenting the magnitude (the caption stays the source of
 * truth). Small counts render exactly.
 */
function VizTicks({ count, cap = 20 }: { count: number; cap?: number }) {
    const n = Math.max(0, Math.round(count));
    const shown = Math.min(n, cap);
    const overflow = n > cap;
    return (
        <span className="pf-viz pf-viz-ticks">
            {Array.from({ length: shown }, (_, i) => {
                const fade = overflow && i >= shown - 3;
                return <span className={fade ? "pf-viz-tick pf-viz-tick--fade" : "pf-viz-tick"} key={i} />;
            })}
            {overflow && <span className="pf-viz-tick--rail" />}
        </span>
    );
}

/** slim rail with a marker positioned proportionally; for time/position cards */
function VizRail({ pos }: { pos: number }) {
    const p = clampPct(pos * 100);
    return (
        <span className="pf-viz pf-viz-rail">
            <span className="pf-viz-rail-track" />
            <span className="pf-viz-rail-marker" style={{ left: `${p}%` }} />
        </span>
    );
}

function buildInsightCards(ins: ProfileInsights): InsightCard[] {
    // weekday index of the busiest day (0=Sun..6=Sat) for the rail position
    const busiestDow = (() => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ins.busiest_day.date);
        if (!m) return undefined;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return Number.isNaN(d.getTime()) ? undefined : d.getDay();
    })();

    const cards: InsightCard[] = [
        {
            q: "How deep do you go?",
            a: fmtPct(ins.deep_session_share),
            s: "of sessions landed a real, non-reverted commit - shipped, not just chatted",
            viz: <VizBar value={ins.deep_session_share} />,
        },
        {
            q: "How many agents at once?",
            a: fmtInt(ins.max_parallel_sessions),
            s: "sessions running in parallel at peak",
            viz: <VizTicks count={ins.max_parallel_sessions} />,
        },
        {
            q: "Longest single run?",
            a: fmtDuration(ins.longest_session_minutes),
            s: "one session, end to end, without letting go",
            viz: <VizRail pos={Math.min(1, ins.longest_session_minutes / (24 * 60))} />,
        },
        {
            q: "When are you most alive?",
            a: <>{fmtHour(ins.peak_hour_utc)}<small> UTC</small></>,
            s: "the hour the graph lights up",
            viz: <VizRail pos={Math.min(1, Math.max(0, ins.peak_hour_utc) / 23)} />,
        },
        {
            q: "Busiest day?",
            a: fmtDay(ins.busiest_day.date),
            s: `${fmtInt(ins.busiest_day.sessions)} sessions in a single day`,
            accent: "ink",
            viz: busiestDow !== undefined ? <VizRail pos={busiestDow / 6} /> : undefined,
        },
        {
            q: "How many hands?",
            a: fmtCompact(ins.subagents_spawned),
            s: "subagents dispatched to do the legwork",
            viz: <VizTicks count={ins.subagents_spawned} />,
        },
        {
            q: "What actually shipped?",
            a: fmtCompact(ins.commits),
            s: "commits landed across the window",
            accent: "ink",
            viz: <VizTicks count={ins.commits} />,
        },
        {
            q: "Time in the loop?",
            a: <>{fmtCompact(ins.hours_total)}<small> hrs</small></>,
            s: "of recorded agent time on the clock",
            accent: "ink",
        },
    ];

    // wrapped-style cards - only shown when fields are present
    if (ins.verification_calls !== undefined && ins.tool_calls !== undefined && ins.tool_calls > 0) {
        const share = ins.verification_calls / ins.tool_calls;
        cards.push({
            q: "How often do you verify?",
            a: fmtPct(share),
            s: `of tool calls are tests, checks, and lints`,
            viz: <VizBar value={share} />,
        });
    }
    if (ins.tool_failures !== undefined && ins.tool_calls !== undefined && ins.tool_calls > 0) {
        const share = ins.tool_failures / ins.tool_calls;
        cards.push({
            q: "Tool failure rate?",
            a: fmtPct(share),
            s: `failed calls across ${fmtCompact(ins.tool_calls)} tool runs`,
            accent: "red",
            viz: <VizBar value={share} tone="red" />,
        });
    }
    if (ins.distinct_skills !== undefined && ins.distinct_tools !== undefined) {
        cards.push({
            q: "How wide is the rig?",
            a: `${fmtInt(ins.distinct_skills)} skills`,
            s: `across ${fmtInt(ins.distinct_tools)} distinct tools`,
            accent: "ink",
            viz: <VizTicks count={ins.distinct_skills} />,
        });
    }
    if (ins.repos_count !== undefined) {
        cards.push({
            q: "How many repos?",
            a: fmtInt(ins.repos_count),
            s: "repositories touched this window",
            viz: <VizTicks count={ins.repos_count} />,
        });
    }

    return cards;
}

interface SkillGroup { readonly source: string; readonly skills: ProfileSkill[]; readonly runs: number }

function groupSkills(skills: readonly ProfileSkill[]): SkillGroup[] {
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

export function UnclaimedDossier({ login }: { login: string }) {
    return (
        <section className="pf-empty">
            <span className="pf-empty-stamp" aria-hidden="true">unclaimed</span>
            <h1>No dossier on file for @{login}.</h1>
            <p>
                ax compiles a public profile from your local agent telemetry - sessions,
                tokens, model split, the rig you've built, the patterns in how you work.
                One command. Your transcripts never leave your machine; only the
                aggregate ships, to a gist you own.
            </p>
            <code className="pf-empty-cmd">ax profile publish</code>
            <p>
                New to ax? <Link to="/">Start here</Link> - install takes 30 seconds,
                the first ingest does the rest.
            </p>
        </section>
    );
}

/* ---------- visitor CTA ---------- */

function VisitorCTA() {
    return (
        <section className="pf-cta" aria-label="get ax">
            <h2 className="pf-cta-headline">This dossier compiled itself.</h2>
            <p className="pf-cta-sub">
                ax measures your real agent usage locally and publishes only the aggregate
                - to a gist you own.
            </p>
            <div className="pf-cta-cmds">
                <code className="pf-cta-cmd">curl -fsSL ax.necmttn.com/install | bash</code>
                <code className="pf-cta-cmd">ax profile publish</code>
            </div>
            <a
                className="pf-cta-repo"
                href="https://github.com/Necmttn/ax"
                target="_blank"
                rel="noopener noreferrer"
            >
                or star the repo →
            </a>
        </section>
    );
}
