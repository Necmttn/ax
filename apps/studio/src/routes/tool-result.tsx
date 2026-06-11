import { useState } from "react";
import { LogText } from "../highlight/log-line.tsx";

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

// Tolerant of attributes, e.g. `<tool_result foo="bar">`. Matches a single
// leading wrapper open tag and a single trailing close tag.
const WRAPPER_OPEN = /^\s*<(?:local-command-stdout|tool_result)\b[^>]*>/i;
const WRAPPER_CLOSE = /<\/(?:local-command-stdout|tool_result)>\s*$/i;
// ANSI SGR escapes (colors/styles). v1 just strips them - no color parsing.
// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Strip the `<local-command-stdout>`/`<tool_result>` wrapper tags and ANSI
 *  escape codes so only the raw tool output remains. */
export function stripToolResult(text: string): string {
    return text.replace(WRAPPER_OPEN, "").replace(WRAPPER_CLOSE, "").replace(ANSI, "");
}

function firstNonEmptyLine(text: string): string {
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (t) return t.length > 120 ? `${t.slice(0, 120)}…` : t;
    }
    return "";
}

/** Compact, collapsible, terminal-styled view of a tool RESULT turn (stdout
 *  from a tool call). Collapsed by default: a one-line summary; expanded: the
 *  stripped output in a dark terminal block. `open` is optional - when supplied
 *  the view is controlled (static markup + tests); otherwise it manages its own
 *  expand state. Layout is intentionally soft; the data is just the text. */
export function ToolResultView({ text, open: openProp }: { text: string; open?: boolean }) {
    const [openState, setOpenState] = useState(false);
    const controlled = openProp !== undefined;
    const open = controlled ? openProp : openState;

    const output = stripToolResult(text);
    const trimmed = output.trim();
    const empty = trimmed.length === 0;
    const lines = output.replace(/\n+$/, "").split("\n");
    const lineCount = empty ? 0 : lines.length;
    const summary = empty
        ? "(no output)"
        : lineCount === 1
        ? `result · ${output.length} char${output.length === 1 ? "" : "s"}`
        : `result · ${lineCount} lines`;
    // Single-line output is short enough to preview inline even when collapsed;
    // multi-line output previews its first non-empty line.
    const preview = empty ? "" : firstNonEmptyLine(output);

    if (empty) {
        return (
            <div style={{ padding: "4px 0 6px", font: `12px/1.5 ${mono}`, color: "#94a3b8" }}>
                <span style={{ color: "#b8b2cf", marginRight: 8 }}>⌷</span>
                · (no output)
            </div>
        );
    }

    return (
        <div style={{ padding: "2px 0 6px" }}>
            <button
                type="button"
                onClick={controlled ? undefined : () => setOpenState((v) => !v)}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "4px 0",
                    cursor: "pointer",
                    font: `12.5px/1.5 ${mono}`,
                    color: "#3a3550",
                }}
            >
                <span style={{ color: "#b8b2cf", width: 10 }}>{open ? "▾" : "▸"}</span>
                <span style={{ color: "#8b8398" }}>⌷</span>
                <span style={{ fontWeight: 600, color: "#5a6472" }}>{summary}</span>
                {preview
                    ? (
                        <span
                            style={{
                                color: "#9aa0ad",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {preview}
                        </span>
                    )
                    : null}
            </button>
            {open
                ? (
                    <pre
                        style={{
                            margin: "2px 0 0 19px",
                            padding: "10px 13px",
                            borderRadius: 7,
                            background: "#1e1e2e",
                            color: "#cdd6f4",
                            font: `11.5px/1.55 ${mono}`,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            overflow: "auto",
                            maxHeight: 360,
                        }}
                    >
                        <LogText text={output} />
                    </pre>
                )
                : null}
        </div>
    );
}
