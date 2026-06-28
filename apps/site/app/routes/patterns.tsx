// apps/site/app/routes/patterns.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { SiteHeader } from "~/components/landing-sections/site-header";
import {
    fetchPatternStats,
    formatCompact,
    trendingPatterns,
    type PatternStats,
    type PatternStatsRow,
} from "~/lib/community";

export const Route = createFileRoute("/patterns")({
    head: () => ({
        meta: [
            { title: "ax patterns - community recovery mesh" },
            { name: "description", content: "Community taste patterns aggregated from published ax profiles, including cross-user failure to recovery joins." },
        ],
    }),
    component: PatternsPage,
});

type State =
    | { kind: "loading" }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | { kind: "ready"; stats: PatternStats };

function PatternsPage() {
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        fetchPatternStats()
            .then((stats) => {
                if (!alive) return;
                setState(Object.keys(stats.patterns).length === 0 ? { kind: "empty" } : { kind: "ready", stats });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound ? { kind: "empty" } : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, []);

    const rows = useMemo(
        () => (state.kind === "ready" ? trendingPatterns(state.stats) : []),
        [state],
    );
    const totals = useMemo(() => {
        if (state.kind !== "ready") return { sessions: 0, recoveries: 0 };
        const sessions = rows.reduce((sum, [, row]) => sum + row.sessions, 0);
        const recoveries = rows.reduce((sum, [, row]) => sum + recoveryEntries(row).length, 0);
        return { sessions, recoveries };
    }, [rows, state]);

    return (
        <>
            <SiteHeader />
            <main className="patterns-page">
                <header className="pt-head">
                    <h1>patterns</h1>
                    <p className="muted">
                        Taste patterns published by builders, folded into one community mesh. Failure modes link to recovery patterns when another builder has contributed the fix.
                    </p>
                    {state.kind === "ready" && (
                        <p className="pt-meta">
                            <strong>{rows.length}</strong> patterns
                            {" · "}<strong>{formatCompact(totals.sessions)}</strong> evidence sessions
                            {" · "}<strong>{totals.recoveries}</strong> recovery joins
                            {state.stats.compiled_at !== "" && (
                                <> · compiled {state.stats.compiled_at.slice(0, 16).replace("T", " ")} UTC</>
                            )}
                            {state.stats.dropped.length > 0 && (
                                <> · {state.stats.dropped.length} dropped rows reported</>
                            )}
                        </p>
                    )}
                </header>

                {state.kind === "loading" && <p className="muted">loading...</p>}
                {state.kind === "empty" && <EmptyPatterns />}
                {state.kind === "error" && <p className="muted">couldn't load patterns: {state.message}</p>}

                {state.kind === "ready" && rows.length > 0 && (
                    <table className="pt-table">
                        <thead>
                            <tr>
                                <th className="pt-rank">#</th>
                                <th>pattern</th>
                                <th className="pt-num">builders</th>
                                <th className="pt-num">sessions</th>
                                <th>recovery joins</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(([key, row], i) => (
                                <tr key={key} data-lead={i === 0}>
                                    <td className="pt-rank">{i + 1}</td>
                                    <td className="pt-name-cell">
                                        <span className="pt-cat">{row.category}</span>
                                        <span className="pt-name">{row.name}</span>
                                    </td>
                                    <td className="pt-num">{formatCompact(row.users)}</td>
                                    <td className="pt-num">{formatCompact(row.sessions)}</td>
                                    <td className="pt-recoveries">
                                        <RecoveryList row={row} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </main>
            <SiteFooter />
        </>
    );
}

function recoveryEntries(row: PatternStatsRow): Array<readonly [string, { readonly users: number; readonly sessions: number }]> {
    return Object.entries(row.recovered_by ?? {})
        .sort(([ak, a], [bk, b]) => b.users - a.users || b.sessions - a.sessions || ak.localeCompare(bk));
}

function RecoveryList({ row }: { readonly row: PatternStatsRow }) {
    const recoveries = recoveryEntries(row);
    if (recoveries.length === 0) return <span className="pt-none">-</span>;
    return (
        <ul className="pt-recovery-list">
            {recoveries.map(([key, recovery]) => {
                const slash = key.indexOf("/");
                const name = slash === -1 ? key : key.slice(slash + 1);
                return (
                    <li key={key}>
                        <span className="pt-recovery-name">{name}</span>
                        <span className="pt-recovery-count">
                            {formatCompact(recovery.users)} builders · {formatCompact(recovery.sessions)} sessions
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

function EmptyPatterns() {
    return (
        <section className="leaders-founding">
            <p className="lf-eyebrow">community mesh</p>
            <h2 className="lf-headline">No shared patterns have landed yet.</h2>
            <p className="lf-lede">
                Patterns appear here as builders publish profiles with taste patterns. The first rows will show adoption counts, then failure-to-recovery joins as the mesh connects.
            </p>
            <p className="lf-foot muted">
                Start from <Link to="/leaders">the community leaders</Link> or publish your own aggregate profile with <code>ax profile publish</code>.
            </p>
        </section>
    );
}
