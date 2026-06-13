// apps/site/app/routes/leaders.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
    fetchLeaderboard,
    fetchSkillStats,
    formatCompact,
    formatUsd,
    trendingSkills,
    type Leaderboard,
    type SkillStats,
} from "~/lib/community";

export const Route = createFileRoute("/leaders")({
    head: () => ({
        meta: [
            { title: "ax leaders - measured agent usage" },
            { name: "description", content: "Token, session, streak, and spend leaderboards measured from real agent telemetry. Join with `ax profile publish`." },
        ],
    }),
    component: LeadersPage,
});

const BOARDS = ["tokens", "sessions", "streak", "cost", "skills"] as const;
type Board = (typeof BOARDS)[number];

// Below this many entrants the boards are technically valid but socially empty -
// render the founding state instead of a one-row "leaderboard".
const FOUNDING_THRESHOLD = 5;

const valueLabel: Record<Exclude<Board, "skills">, (v: number) => string> = {
    tokens: formatCompact,
    sessions: formatCompact,
    streak: (v) => `${v}d`,
    cost: formatUsd,
};

// Privacy boundary doc (the gist carries counts/dates/trend only - no transcripts).
const WHAT_GETS_PUBLISHED =
    "https://github.com/Necmttn/ax/blob/main/docs/superpowers/specs/2026-06-12-ax-profiles-design.md#privacy";

type State =
    | { kind: "loading" }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | { kind: "ready"; lb: Leaderboard; skills: SkillStats };

function entrantCount(lb: Leaderboard): number {
    const logins = new Set<string>();
    for (const board of [lb.boards.tokens, lb.boards.sessions, lb.boards.streak, lb.boards.cost]) {
        for (const row of board) logins.add(row.login);
    }
    return logins.size;
}

function LeadersPage() {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [board, setBoard] = useState<Board>("tokens");

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

    const founding = state.kind === "ready" && entrantCount(state.lb) < FOUNDING_THRESHOLD;

    return (
        <>
            <SiteHeader />
            <main className="leaders-page">
                <h1>leaders</h1>
                <p className="muted">
                    Measured from real agent telemetry (last{" "}
                    {state.kind === "ready" ? state.lb.window_days : 30} days), self-reported
                    by each user's local ax graph. Join: <code>ax profile publish</code>
                </p>

                {state.kind === "loading" && <p className="muted">loading…</p>}
                {(state.kind === "empty" || founding) && (
                    <FoundingState entrants={state.kind === "ready" ? entrantCount(state.lb) : 0} />
                )}
                {state.kind === "error" && <p className="muted">couldn't load leaderboard: {state.message}</p>}

                {state.kind === "ready" && !founding && (
                    <>
                        <div className="leaders-tabs" role="tablist">
                            {BOARDS.map((b) => (
                                <button key={b} role="tab" aria-selected={board === b} onClick={() => setBoard(b)}>
                                    {b === "skills" ? "trending skills" : b}
                                </button>
                            ))}
                        </div>

                        {board !== "skills" ? (
                            <table className="leaders-table">
                                <thead><tr><th>#</th><th>user</th><th>{board}</th></tr></thead>
                                <tbody>
                                    {state.lb.boards[board].map((row, i) => (
                                        <tr key={row.login}>
                                            <td>{i + 1}</td>
                                            <td><Link to="/u/$login" params={{ login: row.login }} search={{ vs: undefined }}>@{row.login}</Link></td>
                                            <td>{valueLabel[board](row.value)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <TrendingSkillsTable skills={state.skills} />
                        )}

                        {state.lb.compiled_at !== "" && (
                            <p className="muted">compiled {state.lb.compiled_at.slice(0, 16).replace("T", " ")} UTC · refreshes nightly</p>
                        )}
                    </>
                )}
            </main>
            <SiteFooter />
        </>
    );
}

function TrendingSkillsTable({ skills }: { readonly skills: SkillStats }) {
    const rows = trendingSkills(skills);
    if (rows.length === 0) {
        return (
            <p className="muted">
                No skill trends yet - a skill trends once <strong>2+ builders</strong> publish
                it (personal <code>local:*</code> skills don't count). Check back after the
                next nightly compile.
            </p>
        );
    }
    return (
        <table className="leaders-table">
            <thead><tr><th>#</th><th>skill</th><th>users</th><th>runs/30d</th></tr></thead>
            <tbody>
                {rows.map(([name, s], i) => (
                    <tr key={name}>
                        <td>{i + 1}</td>
                        <td>{name}</td>
                        <td>{s.users}</td>
                        <td>{formatCompact(s.runs)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

/**
 * Founding / empty state. The boards are legitimately empty until the nightly
 * compile picks up enough entrants - so make it earn its place: a real CTA, a
 * paper-stub render of the exact JSON shape that gets published, and an honest
 * "what gets published" privacy link. Never look broken.
 */
function FoundingState({ entrants }: { readonly entrants: number }) {
    const headline =
        entrants <= 0
            ? "No one is on the board yet - be #1."
            : entrants === 1
                ? "1 builder is publishing receipts - be #2."
                : `${entrants} builders are publishing receipts - join them.`;
    return (
        <section className="leaders-founding">
            <p className="lf-eyebrow">$ ax profile publish</p>
            <h2 className="lf-headline">{headline}</h2>
            <p className="lf-lede">
                The boards rank what your local ax graph actually measured - tokens,
                sessions, streak, spend - and rebuild nightly. They fill in as builders
                opt in. One command publishes yours.
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
