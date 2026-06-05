import { useMemo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { InspectTurnDto, SessionInspectPayload } from "@shared/dashboard-types.ts";
import { isCorrectionTurn, turnText } from "./inspector-filters.ts";

// ---- palette (matches the dark canvas) ----
const PANEL_BG = "#0a0d13";
const BORDER = "#1b2330";
const HEADER = "#e6edf6";
const BODY = "#aab9d6";
const META = "#55657f";
const ACCENT = "#4f8bff";
const LINK = "#2f6df0";

const PANEL_HEIGHT = 220;

function clip(text: string, max = 160): string {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
}

function fmtTokens(n: number | null | undefined): string | null {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function fmtUsd(n: number | null | undefined): string | null {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
}

/** First user_input turn = the task / prompt that opened the session. */
function firstUserTurn(turns: ReadonlyArray<InspectTurnDto>): InspectTurnDto | null {
    return turns.find((t) => t.semantic_role === "user_input") ?? null;
}

/** Last turn that reads as assistant prose. */
function lastAssistantTurn(turns: ReadonlyArray<InspectTurnDto>): InspectTurnDto | null {
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t && t.semantic_role === "assistant_text") return t;
    }
    return null;
}

/** First correction the user made, if any (cheap heuristic shared with the
 *  inspector). */
function firstCorrectionTurn(turns: ReadonlyArray<InspectTurnDto>): InspectTurnDto | null {
    return turns.find((t) => isCorrectionTurn(t)) ?? null;
}

/** Roll tool activity up from the loaded turn window. Each `tool_use` span
 *  carries the concrete tool name in its `label` (e.g. "Edit", "Bash"); fall
 *  back to counting tool_use turns when labels are absent. */
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
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
}

const labelStyle: CSSProperties = {
    color: META,
    font: "700 9px/1 ui-monospace, monospace",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 6,
};

function Frame({ children }: { children: React.ReactNode }) {
    return (
        <div
            style={{
                background: PANEL_BG,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                height: PANEL_HEIGHT,
                maxHeight: PANEL_HEIGHT,
                overflow: "hidden",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: BODY,
                position: "relative",
            }}
        >
            {children}
        </div>
    );
}

function CloseButton({ onClose }: { onClose: () => void }) {
    return (
        <button
            type="button"
            onClick={onClose}
            aria-label="close session detail"
            title="close"
            style={{
                position: "absolute",
                top: 8,
                right: 10,
                zIndex: 2,
                width: 22,
                height: 22,
                lineHeight: "20px",
                textAlign: "center",
                padding: 0,
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                background: "transparent",
                color: META,
                cursor: "pointer",
                font: "13px/1 ui-monospace, monospace",
            }}
        >
            ×
        </button>
    );
}

function Excerpt({ tag, color, text }: { tag: string; color: string; text: string }) {
    return (
        <div style={{ marginBottom: 8 }}>
            <span
                style={{
                    color,
                    font: "700 9px/1 ui-monospace, monospace",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                }}
            >
                {tag}
            </span>
            <div style={{ marginTop: 2, color: BODY, font: "11px/1.5 ui-monospace, monospace" }}>
                {clip(text)}
            </div>
        </div>
    );
}

export function FocusDetail(props: { sessionId: string; onClose: () => void }) {
    const { sessionId, onClose } = props;

    const query = useQuery<SessionInspectPayload>({
        queryKey: ["session-inspect", sessionId],
        queryFn: () => api.sessionInspect(sessionId),
        staleTime: 5 * 60_000,
    });

    const turns = query.data?.turns ?? [];

    const derived = useMemo(() => {
        const first = firstUserTurn(turns);
        return {
            task: first ? turnText(first).trim() : null,
            firstAsk: first,
            lastAssistant: lastAssistantTurn(turns),
            correction: firstCorrectionTurn(turns),
            tools: toolRollup(turns),
        };
    }, [turns]);

    if (query.isLoading) {
        return (
            <Frame>
                <CloseButton onClose={onClose} />
                <div style={{ padding: 16, color: META, font: "11px/1.6 ui-monospace, monospace" }}>
                    Loading session…
                </div>
            </Frame>
        );
    }

    if (query.isError) {
        return (
            <Frame>
                <CloseButton onClose={onClose} />
                <div style={{ padding: 16, color: "#f0a3a3", font: "11px/1.6 ui-monospace, monospace" }}>
                    Failed to load session.
                    <div style={{ marginTop: 4, color: META }}>
                        {query.error instanceof Error ? query.error.message : "unknown error"}
                    </div>
                </div>
            </Frame>
        );
    }

    const data = query.data;
    if (!data || turns.length === 0) {
        return (
            <Frame>
                <CloseButton onClose={onClose} />
                <div style={{ padding: 16, color: META, font: "11px/1.6 ui-monospace, monospace" }}>
                    No turns recorded for this session.
                    <div style={{ marginTop: 8 }}>
                        <Link
                            to="/sessions/$sessionId/inspect"
                            params={{ sessionId }}
                            style={{ color: LINK, textDecoration: "none" }}
                        >
                            open full session →
                        </Link>
                    </div>
                </div>
            </Frame>
        );
    }

    const usage = data.token_usage;
    const tokens = fmtTokens(usage?.estimated_tokens);
    const cost = fmtUsd(usage?.estimated_cost_usd);
    const model = usage?.model ?? null;
    // source isn't on the inspect payload; surface what's available instead.
    const childCount = data.children.length;

    const stats: Array<{ label: string; value: string }> = [
        { label: "turns", value: String(data.total_turns) },
    ];
    if (tokens) stats.push({ label: "tokens", value: tokens });
    if (cost) stats.push({ label: "cost", value: cost });
    if (model) stats.push({ label: "model", value: model });
    if (childCount > 0) stats.push({ label: "subagents", value: String(childCount) });

    const excerpts: Array<{ tag: string; color: string; text: string }> = [];
    if (derived.firstAsk) {
        excerpts.push({ tag: "first ask", color: "#d8b34a", text: turnText(derived.firstAsk) });
    }
    if (derived.correction) {
        excerpts.push({ tag: "correction", color: "#e07a7a", text: turnText(derived.correction) });
    }
    if (derived.lastAssistant) {
        excerpts.push({ tag: "last assistant", color: "#6fb3ff", text: turnText(derived.lastAssistant) });
    }

    return (
        <Frame>
            <CloseButton onClose={onClose} />
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(220px, 1.2fr) minmax(160px, 0.9fr) minmax(260px, 1.4fr)",
                    gap: 0,
                    height: "100%",
                }}
            >
                {/* LEFT: task + stats */}
                <section style={{ padding: "14px 16px", borderRight: `1px solid ${BORDER}`, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                    <div style={labelStyle}>task</div>
                    <div
                        style={{
                            color: HEADER,
                            font: "700 13px/1.4 ui-monospace, monospace",
                            display: "-webkit-box",
                            WebkitLineClamp: 3,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                        }}
                    >
                        {derived.task ? clip(derived.task, 180) : "(no opening prompt)"}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: "auto", paddingTop: 12 }}>
                        {stats.map((s) => (
                            <span
                                key={s.label}
                                style={{
                                    border: `1px solid ${BORDER}`,
                                    borderRadius: 4,
                                    padding: "2px 7px",
                                    font: "10px/1.3 ui-monospace, monospace",
                                    color: BODY,
                                }}
                            >
                                <span style={{ color: META }}>{s.label} </span>
                                <strong style={{ color: HEADER }}>{s.value}</strong>
                            </span>
                        ))}
                    </div>
                </section>

                {/* MIDDLE: tool-activity rollup */}
                <section style={{ padding: "14px 16px", borderRight: `1px solid ${BORDER}`, overflow: "hidden" }}>
                    <div style={labelStyle}>tool activity</div>
                    {derived.tools.length === 0 ? (
                        <div style={{ color: META, font: "11px/1.5 ui-monospace, monospace" }}>
                            No tool calls in the loaded window.
                        </div>
                    ) : (
                        <div style={{ display: "grid", gap: 4 }}>
                            {derived.tools.map((tool) => (
                                <div
                                    key={tool.label}
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        gap: 8,
                                        font: "11px/1.3 ui-monospace, monospace",
                                        color: BODY,
                                    }}
                                >
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {tool.label}
                                    </span>
                                    <strong style={{ color: ACCENT }}>{tool.count}</strong>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {/* RIGHT: key turn excerpts + full-session link */}
                <section style={{ padding: "14px 16px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                    <div style={labelStyle}>what happened</div>
                    <div style={{ overflow: "hidden", flex: 1 }}>
                        {excerpts.length === 0 ? (
                            <div style={{ color: META, font: "11px/1.5 ui-monospace, monospace" }}>
                                No readable turn excerpts.
                            </div>
                        ) : (
                            excerpts.map((e) => <Excerpt key={e.tag} {...e} />)
                        )}
                    </div>
                    <div style={{ paddingTop: 6 }}>
                        <Link
                            to="/sessions/$sessionId/inspect"
                            params={{ sessionId }}
                            preload="intent"
                            style={{ color: LINK, textDecoration: "none", font: "700 11px/1 ui-monospace, monospace" }}
                        >
                            open full session →
                        </Link>
                    </div>
                </section>
            </div>
        </Frame>
    );
}
