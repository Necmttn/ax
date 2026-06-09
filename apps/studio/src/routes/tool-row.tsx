import type { ToolCallDto, ToolCategory } from "@ax/lib/shared/dashboard-types";
import { stripToolResult } from "./tool-result.tsx";

const CATEGORY_TONE: Record<ToolCategory, { bg: string; fg: string }> = {
    net: { bg: "#e4f3ff", fg: "#1f7ac4" },
    file: { bg: "#fff0db", fg: "#b5730a" },
    edit: { bg: "#fde7ef", fg: "#b5306a" },
    sh: { bg: "#eceff3", fg: "#566173" },
    search: { bg: "#efeaff", fg: "#6b46ff" },
    agent: { bg: "#ffe9f3", fg: "#c43d7a" },
    other: { bg: "#eef2f6", fg: "#5a6472" },
};

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Primary arg per tool family - the one value worth showing inline next to the
 *  tool name instead of in a labelled grid. Keeps the header a single readable
 *  line: `Read  src/foo.ts`, `Bash  $ ls -la`. The rest still renders below. */
const PRIMARY_ARG: Record<string, ReadonlyArray<string>> = {
    Read: ["file_path", "path"],
    Write: ["file_path", "path"],
    Edit: ["file_path", "path"],
    Glob: ["pattern"],
    Grep: ["pattern"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    Task: ["description"],
    // The triggered skill's name (e.g. `superpowers:brainstorming`) reads as
    // this card's identity, inline next to `Skill`.
    Skill: ["skill"],
};

function primaryArg(name: string, input: Record<string, unknown> | null): string | null {
    if (!input) return null;
    const keys = PRIMARY_ARG[name] ?? [];
    for (const k of keys) {
        const v = input[k];
        if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
}

/**
 * One unified tool-call unit. A category-tinted left rail links the identity
 * header (badge · name · primary arg · tokens) to the full command/args block
 * and the full result output in a dark, internally-scrollable terminal block.
 * Always shows everything - no toggle. The rail is what visually links the call
 * to its result; the call and its output share one rail, one indent.
 *
 * Hierarchy, top to bottom:
 *   1. identity line  - WHAT ran (reads first, bold name + tinted badge)
 *   2. invocation     - command (`$ ...`) or structured args (secondary, dim)
 *   3. output         - the RESULT, dark terminal block (clearly the answer)
 *
 * Output is resolved from, in priority order:
 *   1. `result` - the paired tool_result turn's `raw_text` (live path, FULL).
 *   2. `call.output_excerpt` - the recorded excerpt (share path fallback).
 * Both pass through `stripToolResult` (wrapper tags + ANSI removed). No
 * truncation here; long output scrolls inside its bounded block so the
 * transcript viewport stays navigable.
 *
 * `Skill` cards carry an extra `skillContent`: the injected SKILL.md from the
 * paired `skill_context` turn. It becomes the main scrollable output block,
 * and the short "Launching skill: …" `result` demotes to a dim launch sub-line
 * above it - the trigger and its injected content fold into one card.
 */
export function ToolRowItem(
    { call, result, skillContent }: { call: ToolCallDto; result?: string; skillContent?: string },
) {
    const tone = CATEGORY_TONE[call.category];
    const input = call.input ?? null;
    const head = primaryArg(call.name, input);
    // Args shown in the grid = everything except the one promoted to the header.
    const headKey = head
        ? (PRIMARY_ARG[call.name] ?? []).find((k) => typeof input?.[k] === "string" && input[k] === head)
        : undefined;
    // `description` is the agent's stated intent for the call - surfaced as its
    // own prominent line, so never repeat it in the args grid.
    const entries = input ? Object.entries(input).filter(([k]) => k !== headKey && k !== "description") : [];
    const intent = typeof input?.description === "string" && input.description.length > 0 && input.description !== head
        ? input.description
        : null;

    const rawOutput = result ?? call.output_excerpt ?? "";
    const resultText = rawOutput ? stripToolResult(rawOutput) : "";
    // Skill cards: the injected SKILL.md is the main output; the short
    // "Launching skill: …" result becomes a dim launch sub-line above it.
    const skill = skillContent ? stripToolResult(skillContent) : "";
    const hasSkill = skill.trim().length > 0;
    const launchSubline = hasSkill && resultText.trim().length > 0 ? resultText : null;
    // For every other card the result IS the output block.
    const output = hasSkill ? skill : resultText;
    const hasOutput = output.trim().length > 0;

    return (
        <div style={{ display: "flex", gap: 9, margin: "2px 0 8px" }}>
            <div
                aria-hidden
                style={{ flex: "0 0 2px", borderRadius: 2, background: tone.fg, opacity: 0.4 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div
                    style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        font: `12.5px/1.5 ${mono}`,
                        color: call.has_error ? "#c4361f" : "#2d2840",
                        padding: "0 0 3px",
                    }}
                >
                    <span
                        style={{
                            font: `700 9.5px/1.7 ${mono}`,
                            letterSpacing: "0.03em",
                            textTransform: "uppercase",
                            borderRadius: 3,
                            padding: "1px 6px",
                            background: tone.bg,
                            color: tone.fg,
                            flex: "0 0 auto",
                        }}
                    >
                        {call.category}
                    </span>
                    <span style={{ fontWeight: 700, flex: "0 0 auto" }}>{call.name}</span>
                    {head
                        ? (
                            <span
                                style={{
                                    color: "#8b8398",
                                    minWidth: 0,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    fontSize: 12,
                                }}
                                title={head}
                            >
                                {head}
                            </span>
                        )
                        : null}
                    {call.has_error
                        ? (
                            <span data-testid="tool-row-error" title="error" style={{ color: "#c4361f", flex: "0 0 auto" }}>
                                ⚠
                            </span>
                        )
                        : null}
                    {call.tokens != null
                        ? (
                            <span style={{ marginLeft: "auto", color: "#b3b8c2", fontSize: 10.5, flex: "0 0 auto" }}>
                                {call.tokens.toLocaleString()}
                            </span>
                        )
                        : null}
                </div>
                {intent
                    ? (
                        <div
                            style={{
                                margin: "0 0 4px",
                                font: `12px/1.5 ${mono}`,
                                color: "#2d2840",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                            }}
                        >
                            {intent}
                        </div>
                    )
                    : null}
                {call.command
                    ? (
                        <pre
                            style={{
                                margin: "0 0 6px",
                                font: `11px/1.5 ${mono}`,
                                color: "#8b8398",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                maxHeight: 130,
                                overflow: "auto",
                            }}
                        >
                            <span style={{ color: "#c0a3e8", userSelect: "none" }}>$ </span>
                            {call.command}
                        </pre>
                    )
                    : entries.length > 0
                    ? (
                        <div
                            style={{
                                margin: "0 0 6px",
                                maxHeight: 170,
                                overflow: "auto",
                                display: "grid",
                                gridTemplateColumns: "minmax(56px,auto) 1fr",
                                gap: "2px 12px",
                                font: `11px/1.5 ${mono}`,
                            }}
                        >
                            {entries.map(([k, v]) => (
                                <div key={k} style={{ display: "contents" }}>
                                    <span style={{ color: "#b3b8c2", textAlign: "right" }}>{k}</span>
                                    <span style={{ color: "#3a3550", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                        {typeof v === "string" ? v : JSON.stringify(v)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )
                    : null}
                {launchSubline
                    ? (
                        <div
                            data-testid="skill-launch-line"
                            style={{
                                margin: "0 0 5px",
                                font: `11px/1.5 ${mono}`,
                                color: "#8b8398",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                            }}
                        >
                            {launchSubline}
                        </div>
                    )
                    : null}
                {hasOutput
                    ? (
                        <pre
                            data-testid="tool-card-output"
                            style={{
                                margin: 0,
                                padding: "8px 12px",
                                borderRadius: 6,
                                background: "#1e1e2e",
                                color: "#cdd6f4",
                                font: `11.5px/1.55 ${mono}`,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                overflow: "auto",
                                maxHeight: 260,
                            }}
                        >
                            {output}
                        </pre>
                    )
                    : null}
            </div>
        </div>
    );
}

/** Compact log-line rendering of a turn's tool calls. One unified card per
 *  call (header + command/args + full result output). `resultFor(callIndex)`
 *  supplies the paired tool_result text when available (live path); on the
 *  share path the card falls back to each call's own `output_excerpt`. */
export function ToolRow(
    { calls, resultFor, skillContentFor }: {
        calls: ReadonlyArray<ToolCallDto>;
        resultFor?: (callIndex: number) => string | undefined;
        /** Injected SKILL.md for a `Skill` call's i-th index (live + share). */
        skillContentFor?: (callIndex: number) => string | undefined;
    },
) {
    if (calls.length === 0) return null;
    return (
        <div style={{ padding: "2px 0 2px", fontFamily: mono }}>
            {calls.map((call, i) => (
                <ToolRowItem
                    key={`${call.seq}-${call.name}-${i}`}
                    call={call}
                    result={resultFor?.(i)}
                    skillContent={skillContentFor?.(i)}
                />
            ))}
        </div>
    );
}
