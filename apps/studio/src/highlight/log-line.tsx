/**
 * Lightweight enrichment for terminal output blocks (tool stdout). Plain
 * tool output has no grammar, but it has recognizable shapes: file paths,
 * error/warning words, numbers-with-units, diff lines. A tiny synchronous
 * tokenizer colors just those, tuned for the dark --term-bg (#1e1e2e,
 * catppuccin-mocha base) so output stops reading as one pale slab.
 * Rendered text is always exactly the input - copy stays byte-faithful.
 */
import { Fragment, useMemo, type ReactNode } from "react";

export type LogKind = "plain" | "path" | "number" | "error" | "warn" | "add" | "del" | "hunk";
export type LogSpan = { text: string; kind: LogKind };

/** Above this, render plain - tokenizing megabyte blobs janks the main thread. */
const MAX_LOG_CHARS = 50_000;

// Catppuccin-mocha accents on the #1e1e2e block. Plain text inherits the
// block's --term-fg.
const LOG_COLOR: Record<Exclude<LogKind, "plain">, string> = {
    path: "#89b4fa",
    number: "#fab387",
    error: "#f38ba8",
    warn: "#f9e2af",
    add: "#a6e3a1",
    del: "#f38ba8",
    hunk: "#cba6f7",
};

// One alternation, ordered: paths first (they contain digits/words that the
// later groups would otherwise split), then severity words, then numbers
// with an optional unit. Plain bare integers stay plain - coloring every
// digit reads as noise.
const TOKEN_RE = new RegExp(
    [
        // /abs/or/rel/paths with 2+ segments, optional :line(:col)
        /(?<path>(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?(?::\d+(?::\d+)?)?|\b[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?)/
            .source,
        /(?<error>\b(?:error(?:s)?|err|fail(?:ed|ure|s)?|fatal|exception|panic(?:ked)?|denied|missing|cannot|unable|not found)\b)/
            .source,
        /(?<warn>\b(?:warn(?:ing|ings)?|deprecated|skip(?:ped|s)?|stale|pending|timeout)\b)/.source,
        // `%` is a non-word char, so the trailing guard is a lookahead, not \b
        /(?<number>\b\d[\d,_]*(?:\.\d+)?\s?(?:ms|s|m|h|[kmgt]i?b|%)(?!\w))/.source,
    ].join("|"),
    "gi",
);

/** True when the text looks like a unified diff - only then do leading
 *  +/- lines get add/del coloring (otherwise bullet lists light up). */
export function looksLikeDiff(text: string): boolean {
    return /^(?:@@ |\+\+\+ |--- a\/|diff --git )/m.test(text);
}

export function tokenizeLogLine(line: string, opts: { diff: boolean } = { diff: false }): LogSpan[] {
    if (opts.diff) {
        if (/^@@/.test(line)) return [{ text: line, kind: "hunk" }];
        if (/^\+/.test(line)) return [{ text: line, kind: "add" }];
        if (/^-/.test(line)) return [{ text: line, kind: "del" }];
    }
    const spans: LogSpan[] = [];
    let cursor = 0;
    for (const m of line.matchAll(TOKEN_RE)) {
        const idx = m.index ?? 0;
        if (idx > cursor) spans.push({ text: line.slice(cursor, idx), kind: "plain" });
        const groups = m.groups ?? {};
        const kind = (Object.keys(groups).find((k) => groups[k] != null) ?? "plain") as LogKind;
        spans.push({ text: m[0], kind });
        cursor = idx + m[0].length;
    }
    if (cursor < line.length) spans.push({ text: line.slice(cursor), kind: "plain" });
    if (spans.length === 0) spans.push({ text: "", kind: "plain" });
    return spans;
}

/** Terminal output with paths/severities/numbers/diff lines tinted. */
export function LogText({ text }: { text: string }) {
    const lines = useMemo(() => {
        if (text.length > MAX_LOG_CHARS) return null;
        const diff = looksLikeDiff(text);
        return text.split("\n").map((line) => tokenizeLogLine(line, { diff }));
    }, [text]);
    if (!lines) return <>{text}</>;
    return (
        <>
            {lines.map((spans, i) => (
                <Fragment key={i}>
                    {i > 0 ? "\n" : null}
                    {spans.map((s, j): ReactNode =>
                        s.kind === "plain"
                            ? s.text
                            : <span key={j} style={{ color: LOG_COLOR[s.kind] }}>{s.text}</span>
                    )}
                </Fragment>
            ))}
        </>
    );
}
