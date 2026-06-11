/**
 * Pure extraction of before/after text pairs from edit-class tool-call inputs,
 * so the transcript can render a real diff instead of raw old_string/new_string
 * args. One DiffPair per logical edit: an Edit call yields one, a MultiEdit
 * yields one per entry, a codex apply_patch yields one per hunk. Callers fall
 * back to the labelled args grid whenever this returns null.
 */

export interface DiffPair {
    readonly fileName: string;
    readonly oldText: string;
    readonly newText: string;
}

/** Input keys consumed by the diff view - the args grid skips these when a
 *  diff renders so the same content is never shown twice. */
export const DIFF_CONSUMED_KEYS: ReadonlySet<string> = new Set([
    "old_string",
    "new_string",
    "content",
    "edits",
    "new_source",
    "patch",
    "diff",
    "input",
    "file_path",
    "notebook_path",
]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function fileNameOf(input: Record<string, unknown>): string {
    return str(input.file_path) ?? str(input.path) ?? str(input.target_file) ?? str(input.notebook_path) ?? "file";
}

function pair(fileName: string, oldText: string, newText: string): DiffPair | null {
    if (oldText.length === 0 && newText.length === 0) return null;
    return { fileName, oldText, newText };
}

/**
 * Parse a patch body into per-hunk DiffPairs. Handles both codex's V4A format
 * (`*** Begin Patch` / `*** Update File: path` / `@@` hunks, no line numbers)
 * and standard unified diffs (`--- a/x` / `+++ b/x` / `@@ -l,c +l,c @@`).
 * Old text = context + `-` lines, new text = context + `+` lines; each `@@`
 * starts a fresh pair so non-adjacent hunks don't pretend to be contiguous.
 */
function parsePatchPairs(patch: string): DiffPair[] {
    const pairs: DiffPair[] = [];
    let file: string | null = null;
    let oldLines: string[] = [];
    let newLines: string[] = [];
    let touched = false;

    const flush = () => {
        if (file && touched) {
            const p = pair(file, oldLines.join("\n"), newLines.join("\n"));
            if (p) pairs.push(p);
        }
        oldLines = [];
        newLines = [];
        touched = false;
    };

    for (const line of patch.split("\n")) {
        if (/^\*\*\* (?:Begin|End) Patch/.test(line)) continue;
        const v4aFile = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
        if (v4aFile?.[1]) {
            flush();
            file = v4aFile[1];
            continue;
        }
        const moveTo = line.match(/^\*\*\* Move to: (.+)$/);
        if (moveTo?.[1]) {
            file = moveTo[1];
            continue;
        }
        const unifiedNew = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
        if (unifiedNew?.[1]) {
            flush();
            if (unifiedNew[1] !== "/dev/null") file = unifiedNew[1];
            continue;
        }
        if (/^--- /.test(line)) continue;
        if (/^@@/.test(line)) {
            flush();
            continue;
        }
        if (line.startsWith("\\ No newline")) continue;
        if (line.startsWith("+")) {
            newLines.push(line.slice(1));
            touched = true;
        } else if (line.startsWith("-")) {
            oldLines.push(line.slice(1));
            touched = true;
        } else {
            // Context line (leading space in both formats; tolerate bare lines).
            const text = line.startsWith(" ") ? line.slice(1) : line;
            oldLines.push(text);
            newLines.push(text);
        }
    }
    flush();
    return pairs;
}

/** Patch text lives under different keys per harness; mirror the lookup order
 *  used by metrics/session-loc.ts. */
function patchText(input: Record<string, unknown>): string | null {
    for (const key of ["patch", "diff", "input", "command", "cmd"]) {
        const v = str(input[key]);
        if (v && (v.includes("*** Begin Patch") || /^(--- |\+\+\+ |@@)/m.test(v))) return v;
    }
    return null;
}

export interface ReadView {
    readonly fileName: string;
    /** File content with the `N→` / `N\t` numbering stripped, for the
     *  single-file code view (same renderer + theme as the edit diffs). */
    readonly contents: string;
    /** 1-based line number of the first content line (the Read offset). The
     *  view only shows its own gutter when this is 1 - the library can't
     *  start numbering mid-file, and wrong numbers are worse than none. */
    readonly startLine: number;
    /** Result lines after the numbered block (system-reminder footers etc.) -
     *  still shown in the plain output block. */
    readonly tail: string;
}

// Read results number lines as `  N→code` (claude UI arrow) or `N\tcode`
// (cat -n style, what the stored transcripts carry).
const READ_LINE = /^\s*(\d+)(?:→|\t)(.*)$/;

/**
 * Parse a Read tool result's numbered lines into plain file content. Returns
 * null for non-file results (images, errors, empty) so the caller keeps the
 * terminal block.
 */
export function extractReadView(
    name: string,
    input: Record<string, unknown> | null,
    resultText: string,
): ReadView | null {
    if (name.toLowerCase() !== "read" || resultText.length === 0) return null;
    const fileName = str(input?.file_path) ?? str(input?.path) ?? "file";
    const lines = resultText.split("\n");
    let start: number | null = null;
    const code: string[] = [];
    let i = 0;
    for (; i < lines.length; i++) {
        const m = lines[i]!.match(READ_LINE);
        if (!m) break;
        start ??= Number(m[1]);
        code.push(m[2] ?? "");
    }
    if (start == null || code.length === 0) return null;
    return { fileName, contents: code.join("\n"), startLine: start, tail: lines.slice(i).join("\n").trim() };
}

/**
 * Extract diff pairs from an edit-class tool call. Returns null when the
 * input doesn't carry recognizable before/after content - the caller keeps
 * its existing args-grid rendering in that case.
 */
export function extractDiffPairs(name: string, input: Record<string, unknown> | null): DiffPair[] | null {
    if (!input) return null;
    const pairs = extract(name.toLowerCase(), input);
    return pairs && pairs.length > 0 ? pairs : null;
}

function extract(name: string, input: Record<string, unknown>): DiffPair[] | null {
    switch (name) {
        case "edit": {
            const oldText = str(input.old_string);
            const newText = str(input.new_string);
            if (oldText == null || newText == null) return null;
            const p = pair(fileNameOf(input), oldText, newText);
            return p ? [p] : null;
        }
        case "multiedit": {
            if (!Array.isArray(input.edits)) return null;
            const fileName = fileNameOf(input);
            const pairs: DiffPair[] = [];
            for (const edit of input.edits) {
                if (typeof edit !== "object" || edit == null) continue;
                const e = edit as Record<string, unknown>;
                const p = pair(fileName, str(e.old_string) ?? "", str(e.new_string) ?? "");
                if (p) pairs.push(p);
            }
            return pairs;
        }
        case "write": {
            const content = str(input.content);
            if (content == null) return null;
            const p = pair(fileNameOf(input), "", content);
            return p ? [p] : null;
        }
        case "notebookedit": {
            const source = str(input.new_source);
            if (source == null) return null;
            const p = pair(fileNameOf(input), "", source);
            return p ? [p] : null;
        }
        case "apply_patch":
        case "apply_diff":
        case "edit_file": {
            // Cursor edit_file sometimes carries plain old/new strings.
            const oldText = str(input.old_string);
            const newText = str(input.new_string);
            if (oldText != null && newText != null) {
                const p = pair(fileNameOf(input), oldText, newText);
                return p ? [p] : null;
            }
            const patch = patchText(input);
            return patch ? parsePatchPairs(patch) : null;
        }
        default:
            return null;
    }
}
