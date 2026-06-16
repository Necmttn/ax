/**
 * Unit tests for renderTable column-builder (table.ts).
 *
 * Covers all hard constraints from spec §E:
 *   1. Auto-width includes header
 *   2. min floor (auto floor) vs width (fixed) are distinct
 *   3. fixed width overrides auto
 *   4. max cap on auto-width
 *   5. clip overflow (no ellipsis)
 *   6. ellipsis overflow (U+2026, NOT "...")
 *   7. custom gap
 *   8. right-align
 *   9. empty rows → just header
 *  10. footer lines appear AFTER rule row
 *  11. footerRule columns draw '─' chars
 *  12. no-footerRule columns → no rule row emitted
 *
 * All assertions use FULL string equality, not just length checks.
 */

import { describe, expect, it } from "bun:test";
import { renderTable } from "./table.ts";
import type { Column, FooterLine } from "./table.ts";

// ---------------------------------------------------------------------------
// Test 1: Auto-width includes header length
// ---------------------------------------------------------------------------
describe("auto-width includes header", () => {
    it("header longer than all cells → header width wins", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "longheader", get: (r) => r.a },
        ];
        const out = renderTable({ columns: cols, rows: [{ a: "short" }, { a: "x" }] });
        // Width = max(0, 10, 5, 1) = 10
        expect(out).toBe("longheader\nshort     \nx         ");
    });
});

// ---------------------------------------------------------------------------
// Test 2: min floor
// ---------------------------------------------------------------------------
describe("min floor", () => {
    it("min > max cell and header length → min wins", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "h", get: (r) => r.a, min: 15 },
        ];
        const out = renderTable({ columns: cols, rows: [{ a: "short" }] });
        // Width = max(15, 1, 5) = 15
        expect(out).toBe("h              \nshort          ");
    });
});

// ---------------------------------------------------------------------------
// Test 3: fixed width (col.width takes precedence over everything)
// ---------------------------------------------------------------------------
describe("fixed width", () => {
    it("width overrides auto-width from header and cells", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "col", get: (r) => r.a, width: 10 },
        ];
        const out = renderTable({ columns: cols, rows: [{ a: "a" }] });
        // Width = 10 (fixed), auto would be max(0, 3, 1) = 3
        expect(out).toBe("col       \na         ");
    });
});

// ---------------------------------------------------------------------------
// Test 4: max cap truncates auto-width
// ---------------------------------------------------------------------------
describe("max cap", () => {
    it("auto-width is capped at col.max", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "hdr", get: (r) => r.a, max: 20 },
        ];
        const out = renderTable({
            columns: cols,
            rows: [{ a: "a".repeat(100) }],
        });
        // Auto = max(0, 3, 100) = 100, cap = min(100, 20) = 20
        expect(out).toBe("hdr                 \naaaaaaaaaaaaaaaaaaaa");
    });
});

// ---------------------------------------------------------------------------
// Test 5: clip overflow (no ellipsis)
// ---------------------------------------------------------------------------
describe("clip overflow", () => {
    it("clips cell to width without ellipsis", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "h", get: (r) => r.a, width: 5 },
        ];
        const out = renderTable({ columns: cols, rows: [{ a: "hello world" }] });
        // clip: "hello world".slice(0, 5) = "hello"
        expect(out).toBe("h    \nhello");
        expect(out).not.toContain("…");
        expect(out).not.toContain("...");
    });
});

// ---------------------------------------------------------------------------
// Test 6: ellipsis overflow (U+2026, NOT "...")
// ---------------------------------------------------------------------------
describe("ellipsis overflow", () => {
    it("uses U+2026 (…) not three dots (...)", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "h", get: (r) => r.a, width: 5, overflow: "ellipsis" },
        ];
        const out = renderTable({ columns: cols, rows: [{ a: "hello world" }] });
        // truncate("hello world", 5) = "hell…" (4 chars + 1 U+2026 = 5 chars)
        expect(out).toBe("h    \nhell…");
        expect(out).toContain("…");
        expect(out).not.toContain("...");
    });
});

// ---------------------------------------------------------------------------
// Test 7: custom gap (single space)
// ---------------------------------------------------------------------------
describe("custom gap", () => {
    it("uses single space between columns when gap=' '", () => {
        const cols: Column<{ a: string; b: string }>[] = [
            { header: "A", get: (r) => r.a, width: 3 },
            { header: "B", get: (r) => r.b, width: 3 },
        ];
        const out = renderTable({
            columns: cols,
            rows: [{ a: "x", b: "y" }],
            gap: " ",
        });
        // "A  " + " " + "B  " = "A   B  "
        // "x  " + " " + "y  " = "x   y  "
        expect(out).toBe("A   B  \nx   y  ");
    });

    it("default gap is two spaces", () => {
        const cols: Column<{ a: string; b: string }>[] = [
            { header: "A", get: (r) => r.a, width: 1 },
            { header: "B", get: (r) => r.b, width: 1 },
        ];
        const out = renderTable({ columns: cols, rows: [{ a: "x", b: "y" }] });
        // "A" + "  " + "B" = "A  B"
        expect(out).toBe("A  B\nx  y");
    });
});

// ---------------------------------------------------------------------------
// Test 8: right-align (padStart)
// ---------------------------------------------------------------------------
describe("right-align", () => {
    it("right-aligns header and cell values with padStart", () => {
        const cols: Column<{ n: string }>[] = [
            { header: "num", get: (r) => r.n, align: "right", width: 10 },
        ];
        const out = renderTable({ columns: cols, rows: [{ n: "42" }] });
        expect(out).toBe("       num\n        42");
    });
});

// ---------------------------------------------------------------------------
// Test 9: empty rows → just header line
// ---------------------------------------------------------------------------
describe("empty rows", () => {
    it("renders only the header when rows is empty", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "col", get: (r) => r.a },
        ];
        const out = renderTable({ columns: cols, rows: [] });
        // Width = max(0, 3) = 3, header "col" padEnd(3) = "col"
        expect(out).toBe("col");
        expect(out.split("\n")).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Test 10: footer lines appear AFTER the rule row
// ---------------------------------------------------------------------------
describe("footer ordering", () => {
    it("rule row appears before footer lines", () => {
        const cols: Column<{ a: string; b: string }>[] = [
            { header: "A", get: (r) => r.a, width: 5, footerRule: true },
            { header: "B", get: (r) => r.b, width: 5 },
        ];
        const footer: FooterLine[] = [{ cells: ["tot", null] }];
        const out = renderTable({
            columns: cols,
            rows: [{ a: "data", b: "info" }],
            footer,
        });
        // header: "A      B    "
        // row:    "data   info "
        // rule:   "─────       "
        // footer: "tot         "
        expect(out).toBe("A      B    \ndata   info \n─────       \ntot         ");
        const lines = out.split("\n");
        const ruleIdx = lines.findIndex((l) => l.includes("─"));
        const footerIdx = lines.findIndex((l) => l.startsWith("tot"));
        expect(ruleIdx).toBeGreaterThan(0);
        expect(footerIdx).toBeGreaterThan(ruleIdx);
    });
});

// ---------------------------------------------------------------------------
// Test 11: footerRule draws '─' chars at resolved column width
// ---------------------------------------------------------------------------
describe("footerRule", () => {
    it("draws '─' chars for footerRule columns, spaces for others", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "x", get: (r) => r.a, width: 4, footerRule: true },
        ];
        const out = renderTable({
            columns: cols,
            rows: [{ a: "hi" }],
            footer: [{ cells: ["end"] }],
        });
        // header: "x   "
        // row:    "hi  "
        // rule:   "────"
        // footer: "end "
        expect(out).toBe("x   \nhi  \n────\nend ");
        expect(out).toContain("────");
        expect(out).not.toContain("---");
    });

    it("rule row only drawn when footer is provided", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "x", get: (r) => r.a, width: 4, footerRule: true },
        ];
        const out = renderTable({ columns: cols, rows: [{ a: "hi" }] });
        // footer: undefined → no rule row
        expect(out).toBe("x   \nhi  ");
        expect(out).not.toContain("─");
    });
});

// ---------------------------------------------------------------------------
// Test 12: footer with no footerRule columns → no rule row emitted
// ---------------------------------------------------------------------------
describe("no footerRule → no rule row", () => {
    it("omits rule row when no column has footerRule: true", () => {
        const cols: Column<{ a: string }>[] = [
            { header: "A", get: (r) => r.a, width: 5 },
        ];
        const footer: FooterLine[] = [{ cells: ["total"] }];
        const out = renderTable({
            columns: cols,
            rows: [{ a: "x" }],
            footer,
        });
        // header: "A    "
        // row:    "x    "
        // footer: "total"
        // NO rule row
        expect(out).toBe("A    \nx    \ntotal");
        expect(out).not.toContain("─");
    });
});
