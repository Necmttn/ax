/**
 * Profile OG poster (1200x630 PNG) for /u/<login> pages.
 *
 * Data path: community/users/<login>.json → gist ax-profile.json.
 * Aesthetic: ax paper/ink editorial (light bg, dark type, green accent).
 *
 * Route: /og-profile/<login> (not /og/u/<login>) - avoids the dynamic-segment
 * collision risk with the existing /og/[owner]/[gistId] function. Cloudflare
 * Pages prefers static segments over params but the second segment would
 * still be captured by [gistId] in the existing function if routing is
 * ambiguous, so we use a non-colliding prefix.
 *
 * Satori-safe rules (learned from the /og/ session card):
 * - No flex-wrap, overflow, gap, max-width, or rgb() commas in style strings.
 * - No raw <svg> children.
 * - Use await image.arrayBuffer() - lazy streams produced empty bodies on Pages.
 * - Hex colors only (commas inside rgb() break the worker's style parser and
 *   drop display:flex from the same declaration).
 * - Manual row-chunking instead of flex-wrap.
 * - Revision r= in cache key; bump OG_PROFILE_RENDER_REV when template changes.
 */
import { ImageResponse } from "workers-og";
import { OG_PROFILE_RENDER_REV } from "../_lib/og-meta";

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";

// --- color palette (paper/ink editorial, matches site CSS tokens) ---
const PAGE  = "#f6f5f0";  // --page
const INK   = "#0a0a0a";  // --ink
const LINE  = "#d8d6cf";  // --line
const MUTED = "#6b6b66";  // --muted
const GREEN = "#2f9e44";  // --green

// --- inline types (no app imports in edge functions) ---
interface Registration {
    readonly github: string;
    readonly gist_id: string;
}

interface ProfileStats {
    readonly sessions: number;
    readonly streak_days: number;
    readonly tokens: { readonly total: number };
    readonly cost_usd?: number;
}

interface ProfileInsights {
    readonly hours_total?: number;
}

interface ProfileV1 {
    readonly v: 1;
    readonly github: string;
    readonly window_days: number;
    readonly stats: ProfileStats;
    readonly insights?: ProfileInsights;
}

// --- compact number helpers (no Intl - not reliably available in workers) ---
function compactNum(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

function compactMoney(usd: number): string {
    if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
    return `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One stat cell: big mono number + small uppercase label below. */
function statCell(value: string, label: string, accent = false): string {
    const valueColor = accent ? GREEN : INK;
    return `<div style="display:flex;flex-direction:column;margin-right:48px">`
        + `<span style="font-size:52px;font-weight:700;color:${valueColor};line-height:1;letter-spacing:-2px">${esc(value)}</span>`
        + `<span style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};margin-top:8px">${esc(label)}</span>`
        + `</div>`;
}

export const onRequestGet: PagesFunction = async (ctx) => {
    const login = String(ctx.params.login ?? "").replace(/\.png$/, "");
    if (!LOGIN_RE.test(login)) {
        return new Response("bad request", { status: 400 });
    }

    // Cache key includes the render revision so template bumps bust stale renders.
    const cache = (caches as unknown as { default: Cache }).default;
    const u = new URL(ctx.request.url);
    u.searchParams.set("r", String(OG_PROFILE_RENDER_REV));
    const cacheKey = new Request(u.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // Step 1: resolve registration (login → gist_id)
    const regRes = await fetch(
        `${REPO_RAW}/community/users/${login.toLowerCase()}.json`,
        { headers: { "user-agent": "ax-og-profile" } },
    );
    if (!regRes.ok) return new Response("not found", { status: 404 });
    const reg = (await regRes.json()) as Registration;
    if (typeof reg.gist_id !== "string" || typeof reg.github !== "string") {
        return new Response("invalid registration", { status: 404 });
    }

    // Step 2: fetch the profile gist
    const profileRes = await fetch(
        `https://gist.githubusercontent.com/${reg.github}/${reg.gist_id}/raw/ax-profile.json`,
        { headers: { "user-agent": "ax-og-profile" } },
    );
    if (!profileRes.ok) return new Response("not found", { status: 404 });
    const profile = (await profileRes.json()) as ProfileV1;
    if (profile.v !== 1) return new Response("invalid profile", { status: 404 });

    const s = profile.stats;
    const ins = profile.insights;

    // Build stat row: sessions · tokens · cost? · streak · hours?
    const statCells = [
        statCell(String(s.sessions), "sessions"),
        statCell(compactNum(s.tokens.total), "tokens"),
        s.cost_usd !== undefined ? statCell(`~${compactMoney(s.cost_usd)}`, "est. spend", true) : "",
        statCell(`${s.streak_days}d`, "streak"),
        ins?.hours_total !== undefined ? statCell(compactNum(ins.hours_total), "hours") : "",
    ].filter(Boolean).slice(0, 5).join("");

    // Header: kicker line above big @login
    const header = `<div style="display:flex;justify-content:space-between;align-items:flex-start">`
        + `<div style="display:flex;flex-direction:column">`
        + `<span style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED}">`
        + `agent telemetry dossier · last ${profile.window_days} days`
        + `</span>`
        + `<span style="font-size:72px;font-weight:700;letter-spacing:-3px;color:${INK};line-height:1;margin-top:12px">`
        + `@${esc(login)}`
        + `</span>`
        + `</div>`
        + `<span style="font-size:28px;font-weight:700;color:${GREEN}">ax</span>`
        + `</div>`;

    // Hairline divider
    const divider = `<div style="display:flex;height:1px;background:${LINE};margin-top:28px;margin-bottom:40px"></div>`;

    // Stats row
    const statsRow = `<div style="display:flex;align-items:flex-end">${statCells}</div>`;

    // Footer
    const footer = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:48px">`
        + `<span style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED}">`
        + `compiled from local transcripts · ax.necmttn.com`
        + `</span>`
        + `</div>`;

    // Full bleed paper card, no inner border (platforms draw their own frame).
    // 64px safe margins keep content clear of corner clipping.
    const html = `<div style="display:flex;flex-direction:column;width:1200px;height:630px;background:${PAGE};padding:60px 72px">`
        + header + divider + statsRow + footer
        + `</div>`;

    // Fetch fonts in parallel to minimize latency
    const [font, fontBold] = await Promise.all([
        fetch("https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.ttf")
            .then(r => r.arrayBuffer()),
        fetch("https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-700-normal.ttf")
            .then(r => r.arrayBuffer()),
    ]);

    let png: ArrayBuffer;
    try {
        const image = new ImageResponse(html, {
            width: 1200,
            height: 630,
            fonts: [
                { name: "JetBrains Mono", data: font,     weight: 400, style: "normal" },
                { name: "JetBrains Mono", data: fontBold, weight: 700, style: "normal" },
            ],
        });
        // Buffer the render: a lazy stream produced empty bodies on Pages.
        png = await image.arrayBuffer();
    } catch (err) {
        return new Response(
            `render error: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`,
            { status: 500 },
        );
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
