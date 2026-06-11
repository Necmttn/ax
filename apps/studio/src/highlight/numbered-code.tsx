/**
 * Read-tool output renders as `NNN<tab>code` lines (cat -n format). Strip the
 * line-number gutter, syntax-highlight the code with the file's grammar on
 * the dark theme, and re-attach the gutter dim - so file reads look like the
 * file, not like a pale text dump. Rendered text equals the input exactly.
 */
import { Fragment } from "react";
import { useHighlightTokens } from "./HighlightedCode.tsx";

const NUMBERED_LINE = /^(\s*\d+(?:\t| {2}))(.*)$/;

export type NumberedOutput = {
    /** Per-line gutter prefixes (e.g. `   12\t`), parallel to code lines. */
    prefixes: string[];
    /** The de-gutted code, one string (joined with \n). */
    code: string;
    /** Unnumbered trailing lines (e.g. an appended system note), verbatim. */
    tail: string | null;
};

/**
 * Parse a numbered-output block: a leading run of `NNN<tab>` lines (3+ to
 * count), then optionally an unnumbered tail. Returns null when the text
 * isn't shaped like numbered file output.
 */
export function parseNumberedOutput(text: string): NumberedOutput | null {
    const lines = text.split("\n");
    const prefixes: string[] = [];
    const codeLines: string[] = [];
    let i = 0;
    for (; i < lines.length; i++) {
        const m = NUMBERED_LINE.exec(lines[i]);
        if (!m) break;
        prefixes.push(m[1]);
        codeLines.push(m[2]);
    }
    if (prefixes.length < 3) return null;
    // Anything after the numbered run survives as a plain tail; blank lines
    // between the run and the tail belong to the tail.
    const tail = i < lines.length ? lines.slice(i).join("\n") : null;
    return { prefixes, code: codeLines.join("\n"), tail };
}

/** Numbered file output: dim gutter + dark-theme highlighted code. */
export function NumberedCode({ parsed, lang }: { parsed: NumberedOutput; lang: string | null }) {
    const tokens = useHighlightTokens(parsed.code, lang, "dark");
    const codeLines = parsed.code.split("\n");
    return (
        <>
            {parsed.prefixes.map((prefix, i) => (
                <Fragment key={i}>
                    {i > 0 ? "\n" : null}
                    <span style={{ color: "#6c7086" }}>{prefix}</span>
                    {tokens && tokens[i]
                        ? tokens[i].map((t, j) =>
                            t.color ? <span key={j} style={{ color: t.color }}>{t.content}</span> : t.content
                        )
                        : codeLines[i]}
                </Fragment>
            ))}
            {parsed.tail != null
                ? (
                    <>
                        {"\n"}
                        {parsed.tail}
                    </>
                )
                : null}
        </>
    );
}
