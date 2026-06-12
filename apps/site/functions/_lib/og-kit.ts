/**
 * Shared primitives for OG poster rendering (satori / workers-og).
 *
 * Satori quirks baked in here so route files don't repeat them:
 *   - No gap / overflow / border-radius on track containers (breaks display:flex)
 *   - Use margin-right, not gap, between siblings
 *   - Replace spaces with &nbsp; in ASCII art (artLine) so satori doesn't collapse them
 *   - No raw <svg> children (parser drops unknown tags)
 *   - Commas inside style values break the workers-og style parser; use hex colors not rgb()
 */

// ---------------------------------------------------------------------------
// Color palette (same values as share card)
// ---------------------------------------------------------------------------
export const INK    = "#e7e9ec";
export const DIM    = "#8b93a1";
export const BG     = "#15161d";
export const CARD   = "#1e1f2a";
export const LINE   = "#33364a";
export const GREEN  = "#34d399";
export const RED    = "#f87171";
export const ROSE   = "#fb7185";
export const GOLD   = "#fbbf24";
export const BLUE   = "#60a5fa";
export const VIOLET = "#a78bfa";

// ---------------------------------------------------------------------------
// String escaping
// ---------------------------------------------------------------------------
export const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------
// ASCII art line - swap every space for NBSP so satori preserves alignment.
// ---------------------------------------------------------------------------
export const artLine = (line: string): string => esc(line).replace(/ /g, " ");

// ---------------------------------------------------------------------------
// Number / currency formatters
// ---------------------------------------------------------------------------
export const fmtUsd = (n: number | null): string | null =>
    n == null ? null : `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;

export const compactNumber = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
    return n.toLocaleString("en-US");
};

// ---------------------------------------------------------------------------
// Stat block - 46px numeral + 14px letter-spaced label (matches share card)
// ---------------------------------------------------------------------------
export const statHtml = (
    value: string,
    label: string,
    color: string = INK,
): string =>
    `<div style="display:flex;flex-direction:column;margin-right:46px"><span style="font-size:46px;font-weight:700;color:${color}">${esc(value)}</span><span style="font-size:14px;letter-spacing:2px;color:${DIM};margin-top:2px">${esc(label)}</span></div>`;

// ---------------------------------------------------------------------------
// Footer band - serif "ax" wordmark + AX.NECMTTN.COM right side
// ---------------------------------------------------------------------------
export const footerHtml = (leftText: string): string =>
    `<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:15px;letter-spacing:2px;color:${DIM}">${esc(leftText)}</span><div style="display:flex;align-items:baseline"><span style="font-size:14px;letter-spacing:2px;color:${DIM};margin-right:10px">RECORDED WITH</span><span style="font-size:24px;color:${INK};font-weight:700;font-family:'Gelasio'">ax</span><span style="font-size:14px;letter-spacing:2px;color:${DIM};margin-left:12px">· AX.NECMTTN.COM</span></div></div>`;

// ---------------------------------------------------------------------------
// Block logo - ANSI-shadow pixel grid (font-independent)
//
// The 6-line canonical mark from install.sh:
//
//    █████╗ ██╗  ██╗
//   ██╔══██╗╚██╗██╔╝
//   ███████║ ╚███╔╝
//   ██╔══██║ ██╔██╗
//   ██║  ██║██╔╝ ██╗
//   ╚═╝  ╚═╝╚═╝  ╚═╝
//
// Block glyphs (█ ╔ ╗ ╚ ╝ ═ ║) will NOT render in satori (latin-only font
// subsets). We parse the string character by character and emit one <div>
// per cell: solid=█ → ink color, frame=╔╗╚╝═║ → dimColor, space → empty.
// ---------------------------------------------------------------------------
const LOGO_LINES = [
    " █████╗ ██╗  ██╗",
    "██╔══██╗╚██╗██╔╝",
    "███████║ ╚███╔╝ ",
    "██╔══██║ ██╔██╗ ",
    "██║  ██║██╔╝ ██╗",
    "╚═╝  ╚═╝╚═╝  ╚═╝",
] as const;

const SOLID_CHARS = new Set(["█"]);
const FRAME_CHARS = new Set(["╔", "╗", "╚", "╝", "═", "║"]);

export interface BlockLogoOpts {
    /** px per grid cell (e.g. 4 = small header, 8 = mid, 16 = large) */
    scale: number;
    /** Solid pixel color (ink) */
    color: string;
    /** Frame/connector pixel color (dim) */
    dimColor: string;
}

export const blockLogoHtml = ({ scale, color, dimColor }: BlockLogoOpts): string => {
    const rows = LOGO_LINES.map((line) => {
        const cells = [...line].map((ch) => {
            if (SOLID_CHARS.has(ch)) {
                return `<div style="display:flex;width:${scale}px;height:${scale}px;background:${color}"></div>`;
            }
            if (FRAME_CHARS.has(ch)) {
                return `<div style="display:flex;width:${scale}px;height:${scale}px;background:${dimColor}"></div>`;
            }
            // space → empty cell
            return `<div style="display:flex;width:${scale}px;height:${scale}px"></div>`;
        }).join("");
        return `<div style="display:flex">${cells}</div>`;
    }).join("");
    return `<div style="display:flex;flex-direction:column">${rows}</div>`;
};

// ---------------------------------------------------------------------------
// Font loading - deduped helper used by both route files
// ---------------------------------------------------------------------------
export const loadOgFonts = async (): Promise<{
    regular: ArrayBuffer;
    bold: ArrayBuffer;
    serif: ArrayBuffer;
}> => {
    const [regular, bold, serif] = await Promise.all([
        fetch("https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.ttf").then((r) => r.arrayBuffer()),
        fetch("https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-700-normal.ttf").then((r) => r.arrayBuffer()),
        fetch("https://cdn.jsdelivr.net/fontsource/fonts/gelasio@latest/latin-700-normal.ttf").then((r) => r.arrayBuffer()),
    ]);
    return { regular, bold, serif };
};
