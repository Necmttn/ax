// apps/site/app/routes/leaders.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { ForesightLink } from "@ax/foresight";
import { useEffect, useMemo, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
    fetchLeaderboard,
    fetchSkillStats,
    formatCompact,
    formatUsdCompact,
    skillRouteKey,
    trendingSkills,
    type Leaderboard,
    type SkillStats,
} from "@ax/lib/shared/community";
import { prefetchProfile } from "../profile-cache.ts";

export const Route = createFileRoute("/leaders")({
    head: () => ({
        meta: [
            { title: "ax leaders - measured agent usage" },
            { name: "description", content: "Token, session, streak, and spend leaderboards measured from real agent telemetry. Join with `ax profile publish`." },
        ],
    }),
    component: LeadersPage,
});

// The four ranked metrics, joined into one roster row per builder. `key`
// indexes both the leaderboard board and the RosterRow; clicking a column
// header re-sorts the whole roster by that metric (the old tab-flip showed
// one number at a time - this shows every builder's full receipt at once).
type MetricKey = "tokens" | "sessions" | "cost" | "streak";
const METRICS: ReadonlyArray<{ key: MetricKey; label: string; fmt: (v: number) => string }> = [
    { key: "tokens", label: "tokens", fmt: formatCompact },
    { key: "sessions", label: "sessions", fmt: formatCompact },
    { key: "cost", label: "spend", fmt: formatUsdCompact },
    { key: "streak", label: "streak", fmt: (v) => `${v}d` },
];

// Privacy boundary doc (the gist carries counts/dates/trend only - no transcripts).
const WHAT_GETS_PUBLISHED =
    "https://github.com/Necmttn/ax/blob/main/docs/superpowers/specs/2026-06-12-ax-profiles-design.md#privacy";

type State =
    | { kind: "loading" }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | { kind: "ready"; lb: Leaderboard; skills: SkillStats };

interface RosterRow {
    readonly login: string;
    tokens?: number;
    sessions?: number;
    cost?: number;
    streak?: number;
}

// Fold the four independently-sorted boards into one row per builder.
function buildRoster(lb: Leaderboard): RosterRow[] {
    const byLogin = new Map<string, RosterRow>();
    const merge = (key: MetricKey, rows: Leaderboard["boards"][MetricKey]) => {
        for (const r of rows) {
            const row = byLogin.get(r.login) ?? { login: r.login };
            row[key] = r.value;
            byLogin.set(r.login, row);
        }
    };
    merge("tokens", lb.boards.tokens);
    merge("sessions", lb.boards.sessions);
    merge("cost", lb.boards.cost);
    merge("streak", lb.boards.streak);
    return [...byLogin.values()];
}

function LeadersPage() {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [sort, setSort] = useState<MetricKey>("tokens");

    useEffect(() => {
        let alive = true;
        Promise.all([fetchLeaderboard(), fetchSkillStats().catch(() => ({}) as SkillStats)])
            .then(([lb, skills]) => alive && setState({ kind: "ready", lb, skills }))
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound ? { kind: "empty" } : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, []);

    const roster = useMemo(
        () => (state.kind === "ready" ? buildRoster(state.lb) : []),
        [state],
    );
    const sorted = useMemo(() => {
        const v = (r: RosterRow) => r[sort] ?? Number.NEGATIVE_INFINITY;
        return [...roster].sort((a, b) => v(b) - v(a) || a.login.localeCompare(b.login));
    }, [roster, sort]);
    const max = useMemo(
        () => Math.max(1, ...sorted.map((r) => r[sort] ?? 0)),
        [sorted, sort],
    );

    const empty = state.kind === "empty" || (state.kind === "ready" && roster.length === 0);

    return (
        <>
            <SiteHeader />
            <main className="leaders-page">
                <header className="lb-head">
                    <h1>leaders</h1>
                    <p className="muted">
                        Ranked from real agent telemetry, self-reported by each builder's local ax
                        graph and recompiled nightly. Join in one command: <code>ax profile publish</code>
                    </p>
                    {state.kind === "ready" && !empty && (
                        <p className="lb-meta">
                            <strong>{roster.length}</strong> {roster.length === 1 ? "builder" : "builders"}
                            {" · "}last {state.lb.window_days}d
                            {state.lb.compiled_at !== "" && (
                                <> · compiled {state.lb.compiled_at.slice(0, 16).replace("T", " ")} UTC</>
                            )}
                        </p>
                    )}
                </header>

                {state.kind === "loading" && <p className="muted">loading…</p>}
                {empty && <FoundingState />}
                {state.kind === "error" && <p className="muted">couldn't load leaderboard: {state.message}</p>}

                {state.kind === "ready" && !empty && (
                    <>
                        <table className="lb-roster">
                            <thead>
                                <tr>
                                    <th className="lb-rank">#</th>
                                    <th className="lb-who">builder</th>
                                    {METRICS.map((m) => (
                                        <th
                                            key={m.key}
                                            className="lb-num"
                                            data-active={sort === m.key}
                                            aria-sort={sort === m.key ? "descending" : "none"}
                                        >
                                            <button type="button" onClick={() => setSort(m.key)}>
                                                {m.label}
                                                <span className="lb-caret" aria-hidden>{sort === m.key ? "▾" : ""}</span>
                                            </button>
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {sorted.map((row, i) => (
                                    <tr key={row.login} data-lead={i === 0}>
                                        <td className="lb-rank">{i + 1}</td>
                                        <td className="lb-who">
                                            <ForesightLink
                                                to="/u/$login"
                                                params={{ login: row.login }}
                                                search={{ vs: undefined }}
                                                prefetchData={() => prefetchProfile(row.login)}
                                            >
                                                <img
                                                    className="lb-avatar"
                                                    src={`https://github.com/${row.login}.png?size=48`}
                                                    alt=""
                                                    width={24}
                                                    height={24}
                                                    loading="lazy"
                                                />
                                                <span>@{row.login}</span>
                                            </ForesightLink>
                                        </td>
                                        {METRICS.map((m) => {
                                            const v = row[m.key];
                                            const active = sort === m.key;
                                            return (
                                                <td key={m.key} className="lb-num" data-active={active}>
                                                    {active && v != null && (
                                                        <span className="lb-bar" style={{ width: `${Math.max(2, (v / max) * 100)}%` }} aria-hidden />
                                                    )}
                                                    <span className="lb-val">{v == null ? "-" : m.fmt(v)}</span>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        <JoinBand />

                        <TrendingSkills skills={state.skills} />
                    </>
                )}
            </main>
            <SiteFooter />
        </>
    );
}

// Slim "you're next" band - woven below the live board, never a takeover. The
// board already proves the boards are real; this just hands you the command.
function JoinBand() {
    return (
        <aside className="lb-join">
            <code className="lb-join-cmd">$ ax profile publish</code>
            <span className="lb-join-copy">
                ranks what your local ax graph measured - counts, dates, and trends only.{" "}
                <a href={WHAT_GETS_PUBLISHED} target="_blank" rel="noreferrer">what gets published →</a>
            </span>
        </aside>
    );
}

function TrendingSkills({ skills }: { readonly skills: SkillStats }) {
    const rows = trendingSkills(skills);
    if (rows.length === 0) return null;
    const maxRuns = Math.max(1, ...rows.map(([, s]) => s.runs));
    return (
        <section className="lb-skills">
            <h2>trending skills</h2>
            <p className="muted">Skills adopted by 2+ builders, however each installed them.</p>
            <ol className="lb-skill-list">
                {rows.map(([name, s], i) => {
                    // Keys are canonical skill identities (bare names); the badge
                    // shows the best-known install source, but only when it's a
                    // real plugin (a purely-`local` skill gets no badge).
                    const source = s.source && s.source !== "local" ? s.source : "";
                    return (
                        <li key={name} className="lb-skill">
                            <span className="lb-skill-rank">{i + 1}</span>
                            <Link className="lb-skill-name" to="/skills/$key" params={{ key: skillRouteKey(name, s) }}>
                                {source && <span className="lb-skill-src">{source}</span>}
                                {name}
                            </Link>
                            <span className="lb-skill-users">{s.users} builders</span>
                            <span className="lb-skill-runs">
                                <span className="lb-bar" style={{ width: `${Math.max(4, (s.runs / maxRuns) * 100)}%` }} aria-hidden />
                                <span className="lb-val">{formatCompact(s.runs)}<small>/30d</small></span>
                            </span>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}

/**
 * Founding / empty state - shown ONLY when the board has zero builders. Make it
 * earn its place: a real CTA, a paper-stub render of the exact JSON shape that
 * gets published, and an honest "what gets published" privacy link.
 */
function FoundingState() {
    return (
        <section className="leaders-founding">
            <p className="lf-eyebrow">$ ax profile publish</p>
            <h2 className="lf-headline">No one is on the board yet - be #1.</h2>
            <p className="lf-lede">
                The boards rank what your local ax graph actually measured - tokens, sessions,
                streak, spend - and rebuild nightly. They fill in as builders opt in. One command
                publishes yours.
            </p>

            <figure className="lf-stub" aria-label="example published profile">
                <figcaption className="lf-stub-cap">~/.ax · ax-profile.json (the shape that gets published)</figcaption>
                <pre className="lf-stub-body">{STUB_JSON}</pre>
            </figure>

            <p className="lf-foot muted">
                Counts, dates, and trends only - never transcripts, code, or paths.{" "}
                <a href={WHAT_GETS_PUBLISHED} target="_blank" rel="noreferrer">what gets published →</a>
            </p>
            <p className="lf-prov muted">
                Compiled nightly from registered gists · source:{" "}
                <a href="https://github.com/Necmttn/ax/tree/community-data/community" target="_blank" rel="noreferrer">
                    community/leaderboard.json
                </a>
            </p>
        </section>
    );
}

// A trimmed, honest stub of the published ProfileV1 shape (aggregates only).
const STUB_JSON = `{
  "v": 1,
  "github": "you",
  "window_days": 30,
  "stats": {
    "sessions": 412,
    "streak_days": 9,
    "tokens": { "total": 1840000000 },
    "cost_usd": 605,
    "harnesses": ["claude", "codex"]
  },
  "rig": {
    "skills": [
      { "name": "superpowers:tdd", "source": "superpowers", "runs": 88 }
    ],
    "hooks": ["enforce-worktree"],
    "routing_table": true
  }
}`;
