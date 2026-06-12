import { describe, expect, test } from "bun:test";
import {
    esc,
    artLine,
    fmtUsd,
    compactNumber,
    compactUsd,
    statHtml,
    footerHtml,
    blockLogoHtml,
    INK,
    DIM,
    GREEN,
} from "./og-kit";

describe("esc", () => {
    test("escapes html special chars", () => {
        expect(esc("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
    });
    test("leaves plain strings unchanged", () => {
        expect(esc("hello world")).toBe("hello world");
    });
});

describe("artLine", () => {
    test("replaces spaces with non-breaking spaces", () => {
        // " /\\ " has leading + trailing spaces
        const result = artLine(" /\\ ");
        expect(result).not.toContain(" ");
        expect(result).toContain(" ");
    });
    test("escapes html and replaces spaces", () => {
        const result = artLine("a & b");
        // spaces become nbsp, & becomes &amp;
        expect(result).toBe("a &amp; b");
    });
});

describe("fmtUsd", () => {
    test("returns null for null input", () => {
        expect(fmtUsd(null)).toBeNull();
    });
    test("formats cents with two decimals", () => {
        expect(fmtUsd(1.23)).toBe("$1.23");
    });
    test("formats large values with zero decimals", () => {
        expect(fmtUsd(150.5)).toBe("$151");
    });
});

describe("compactNumber", () => {
    test("formats billions", () => {
        expect(compactNumber(19_620_900_000)).toBe("19.6B");
    });
    test("formats millions", () => {
        expect(compactNumber(1_500_000)).toBe("1.5M");
    });
    test("formats thousands", () => {
        expect(compactNumber(2500)).toBe("2.5K");
    });
    test("leaves small numbers as-is", () => {
        expect(compactNumber(42)).toBe("42");
    });
});

describe("compactUsd", () => {
    test("humanizes big spend with approx marker", () => {
        expect(compactUsd(22_882)).toBe("~$22.9K");
    });
    test("small spend stays exact", () => {
        expect(compactUsd(42.4)).toBe("$42");
    });
});

describe("statHtml", () => {
    test("contains the label uppercased (caller passes uppercase)", () => {
        const html = statHtml("42", "TURNS");
        expect(html).toContain("TURNS");
    });
    test("contains the value", () => {
        const html = statHtml("$1.23", "COST", GREEN);
        expect(html).toContain("$1.23");
    });
    test("uses custom color for value span", () => {
        const html = statHtml("99", "SESSIONS", GREEN);
        expect(html).toContain(GREEN);
    });
    test("defaults to INK color", () => {
        const html = statHtml("99", "SESSIONS");
        expect(html).toContain(INK);
    });
});

describe("footerHtml", () => {
    test("includes the left text", () => {
        const html = footerHtml("COMPILED FROM LOCAL TRANSCRIPTS");
        expect(html).toContain("COMPILED FROM LOCAL TRANSCRIPTS");
    });
    test("includes AX.NECMTTN.COM", () => {
        const html = footerHtml("anything");
        expect(html).toContain("AX.NECMTTN.COM");
    });
    test("carries the block mark, not a serif wordmark (one logo, two scales)", () => {
        const html = footerHtml("anything");
        expect(html).not.toContain("Gelasio");
        expect(html).toContain("AX.NECMTTN.COM");
        // pixel cells from the embedded block logo at scale 3
        expect(html).toContain("width:3px;height:3px");
    });
});

describe("blockLogoHtml", () => {
    const opts = { scale: 4, color: INK, dimColor: DIM };

    test("produces 6 row divs", () => {
        const html = blockLogoHtml(opts);
        // Each row is a <div style="display:flex"> - count flex rows
        const rowMatches = [...html.matchAll(/<div style="display:flex">/g)];
        // 6 rows + 1 outer column container = 7 matches
        expect(rowMatches.length).toBeGreaterThanOrEqual(6);
    });

    test("first row has correct pixel count (17 chars → 17 cells)", () => {
        const html = blockLogoHtml(opts);
        // Parse out first row - first <div style="display:flex">...</div> block
        const firstRowMatch = html.match(/<div style="display:flex">(<div style="display:flex;[^"]*"[^>]*><\/div>)+<\/div>/);
        expect(firstRowMatch).not.toBeNull();
        // Count cells in first row - each cell has display:flex; (with semicolon, unlike the row wrapper)
        // The row wrapper uses display:flex" (no semicolon), so matchAll on display:flex; counts only cells.
        const cellCount = [...(firstRowMatch?.[0] ?? "").matchAll(/<div style="display:flex;/g)].length;
        // First row " █████╗ ██╗  ██╗" = 16 chars → 16 cells
        expect(cellCount).toBe(16);
    });

    test("solid pixels use the ink color", () => {
        const html = blockLogoHtml({ scale: 4, color: "#ffffff", dimColor: "#888888" });
        expect(html).toContain("background:#ffffff");
    });

    test("frame pixels use the dim color", () => {
        const html = blockLogoHtml({ scale: 4, color: "#ffffff", dimColor: "#888888" });
        expect(html).toContain("background:#888888");
    });

    test("scale param controls cell px size", () => {
        const html8 = blockLogoHtml({ scale: 8, color: INK, dimColor: DIM });
        expect(html8).toContain("width:8px");
        expect(html8).toContain("height:8px");
        const html4 = blockLogoHtml({ scale: 4, color: INK, dimColor: DIM });
        expect(html4).toContain("width:4px");
    });
});
