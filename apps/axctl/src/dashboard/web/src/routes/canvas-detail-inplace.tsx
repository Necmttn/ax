import { useMemo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    InspectTurnDto,
    SessionInspectPayload,
} from "@shared/dashboard-types.ts";
import { turnText, isCorrectionTurn } from "./inspector-filters.ts";

// --- styling tokens (match the dark canvas) ------------------------------
const COL_BG = "#0e1422";
const COL_BORDER = "#2a3650";
const COL_BORDER_FOCAL = "#4f8bff";
const COL_HEADER = "#e6edf6";
const COL_BODY = "#aab9d6";
const COL_META = "#55657f";
const COL_LINK = "#2f6df0";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const cardStyle = (x: number, y: number): CSSProperties => ({
    position: "absolute",
    left: x,
    top: y,
    width: 360,
    maxHeight: 260,
    overflow: "auto",
    pointerEvents: "auto",
    background: COL_BG,
    border: `1px solid ${COL_BORDER_FOCAL}`,
    borderRadius: 8,
    boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
    color: COL_BODY,
    font: `11px/1.5 ${MONO}`,
    padding: 0,
    zIndex: 40,
});

function truncate(text: string, max = 140): string {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length === 0) return "";
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const numberOrNull = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

const fmtCount = (value: number | null | undefined): string =>
    numberOrNull(value)?.toLocaleString() ?? "-";

const fmtUsd = (value: number | null | undefined): string => {
    const n = numberOrNull(value);
    if (n === null) return "-";
    if (n === 0) return "$0";
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
};

/** Tool-activity rollup: tool_use turns carry spans with kind="tool_use" and
 *  a `label` (the tool name). Count by label across the loaded turn window. */
function toolRollup(turns: ReadonlyArray<InspectTurnDto>): Array<{ label: string; count: number }> {
    const counts = new Map<string, number>();
    for (const turn of turns) {
        for (const span of turn.spans) {
            if (span.kind !== "tool_use") continue;
            const label = (span.label ?? "tool").trim() || "tool";
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
}

function firstUserTurn(turns: ReadonlyArray<InspectTurnDto>): InspectTurnDto | null {
    return turns.find((t) => t.semantic_role === "user_input") ?? null;
}

function lastAssistantTurn(turns: ReadonlyArray<InspectTurnDto>): InspectTurnDto | null {
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t && t.semantic_role === "assistant_text") return t;
    }
    return null;
}

function correctionTurn(turns: ReadonlyArray<InspectTurnDto>): InspectTurnDto | null {
    return turns.find((t) => isCorrectionTurn(t)) ?? null;
}

function Shell({ x, y, onClose, children }: {
    x: number;
    y: number;
    onClose: () => void;
    children: React.ReactNode;
}) {
    return (
        <div style={cardStyle(x, y)} role="dialog" aria-label="session detail">
            <button
                type="button"
                onClick={onClose}
                aria-label="close"
                title="close"
                style={{
                    position: "sticky",
                    top: 6,
                    float: "right",
                    marginRight: 6,
                    width: 18,
                    height: 18,
                    lineHeight: "16px",
                    padding: 0,
                    background: "transparent",
                    border: `1px solid ${COL_BORDER}`,
                    borderRadius: 4,
                    color: COL_META,
                    cursor: "pointer",
                    font: `12px/1 ${MONO}`,
                    zIndex: 1,
                }}
            >
                ×
            </button>
            <div style={{ padding: "10px 12px" }}>{children}</div>
        </div>
    );
}

function Excerpt({ label, text }: { label: string; text: string }) {
    if (!text) return null;
    return (
        <div style={{ marginTop: 6 }}>
            <span style={{ color: COL_META, textTransform: "uppercase", fontSize: 9, letterSpacing: "0.05em" }}>
                {label}
            </span>
            <div style={{ color: COL_BODY, marginTop: 2 }}>{text}</div>
        </div>
    );
}

export function InPlaceDetail(props: { sessionId: string; x: number; y: number; onClose: () => void }) {
    const { sessionId, x, y, onClose } = props;

    const query = useQuery<SessionInspectPayload>({
        queryKey: ["session-inspect", sessionId],
        queryFn: () => api.sessionInspect(sessionId),
        staleTime: 5 * 60_000,
    });

    const data = query.data;

    const derived = useMemo(() => {
        if (!data) return null;
        const turns = data.turns;
        const first = firstUserTurn(turns);
        const lastAssistant = lastAssistantTurn(turns);
        const correction = correctionTurn(turns);
        return {
            taskHeader: first ? truncate(turnText(first), 180) : null,
            firstAsk: first ? truncate(turnText(first), 140) : "",
            lastAssistant: lastAssistant ? truncate(turnText(lastAssistant), 140) : "",
            correction: correction ? truncate(turnText(correction), 140) : "",
            tools: toolRollup(turns).slice(0, 8),
        };
    }, [data]);

    if (query.isLoading) {
        return (
            <Shell x={x} y={y} onClose={onClose}>
                <div style={{ color: COL_META }}>loading session…</div>
            </Shell>
        );
    }

    if (query.isError) {
        return (
            <Shell x={x} y={y} onClose={onClose}>
                <div style={{ color: "#f0a0a0" }}>
                    failed to load session
                    <div style={{ color: COL_META, marginTop: 4 }}>
                        {query.error instanceof Error ? query.error.message : "unknown error"}
                    </div>
                </div>
            </Shell>
        );
    }

    if (!data || data.total_turns === 0 || !derived) {
        return (
            <Shell x={x} y={y} onClose={onClose}>
                <div style={{ color: COL_META }}>no turns in this session.</div>
            </Shell>
        );
    }

    const usage = data.token_usage;
    const model = usage?.model ?? null;

    const stats: Array<{ label: string; value: string }> = [
        { label: "turns", value: fmtCount(data.total_turns) },
    ];
    if (usage) {
        stats.push({ label: "tokens", value: fmtCount(usage.estimated_tokens) });
        stats.push({ label: "cost", value: fmtUsd(usage.estimated_cost_usd) });
    }
    if (model) stats.push({ label: "model", value: model });

    return (
        <Shell x={x} y={y} onClose={onClose}>
            <div style={{ color: COL_HEADER, fontWeight: 700, lineHeight: 1.4, paddingRight: 22 }}>
                {derived.taskHeader ?? "(no user prompt found)"}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", marginTop: 8 }}>
                {stats.map((s) => (
                    <span key={s.label} style={{ color: COL_META }}>
                        {s.label} <strong style={{ color: COL_BODY }}>{s.value}</strong>
                    </span>
                ))}
            </div>

            {derived.tools.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                    {derived.tools.map((t) => (
                        <span
                            key={t.label}
                            style={{
                                background: "#16203a",
                                border: `1px solid ${COL_BORDER}`,
                                borderRadius: 3,
                                padding: "0 6px",
                                color: COL_BODY,
                                fontSize: 10,
                            }}
                        >
                            {t.label} <strong>{t.count}</strong>
                        </span>
                    ))}
                </div>
            ) : null}

            <Excerpt label="first ask" text={derived.firstAsk} />
            <Excerpt label="last assistant" text={derived.lastAssistant} />
            <Excerpt label="correction" text={derived.correction} />

            <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${COL_BORDER}` }}>
                <Link
                    to="/sessions/$sessionId/inspect"
                    params={{ sessionId }}
                    style={{ color: COL_LINK, textDecoration: "none", fontWeight: 600 }}
                >
                    open full session →
                </Link>
            </div>
        </Shell>
    );
}
