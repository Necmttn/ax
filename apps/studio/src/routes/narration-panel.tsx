/**
 * NarrationPanel - renders a SessionNarration as a vertical timeline:
 * header (title, intent, before/after), then stops down a border-left spine
 * (TourDialog-style), each with a bold gist, lightly-rendered markdown
 * detail, and anchors drawn by kind. file_hunk anchors reuse the same
 * @pierre/diffs FileDiff + buildHunkPatch path as the review view; the
 * conversational anchors (turn / user_direction / correction / tool_failure)
 * are quote/marker blocks that jump into the transcript via onJumpToTurn.
 */

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { buildHunkPatch } from "./files-touched.ts";
import type {
    CorrectionAnchor,
    FileHunkAnchor,
    NarrationAnchor,
    NarrationStop,
    SessionNarration,
    TermAnchor,
    ToolFailureAnchor,
    TurnAnchor,
    UserDirectionAnchor,
} from "./narration-types.ts";

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

// ---------------------------------------------------------------------------
// Tiny markdown: paragraphs + `inline code` + **bold**. No md lib.
// ---------------------------------------------------------------------------

function renderInline(text: string): ReactNode[] {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
            return (
                <code
                    key={i}
                    style={{
                        font: `11px/1.5 ${mono}`,
                        background: "var(--panel)",
                        border: "1px solid var(--line)",
                        borderRadius: 3,
                        padding: "0 3px",
                    }}
                >
                    {part.slice(1, -1)}
                </code>
            );
        }
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
            return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part;
    });
}

function renderDetail(text: string): ReactNode[] {
    return text
        .split(/\n\s*\n/)
        .filter((p) => p.trim().length > 0)
        .map((para, i) => (
            <p key={i} style={{ margin: "4px 0", font: `12px/1.6 ${mono}`, color: "var(--ink)" }}>
                {renderInline(para.trim())}
            </p>
        ));
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function TurnButton({ seq, onJumpToTurn }: {
    readonly seq: number;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    return (
        <button
            type="button"
            onClick={() => onJumpToTurn(seq)}
            style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                font: `700 11px/1.6 ${mono}`, color: "var(--blue)",
            }}
            title="Jump to this turn in the transcript"
        >
            turn {seq}
        </button>
    );
}

const KIND_TAG: CSSProperties = {
    font: `700 9.5px/1.6 ${mono}`,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
};

// ---------------------------------------------------------------------------
// Anchor renderers by kind
// ---------------------------------------------------------------------------

function FileHunkBlock({ anchor, onJumpToTurn }: {
    readonly anchor: FileHunkAnchor;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    const fileDiff = useMemo(
        () => getSingularPatch(buildHunkPatch(anchor.file, anchor.old_text, anchor.new_text)),
        [anchor.file, anchor.old_text, anchor.new_text],
    );
    return (
        <div style={{
            margin: "8px 0",
            border: "1px solid var(--line)",
            borderLeft: "3px solid var(--green)",
            borderRadius: 4,
            overflow: "hidden",
            background: "var(--panel)",
        }}>
            <div style={{
                display: "flex", alignItems: "baseline", gap: 8, padding: "4px 10px",
                font: `11px/1.6 ${mono}`, color: "var(--muted)",
                borderBottom: "1px solid var(--line)",
            }}>
                <span style={{ fontWeight: 600, color: "var(--ink)" }}>{anchor.file}</span>
                {anchor.turn_seq !== undefined ? (
                    <span style={{ marginLeft: "auto" }}>
                        <TurnButton seq={anchor.turn_seq} onJumpToTurn={onJumpToTurn} />
                    </span>
                ) : null}
            </div>
            <div style={{ padding: "4px 10px", font: `11px/1.6 ${mono}`, color: "var(--muted)" }}>
                {anchor.label}
            </div>
            <div style={{ maxHeight: 280, overflow: "auto", font: `11.5px/1.5 ${mono}` }}>
                <FileDiff
                    fileDiff={fileDiff}
                    options={{
                        themeType: "light",
                        diffStyle: "unified",
                        overflow: "wrap",
                        lineDiffType: "word-alt",
                        diffIndicators: "bars",
                        disableLineNumbers: true,
                        disableFileHeader: true,
                        hunkSeparators: "simple",
                    }}
                />
            </div>
        </div>
    );
}

function TurnMarker({ anchor, onJumpToTurn }: {
    readonly anchor: TurnAnchor;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    return (
        <div style={{ margin: "6px 0", font: `11.5px/1.6 ${mono}`, color: "var(--muted)" }}>
            ◦ <TurnButton seq={anchor.turn_seq} onJumpToTurn={onJumpToTurn} /> - {anchor.label}
        </div>
    );
}

function QuoteBlock({ tag, color, seq, onJumpToTurn, children }: {
    readonly tag: string;
    readonly color: string;
    readonly seq: number;
    readonly onJumpToTurn: (seq: number) => void;
    readonly children: ReactNode;
}) {
    return (
        <div style={{
            margin: "8px 0",
            padding: "6px 10px",
            border: "1px solid var(--line)",
            borderLeft: `3px solid ${color}`,
            borderRadius: 4,
            background: "var(--panel)",
        }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ ...KIND_TAG, color }}>{tag}</span>
                <span style={{ marginLeft: "auto" }}>
                    <TurnButton seq={seq} onJumpToTurn={onJumpToTurn} />
                </span>
            </div>
            {children}
        </div>
    );
}

function UserDirectionBlock({ anchor, onJumpToTurn }: {
    readonly anchor: UserDirectionAnchor;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    return (
        <QuoteBlock tag="user direction" color="var(--blue)" seq={anchor.turn_seq} onJumpToTurn={onJumpToTurn}>
            <div style={{ font: `italic 12px/1.6 ${mono}`, color: "var(--ink)", marginTop: 2 }}>
                “{anchor.quote}”
            </div>
        </QuoteBlock>
    );
}

function CorrectionBlock({ anchor, onJumpToTurn }: {
    readonly anchor: CorrectionAnchor;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    return (
        <QuoteBlock tag="correction" color="var(--gold)" seq={anchor.turn_seq} onJumpToTurn={onJumpToTurn}>
            <div style={{ font: `italic 12px/1.6 ${mono}`, color: "var(--ink)", marginTop: 2 }}>
                “{anchor.quote}”
            </div>
            <div style={{ font: `11.5px/1.6 ${mono}`, color: "var(--muted)", marginTop: 4 }}>
                → {anchor.outcome}
            </div>
        </QuoteBlock>
    );
}

function ToolFailureBlock({ anchor, onJumpToTurn }: {
    readonly anchor: ToolFailureAnchor;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    return (
        <QuoteBlock tag={`${anchor.tool} failed`} color="var(--red)" seq={anchor.turn_seq} onJumpToTurn={onJumpToTurn}>
            <div style={{
                font: `11px/1.5 ${mono}`, color: "var(--red)", marginTop: 2,
                whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
                {anchor.error_excerpt}
            </div>
            <div style={{ font: `11.5px/1.6 ${mono}`, color: "var(--muted)", marginTop: 4 }}>
                ↻ {anchor.recovery}
            </div>
        </QuoteBlock>
    );
}

function TermChip({ anchor }: { readonly anchor: TermAnchor }) {
    return (
        <span
            title={anchor.definition}
            style={{
                display: "inline-flex", alignItems: "baseline", gap: 5,
                margin: "4px 6px 4px 0", padding: "1px 8px",
                border: "1px solid var(--line)", borderRadius: 10,
                background: "var(--panel)", font: `11px/1.7 ${mono}`,
            }}
        >
            <span style={{ fontWeight: 700, color: "var(--ink)" }}>{anchor.name}</span>
            <span style={{ color: "var(--muted)" }}>{anchor.definition}</span>
        </span>
    );
}

function AnchorView({ anchor, onJumpToTurn }: {
    readonly anchor: NarrationAnchor;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    switch (anchor.kind) {
        case "file_hunk":
            return <FileHunkBlock anchor={anchor} onJumpToTurn={onJumpToTurn} />;
        case "turn":
            return <TurnMarker anchor={anchor} onJumpToTurn={onJumpToTurn} />;
        case "user_direction":
            return <UserDirectionBlock anchor={anchor} onJumpToTurn={onJumpToTurn} />;
        case "correction":
            return <CorrectionBlock anchor={anchor} onJumpToTurn={onJumpToTurn} />;
        case "tool_failure":
            return <ToolFailureBlock anchor={anchor} onJumpToTurn={onJumpToTurn} />;
        case "term":
            return <TermChip anchor={anchor} />;
    }
}

// ---------------------------------------------------------------------------
// Stop card on the timeline spine
// ---------------------------------------------------------------------------

function StopCard({ stop, index, isLast, onJumpToTurn }: {
    readonly stop: NarrationStop;
    readonly index: number;
    readonly isLast: boolean;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    return (
        <div style={{ position: "relative", paddingLeft: 26, paddingBottom: isLast ? 4 : 18 }}>
            {/* Timeline node */}
            <span style={{
                position: "absolute", left: -10, top: 0,
                width: 20, height: 20, borderRadius: "50%",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "var(--panel)", border: "1px solid var(--line)",
                font: `700 9.5px/1 ${mono}`, color: "var(--blue)",
            }}>
                {index + 1}
            </span>

            <div style={{ font: `700 10px/1.6 ${mono}`, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)" }}>
                {stop.title}
            </div>
            <div style={{ font: `700 12.5px/1.55 ${mono}`, color: "var(--ink)", margin: "2px 0 2px" }}>
                {stop.gist}
            </div>
            {renderDetail(stop.detail)}

            <div>
                {stop.anchors.map((anchor, i) => (
                    <AnchorView key={i} anchor={anchor} onJumpToTurn={onJumpToTurn} />
                ))}
            </div>

            {!isLast && stop.transition ? (
                <div style={{ font: `italic 11px/1.6 ${mono}`, color: "var(--muted)", marginTop: 6 }}>
                    {stop.transition}
                </div>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const HEADER_CARD: CSSProperties = {
    border: "1px solid var(--line)",
    borderRadius: 4,
    background: "var(--panel)",
    padding: "6px 10px",
    flex: "1 1 0",
    minWidth: 0,
};

export function NarrationPanel({ narration, onJumpToTurn }: {
    readonly narration: SessionNarration;
    /** Jump the transcript view to a turn seq. */
    readonly onJumpToTurn: (seq: number) => void;
}) {
    const { meta } = narration;
    return (
        <div style={{ padding: "12px 14px", maxWidth: 860 }}>
            {/* Header */}
            <div style={{ font: `700 14px/1.4 ${mono}`, color: "var(--ink)" }}>
                {narration.title}
            </div>
            <div style={{ font: `11px/1.7 ${mono}`, color: "var(--muted)", marginBottom: 8 }}>
                session {meta.session_id} · narrated by {meta.generator} ({meta.model}) · {meta.generated_at}
            </div>
            <div style={{ font: `12px/1.6 ${mono}`, color: "var(--ink)", marginBottom: 10 }}>
                {renderInline(narration.intent)}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <div style={HEADER_CARD}>
                    <span style={{ ...KIND_TAG, color: "var(--red)" }}>before</span>
                    <div style={{ font: `11.5px/1.6 ${mono}`, color: "var(--ink)", marginTop: 2 }}>
                        {narration.before}
                    </div>
                </div>
                <div style={HEADER_CARD}>
                    <span style={{ ...KIND_TAG, color: "var(--green)" }}>after</span>
                    <div style={{ font: `11.5px/1.6 ${mono}`, color: "var(--ink)", marginTop: 2 }}>
                        {narration.after}
                    </div>
                </div>
            </div>

            {/* Timeline spine */}
            <div style={{ borderLeft: "1px solid var(--line)", marginLeft: 10, paddingTop: 2 }}>
                {narration.stops.map((stop, i) => (
                    <StopCard
                        key={i}
                        stop={stop}
                        index={i}
                        isLast={i === narration.stops.length - 1}
                        onJumpToTurn={onJumpToTurn}
                    />
                ))}
            </div>

            <div style={{ font: `10.5px/1.6 ${mono}`, color: "var(--muted)", marginTop: 10, paddingTop: 6, borderTop: "1px solid var(--line)" }}>
                {narration.stops.length} stops
            </div>
        </div>
    );
}
