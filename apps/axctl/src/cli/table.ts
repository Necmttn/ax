/**
 * Pure column-builder for CLI tabular output.
 *
 * Key design decisions (see spec: arch-deepening-goal-package.md §E):
 *  - Column.get owns raw cell text, null-fallbacks, and synthesized prefixes.
 *    renderTable owns 100% of pad/clip/truncation — do NOT call truncate()/slice()
 *    inside a get() implementation.
 *  - Auto-width INCLUDES the header: max(min??0, header.length, ...cellLengths).
 *  - `width` (fixed) and `min` (auto floor) are DISTINCT: `width` short-circuits
 *    all auto logic; `min` is just a floor passed into auto.
 *  - `overflow: 'ellipsis'` delegates to render.ts `truncate` (U+2026, NOT "...").
 *  - `gap` is per-call (default "  ", two spaces). Cost tables pass " " (one space).
 *  - Footer rule row: drawn BEFORE footer lines when any Column has footerRule:true.
 *    Rule row renders '─'.repeat(w) on footerRule columns, ' '.repeat(w) elsewhere.
 *  - Terminal-width: opt-in via opts.maxWidth ONLY. NEVER read process.stdout.columns
 *    or env vars inside renderTable — breaks byte-identity for non-interactive callers.
 *  - Cells must be ANSI-free. No strwidth seam yet — add one before accepting ANSI input.
 */

import { truncate } from "./render.js";

export type Align = "left" | "right";
export type Overflow = "clip" | "ellipsis";

export interface Column<T> {
    header: string;
    get: (row: T) => string;
    align?: Align; // default 'left'
    width?: number; // FIXED width (overrides auto)
    min?: number; // floor for auto-width
    max?: number; // cap for auto-width
    overflow?: Overflow; // default 'clip'
    footerRule?: boolean; // draw '─'.repeat(resolvedWidth) in the rule row
}

export interface FooterLine {
    cells: (string | null)[]; // null → blank (filled with spaces)
}

export interface TableOptions<T> {
    columns: Column<T>[];
    rows: T[];
    gap?: string; // default '  ' (two spaces)
    footer?: FooterLine[]; // appended after rule row (if any)
    maxWidth?: number; // opt-in only; NEVER read process.stdout.columns
}

export function renderTable<T>(opts: TableOptions<T>): string {
    const gap = opts.gap ?? "  ";
    const cols = opts.columns;

    // Compute all cell values upfront
    const cellMatrix = opts.rows.map((row) => cols.map((col) => col.get(row)));

    // Resolve widths
    const widths = cols.map((col, i) => {
        if (col.width !== undefined) return col.width; // fixed
        const cells = cellMatrix.map((row) => row[i]);
        const auto = Math.max(
            col.min ?? 0,
            col.header.length,
            ...cells.map((c) => c.length),
        );
        return col.max !== undefined ? Math.min(auto, col.max) : auto;
    });

    // Render a cell to exact width
    function renderCell(text: string, w: number, col: Column<T>): string {
        const overflow = col.overflow ?? "clip";
        let cell: string;
        if (text.length > w) {
            cell = overflow === "ellipsis" ? truncate(text, w) : text.slice(0, w);
        } else {
            cell = text;
        }
        return col.align === "right" ? cell.padStart(w) : cell.padEnd(w);
    }

    const lines: string[] = [];

    // Header row
    lines.push(
        cols
            .map((col, i) => {
                const w = widths[i];
                return col.align === "right"
                    ? col.header.padStart(w)
                    : col.header.padEnd(w);
            })
            .join(gap),
    );

    // Data rows
    for (const row of cellMatrix) {
        lines.push(
            cols.map((col, i) => renderCell(row[i], widths[i], col)).join(gap),
        );
    }

    // Footer rule row (if any col has footerRule: true)
    if (opts.footer !== undefined && cols.some((c) => c.footerRule)) {
        lines.push(
            cols
                .map((col, i) =>
                    col.footerRule
                        ? "─".repeat(widths[i])
                        : " ".repeat(widths[i]),
                )
                .join(gap),
        );
    }

    // Footer lines
    if (opts.footer) {
        for (const fl of opts.footer) {
            lines.push(
                cols
                    .map((col, i) => {
                        const cell = fl.cells[i] ?? null;
                        if (cell === null) return " ".repeat(widths[i]);
                        return col.align === "right"
                            ? cell.padStart(widths[i])
                            : cell.padEnd(widths[i]);
                    })
                    .join(gap),
            );
        }
    }

    return lines.join("\n");
}
