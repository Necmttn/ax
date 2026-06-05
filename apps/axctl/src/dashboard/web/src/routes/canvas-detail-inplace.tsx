import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { SessionSummary } from "@shared/dashboard-types.ts";

// In-place card - anchored at the pill (x,y in the lanes container). DB-only
// summary (fast); the same facts as the focus strip, in a compact card.

const fmtTokens = (n: number | null): string =>
    n == null ? "-" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
const trunc = (s: string | null, n: number): string | null => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function InPlaceDetail({ sessionId, x, y, onClose }: { sessionId: string; x: number; y: number; onClose: () => void }) {
    const q = useQuery({
        queryKey: ["session-summary", sessionId],
        queryFn: () => api.sessionSummary(sessionId),
    });
    const d: SessionSummary | null = q.data ?? null;

    const card = (children: ReactNode) => (
        <div style={{
            position: "absolute", left: x, top: y, width: 360, maxHeight: 270, overflow: "auto",
            background: "#0e1422", border: "1px solid #4f8bff", borderRadius: 8, padding: "8px 10px",
            pointerEvents: "auto", zIndex: 20, boxShadow: "0 8px 28px #000a", fontSize: 11,
        }}>
            <button type="button" onClick={onClose} style={{ position: "absolute", top: 6, right: 6, background: "none", border: "none", color: "#8b9ab3", cursor: "pointer", fontSize: 13 }}>×</button>
            {children}
        </div>
    );

    if (q.isLoading) return card(<div style={{ color: "#55657f" }}>loading session…</div>);
    if (q.error) return card(<div style={{ color: "#e0563a" }}>error: {String(q.error)}</div>);
    if (!d) return null;

    const chip = (label: string, n: number) => (
        <span key={label} style={{ display: "inline-block", margin: "0 4px 4px 0", padding: "1px 5px", borderRadius: 4, background: "#16203a", color: "#aab9d6", fontSize: 10 }}>{label} <b style={{ color: "#4f8bff" }}>{n}</b></span>
    );
    const excerpt = (label: string, text: string | null) => text ? (
        <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 9, letterSpacing: ".06em", color: "#55657f", textTransform: "uppercase" }}>{label}</div>
            <div style={{ color: "#aab9d6", lineHeight: 1.4 }}>{trunc(text, 160)}</div>
        </div>
    ) : null;

    return card(
        <>
            <div style={{ fontWeight: 600, color: "#e6edf6", fontSize: 12, lineHeight: 1.3, paddingRight: 14, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {d.task ?? d.session_id}
            </div>
            <div style={{ marginTop: 5, color: "#8b9ab3", fontSize: 10 }}>
                {d.turns} turns · {fmtTokens(d.tokens)} tok{d.cost_usd != null ? ` · $${d.cost_usd.toFixed(2)}` : ""}{d.model ? ` · ${d.model}` : ""}{d.subagents > 0 ? ` · ${d.subagents} subagents` : ""}
            </div>
            {d.tools.length > 0 ? <div style={{ marginTop: 6 }}>{d.tools.slice(0, 8).map((t) => chip(t.name, t.count))}</div> : null}
            {excerpt("first ask", d.first_ask)}
            {excerpt("correction", d.correction)}
            {excerpt("last assistant", d.last_assistant)}
            <Link to="/sessions/$sessionId/inspect" params={{ sessionId }} style={{ color: "#2f6df0", display: "inline-block", marginTop: 8 }}>open full session →</Link>
        </>,
    );
}
