/**
 * NarrationPanel - renders a SessionNarration as a scrollytelling spread
 * (Code Hike scrollycoding-style): story cards scroll down the left column,
 * and a sticky code pane on the right swaps to the active stop's hunks as
 * each card crosses the viewport's focus band. file_hunk anchors reuse the
 * same @pierre/diffs FileDiff + buildHunkPatch path as the review view; the
 * conversational anchors (turn / user_direction / correction / tool_failure)
 * stay inline in their card and jump into the transcript via onJumpToTurn.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { HighlighterCore } from "shiki/core";
import { ShikiMagicMove } from "shiki-magic-move/react";
import "shiki-magic-move/style.css";
import { highlighterFor, THEME } from "../highlight/highlighter.ts";
import { langFromPath } from "../highlight/lang.ts";
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
// Scrolly stop card (left column)
// ---------------------------------------------------------------------------

function StopCard({ stop, index, isActive, isLast, onJumpToTurn, onActivate, cardRef }: {
    readonly stop: NarrationStop;
    readonly index: number;
    readonly isActive: boolean;
    readonly isLast: boolean;
    readonly onJumpToTurn: (seq: number) => void;
    readonly onActivate: () => void;
    readonly cardRef: (el: HTMLDivElement | null) => void;
}) {
    // Code hunks live in the sticky pane; the card keeps the conversation.
    const inlineAnchors = stop.anchors.filter((a) => a.kind !== "file_hunk");
    return (
        <div
            ref={cardRef}
            data-stop-index={index}
            onClick={onActivate}
            style={{
                margin: "0 0 28px",
                padding: "12px 14px",
                background: "var(--panel)",
                border: "1px solid var(--line)",
                borderLeft: `3px solid ${isActive ? "var(--blue)" : "var(--line)"}`,
                borderRadius: 4,
                opacity: isActive ? 1 : 0.55,
                transition: "opacity 160ms ease, border-color 160ms ease",
                cursor: "default",
            }}
        >
            <div style={{ font: `700 10px/1.6 ${mono}`, textTransform: "uppercase", letterSpacing: "0.08em", color: isActive ? "var(--blue)" : "var(--muted)" }}>
                {index + 1} · {stop.title}
            </div>
            <div style={{ font: `700 12.5px/1.55 ${mono}`, color: "var(--ink)", margin: "2px 0 2px" }}>
                {stop.gist}
            </div>
            {renderDetail(stop.detail)}

            <div>
                {inlineAnchors.map((anchor, i) => (
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
// Sticky code pane (right column) - the active stop's hunks
// ---------------------------------------------------------------------------

/**
 * Magic-move morph of one hunk: mounts on the replaced fragment, then
 * animates token-by-token to the inserted one - the change plays as motion.
 * Crossing to another stop morphs from whatever is on screen to the next
 * hunk's old state and replays. Falls back to the static diff while the
 * grammar loads (or when the file has no known grammar).
 */
function MorphHunk({ anchor }: { readonly anchor: FileHunkAnchor }) {
    const lang = langFromPath(anchor.file);
    const [highlighter, setHighlighter] = useState<HighlighterCore | null>(null);
    useEffect(() => {
        if (!lang) return;
        let live = true;
        highlighterFor(lang).then((core) => {
            if (live) setHighlighter(core);
        });
        return () => {
            live = false;
        };
    }, [lang]);

    const oldCode = anchor.old_text;
    const newCode = anchor.new_text ?? "";
    const [code, setCode] = useState(oldCode ?? newCode);
    useEffect(() => {
        setCode(oldCode ?? newCode);
        if (oldCode != null && newCode) {
            // Let the old state paint, then play the morph to the new one.
            const t = setTimeout(() => setCode(newCode), 500);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [oldCode, newCode]);

    if (!lang || !highlighter) return <PaneDiff anchor={anchor} />;
    return (
        <div style={{ padding: "4px 12px 10px", font: `11.5px/1.5 ${mono}`, overflow: "auto" }}>
            <ShikiMagicMove
                highlighter={highlighter}
                lang={lang}
                theme={THEME}
                code={code}
                options={{ duration: 650, stagger: 2, lineNumbers: false }}
            />
        </div>
    );
}

function CodePane({ stop, index, onJumpToTurn }: {
    readonly stop: NarrationStop | null;
    readonly index: number;
    readonly onJumpToTurn: (seq: number) => void;
}) {
    const [mode, setMode] = useState<"animate" | "diff">("animate");
    const hunks = (stop?.anchors ?? []).filter((a): a is FileHunkAnchor => a.kind === "file_hunk");
    return (
        <div style={{
            position: "sticky",
            top: 12,
            maxHeight: "calc(100vh - 96px)",
            overflow: "auto",
            border: "1px solid var(--line)",
            borderRadius: 4,
            background: "var(--panel)",
        }}>
            <div style={{
                position: "sticky", top: 0, zIndex: 1,
                display: "flex", alignItems: "baseline", gap: 8,
                padding: "6px 12px",
                font: `700 10px/1.6 ${mono}`, textTransform: "uppercase", letterSpacing: "0.08em",
                color: "var(--muted)", background: "var(--panel)",
                borderBottom: "1px solid var(--line)",
            }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {stop ? `${index + 1} · ${stop.title}` : "code"}
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 2, flex: "0 0 auto" }}>
                    {(["animate", "diff"] as const).map((m) => (
                        <button
                            key={m}
                            type="button"
                            onClick={() => setMode(m)}
                            aria-pressed={mode === m}
                            style={{
                                font: `700 9.5px/1.6 ${mono}`, textTransform: "uppercase", letterSpacing: "0.06em",
                                padding: "0 7px", borderRadius: 3, cursor: "pointer",
                                border: "1px solid var(--line)",
                                background: mode === m ? "var(--ink)" : "transparent",
                                color: mode === m ? "var(--page)" : "var(--muted)",
                            }}
                        >
                            {m}
                        </button>
                    ))}
                </span>
            </div>
            {hunks.length === 0 ? (
                <div style={{ padding: "18px 14px", font: `11.5px/1.7 ${mono}`, color: "var(--muted)" }}>
                    No code for this stop - the story is in the card.
                </div>
            ) : (
                // Keyed by stop so the pane visibly swaps with the active card.
                <div key={index}>
                    {hunks.map((anchor, i) => (
                        <div key={i} style={{ borderBottom: i < hunks.length - 1 ? "1px solid var(--line)" : "none" }}>
                            <div style={{
                                display: "flex", alignItems: "baseline", gap: 8,
                                padding: "6px 12px 0",
                                font: `11px/1.6 ${mono}`, color: "var(--muted)",
                            }}>
                                <span style={{ fontWeight: 600, color: "var(--ink)" }}>{anchor.file}</span>
                                {anchor.turn_seq !== undefined ? (
                                    <span style={{ marginLeft: "auto" }}>
                                        <TurnButton seq={anchor.turn_seq} onJumpToTurn={onJumpToTurn} />
                                    </span>
                                ) : null}
                            </div>
                            <div style={{ padding: "0 12px 4px", font: `11px/1.6 ${mono}`, color: "var(--muted)" }}>
                                {anchor.label}
                            </div>
                            {mode === "animate" ? <MorphHunk anchor={anchor} /> : <PaneDiff anchor={anchor} />}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PaneDiff({ anchor }: { readonly anchor: FileHunkAnchor }) {
    const fileDiff = useMemo(
        () => getSingularPatch(buildHunkPatch(anchor.file, anchor.old_text, anchor.new_text)),
        [anchor.file, anchor.old_text, anchor.new_text],
    );
    return (
        <div style={{ font: `11.5px/1.5 ${mono}` }}>
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
    const [activeIdx, setActiveIdx] = useState(0);
    const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

    // The card whose top crosses the viewport's focus band (upper third)
    // becomes active and drives the sticky code pane - the scrollycoding
    // contract. Click also activates, for readers who browse instead of scroll.
    useEffect(() => {
        const cards = cardRefs.current.filter((el): el is HTMLDivElement => el != null);
        if (cards.length === 0) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const idx = Number((entry.target as HTMLElement).dataset.stopIndex);
                    if (Number.isFinite(idx)) setActiveIdx(idx);
                }
            },
            // A thin horizontal band ~1/3 down the viewport: a card becomes
            // active exactly when it scrolls through the reader's eye line.
            { rootMargin: "-30% 0px -60% 0px", threshold: 0 },
        );
        for (const card of cards) observer.observe(card);
        return () => observer.disconnect();
    }, [narration.stops.length]);

    const activeStop = narration.stops[activeIdx] ?? null;

    return (
        <div style={{ padding: "12px 14px" }}>
            {/* Header */}
            <div style={{ font: `700 14px/1.4 ${mono}`, color: "var(--ink)" }}>
                {narration.title}
            </div>
            <div style={{ font: `11px/1.7 ${mono}`, color: "var(--muted)", marginBottom: 8 }}>
                session {meta.session_id} · narrated by {meta.generator} ({meta.model}) · {meta.generated_at}
            </div>
            <div style={{ font: `12px/1.6 ${mono}`, color: "var(--ink)", marginBottom: 10, maxWidth: 760 }}>
                {renderInline(narration.intent)}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20, maxWidth: 860 }}>
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

            {/* Scrolly spread: cards left, sticky code right */}
            <div style={{
                display: "grid",
                gridTemplateColumns: "minmax(300px, 420px) minmax(0, 1fr)",
                gap: 20,
                alignItems: "start",
            }}>
                <div style={{ paddingBottom: "45vh" }}>
                    {narration.stops.map((stop, i) => (
                        <StopCard
                            key={i}
                            stop={stop}
                            index={i}
                            isActive={i === activeIdx}
                            isLast={i === narration.stops.length - 1}
                            onJumpToTurn={onJumpToTurn}
                            onActivate={() => setActiveIdx(i)}
                            cardRef={(el) => {
                                cardRefs.current[i] = el;
                            }}
                        />
                    ))}
                    <div style={{ font: `10.5px/1.6 ${mono}`, color: "var(--muted)", paddingTop: 6, borderTop: "1px solid var(--line)" }}>
                        {narration.stops.length} stops
                    </div>
                </div>
                <CodePane stop={activeStop} index={activeIdx} onJumpToTurn={onJumpToTurn} />
            </div>
        </div>
    );
}
