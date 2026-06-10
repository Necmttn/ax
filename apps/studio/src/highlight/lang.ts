/**
 * Pure language-resolution + fence-parsing helpers for transcript syntax
 * highlighting. Grammar ids here are the canonical keys of LANG_LOADERS in
 * highlighter.ts - resolveLang/langFromPath collapse the common aliases
 * (ts, sh, py, surql, ...) onto that set so callers never miss a loader.
 */

const SUPPORTED = new Set([
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "json",
    "jsonc",
    "shellscript",
    "python",
    "sql",
    "markdown",
    "yaml",
    "rust",
    "go",
    "css",
    "html",
    "diff",
    "toml",
    "dockerfile",
]);

const ALIASES: Record<string, string> = {
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    sh: "shellscript",
    bash: "shellscript",
    zsh: "shellscript",
    shell: "shellscript",
    console: "shellscript",
    py: "python",
    surql: "sql",
    yml: "yaml",
    rs: "rust",
    golang: "go",
    md: "markdown",
    htm: "html",
    patch: "diff",
    docker: "dockerfile",
};

/** Normalize a language hint (fence info string word, file extension) to a
 *  supported canonical grammar id, or null when we have no grammar for it. */
export function resolveLang(hint: string | null | undefined): string | null {
    if (!hint) return null;
    const id = hint.trim().toLowerCase();
    if (id.length === 0) return null;
    const canonical = ALIASES[id] ?? id;
    return SUPPORTED.has(canonical) ? canonical : null;
}

/** Grammar id for a file path, by extension (plus `Dockerfile`), or null. */
export function langFromPath(path: string | null | undefined): string | null {
    if (!path) return null;
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (/^dockerfile$/i.test(base)) return "dockerfile";
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return null;
    return resolveLang(base.slice(dot + 1));
}

export type TextSegment = { type: "text"; raw: string };
export type FenceSegment = {
    type: "fence";
    /** Exact source slice (open line + body + close line) - segments always
     *  concatenate back to the input, so rendering stays copy-faithful. */
    raw: string;
    /** Canonical grammar id resolved from the info string, or null. */
    lang: string | null;
    /** Code between the fence markers (no surrounding newlines). */
    body: string;
    openLine: string;
    /** Null when the fence is unclosed (runs to end of input). */
    closeLine: string | null;
};
export type Segment = TextSegment | FenceSegment;

const OPEN_RE = /^[ \t]{0,3}(`{3,})([^`]*)$/;
const CLOSE_RE = /^[ \t]{0,3}(`{3,})[ \t]*$/;

/**
 * Split text into plain-text and ``` fenced-code segments. Line-based scan:
 * a fence opens on a line of 3+ backticks (optional info string) and closes
 * on a line of at least as many backticks; an unclosed fence runs to the end.
 * Invariant: segments' `raw` concatenated === input.
 */
export function parseFences(text: string): Segment[] {
    const lines = text.split("\n");
    // Char offset of each line start in `text`.
    const starts: number[] = new Array(lines.length);
    for (let k = 0, off = 0; k < lines.length; k++) {
        starts[k] = off;
        off += lines[k].length + 1;
    }
    const lineEnd = (k: number) => starts[k] + lines[k].length;

    const segments: Segment[] = [];
    let textStart = 0;
    let i = 0;
    while (i < lines.length) {
        const open = OPEN_RE.exec(lines[i]);
        if (!open) {
            i++;
            continue;
        }
        const ticks = open[1].length;
        let close = -1;
        for (let j = i + 1; j < lines.length; j++) {
            const m = CLOSE_RE.exec(lines[j]);
            if (m && m[1].length >= ticks) {
                close = j;
                break;
            }
        }
        if (starts[i] > textStart) {
            segments.push({ type: "text", raw: text.slice(textStart, starts[i]) });
        }
        const bodyEnd = close === -1 ? lines.length : close;
        const rawEnd = close === -1 ? text.length : lineEnd(close);
        segments.push({
            type: "fence",
            raw: text.slice(starts[i], rawEnd),
            lang: resolveLang(open[2]),
            body: lines.slice(i + 1, bodyEnd).join("\n"),
            openLine: lines[i],
            closeLine: close === -1 ? null : lines[close],
        });
        textStart = rawEnd;
        i = close === -1 ? lines.length : close + 1;
    }
    if (textStart < text.length || segments.length === 0) {
        segments.push({ type: "text", raw: text.slice(textStart) });
    }
    return segments;
}
