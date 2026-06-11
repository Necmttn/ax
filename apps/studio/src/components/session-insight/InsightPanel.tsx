import type { CSSProperties, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.ts";
import type { SessionInsightsPayload, SessionListRow } from "@ax/lib/shared/dashboard-types";
import { StoryBar } from "./StoryBar.tsx";

const LBL: CSSProperties = {
    fontSize: 10,
    color: "var(--sx-ink-500)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontWeight: 600,
    marginBottom: 8,
};

const CAP: CSSProperties = {
    fontSize: 10,
    color: "var(--sx-ink-500)",
    marginTop: 6,
    lineHeight: 1.5,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
};

const CHART_BAND: CSSProperties = {
    minHeight: 36,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function OutcomeCell({ p }: { readonly p: SessionInsightsPayload }): ReactNode {
    const hasChecks = p.checks.length > 0;
    const hasCommits = p.commits.length > 0;
    if (!hasChecks && !hasCommits && p.durability === null) return null;

    const reverted = p.commits.filter((c) => c.reverted).length;
    const durability = p.durability === null ? null : clamp01(p.durability);
    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>Outcome</div>
            <div style={CHART_BAND}>
                {p.checks.map((c) => (
                    <div
                        key={c.kind}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: 10,
                            color: "var(--sx-ink-500)",
                            height: 13,
                            minWidth: 0,
                        }}
                    >
                        <span style={{ width: 36, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
                            {c.kind}
                        </span>
                        {c.runs.map((r, i) => (
                            <span
                                key={i}
                                title={r.ts}
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: "50%",
                                    flexShrink: 0,
                                    background: r.ok ? "var(--sx-green-700)" : "var(--sx-red-700)",
                                }}
                            />
                        ))}
                    </div>
                ))}
                {durability !== null ? (
                    <div style={{ marginTop: 5, maxWidth: 160, height: 6, borderRadius: 2, overflow: "hidden", display: "flex" }}>
                        <span style={{ width: `${Math.round(durability * 100)}%`, background: "var(--sx-green-300)" }} />
                        <span style={{ flex: 1, background: "var(--sx-red-300)" }} />
                    </div>
                ) : null}
            </div>
            <div style={CAP}>
                {hasCommits ? (
                    <>
                        {p.commits.length} commits
                        {reverted > 0 ? <span style={{ color: "var(--sx-red-700)" }}> · {reverted} reverted</span> : null}
                    </>
                ) : "no commits"}
                {durability !== null ? <> · durability {durability.toFixed(1)}</> : null}
            </div>
        </div>
    );
}

function LocCell({ p }: { readonly p: SessionInsightsPayload }): ReactNode {
    if (!p.loc || (p.loc.added === 0 && p.loc.removed === 0)) return null;
    const added = Math.max(0, p.loc.added);
    const removed = Math.max(0, p.loc.removed);
    const total = Math.max(1, added + removed);
    const fmt = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>Delta LOC</div>
            <div style={CHART_BAND}>
                <div style={{ display: "flex", alignItems: "center", maxWidth: 180, minWidth: 0 }}>
                    <span style={{ width: `${(added / total) * 100}%`, height: 6, background: "var(--sx-green-300)", borderRadius: 1 }} />
                    <span style={{ width: `${(removed / total) * 100}%`, height: 6, background: "var(--sx-red-300)", borderRadius: 1, marginLeft: 2 }} />
                </div>
            </div>
            <div style={CAP}>
                <span style={{ color: "var(--sx-green-700)" }}>+{fmt(added)}</span>{" "}
                <span style={{ color: "var(--sx-red-700)" }}>-{fmt(removed)}</span>
            </div>
        </div>
    );
}

function SkillArcCell({ p }: { readonly p: SessionInsightsPayload }): ReactNode {
    if (p.skills.length === 0) return null;
    const arc = p.skills.filter((s, i) => i === 0 || s.name !== p.skills[i - 1]!.name);
    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>Skill arc</div>
            <div style={CHART_BAND}>
                <div style={{ lineHeight: 1.7, minWidth: 0, overflow: "hidden" }}>
                    {arc.slice(0, 8).map((s, i) => (
                        <span key={`${s.name}-${i}`}>
                            {i > 0 ? <span style={{ color: "var(--sx-ink-300)" }}> -&gt; </span> : null}
                            <span
                                title={s.name}
                                style={{
                                    display: "inline-block",
                                    maxWidth: "100%",
                                    fontSize: 10,
                                    padding: "1px 7px",
                                    borderRadius: 8,
                                    background: "var(--sx-line-100)",
                                    color: "var(--sx-ink-600)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    verticalAlign: "bottom",
                                }}
                            >
                                {s.name}
                            </span>
                        </span>
                    ))}
                    {arc.length > 8 ? <span style={{ color: "var(--sx-ink-300)" }}> +{arc.length - 8}</span> : null}
                </div>
            </div>
            <div style={CAP}>{arc.length} skill{arc.length === 1 ? "" : "s"}</div>
        </div>
    );
}

function ContextCell({ p }: { readonly p: SessionInsightsPayload }): ReactNode {
    const points = p.context_curve
        .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.pct))
        .map((c) => ({ t: Math.max(0, c.t), pct: clamp01(c.pct) }));
    if (points.length < 2) return null;

    const tMax = Math.max(...points.map((c) => c.t), 1);
    const width = 160;
    const height = 32;
    const yOf = (pct: number): number => height - 2 - pct * (height - 6);
    const path = points
        .map((c, i) => `${i === 0 ? "M" : "L"}${((c.t / tMax) * width).toFixed(1)},${yOf(c.pct).toFixed(1)}`)
        .join(" ");
    const peak = Math.max(...points.map((c) => c.pct));
    const last = points[points.length - 1]!.pct;
    const compactionDots = p.compactions.slice(0, points.length).map((_, i) => {
        const index = Math.round(((i + 1) / (p.compactions.length + 1)) * (points.length - 1));
        return points[index]!;
    });

    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>Context</div>
            <div style={CHART_BAND}>
                <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
                    <line
                        x1={0}
                        y1={yOf(0.9)}
                        x2={width}
                        y2={yOf(0.9)}
                        stroke="var(--sx-line-200)"
                        strokeWidth={1}
                        strokeDasharray="3,3"
                    />
                    <path d={path} fill="none" stroke="var(--sx-chart-line)" strokeWidth={1.5} />
                    {compactionDots.map((c, i) => (
                        <circle key={i} cx={(c.t / tMax) * width} cy={yOf(c.pct)} r={2.4} fill="var(--sx-amber-500)" />
                    ))}
                </svg>
            </div>
            <div style={CAP}>
                {p.compactions.length} compaction{p.compactions.length === 1 ? "" : "s"} · peak {Math.round(peak * 100)}% · ends {Math.round(last * 100)}%
            </div>
        </div>
    );
}

function BaselineFooter({ p }: { readonly p: SessionInsightsPayload }): ReactNode {
    const { cost_ratio, friction_ratio, land_ratio, cache_pct } = p.baseline;
    if (cost_ratio === null && friction_ratio === null && land_ratio === null && cache_pct === null) return null;

    const delta = (label: string, r: number | null, higherIsWorse: boolean): ReactNode => {
        if (r === null) return null;
        const worse = higherIsWorse ? r > 1 : r < 1;
        return (
            <span>
                {" · "}{label}{" "}
                <span style={{ color: worse ? "var(--sx-red-700)" : "var(--sx-green-700)" }}>
                    {r.toFixed(1)}x{r > 1 ? " up" : " down"}
                </span>
            </span>
        );
    };

    return (
        <div style={{
            marginTop: 14,
            paddingTop: 8,
            borderTop: "1px dashed var(--sx-line-200)",
            fontSize: 10,
            color: "var(--sx-ink-500)",
            textAlign: "right",
            whiteSpace: "normal",
            overflowWrap: "anywhere",
        }}>
            vs 30d median
            {delta("cost", cost_ratio, true)}
            {delta("friction", friction_ratio, true)}
            {delta("landed", land_ratio, true)}
            {cache_pct !== null ? <span> · cache {Math.round(clamp01(cache_pct) * 100)}%</span> : null}
        </div>
    );
}

/** Accordion body for an expanded sessions-list row. Fetches lazily on first
 * expand; TanStack Query caches per session id. */
export function InsightPanel({ row }: { readonly row: SessionListRow }) {
    const q = useQuery({
        queryKey: ["session-insights", row.id],
        queryFn: () => api.sessionInsights(row.id),
        staleTime: 5 * 60_000,
    });

    if (q.isLoading) {
        return <div style={{ padding: "12px 16px", fontSize: 10, color: "var(--sx-ink-300)" }}>loading insights…</div>;
    }

    if (q.error || !q.data) {
        return (
            <div style={{ padding: "12px 16px", fontSize: 10, color: "var(--sx-ink-300)" }}>
                failed to load insights ·{" "}
                <button
                    onClick={() => void q.refetch()}
                    style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--sx-ink-500)",
                        cursor: "pointer",
                        fontSize: 10,
                        textDecoration: "underline",
                        padding: 0,
                    }}
                >
                    retry
                </button>
            </div>
        );
    }

    const p = q.data;
    const hasBaseline = Object.values(p.baseline).some((v) => v !== null);
    const empty = p.phases.length === 0
        && p.friction_ticks.length === 0
        && p.commits.length === 0
        && p.subagent_spans.length === 0
        && p.checks.length === 0
        && p.loc === null
        && p.durability === null
        && p.delegation_ratio === null
        && p.skills.length === 0
        && p.context_curve.length < 2
        && p.compactions.length === 0
        && !hasBaseline;
    if (empty) {
        return <div style={{ padding: "12px 16px", fontSize: 10, color: "var(--sx-ink-300)" }}>no insight data for this session</div>;
    }

    const cells = [
        ["outcome", OutcomeCell({ p })],
        ["loc", LocCell({ p })],
        ["skills", SkillArcCell({ p })],
        ["context", ContextCell({ p })],
    ].filter((cell): cell is readonly [string, Exclude<ReactNode, null | undefined | false>] => Boolean(cell[1]));

    return (
        <div style={{ padding: "12px 16px 14px 38px", minWidth: 0 }}>
            <StoryBar insights={p} startedAt={row.started_at} endedAt={row.ended_at} />
            {cells.length > 0 ? (
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: "14px 0",
                    marginTop: 16,
                }}>
                    {cells.map(([key, cell]) => <div key={key}>{cell}</div>)}
                </div>
            ) : null}
            <BaselineFooter p={p} />
        </div>
    );
}
