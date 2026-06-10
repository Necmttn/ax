/**
 * Per-session OG image: a poster derived from the share's gist manifest
 * (`index.json`) - verdict, title, headline numbers, and the subagent
 * fan-out as cost-shaded lane bars on a shared time axis. The same visual
 * language as the share page's hero, so the link preview IS the product.
 *
 * Served at /og/<owner>/<gistId> (PNG, 1200x630). Cached aggressively:
 * a given gist's manifest is immutable enough for a day.
 */
import { ImageResponse } from "workers-og";

interface SubagentCard {
    readonly started_at?: string;
    readonly ended_at?: string;
    readonly duration_ms: number | null;
    readonly cost_usd: number | null;
    readonly stats?: { readonly failures?: number };
}

interface Manifest {
    readonly kind: string;
    readonly session: { readonly summary?: string; readonly model?: string; readonly started_at?: string };
    readonly stats: { readonly files_changed: number };
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

const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const cleanSummary = (raw: string | undefined): string => {
    const text = (raw ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return text.length > 0 ? (text.length > 120 ? `${text.slice(0, 119)}…` : text) : "Shared agent session";
};

const fmtDuration = (ms: number | null): string | null => {
    if (ms == null || ms <= 0) return null;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const fmtUsd = (n: number | null): string | null =>
    n == null ? null : `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;

/** Greedy-packed subagent lanes as absolutely-positioned divs. */
function laneHtml(cards: ReadonlyArray<SubagentCard>): string {
    const times = cards
        .map((c) => ({ t: Date.parse(c.started_at ?? ""), d: c.duration_ms ?? 0, cost: c.cost_usd ?? 0, failed: (c.stats?.failures ?? 0) > 0 }))
        .filter((c) => Number.isFinite(c.t));
    if (times.length === 0) return "";
    const t0 = Math.min(...times.map((c) => c.t));
    const t1 = Math.max(...times.map((c) => c.t + Math.max(c.d, 60_000)));
    const span = Math.max(t1 - t0, 60_000);
    const maxCost = Math.max(0.01, ...times.map((c) => c.cost));
    const laneEnds: number[] = [];
    let bars = "";
    for (const c of times.sort((p, q) => p.t - q.t)) {
        const x = (c.t - t0) / span;
        const w = Math.max(c.d / span, 0.008);
        let r = 0;
        while (r < laneEnds.length && laneEnds[r] > x - 0.004) r++;
        if (r >= 5) r = 4;
        laneEnds[r] = x + w;
        const opacity = (0.35 + 0.6 * (c.cost / maxCost)).toFixed(2);
        bars += `<div style="position:absolute;left:${(x * 100).toFixed(2)}%;top:${r * 22}px;width:${Math.max(w * 100, 0.8).toFixed(2)}%;height:16px;border-radius:3px;background:${c.failed ? "#bd443b" : "#b32650"};opacity:${opacity}"></div>`;
    }
    return `<div style="display:flex;position:relative;width:100%;height:${laneEnds.length * 22}px">${bars}</div>`;
}

export const onRequestGet: PagesFunction = async (ctx) => {
    const owner = String(ctx.params.owner ?? "");
    const gistId = String(ctx.params.gistId ?? "").replace(/\.png$/, "");
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[a-f0-9]+$/.test(gistId)) {
        return new Response("bad request", { status: 400 });
    }
    const cache = (caches as unknown as { default: Cache }).default;
    // r= version busts stale cached renders when the poster template changes.
    const u = new URL(ctx.request.url);
    u.searchParams.set("r", "2");
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
    const date = (manifest.session.started_at ?? "").slice(0, 10);
    const right = [fmtUsd(t.cost_usd), fmtDuration(t.duration_ms), date].filter(Boolean).join(" · ");
    const stat = (n: string, label: string) =>
        `<div style="display:flex;flex-direction:column"><span style="font-size:40px;font-weight:700;color:#141615">${n}</span><span style="font-size:15px;letter-spacing:1px;color:#66706b">${label.toUpperCase()}</span></div>`;
    const stats = [
        stat(t.turns.toLocaleString("en-US"), "turns"),
        stat(t.tool_calls.toLocaleString("en-US"), "tool calls"),
        t.subagents > 0 ? stat(String(t.subagents), "subagents") : "",
        stat(String(manifest.stats.files_changed), "files"),
        t.failures > 0 ? `<div style="display:flex;flex-direction:column"><span style="font-size:40px;font-weight:700;color:#bd443b">${t.failures}</span><span style="font-size:15px;letter-spacing:1px;color:#66706b">FAILURES</span></div>` : "",
    ].filter(Boolean).join("");

    const html = `
<div style="display:flex;flex-direction:column;width:1200px;height:630px;background:#f3f6f5;padding:28px;font-family:'JetBrains Mono'">
  <div style="display:flex;flex-direction:column;flex:1;background:#ffffff;border:2px solid #cfd8d4;padding:44px 52px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="display:flex;align-items:baseline"><span style="font-size:30px;color:#141615;font-weight:700">ax</span><span style="font-size:15px;color:#66706b;margin-left:12px;letter-spacing:2px">AGENT EXPERIENCE</span></div>
      <span style="font-size:20px;color:#66706b">${esc(right)}</span>
    </div>
    <div style="display:flex;font-size:38px;line-height:1.25;color:#141615;margin-top:34px;font-weight:600">${title}</div>
    <div style="display:flex;gap:56px;margin-top:36px">${stats}</div>
    <div style="display:flex;margin-top:38px">${laneHtml(manifest.subagents)}</div>
    <div style="display:flex;flex:1"></div>
    <div style="display:flex;justify-content:space-between;font-size:16px;letter-spacing:1px;color:#66706b">
      <span>${t.subagents > 0 ? `BARS = ${t.subagents} SUBAGENTS · DARKER = COSTLIER` : ""}</span>
      <span>RECORDED WITH AX · AX.NECMTTN.COM</span>
    </div>
  </div>
</div>`;

    const font = await fetch(
        "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.ttf",
    ).then((r) => r.arrayBuffer());
    const fontBold = await fetch(
        "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-700-normal.ttf",
    ).then((r) => r.arrayBuffer());

    const debug = u.searchParams.get("debug") ?? "";
    const part = debug.startsWith("part:") ? Number(debug.slice(5)) : 99;
    const pieces = [
        `<div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex;align-items:baseline"><span style="font-size:30px;color:#141615;font-weight:700">ax</span><span style="font-size:15px;color:#66706b;margin-left:12px;letter-spacing:2px">AGENT EXPERIENCE</span></div><span style="font-size:20px;color:#66706b">${esc(right)}</span></div>`,
        `<div style="display:flex;font-size:38px;line-height:1.25;color:#141615;margin-top:34px;font-weight:600">${title}</div>`,
        `<div style="display:flex;gap:56px;margin-top:36px">${stats}</div>`,
        `<div style="display:flex;margin-top:38px">${laneHtml(manifest.subagents)}</div>`,
        `<div style="display:flex;flex:1"></div><div style="display:flex;justify-content:space-between;font-size:16px;letter-spacing:1px;color:#66706b"><span>${t.subagents > 0 ? `BARS = ${t.subagents} SUBAGENTS · DARKER = COSTLIER` : ""}</span><span>RECORDED WITH AX · AX.NECMTTN.COM</span></div>`,
    ];
    const renderHtml = debug === "min"
        ? `<div style="display:flex;width:1200px;height:630px;background:#fff;font-family:'JetBrains Mono';font-size:60px;align-items:center;justify-content:center">ax og probe</div>`
        : `<div style="display:flex;flex-direction:column;width:1200px;height:630px;background:#f3f6f5;padding:28px;font-family:'JetBrains Mono'"><div style="display:flex;flex-direction:column;flex:1;background:#ffffff;border:2px solid #cfd8d4;padding:44px 52px">${pieces.slice(0, part).join("")}</div></div>`;
    let png: ArrayBuffer;
    try {
        const image = new ImageResponse(renderHtml, {
            width: 1200,
            height: 630,
            fonts: [
                { name: "JetBrains Mono", data: font, weight: 400, style: "normal" },
                { name: "JetBrains Mono", data: fontBold, weight: 700, style: "normal" },
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
