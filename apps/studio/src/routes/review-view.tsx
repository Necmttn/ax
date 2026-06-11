import { useMemo, useState, type CSSProperties } from "react";
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { SessionInspectPayload } from "@ax/lib/shared/dashboard-types";
import type { SessionTimelinePayload } from "../api.ts";
import { ToolRowItem } from "./tool-row.tsx";
import { compactChars, FilesTouchedTree } from "./files-touched-panel.tsx";
import {
    buildFilesTouched,
    buildFileStory,
    buildHunkPatch,
    buildTouchContexts,
    type FileStoryEvent,
    type FileTouch,
} from "./files-touched.ts";

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

const PANE_HEADER: CSSProperties = {
    font: `700 10px/1.5 ${mono}`,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--muted)",
    padding: "8px 10px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel)",
    position: "sticky",
    top: 0,
    zIndex: 1,
};

/** One write event in the file's story, rendered as a real diff via
 *  @pierre/diffs - word-level intraline highlights, proper +/- gutter. Line
 *  numbers are hidden: tool calls carry fragments, not file offsets. */
function HunkCard({ event, path, onOpenTranscript, onFocusTurn }: {
    readonly event: FileStoryEvent;
    readonly path: string;
    readonly onOpenTranscript: (seq: number) => void;
    readonly onFocusTurn: (seq: number) => void;
}) {
    const fileDiff = useMemo(
        () => getSingularPatch(buildHunkPatch(path, event.oldString, event.newString)),
        [path, event.oldString, event.newString],
    );
    return (
        <div style={{
            margin: "8px 10px",
            border: "1px solid var(--line)",
            borderLeft: `3px solid ${event.hasError ? "var(--red)" : "var(--green)"}`,
            borderRadius: 4,
            overflow: "hidden",
            background: "var(--panel)",
        }}>
            <div style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                padding: "4px 10px",
                font: `11px/1.6 ${mono}`,
                color: "var(--muted)",
                borderBottom: "1px solid var(--line)",
            }}>
                <button
                    type="button"
                    onClick={() => onFocusTurn(event.turnSeq)}
                    style={{
                        background: "none", border: "none", padding: 0, cursor: "pointer",
                        font: `700 11px/1.6 ${mono}`, color: "var(--blue)",
                    }}
                    title="Show this turn in the right pane"
                >
                    turn {event.turnSeq}
                </button>
                <span style={{ fontWeight: 600 }}>{event.tool}</span>
                {event.hasError ? <span style={{ color: "var(--red)" }}>⚠ failed</span> : null}
                <button
                    type="button"
                    onClick={() => onOpenTranscript(event.turnSeq)}
                    style={{
                        marginLeft: "auto", background: "none", border: "none", padding: 0,
                        cursor: "pointer", font: `11px/1.6 ${mono}`, color: "var(--muted)",
                    }}
                >
                    open in transcript →
                </button>
            </div>
            <div style={{ maxHeight: 360, overflow: "auto", font: `11.5px/1.5 ${mono}` }}>
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

/**
 * DiffsHub-style review surface for one session: files-touched tree as the
 * sidebar, the selected file's ordered change story (every hunk the agent
 * applied, in order) in the center, and the transcript turns that touched
 * that file on the right - so a reviewer can read WHY next to WHAT.
 */
export function ReviewView({ data, timeline, onOpenTranscript }: {
    readonly data: SessionInspectPayload;
    /** Share timeline (when present) - its segments label each touching turn
     *  with the phase the agent was in. */
    readonly timeline?: SessionTimelinePayload | null;
    /** Switch to the transcript view anchored at a turn. */
    readonly onOpenTranscript: (seq: number) => void;
}) {
    const model = useMemo(() => buildFilesTouched(data.turns), [data.turns]);
    const defaultFile = model.files.find((f) => f.status != null) ?? model.files[0];
    const [selected, setSelected] = useState<FileTouch | undefined>(defaultFile);
    const story = useMemo(
        () => (selected ? buildFileStory(data.turns, selected.absPath) : []),
        [data.turns, selected],
    );
    const touchingSeqs = useMemo(() => new Set(story.map((e) => e.turnSeq)), [story]);
    const touchingTurns = useMemo(
        () => data.turns.filter((t) => touchingSeqs.has(t.seq)),
        [data.turns, touchingSeqs],
    );
    const contexts = useMemo(
        () => buildTouchContexts(data.turns, [...touchingSeqs]),
        [data.turns, touchingSeqs],
    );
    // seq → enclosing timeline segment title ("the phase the agent was in").
    const segmentFor = useMemo(() => {
        const segments = (timeline?.segments ?? [])
            .filter((s) => s.start_seq != null)
            .sort((a, b) => (a.start_seq ?? 0) - (b.start_seq ?? 0));
        return (seq: number): string | null => {
            let title: string | null = null;
            for (const s of segments) {
                if ((s.start_seq ?? 0) > seq) break;
                title = s.title.replace(/^committed\s+\S+\s*·\s*/, "").trim() || s.title;
            }
            return title;
        };
    }, [timeline]);
    const writes = story.filter((e) => e.op === "write");

    const focusTurn = (seq: number) => {
        document.getElementById(`rev-t-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    if (model.files.length === 0) {
        return (
            <div style={{ padding: "16px var(--strip-x)", color: "var(--muted)", font: `12px/1.5 ${mono}` }}>
                No file activity in this session.
            </div>
        );
    }

    return (
        <div style={{
            display: "grid",
            gridTemplateColumns: "280px minmax(0, 1fr) minmax(280px, 380px)",
            borderTop: "1px solid var(--line)",
            height: "min(78vh, 860px)",
        }}>
            <div style={{ borderRight: "1px solid var(--line)", overflow: "auto", background: "var(--panel)" }}>
                <div style={PANE_HEADER}>
                    {model.files.length} files{model.root ? <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {model.root}</span> : null}
                </div>
                <div style={{ padding: "4px 6px" }}>
                    <FilesTouchedTree
                        model={model}
                        onSelect={setSelected}
                        initialSelectedPath={defaultFile?.path}
                        maxHeight={780}
                    />
                </div>
            </div>
            <div style={{ borderRight: "1px solid var(--line)", overflow: "auto" }}>
                <div style={PANE_HEADER}>
                    <span style={{ textTransform: "none", letterSpacing: 0 }}>{selected?.path ?? ""}</span>
                    {selected && (selected.charsAdded > 0 || selected.charsRemoved > 0) ? (
                        <span style={{ marginLeft: 8 }}>
                            {selected.charsAdded > 0 ? <span style={{ color: "var(--green)" }}>+{compactChars(selected.charsAdded)}</span> : null}
                            {" "}
                            {selected.charsRemoved > 0 ? <span style={{ color: "var(--red)" }}>−{compactChars(selected.charsRemoved)}</span> : null}
                        </span>
                    ) : null}
                    <span style={{ marginLeft: 8 }}>{writes.length} change{writes.length === 1 ? "" : "s"}</span>
                </div>
                {story.map((event, i) =>
                    event.op === "write" ? (
                        <HunkCard
                            key={`${event.turnSeq}-${event.callIndex}-${i}`}
                            event={event}
                            path={selected?.path ?? ""}
                            onOpenTranscript={onOpenTranscript}
                            onFocusTurn={focusTurn}
                        />
                    ) : (
                        <div
                            key={`${event.turnSeq}-${event.callIndex}-${i}`}
                            style={{ padding: "2px 12px", font: `11px/1.6 ${mono}`, color: "var(--muted-2)" }}
                        >
                            ◦ read at{" "}
                            <button
                                type="button"
                                onClick={() => focusTurn(event.turnSeq)}
                                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--blue)" }}
                            >
                                turn {event.turnSeq}
                            </button>
                        </div>
                    ),
                )}
            </div>
            <div style={{ overflow: "auto", background: "var(--page)" }}>
                <div style={PANE_HEADER}>
                    why - turns touching this file
                </div>
                {touchingTurns.map((turn) => {
                    const ownCalls = (turn.tool_calls ?? []).filter((call) => {
                        const input = call.input ?? {};
                        return [input.file_path, input.path, input.notebook_path].includes(selected?.absPath);
                    });
                    const text = (turn.raw_text ?? "").trim();
                    const ctx = contexts.get(turn.seq);
                    const phase = segmentFor(turn.seq);
                    const chips = [
                        phase ? { label: phase, title: "session phase (timeline segment)" } : null,
                        ctx?.activeTodo ? { label: `☐ ${ctx.activeTodo}`, title: "active plan item (latest TodoWrite)" } : null,
                    ].filter((c): c is { label: string; title: string } => c != null);
                    return (
                        <div key={turn.seq} id={`rev-t-${turn.seq}`} style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
                            {chips.length > 0 ? (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                                    {chips.map((chip) => (
                                        <span
                                            key={chip.label}
                                            title={chip.title}
                                            style={{
                                                font: `10px/1.6 ${mono}`,
                                                color: "var(--muted)",
                                                background: "var(--panel)",
                                                border: "1px solid var(--line)",
                                                borderRadius: 3,
                                                padding: "0 6px",
                                                maxWidth: "100%",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {chip.label}
                                        </span>
                                    ))}
                                </div>
                            ) : null}
                            {ctx?.userDirection ? (
                                <div style={{
                                    margin: "0 0 6px",
                                    padding: "4px 8px",
                                    borderLeft: "3px solid var(--blue)",
                                    background: "color-mix(in srgb, var(--blue) 6%, var(--panel))",
                                    borderRadius: 3,
                                    font: `11.5px/1.5 ${mono}`,
                                    color: "var(--ink)",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    maxHeight: 120,
                                    overflow: "auto",
                                }}>
                                    <button
                                        type="button"
                                        onClick={() => onOpenTranscript(ctx.userDirection!.seq)}
                                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: `700 10px/1.6 ${mono}`, color: "var(--blue)", display: "block" }}
                                    >
                                        user · turn {ctx.userDirection.seq} →
                                    </button>
                                    {ctx.userDirection.text.length > 600 ? `${ctx.userDirection.text.slice(0, 600)}…` : ctx.userDirection.text}
                                </div>
                            ) : null}
                            {ctx?.reasoning && ctx.reasoning.seq !== turn.seq ? (
                                <div style={{
                                    margin: "0 0 6px",
                                    padding: "4px 8px",
                                    borderLeft: "3px solid var(--line)",
                                    font: `11.5px/1.5 ${mono}`,
                                    color: "var(--muted)",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    maxHeight: 120,
                                    overflow: "auto",
                                }}>
                                    {ctx.reasoning.text.length > 600 ? `${ctx.reasoning.text.slice(0, 600)}…` : ctx.reasoning.text}
                                </div>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => onOpenTranscript(turn.seq)}
                                style={{
                                    background: "none", border: "none", padding: 0, cursor: "pointer",
                                    font: `700 10.5px/1.6 ${mono}`, color: "var(--blue)",
                                }}
                            >
                                turn {turn.seq} →
                            </button>
                            {text ? (
                                <div style={{
                                    margin: "4px 0 6px",
                                    font: `11.5px/1.55 ${mono}`,
                                    color: "var(--ink)",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    maxHeight: 160,
                                    overflow: "auto",
                                }}>
                                    {text.length > 1200 ? `${text.slice(0, 1200)}…` : text}
                                </div>
                            ) : null}
                            {ownCalls.map((call, i) => (
                                <ToolRowItem key={`${call.seq}-${i}`} call={call} />
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
