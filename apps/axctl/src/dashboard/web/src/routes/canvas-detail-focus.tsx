import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { SessionSummary } from "@shared/dashboard-types.ts";

// Focus strip - full-width bottom inspector. DB-only summary (fast); shows the
// session's task, stats, tool-activity rollup, and key turn excerpts.

const fmtTokens = (n: number | null): string =>
    n == null ? "-" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
const trunc = (s: string | null, n: number): string | null => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);

const panel = (bg: string): CSSProperties => ({ marginTop: 12, background: bg, border: "1px solid #1b2330", borderRadius: 12 });

export function FocusDetail({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const q = useQuery({
        queryKey: ["session-summary", sessionId],
        queryFn: () => api.sessionSummary(sessionId),
    });
    const d: SessionSummary | null = q.data ?? null;

    if (q.isLoading) return <div style={{ ...panel("#0a0d13"), padding: 14, color: "#55657f", fontSize: 12 }}>Loading session…</div>;
    if (q.error) return <div style={{ ...panel("#0a0d13"), padding: 14, color: "#e0563a", fontSize: 12 }}>Error: {String(q.error)}</div>;
    if (!d) return null;

    const stat = (label: string, value: string) => (
        <span style={{ marginRight: 14 }}><span style={{ color: "#55657f" }}>{label} </span><b style={{ color: "#cfe0ff" }}>{value}</b></span>
    );
    const excerpt = (label: string, text: string | null) => text ? (
        <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 9, letterSpacing: ".06em", color: "#55657f", textTransform: "uppercase" }}>{label}</div>
            <div style={{ color: "#aab9d6", fontSize: 11, lineHeight: 1.4 }}>{trunc(text, 200)}</div>
        </div>
    ) : null;

    return (
        <div style={panel("#0a0d13")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "10px 14px 0" }}>
                <div style={{ fontSize: 9, letterSpacing: ".06em", color: "#55657f", textTransform: "uppercase" }}>session</div>
                <button type="button" onClick={onClose} style={{ background: "none", border: "1px solid #2a3650", color: "#8b9ab3", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}>close</button>
            </div>
            <div style={{ display: "flex", gap: 18, padding: "4px 14px 14px", alignItems: "flex-start" }}>
                {/* left: task + stats */}
                <div style={{ flex: "1 1 32%", minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "#e6edf6", fontSize: 13, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {d.task ?? d.session_id}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: "#aab9d6" }}>
                        {stat("turns", String(d.turns))}
                        {stat("tokens", fmtTokens(d.tokens))}
                        {d.cost_usd != null ? stat("cost", `$${d.cost_usd.toFixed(2)}`) : null}
                        {d.model ? stat("model", d.model) : null}
                        {d.subagents > 0 ? stat("subagents", String(d.subagents)) : null}
                    </div>
                </div>
                {/* middle: tool rollup */}
                <div style={{ flex: "0 0 28%", minWidth: 0 }}>
                    <div style={{ fontSize: 9, letterSpacing: ".06em", color: "#55657f", textTransform: "uppercase", marginBottom: 4 }}>tool activity</div>
                    {d.tools.length === 0 ? <div style={{ color: "#55657f", fontSize: 11 }}>none</div> : (
                        <div style={{ columnCount: 2, columnGap: 16, fontSize: 11 }}>
                            {d.tools.slice(0, 10).map((t) => (
                                <div key={t.name} style={{ display: "flex", justifyContent: "space-between", color: "#aab9d6" }}>
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                                    <b style={{ color: "#4f8bff" }}>{t.count}</b>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                {/* right: excerpts */}
                <div style={{ flex: "1 1 36%", minWidth: 0 }}>
                    {excerpt("first ask", d.first_ask)}
                    {excerpt("correction", d.correction)}
                    {excerpt("last assistant", d.last_assistant)}
                    <Link to="/sessions/$sessionId/inspect" params={{ sessionId }} style={{ color: "#2f6df0", fontSize: 11, display: "inline-block", marginTop: 8 }}>
                        open full session →
                    </Link>
                </div>
            </div>
        </div>
    );
}
