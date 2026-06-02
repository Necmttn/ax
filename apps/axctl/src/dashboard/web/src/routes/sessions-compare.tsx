import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    SessionCompareEntry,
    SessionId,
} from "@shared/dashboard-types.ts";
import { shortSessionId } from "@shared/session-id.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";

const fmtDuration = (ms: number | null): string => {
    if (ms === null) return "-";
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${s}s`;
};

const fmtTokens = (n: number | null | undefined): string => {
    if (n === null || n === undefined) return "-";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
};

const fmtCost = (n: number | null | undefined): string =>
    n === null || n === undefined ? "-" : `$${n.toFixed(2)}`;

const fmtInt = (n: number | null | undefined): string =>
    n === null || n === undefined ? "-" : String(n);

const laneTag = (i: number): string => `[${i + 1}]`;

interface MetricRow {
    readonly label: string;
    readonly value: (e: SessionCompareEntry) => string;
    readonly winner?: SessionId | null;
    /** Lower-is-better axes get the winner highlight. */
    readonly ranked?: boolean;
}

export function SessionsCompareRoute() {
    const search = useSearch({ from: "/sessions/compare" });
    const ids = (search.ids ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const turns = search.turns === true;

    const query = useQuery({
        queryKey: ["sessions-compare", ids.join(","), turns],
        queryFn: () => api.sessionCompare(ids, { turns }),
        enabled: ids.length >= 2,
    });
    const data = query.data ?? null;
    const sessions = data?.sessions ?? [];

    const rows = useMemo<ReadonlyArray<MetricRow>>(() => {
        if (!data) return [];
        const w = data.winners;
        return [
            { label: "source", value: (e) => e.source },
            { label: "model", value: (e) => e.model ?? "-" },
            { label: "duration", value: (e) => fmtDuration(e.duration_ms), winner: w.fastest, ranked: true },
            { label: "turns", value: (e) => fmtInt(e.health?.turns ?? null) },
            { label: "tokens", value: (e) => fmtTokens(e.token_usage?.estimated_tokens ?? null), winner: w.fewest_tokens, ranked: true },
            { label: "cost", value: (e) => fmtCost(e.token_usage?.estimated_cost_usd ?? null), winner: w.cheapest, ranked: true },
            { label: "tool calls", value: (e) => fmtInt(e.health?.tool_calls ?? null) },
            { label: "tool errors", value: (e) => fmtInt(e.health?.tool_errors ?? null) },
            { label: "corrections", value: (e) => fmtInt(e.health?.user_corrections ?? null) },
            { label: "interruptions", value: (e) => fmtInt(e.health?.interruptions ?? null) },
            { label: "noise (err+corr+int)", value: (e) => fmtInt(e.noise_score), winner: w.cleanest, ranked: true },
            { label: "commits", value: (e) => fmtInt(e.commit_count) },
        ];
    }, [data]);

    const maxTurnTokens = useMemo(() => {
        let max = 0;
        for (const s of sessions) {
            for (const t of s.turns ?? []) {
                if (t.est_tokens && t.est_tokens > max) max = t.est_tokens;
            }
        }
        return max;
    }, [sessions]);

    const hasTurns = sessions.some((s) => (s.turns?.length ?? 0) > 0);
    const maxTurnCount = Math.max(0, ...sessions.map((s) => s.turns?.length ?? 0));

    return (
        <section className="panel">
            <header>
                <h2>Compare sessions</h2>
                <span className="meta">
                    {data
                        ? `${sessions.length} sessions${data.task_label ? ` · task: ${data.task_label}` : " · task: (mixed)"}`
                        : ""}
                </span>
            </header>

            {ids.length < 2 ? (
                <div className="empty">
                    Select 2+ sessions to compare (from the Sessions list), or open
                    <code> /sessions/compare?ids=a,b</code>.
                </div>
            ) : null}

            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {query.isLoading ? <div className="loading">Loading…</div> : null}

            {data && data.not_found.length > 0 ? (
                <div className="error">Not found: {data.not_found.join(", ")}</div>
            ) : null}

            {data && sessions.length >= 2 ? (
                <>
                    {/* Lane legend */}
                    <ul className="compare-legend">
                        {sessions.map((s, i) => (
                            <li key={s.session_id}>
                                <span className="lane-tag">{laneTag(i)}</span>{" "}
                                <Link to="/sessions/$sessionId" params={{ sessionId: s.session_id }}>
                                    {shortSessionId(s.session_id)}
                                </Link>
                                {s.project ? (
                                    <small className="meta"> · {prettifyProjectSlug(s.project)}</small>
                                ) : null}
                            </li>
                        ))}
                    </ul>

                    {/* Summary strip */}
                    <table className="skills compare-table">
                        <thead>
                            <tr>
                                <th>metric</th>
                                {sessions.map((s, i) => (
                                    <th key={s.session_id} className="num">{laneTag(i)}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.label}>
                                    <td className="skill-cell">{row.label}</td>
                                    {sessions.map((s) => {
                                        const isWin = row.ranked && row.winner === s.session_id;
                                        return (
                                            <td key={s.session_id} className={`num${isWin ? " win" : ""}`}>
                                                {isWin ? <strong>{row.value(s)} ★</strong> : row.value(s)}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {/* Per-turn swimlane */}
                    {turns && hasTurns ? (
                        <div className="swimlane-wrap">
                            <h3>Per-turn (index-aligned · brightness = tokens · red = error)</h3>
                            <div
                                className="swimlane"
                                style={{ gridTemplateColumns: `repeat(${sessions.length}, minmax(80px, 1fr))` }}
                            >
                                {sessions.map((s, i) => (
                                    <div key={s.session_id} className="swimlane-col">
                                        <div className="swimlane-head">{laneTag(i)}</div>
                                        {Array.from({ length: maxTurnCount }, (_, ti) => {
                                            const t = s.turns?.[ti];
                                            if (!t) return <div key={ti} className="turn-cell empty" />;
                                            const intensity = maxTurnTokens > 0 && t.est_tokens
                                                ? Math.max(0.12, t.est_tokens / maxTurnTokens)
                                                : 0.06;
                                            return (
                                                <div
                                                    key={ti}
                                                    className={`turn-cell${t.has_error ? " err" : ""}`}
                                                    style={{ background: `rgba(56, 189, 248, ${intensity})` }}
                                                    title={`turn ${t.seq} · ${t.role ?? "?"} · ${fmtTokens(t.est_tokens)} tok${t.gap_ms != null ? ` · gap ${Math.round(t.gap_ms / 1000)}s` : ""}${t.has_error ? " · ERROR" : ""}`}
                                                >
                                                    {fmtTokens(t.est_tokens)}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </>
            ) : null}
        </section>
    );
}
