/**
 * Per-session OG poster (1200x630 PNG), rendered at the edge from the share's
 * gist manifest. Dark card built to pop on a feed: big verdict numbers, the
 * subagent fleet as a waffle grid (one cell per subagent, brighter = costlier,
 * red = hit failures), and a stacked cost-anatomy bar (where the dollars went).
 *
 * Satori-safe rules learned the hard way: every multi-child element needs
 * explicit display:flex, integer px only, no raw <svg> children (the worker
 * html parser drops unknown tags).
 */
import { ImageResponse } from "workers-og";
import { OG_RENDER_REV } from "../../_lib/og-meta";

interface SubagentCard {
    readonly cost_usd: number | null;
    readonly stats?: { readonly failures?: number };
}

interface TokenUsage {
    readonly estimated_input_cost_usd: number | null;
    readonly estimated_cache_creation_cost_usd: number | null;
    readonly estimated_cache_read_cost_usd: number | null;
    readonly estimated_output_cost_usd: number | null;
}

interface Manifest {
    readonly kind: string;
    readonly session: { readonly summary?: string; readonly model?: string; readonly started_at?: string };
    readonly token_usage?: TokenUsage | null;
    readonly totals: {
        readonly cost_usd: number | null;
        readonly duration_ms: number | null;
        readonly tool_calls: number;
        readonly turns: number;
        readonly subagents: number;
        readonly failures: number;
    };
    readonly subagents: ReadonlyArray<SubagentCard>;
}

const INK = "#e7e9ec";
const DIM = "#8b93a1";
const BG = "#15161d";
const CARD = "#1e1f2a";
const LINE = "#33364a";
const GREEN = "#34d399";
const RED = "#f87171";
const ROSE = "#fb7185";
const GOLD = "#fbbf24";
const BLUE = "#60a5fa";
const VIOLET = "#a78bfa";

const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const cleanSummary = (raw: string | undefined): string => {
    const text = (raw ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return text.length > 0 ? (text.length > 110 ? `${text.slice(0, 109)}…` : text) : "Shared agent session";
};

const fmtDuration = (ms: number | null): string | null => {
    if (ms == null || ms <= 0) return null;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const fmtUsd = (n: number | null): string | null =>
    n == null ? null : `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;

/** Mix a hex color toward the card background (0 = card, 1 = full color). */
function shade(hex: string, t: number): string {
    const c = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16);
    const [r1, g1, b1] = [c(hex, 1), c(hex, 3), c(hex, 5)];
    const [r0, g0, b0] = [c(CARD, 1), c(CARD, 3), c(CARD, 5)];
    const mix = (a: number, b: number) => Math.round(b + (a - b) * t).toString(16).padStart(2, "0");
    // Hex, not rgb(): commas inside a style value break the worker's parser
    // and the declarations after them (display:flex included) get dropped.
    return `#${mix(r1, r0)}${mix(g1, g0)}${mix(b1, b0)}`;
}

/** The fleet: one rounded cell per subagent, brightness = cost share. */
function fleetHtml(cards: ReadonlyArray<SubagentCard>): string {
    if (cards.length === 0) return "";
    const maxCost = Math.max(0.01, ...cards.map((c) => c.cost_usd ?? 0));
    const sorted = [...cards].sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0));
    const n = sorted.length;
    const cell = n <= 16 ? 44 : n <= 36 ? 36 : 28;
    const cells = sorted.map((c) => {
        const failed = (c.stats?.failures ?? 0) > 0;
        const t = 0.25 + 0.75 * ((c.cost_usd ?? 0) / maxCost);
        const color = failed ? shade(RED, Math.max(t, 0.55)) : shade(ROSE, t);
        return `<div style="display:flex;width:${cell}px;height:${cell}px;border-radius:6px;background:${color};margin-right:6px"></div>`;
    });
    // Manual row chunking - flex-wrap is one of the properties the worker's
    // style parser stops at, taking display:flex down with it.
    const perRow = 8;
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += perRow) {
        rows.push(`<div style="display:flex;margin-bottom:6px">${cells.slice(i, i + perRow).join("")}</div>`);
    }
    return `<div style="display:flex;flex-direction:column">${rows.join("")}</div>`;
}

/** Stacked cost-anatomy bar: fresh / cache write / cache read / output / subagents. */
function costBarHtml(m: Manifest): string {
    const u = m.token_usage;
    const subCost = m.subagents.reduce((acc, c) => acc + (c.cost_usd ?? 0), 0);
    const parts = [
        { label: "fresh", v: u?.estimated_input_cost_usd ?? 0, color: BLUE },
        { label: "cache write", v: u?.estimated_cache_creation_cost_usd ?? 0, color: GOLD },
        { label: "cache read", v: u?.estimated_cache_read_cost_usd ?? 0, color: GREEN },
        { label: "output", v: u?.estimated_output_cost_usd ?? 0, color: VIOLET },
        { label: `${m.totals.subagents} subagents`, v: subCost, color: ROSE },
    ].filter((p) => p.v > 0.005);
    const total = parts.reduce((acc, p) => acc + p.v, 0);
    if (total <= 0) return "";
    const W = 1088;
    const segs = parts.map((p) =>
        `<div style="display:flex;width:${Math.max(Math.round((p.v / total) * W), 6)}px;height:14px;background:${p.color}"></div>`
    ).join("");
    // No overflow:hidden / border-radius on the track: unknown properties
    // truncate the style and the container loses display:flex.
    // margin-right, not gap: gap is another property the style parser stops
    // at, truncating display:flex with it.
    const legend = parts.map((p) =>
        `<div style="display:flex;align-items:center;margin-right:26px"><div style="display:flex;width:10px;height:10px;border-radius:2px;background:${p.color};margin-right:8px"></div><span style="font-size:15px;color:${DIM}">${p.label.toUpperCase()} ${fmtUsd(p.v)}</span></div>`
    ).join("");
    return `<div style="display:flex;flex-direction:column"><div style="display:flex">${segs}</div><div style="display:flex;margin-top:12px">${legend}</div></div>`;
}

/**
 * ASCII AX mark, two lines, monospace column-aligned:
 *
 *    col: 0123456
 *          /\  \/
 *         /--\ /\
 *
 * A = ` /\` over `/--\` (cols 0-3), X = `\/` over `/\` (cols 5-6). Shared by
 * the small header logo and the large ?variant=watermark background; each
 * line renders as its own div (line-stack) to avoid <pre> fragility in
 * workers-og.
 */
const ASCII_AX_LINES = [" /\\  \\/", "/--\\ /\\"] as const;

// Satori collapses runs of regular spaces under its default white-space
// handling, which destroys column alignment. Swap every space (leading and
// internal) for a literal non-breaking space, which satori renders as-is.
const artLine = (line: string): string => esc(line).replace(/ /g, "\u00A0");

/** Small two-line ASCII AX wordmark for the poster header. */
function asciiLogoHtml(color: string): string {
    const lines = ASCII_AX_LINES.map(
        (line) =>
            `<div style="display:flex;font-size:14px;line-height:16px;color:${color};letter-spacing:1px;font-weight:700">${artLine(line)}</div>`,
    ).join("");
    return `<div style="display:flex;flex-direction:column">${lines}</div>`;
}

/**
 * Large background ASCII watermark for the ?variant=watermark debug variant:
 * the same AX mark as the header, scaled up. Positioned absolutely (satori
 * supports position:absolute when the container is position:relative). Low
 * opacity so content stays readable.
 */
function asciiWatermarkHtml(): string {
    const lines = ASCII_AX_LINES.map(
        (line) =>
            `<div style="display:flex;font-size:120px;line-height:132px;color:${INK};letter-spacing:4px;font-weight:700">${artLine(line)}</div>`,
    ).join("");
    // Faded via an opacity wrapper on the container (not a hex alpha channel
    // on the color) - satori applies opacity to the whole subtree.
    return `<div style="display:flex;flex-direction:column;position:absolute;top:160px;left:120px;opacity:0.06">${lines}</div>`;
}

export const onRequestGet: PagesFunction = async (ctx) => {
    const owner = String(ctx.params.owner ?? "");
    const gistId = String(ctx.params.gistId ?? "").replace(/\.png$/, "");
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[a-f0-9]+$/.test(gistId)) {
        return new Response("bad request", { status: 400 });
    }
    const cache = (caches as unknown as { default: Cache }).default;
    // r= version (OG_RENDER_REV, shared with the /s/ meta rewriter's ?v=
    // og:image param) busts stale cached renders when the template changes.
    // Append variant so watermark and default renders cache independently.
    const u = new URL(ctx.request.url);
    const variant = u.searchParams.get("variant") ?? "default";
    u.searchParams.set("r", `${OG_RENDER_REV}-${variant}`);
    const cacheKey = new Request(u.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const manifestRes = await fetch(
        `https://gist.githubusercontent.com/${owner}/${gistId}/raw/index.json`,
        { headers: { "user-agent": "ax-og" } },
    );
    if (!manifestRes.ok) return new Response("not found", { status: 404 });
    const manifest = (await manifestRes.json()) as Manifest;
    if (manifest.kind !== "manifest") return new Response("not a share", { status: 404 });

    const t = manifest.totals;
    const title = esc(cleanSummary(manifest.session.summary));
    const model = manifest.session.model ?? "";
    const date = (manifest.session.started_at ?? "").slice(0, 10);

    const stat = (n: string, label: string, color: string = INK) =>
        `<div style="display:flex;flex-direction:column;margin-right:46px;width:200px"><span style="font-size:46px;font-weight:700;color:${color}">${n}</span><span style="font-size:14px;letter-spacing:2px;color:${DIM};margin-top:2px">${label}</span></div>`;
    const statList = [
        stat(t.turns.toLocaleString("en-US"), "TURNS"),
        stat(t.tool_calls.toLocaleString("en-US"), "TOOL CALLS"),
        fmtDuration(t.duration_ms) ? stat(fmtDuration(t.duration_ms)!, "WALL CLOCK") : "",
        fmtUsd(t.cost_usd) ? stat(fmtUsd(t.cost_usd)!, "TOTAL COST", GREEN) : "",
        t.failures > 0 ? stat(String(t.failures), "FAILED TOOL CALLS", RED) : "",
    ].filter(Boolean);
    // Two rows so the stat column shares the band with the fleet waffle
    // instead of running underneath it.
    const stats = `<div style="display:flex;flex-direction:column"><div style="display:flex;margin-bottom:30px">${statList.slice(0, 3).join("")}</div><div style="display:flex">${statList.slice(3).join("")}</div></div>`;

    const blocks: Record<string, string> = {
        // ASCII logo replaces the serif "ax" wordmark. The line-stack avoids
        // <pre> fragility and keeps display:flex on the container intact.
        header: `<div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex;align-items:center"><div style="display:flex;margin-right:14px">${asciiLogoHtml(INK)}</div><span style="font-size:14px;color:${DIM};letter-spacing:3px">AGENT EXPERIENCE</span></div><span style="font-size:17px;color:${DIM}">${esc([model, date].filter(Boolean).join(" · "))}</span></div>`,
        title: `<div style="display:flex;font-size:33px;line-height:1.3;color:${INK};margin-top:26px;font-weight:600">${title}</div>`,
        stats: `<div style="display:flex;margin-top:30px">${stats}</div>`,
        fleet: t.subagents > 0 ? `<div style="display:flex;flex-direction:column;align-items:flex-start;margin-top:30px"><div style="display:flex">${fleetHtml(manifest.subagents)}</div><span style="font-size:14px;letter-spacing:2px;color:${DIM};margin-top:10px">${t.subagents} SUBAGENTS · BRIGHTER = COSTLIER</span></div>` : "",
        costbar: `<div style="display:flex;margin-top:30px">${costBarHtml(manifest)}</div>`,
        footer: `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px"><span style="font-size:15px;letter-spacing:2px;color:${DIM}">EVERY TURN · EVERY TOOL CALL · EVERY DOLLAR</span><div style="display:flex;align-items:baseline"><span style="font-size:14px;letter-spacing:2px;color:${DIM};margin-right:10px">RECORDED WITH</span><span style="font-size:24px;color:${INK};font-weight:700;font-family:'Gelasio'">ax</span><span style="font-size:14px;letter-spacing:2px;color:${DIM};margin-left:12px">· AX.NECMTTN.COM</span></div></div>`,
    };
    const probe = u.searchParams.get("probe");
    // Full layout: stats column left, fleet right, then the cost bar; probe
    // mode stacks individual blocks so each can be tested in isolation.
    const mid = `<div style="display:flex;flex:1;align-items:center;margin-top:10px"><div style="display:flex;flex:1">${stats}</div>${t.subagents > 0 ? blocks.fleet : ""}</div>`;
    const inner = probe
        ? probe.split(",").filter((k) => k in blocks).map((k) => blocks[k]).join("")
        : `${blocks.header}${blocks.title}${mid}${blocks.costbar}${blocks.footer}`;
    // ?variant=watermark: inject a large low-opacity ASCII background mark for
    // iterating on the treatment without making it the default social card.
    // position:relative on the outer container lets the absolute child render
    // behind the content stack. Never active by default.
    const watermark = variant === "watermark" ? asciiWatermarkHtml() : "";
    // Full bleed, no border: the platform rendering the preview (X / Slack /
    // Discord) draws its own frame + rounded corners - an inner border reads
    // as a nested double-frame. 64px safe margins keep content clear of the
    // platforms' corner clipping (GitHub-card convention).
    const html = `<div style="display:flex;flex-direction:column;position:relative;width:1200px;height:630px;background:${CARD};padding:56px 64px;font-family:'JetBrains Mono'">${watermark}${inner}</div>`;

    const font = await fetch(
        "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.ttf",
    ).then((r) => r.arrayBuffer());
    const fontBold = await fetch(
        "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-700-normal.ttf",
    ).then((r) => r.arrayBuffer());
    // Brand wordmark serif - Gelasio is metric-compatible with Georgia (the
    // site's wordmark face), which is not licensable for embedding.
    const fontSerif = await fetch(
        "https://cdn.jsdelivr.net/fontsource/fonts/gelasio@latest/latin-700-normal.ttf",
    ).then((r) => r.arrayBuffer());

    let png: ArrayBuffer;
    try {
        const image = new ImageResponse(html, {
            width: 1200,
            height: 630,
            fonts: [
                { name: "JetBrains Mono", data: font, weight: 400, style: "normal" },
                { name: "JetBrains Mono", data: fontBold, weight: 700, style: "normal" },
                { name: "Gelasio", data: fontSerif, weight: 700, style: "normal" },
            ],
        });
        // Buffer the render: a lazy stream produced empty bodies on Pages, and
        // an empty 200 would get edge-cached for a day.
        png = await image.arrayBuffer();
    } catch (err) {
        return new Response(`render error: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`, { status: 500 });
    }
    if (png.byteLength === 0) return new Response("render produced 0 bytes", { status: 500 });
    const res = new Response(png, {
        headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400, s-maxage=86400",
        },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
};
