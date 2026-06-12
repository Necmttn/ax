// apps/site/app/routes/leaders.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
    fetchLeaderboard,
    fetchSkillStats,
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

const fmt = (n: number): string => Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
const valueLabel: Record<Exclude<Board, "skills">, (v: number) => string> = {
    tokens: fmt,
    sessions: fmt,
    streak: (v) => `${v}d`,
    cost: (v) => `$${v.toFixed(0)}`,
};

type State =
    | { kind: "loading" }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | { kind: "ready"; lb: Leaderboard; skills: SkillStats };

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

    return (
        <>
            <SiteHeader />
            <main className="leaders-page">
                <h1>leaders</h1>
                <p className="muted">
                    Measured from real agent telemetry (last 30 days), self-reported by each
                    user's local ax graph. Join: <code>ax profile publish</code>
                </p>

                {state.kind === "loading" && <p className="muted">loading…</p>}
                {state.kind === "empty" && (
                    <p>No leaderboard compiled yet - be the first: <code>ax profile publish</code></p>
                )}
                {state.kind === "error" && <p className="muted">couldn't load leaderboard: {state.message}</p>}

                {state.kind === "ready" && (
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
                                            <td><Link to="/u/$login" params={{ login: row.login }}>@{row.login}</Link></td>
                                            <td>{valueLabel[board](row.value)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <table className="leaders-table">
                                <thead><tr><th>#</th><th>skill</th><th>users</th><th>runs/30d</th></tr></thead>
                                <tbody>
                                    {Object.entries(state.skills)
                                        .sort(([, a], [, b]) => b.users - a.users || b.runs - a.runs)
                                        .slice(0, 50)
                                        .map(([name, s], i) => (
                                            <tr key={name}>
                                                <td>{i + 1}</td>
                                                <td>{name}</td>
                                                <td>{s.users}</td>
                                                <td>{fmt(s.runs)}</td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
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
