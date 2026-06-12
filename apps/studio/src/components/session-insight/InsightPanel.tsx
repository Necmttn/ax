import type { CSSProperties, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.ts";
import type { SessionInsightsPayload, SessionListRow } from "@ax/lib/shared/dashboard-types";
import { StoryBar } from "./StoryBar.tsx";

const LBL: CSSProperties = {
    fontSize: 9,
    color: "var(--sx-ink-500)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontWeight: 600,
    marginBottom: 6,
};

const CAP: CSSProperties = {
    fontSize: 10,
    color: "var(--sx-ink-500)",
    marginTop: 5,
    lineHeight: 1.35,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
};

const CHART_BAND: CSSProperties = {
    minHeight: 28,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const compactKind = (kind: string): string => kind
    .replace(/_/g, " ")
    .replace(/\btool failure\b/i, "tool fail")
    .replace(/\buser correction\b/i, "correction");

function OutcomeCell({ p }: { readonly p: SessionInsightsPayload }): ReactNode {
    const hasChecks = p.checks.length > 0;
    const hasCommits = p.commits.length > 0;
    if (!hasChecks && !hasCommits && p.durability === null) return null;

    const reverted = p.commits.filter((c) => c.reverted).length;
    const durability = p.durability === null ? null : clamp01(p.durability);
    const visibleRuns = 12;
    return (
        <div style={{ minWidth: 0 }}>
            <div style={LBL}>Outcome</div>
            <div style={CHART_BAND}>
                {p.checks.map((c) => (
                    <div
                        key={c.kind}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: 10,
                            color: "var(--sx-ink-500)",
                            height: 12,
                            minWidth: 0,
                        }}
                    >
                        <span title={c.kind} style={{ width: 48, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
                            {compactKind(c.kind)}
                        </span>
                        {c.runs.slice(0, visibleRuns).map((r, i) => (
                            <span
                                key={i}
                                title={r.ts}
                                style={{
                                    width: 5,
                                    height: 5,
                                    borderRadius: "50%",
                                    flexShrink: 0,
                                    background: r.ok ? "var(--sx-green-700)" : "var(--sx-red-700)",
                                }}
                            />
                        ))}
                        {c.runs.length > visibleRuns ? (
                            <span style={{ color: "var(--sx-ink-300)", marginLeft: 2 }}>+{c.runs.length - visibleRuns}</span>
                        ) : null}
                    </div>
                ))}
                {durability !== null ? (
                    <div style={{ marginTop: 5, maxWidth: 130, height: 5, borderRadius: 2, overflow: "hidden", display: "flex" }}>
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
        <div style={{ minWidth: 0 }}>
            <div style={LBL}>Delta LOC</div>
            <div style={CHART_BAND}>
                <div style={{ display: "flex", alignItems: "center", maxWidth: 150, minWidth: 0 }}>
                    <span style={{ width: `${(added / total) * 100}%`, height: 5, background: "var(--sx-green-300)", borderRadius: 1 }} />
                    <span style={{ width: `${(removed / total) * 100}%`, height: 5, background: "var(--sx-red-300)", borderRadius: 1, marginLeft: 2 }} />
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
    const labelOf = (name: string): string => {
        // Codex tool patterns: match v\d+: prefix or bare codex_ prefix first.
        const normalized = name.replace(/^v\d+:/, "").toLowerCase();
        if (normalized.includes("spawn_agent")) return "spawn";
        if (normalized.includes("wait_agent")) return "wait";
        if (normalized.includes("exec_command")) return "exec";
        if (normalized.includes("apply_patch")) return "patch";
        if (normalized.includes("update_plan")) return "plan";
        if (normalized.includes("view_image")) return "image";
        if (normalized.includes("web_run")) return "web";
        if (normalized.includes("read") || normalized.includes("open")) return "read";
        // Codex-style names without a simple namespace:slug shape
        if (!normalized.includes(":") || normalized.replace(/^v\d+:/, "").includes("_")) {
            return normalized
                .replace(/^codex_/, "")
                .replace(/^claude_/, "")
                .replace(/_/g, " ")
                .slice(0, 18);
        }
        // Simple plugin-namespaced skill id: keep post-colon slug as the label.
        const colonIdx = name.lastIndexOf(":");
        return name.slice(colonIdx + 1).replace(/_/g, " ").slice(0, 18);
    };
    // Dedupe consecutive repeats AFTER labeling (same chip text = same label).
    const withLabels = p.skills.map((s) => ({ ...s, label: labelOf(s.name) }));
    const arc = withLabels.filter((s, i) => i === 0 || s.label !== withLabels[i - 1]!.label);
    return (
        <div style={{ minWidth: 0 }}>
            <div style={LBL}>Skill arc</div>
            <div style={CHART_BAND}>
                <div style={{ lineHeight: 1.45, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {arc.slice(0, 5).map((s, i) => (
                        <span key={`${s.name}-${i}`}>
                            {i > 0 ? <span style={{ color: "var(--sx-ink-300)" }}> → </span> : null}
                            <span
                                title={s.name}
                                style={{
                                    display: "inline-block",
                                    maxWidth: 130,
                                    fontSize: 10,
                                    padding: "1px 5px",
                                    borderRadius: 3,
                                    background: "var(--sx-line-100)",
                                    color: "var(--sx-ink-600)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    verticalAlign: "bottom",
                                }}
                            >
                                {s.label}
                            </span>
                        </span>
                    ))}
                    {arc.length > 5 ? <span style={{ color: "var(--sx-ink-300)" }}> +{arc.length - 5}</span> : null}
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
    // Position each compaction dot at its real t offset, snapped to the nearest
    // curve point's y. Dots are only rendered when the curve is non-empty.
    const compactionDots = points.length === 0 ? [] : p.compactions.map((comp) => {
        const dotT = comp.t;
        // Find the curve point nearest in t to dotT.
        let nearest = points[0]!;
        let minDist = Math.abs(nearest.t - dotT);
        for (const pt of points) {
            const d = Math.abs(pt.t - dotT);
            if (d < minDist) { minDist = d; nearest = pt; }
        }
        return { x: (dotT / tMax) * width, y: yOf(nearest.pct) };
    });

    return (
        <div style={{ minWidth: 0 }}>
            <div style={LBL}>Context</div>
            <div style={CHART_BAND}>
                <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden style={{ maxWidth: 260 }}>
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
                        <circle key={i} cx={c.x} cy={c.y} r={2.4} fill="var(--sx-amber-500)" />
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
        // When the ratio rounds to 1.0, show a neutral "≈median" instead of "1.0x down/up".
        if (Math.round(r * 10) === 10) {
            return (
                <span>
                    {" · "}{label}{" "}
                    <span style={{ color: "var(--sx-ink-500)" }}>≈median</span>
                </span>
            );
        }
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
            paddingTop: 7,
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

    const cells: Array<{ readonly key: string; readonly node: ReactNode }> = [
        { key: "outcome", node: OutcomeCell({ p }) },
        { key: "loc", node: LocCell({ p }) },
        { key: "skills", node: SkillArcCell({ p }) },
        { key: "context", node: ContextCell({ p }) },
    ].filter((cell) => cell.node !== null && cell.node !== undefined && cell.node !== false);

    return (
        <div style={{ padding: "10px 16px 10px 38px", minWidth: 0 }}>
            <StoryBar insights={p} startedAt={row.started_at} endedAt={row.ended_at} />
            {cells.length > 0 ? (
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: "12px 28px",
                    marginTop: 12,
                    alignItems: "start",
                }}>
                    {cells.map((cell) => <div key={cell.key}>{cell.node}</div>)}
                </div>
            ) : null}
            <BaselineFooter p={p} />
        </div>
    );
}
