// apps/site/app/routes/u.$login.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
    fetchProfile,
    type ProfileV1,
    type ProfileDailyRow,
    type ProfileInsights,
    type ProfileSkill,
} from "~/lib/community";

export const Route = createFileRoute("/u/$login")({
    head: ({ params }) => ({
        meta: [
            { title: `@${params.login} - ax profile` },
            { name: "description", content: `${params.login}'s agent profile: usage, rig, and taste from the ax graph.` },
        ],
    }),
    component: ProfilePage,
});

type State =
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; profile: ProfileV1 };

function ProfilePage() {
    const { login } = Route.useParams();
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        fetchProfile(login)
            .then((profile) => {
                if (!alive) return;
                // Identity binding: the registered login must match the
                // gist's claimed github handle, else a hostile gist could
                // impersonate another user on its /u/ page.
                if (profile.github.toLowerCase() !== login.toLowerCase()) {
                    setState({ kind: "error", message: "profile identity mismatch" });
                    return;
                }
                setState({ kind: "ready", profile });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound
                    ? { kind: "not-found" }
                    : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [login]);

    return (
        <>
            <SiteHeader />
            <main className="profile-page">
                {state.kind === "loading" && <p className="pf-loading">pulling the dossier on @{login}…</p>}
                {state.kind === "not-found" && <UnclaimedDossier login={login} />}
                {state.kind === "error" && <p className="pf-loading">couldn't load profile: {state.message}</p>}
                {state.kind === "ready" && <ProfileDossier profile={state.profile} />}
            </main>
            <SiteFooter />
        </>
    );
}

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

function ProfileDossier({ profile: p }: { profile: ProfileV1 }) {
    const daily = p.activity && p.activity.daily.length > 0
        ? [...p.activity.daily].sort((a, b) => (a.date < b.date ? -1 : 1))
        : [];
    const ins = p.insights;
    const models = [...p.stats.models].sort((a, b) => b.share - a.share);
    const tools = ins && ins.tools_top.length > 0 ? ins.tools_top.slice(0, 10) : [];
    let section = 0;
    const nextSection = (): string => String(++section).padStart(2, "0");

    return (
        <article className="pf-dossier">
            {/* nameplate */}
            <header className="pf-mast">
                <div className="pf-mast-kicker">
                    <span>agent telemetry dossier</span>
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

            {/* the window: activity timeline + model split, one story */}
            <section className="pf-section">
                <Kicker n={nextSection()} title="The window" note={`last ${p.window_days} days`} />
                <div className={daily.length > 0 ? "pf-window" : "pf-window pf-window--solo"}>
                    {daily.length > 0 && <ActivityTimeline daily={daily} busiest={ins?.busiest_day.date} />}
                    <div className="pf-models">
                        <div className="pf-models-head">
                            model split · {fmtInt(p.stats.sessions)} sessions over {p.window_days} days
                        </div>
                        {models.map((m, i) => (
                            <div className="pf-model" key={`${m.name}-${i}`}>
                                <div className="pf-model-top">
                                    <span className="pf-model-name">{m.name}</span>
                                    <span className="pf-model-meta">
                                        <strong>{fmtPct(m.share)}</strong>
                                        {m.cost_usd !== undefined ? ` · ~${fmtMoney(m.cost_usd)}` : ""}
                                    </span>
                                </div>
                                <span className="pf-model-track">
                                    <span
                                        className={i === 0 ? "pf-model-fill pf-model-fill--lead" : "pf-model-fill"}
                                        style={{ width: `${clampPct(m.share * 100)}%` }}
                                    />
                                </span>
                            </div>
                        ))}
                        {models.length === 0 && <p className="pf-quiet">no model data in this window.</p>}
                    </div>
                </div>
            </section>

            {/* wrapped-style insight cards */}
            {ins && (
                <section className="pf-section">
                    <Kicker n={nextSection()} title="The shape of the work" note="derived from session telemetry" />
                    <div className="pf-cards">
                        {buildInsightCards(ins).map((c) => (
                            <div className="pf-card" key={c.q}>
                                <span className="pf-card-q">{c.q}</span>
                                <span className="pf-card-a">{c.a}</span>
                                <span className="pf-card-s">{c.s}</span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* tool taste */}
            {tools.length > 0 && (
                <section className="pf-section">
                    <Kicker n={nextSection()} title="Tool taste" note="what the hands actually reach for" />
                    <div className="pf-tools">
                        {tools.map((t, i) => {
                            const max = tools[0]?.runs ?? 0;
                            const w = max > 0 ? clampPct((t.runs / max) * 100) : 0;
                            return (
                                <div className="pf-tool" key={`${t.name}-${i}`}>
                                    <span className="pf-tool-rank">{String(i + 1).padStart(2, "0")}</span>
                                    <span className="pf-tool-name">{t.name}</span>
                                    <span className="pf-tool-track" aria-hidden="true">
                                        <span
                                            className={i === 0 ? "pf-tool-bar pf-tool-bar--lead" : "pf-tool-bar"}
                                            style={{ width: `${w}%` }}
                                        />
                                    </span>
                                    <span className="pf-tool-runs">{fmtCompact(t.runs)}</span>
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* the rig: skills grouped by source + guardrails */}
            <section className="pf-section">
                <Kicker n={nextSection()} title="The rig" note={`${fmtInt(p.rig.skills.length)} skills · ${fmtInt(p.rig.hooks.length)} hooks`} />
                <div className="pf-rig">
                    <div className="pf-rig-skills">
                        {groupSkills(p.rig.skills).map((g) => (
                            <div className="pf-rig-group" key={g.source}>
                                <div className="pf-rig-group-head">
                                    <span>{g.source}</span>
                                    <span>{fmtInt(g.skills.length)} skills · {fmtCompact(g.runs)} runs</span>
                                </div>
                                {g.skills.slice(0, 10).map((s) => (
                                    <div className="pf-skill" key={s.name}>
                                        <span className="pf-skill-name">{s.name}</span>
                                        <span className="pf-skill-runs">{fmtCompact(s.runs)} runs</span>
                                    </div>
                                ))}
                                {g.skills.length > 10 && (
                                    <div className="pf-rig-more">+ {fmtInt(g.skills.length - 10)} more</div>
                                )}
                            </div>
                        ))}
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

function ActivityTimeline({ daily, busiest }: { daily: readonly ProfileDailyRow[]; busiest?: string }) {
    const maxSessions = daily.reduce((m, d) => Math.max(m, d.sessions), 0);
    const maxTokens = daily.reduce((m, d) => Math.max(m, d.tokens), 0);
    const totalSessions = daily.reduce((s, d) => s + d.sessions, 0);
    const avg = daily.length > 0 ? totalSessions / daily.length : 0;
    const first = daily[0];
    const last = daily[daily.length - 1];
    return (
        <div className="pf-activity">
            <div
                className="pf-chart"
                role="img"
                aria-label={`daily sessions over ${daily.length} days, peaking at ${fmtInt(maxSessions)}`}
            >
                {daily.map((d) => {
                    const h = maxSessions > 0 ? clampPct((d.sessions / maxSessions) * 100) : 0;
                    const q = maxTokens > 0 ? Math.min(4, Math.max(1, Math.ceil((d.tokens / maxTokens) * 4))) : 1;
                    const peak = busiest !== undefined && d.date === busiest;
                    return (
                        <span
                            className="pf-chart-day"
                            key={d.date}
                            title={`${d.date} · ${fmtInt(d.sessions)} sessions · ${fmtCompact(d.tokens)} tokens`}
                        >
                            <span
                                className={`pf-chart-fill pf-q${q}${peak ? " is-peak" : ""}`}
                                style={{ height: `${Math.max(h, d.sessions > 0 ? 3 : 0)}%` }}
                            />
                        </span>
                    );
                })}
            </div>
            <div className="pf-chart-axis">
                <span>{first ? fmtDay(first.date) : ""}</span>
                <span className="pf-chart-axis-mid">~{fmtInt(avg)} sessions/day · darker = heavier token days{busiest !== undefined ? " · peak in red" : ""}</span>
                <span>{last ? fmtDay(last.date) : ""}</span>
            </div>
        </div>
    );
}

interface InsightCard { readonly q: string; readonly a: ReactNode; readonly s: string }

function buildInsightCards(ins: ProfileInsights): InsightCard[] {
    const cards: InsightCard[] = [
        {
            q: "How deep do you go?",
            a: fmtPct(ins.deep_session_share),
            s: "of sessions ran 90+ minutes - deliberate, not drive-by",
        },
        {
            q: "How many agents at once?",
            a: fmtInt(ins.max_parallel_sessions),
            s: "sessions running in parallel at peak",
        },
        {
            q: "Longest single run?",
            a: fmtDuration(ins.longest_session_minutes),
            s: "one session, end to end, without letting go",
        },
        {
            q: "When are you most alive?",
            a: <>{fmtHour(ins.peak_hour_utc)}<small> UTC</small></>,
            s: "the hour the graph lights up",
        },
        {
            q: "Busiest day?",
            a: fmtDay(ins.busiest_day.date),
            s: `${fmtInt(ins.busiest_day.sessions)} sessions in a single day`,
        },
        {
            q: "How many hands?",
            a: fmtCompact(ins.subagents_spawned),
            s: "subagents dispatched to do the legwork",
        },
        {
            q: "What actually shipped?",
            a: fmtCompact(ins.commits),
            s: "commits landed across the window",
        },
        {
            q: "Time in the loop?",
            a: <>{fmtCompact(ins.hours_total)}<small> hrs</small></>,
            s: "of recorded agent time on the clock",
        },
    ];

    // wrapped-style cards - only shown when fields are present
    if (ins.verification_calls !== undefined && ins.tool_calls !== undefined && ins.tool_calls > 0) {
        cards.push({
            q: "How often do you verify?",
            a: fmtPct(ins.verification_calls / ins.tool_calls),
            s: `of tool calls are tests, checks, and lints`,
        });
    }
    if (ins.tool_failures !== undefined && ins.tool_calls !== undefined && ins.tool_calls > 0) {
        cards.push({
            q: "Tool failure rate?",
            a: fmtPct(ins.tool_failures / ins.tool_calls),
            s: `failed calls across ${fmtCompact(ins.tool_calls)} tool runs`,
        });
    }
    if (ins.distinct_skills !== undefined && ins.distinct_tools !== undefined) {
        cards.push({
            q: "How wide is the rig?",
            a: `${fmtInt(ins.distinct_skills)} skills`,
            s: `across ${fmtInt(ins.distinct_tools)} distinct tools`,
        });
    }
    if (ins.repos_count !== undefined) {
        cards.push({
            q: "How many repos?",
            a: fmtInt(ins.repos_count),
            s: "repositories touched this window",
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

function UnclaimedDossier({ login }: { login: string }) {
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
