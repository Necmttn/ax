import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import type {
    ToolFailureDetailPayload,
    ToolFailureEntry,
    ToolFailureRecommendation,
    ToolFailuresResponse,
} from "@shared/dashboard-types.ts";
import { fmtCount, fmtLastUsed, fmtTs } from "@shared/formatters.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";

type Filter = "all" | "fix" | "watch" | "ignore";

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
    { key: "fix", label: "Fix" },
    { key: "watch", label: "Watch" },
    { key: "ignore", label: "Ignore" },
    { key: "all", label: "All" },
];

const filterRows = (
    rows: ReadonlyArray<ToolFailureEntry>,
    filter: Filter,
    search: string,
): ReadonlyArray<ToolFailureEntry> => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
        if (filter !== "all" && r.recommendation !== filter) return false;
        if (q && !r.label.toLowerCase().includes(q)) return false;
        return true;
    });
};


export function ToolFailuresRoute() {
    const queryClient = useQueryClient();
    const failuresQuery = useQuery({
        queryKey: ["tool-failures"],
        queryFn: () => api.toolFailures(),
    });
    const data = failuresQuery.data ?? null;
    const [actionError, setError] = useState<string | null>(null);
    const error =
        actionError ?? (failuresQuery.error ? String(failuresQuery.error) : null);
    const loading = failuresQuery.isLoading;
    const refreshing = failuresQuery.isFetching && !failuresQuery.isLoading;
    const [filter, setFilter] = useState<Filter>("fix");
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

    const load = async (_mode: "initial" | "refresh" = "refresh") => {
        await failuresQuery.refetch();
    };

    const visible = useMemo(
        () => (data ? filterRows(data.failures, filter, search) : []),
        [data, filter, search],
    );

    const totals = useMemo(() => {
        if (!data) return null;
        let fix = 0;
        let watch = 0;
        let ignore = 0;
        for (const f of data.failures) {
            if (f.recommendation === "fix") fix += 1;
            else if (f.recommendation === "watch") watch += 1;
            else ignore += 1;
        }
        return { total: data.failures.length, fix, watch, ignore };
    }, [data]);

    const toggleExpanded = (row: ToolFailureEntry) => {
        const isOpen = expanded.has(row.label);
        setExpanded((curr) => {
            const next = new Set(curr);
            if (isOpen) next.delete(row.label);
            else next.add(row.label);
            return next;
        });
        // Prefetch on open if not already cached - useQuery in the row will
        // pick up the cached data and skip the loading state.
        if (!isOpen) {
            void queryClient.prefetchQuery({
                queryKey: ["tool-failure-detail", row.label],
                queryFn: () => api.toolFailureDetail(row.label),
                staleTime: 60_000,
            });
        }
    };

    return (
        <section className="panel">
            <header>
                <h2>Tool Failures</h2>
                <span className="meta">
                    {totals
                        ? `${totals.total} commands failing · fix ${totals.fix} · watch ${totals.watch} · ignore ${totals.ignore}`
                        : ""}
                    {data ? ` · generated ${fmtTs(data.generatedAt)}` : ""}
                </span>
            </header>

            <div className="actions toolbar">
                {FILTERS.map((f) => (
                    <button
                        key={f.key}
                        className={filter === f.key ? "is-active" : undefined}
                        onClick={() => setFilter(f.key)}
                        type="button"
                    >
                        {f.label}
                    </button>
                ))}
                <input
                    type="search"
                    placeholder="search command label"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="search"
                    aria-label="Search tool labels"
                />
                <button
                    onClick={() => load("refresh")}
                    type="button"
                    style={{ marginLeft: "auto" }}
                    disabled={refreshing}
                >
                    {refreshing ? "Refreshing…" : "Refresh"}
                </button>
            </div>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data && visible.length === 0 && !loading ? (
                <div className="empty">No tool failures match.</div>
            ) : null}

            {data && visible.length > 0 ? (
                <table className="skills" style={{ opacity: refreshing ? 0.6 : 1 }}>
                    <thead>
                        <tr>
                            <th>Command</th>
                            <th>Recommendation</th>
                            <th className="num">Failures</th>
                            <th className="num">Sessions</th>
                            <th className="num">Last</th>
                            <th>Exit codes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((row) => (
                            <ToolFailureRowView
                                key={row.label}
                                row={row}
                                expanded={expanded.has(row.label)}
                                onToggleExpand={() => toggleExpanded(row)}
                            />
                        ))}
                    </tbody>
                </table>
            ) : null}
        </section>
    );
}

function ToolFailureRowView({
    row,
    expanded,
    onToggleExpand,
}: {
    row: ToolFailureEntry;
    expanded: boolean;
    onToggleExpand: () => void;
}) {
    const detailQuery = useQuery({
        queryKey: ["tool-failure-detail", row.label],
        queryFn: () => api.toolFailureDetail(row.label),
        enabled: expanded,
        staleTime: 60_000,
    });
    const detail = detailQuery.data ?? null;
    const detailLoading = detailQuery.isLoading;
    const exitCodes = row.exit_codes
        .filter((c) => c != null)
        .slice(0, 4)
        .join(", ");
    return (
        <>
            <tr>
                <td className="skill-cell">
                    <strong>{row.label}</strong>
                </td>
                <td>
                    <button
                        type="button"
                        className="reason-button"
                        onClick={onToggleExpand}
                        title={expanded ? "hide samples" : "show samples"}
                    >
                        <span className={`badge ${badgeClass(row.recommendation)}`}>
                            {row.recommendation}
                        </span>
                        <small>
                            {row.recommendation_reason} {expanded ? "▴" : "▾"}
                        </small>
                    </button>
                </td>
                <td className="num">{fmtCount(row.failure_count)}</td>
                <td className="num">{fmtCount(row.distinct_sessions)}</td>
                <td className="num">{fmtLastUsed(row.last_seen)}</td>
                <td>
                    <small>{exitCodes || "-"}</small>
                </td>
            </tr>
            {expanded ? (
                <tr className="detail-row">
                    <td />
                    <td colSpan={5}>
                        <FailureDetail detail={detail} loading={detailLoading} />
                    </td>
                </tr>
            ) : null}
        </>
    );
}

function badgeClass(r: ToolFailureRecommendation): string {
    if (r === "fix") return "review";
    if (r === "watch") return "review";
    return "archive";
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function FailureDetail({
    detail,
    loading,
}: {
    detail: ToolFailureDetailPayload | null;
    loading: boolean;
}) {
    if (loading && !detail) return <div className="loading">Loading samples…</div>;
    if (!detail) return <div className="empty">No samples.</div>;
    return (
        <div>
            <h3 style={{ margin: "0 0 8px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
                Last {detail.samples.length} failures
            </h3>
            {detail.samples.length === 0 ? (
                <div className="empty">No samples recorded.</div>
            ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                    {detail.samples.map((s, i) => (
                        <li
                            key={`${s.ts}-${i}`}
                            style={{
                                borderLeft: "3px solid var(--red)",
                                paddingLeft: 12,
                                fontSize: 12,
                            }}
                        >
                            <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
                                <code>{fmtTs(s.ts)}</code>
                                <span>{prettifyProjectSlug(s.project)}</span>
                                {s.exit_code !== null ? (
                                    <span className="chip">exit {s.exit_code}</span>
                                ) : null}
                            </div>
                            {s.command_text ? (
                                <pre style={{ margin: "4px 0", padding: "6px 8px", background: "var(--track)", overflowX: "auto" }}>
                                    {truncate(s.command_text, 240)}
                                </pre>
                            ) : null}
                            {s.error_text ? (
                                <pre style={{ margin: "4px 0", padding: "6px 8px", background: "rgba(189, 68, 59, 0.07)", color: "var(--red)", overflowX: "auto" }}>
                                    {truncate(s.error_text, 320)}
                                </pre>
                            ) : null}
                            {s.output_excerpt ? (
                                <small style={{ color: "var(--muted)" }}>
                                    {truncate(s.output_excerpt, 200)}
                                </small>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
