/**
 * Duel OG card (1200x630 PNG) - two agent dossiers head to head.
 *
 * Route: /og-duel/<a>/<b>. Data path mirrors og-profile: each login resolved
 * via community/users/<login>.json -> gist ax-profile.json. Unregistered side
 * renders an "unclaimed challenger" half so the unfurl still reads as a dare.
 *
 * Satori rules (same as og-profile): display:flex everywhere, integer px,
 * margin-right not gap, no overflow/border-radius on tracks, no raw svg,
 * hex colors only, no flex-wrap. NO radar here - satori can't draw the polygon;
 * the duel reads via side-by-side stat ledgers + a lead tally.
 */
import { ImageResponse } from "workers-og";
import {
    INK, DIM, CARD, GREEN, BLUE, PAPER,
    esc, statHtml, footerHtml, blockLogoHtml, compactNumber, compactUsd, loadOgFonts,
} from "../../_lib/og-kit";

const LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;
const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";

interface ProfileLite {
    readonly github: string;
    readonly sessions: number | null;
    readonly tokens: number | null;
    readonly spendUsd: number | null;
    readonly streakDays: number | null;
    readonly registered: boolean;
}

async function loadProfile(login: string): Promise<ProfileLite> {
    const empty: ProfileLite = { github: login, sessions: null, tokens: null, spendUsd: null, streakDays: null, registered: false };
    try {
        const regRes = await fetch(
            `${REPO_RAW}/community/users/${login.toLowerCase()}.json`,
            { headers: { "user-agent": "ax-og-duel" } },
        );
        if (!regRes.ok) return empty;
        const reg = (await regRes.json()) as { gist_id?: string; github?: string };
        if (typeof reg.gist_id !== "string" || typeof reg.github !== "string") return empty;
        const pRes = await fetch(
            `https://gist.githubusercontent.com/${reg.github}/${reg.gist_id}/raw/ax-profile.json`,
            { headers: { "user-agent": "ax-og-duel" } },
        );
        if (!pRes.ok) return empty;
        const p = (await pRes.json()) as {
            v?: number;
            github?: string;
            stats?: { sessions?: number; streak_days?: number; tokens?: { total?: number }; cost_usd?: number };
        };
        if (p.v !== 1 || !p.stats) return empty;
        return {
            github: typeof p.github === "string" ? p.github : login,
            sessions: p.stats.sessions ?? null,
            tokens: p.stats.tokens?.total ?? null,
            spendUsd: p.stats.cost_usd ?? null,
            streakDays: p.stats.streak_days ?? null,
            registered: true,
        };
    } catch { return empty; }
}

/** Strictly-greater wins across the comparable numeric stats both sides expose. */
function statsLead(a: ProfileLite, b: ProfileLite): { aLeads: number; bLeads: number; total: number } {
    const keys: ReadonlyArray<keyof ProfileLite> = ["sessions", "tokens", "spendUsd"];
    let aLeads = 0, bLeads = 0, total = 0;
    for (const k of keys) {
        const av = a[k] as number | null;
        const bv = b[k] as number | null;
        if (av === null && bv === null) continue;
        total++;
        if (av !== null && (bv === null || av > bv)) aLeads++;
        else if (bv !== null && (av === null || bv > av)) bLeads++;
    }
    return { aLeads, bLeads, total };
}

function ledgerHtml(p: ProfileLite, accent: string): string {
    const handle = `<div style="display:flex;align-items:baseline"><span style="font-size:40px;font-weight:700;color:${accent};font-family:'Gelasio';margin-right:2px">@</span><span style="font-size:56px;font-weight:700;color:${INK};font-family:'Gelasio';line-height:1">${esc(p.github)}</span></div>`;
    if (!p.registered) {
        return `<div style="display:flex;flex-direction:column;width:480px">${handle}<span style="font-size:18px;color:${DIM};margin-top:24px">unclaimed - challenge unanswered</span></div>`;
    }
    const noMr = { marginRight: 0 };
    const stats = `<div style="display:flex;justify-content:space-between;margin-top:32px">${[
        statHtml(p.sessions != null ? p.sessions.toLocaleString("en-US") : "-", "SESSIONS", INK, noMr),
        statHtml(p.tokens != null ? compactNumber(p.tokens) : "-", "TOKENS", INK, noMr),
        statHtml(p.spendUsd != null ? compactUsd(p.spendUsd) : "-", "SPEND", accent, noMr),
    ].join("")}</div>`;
    return `<div style="display:flex;flex-direction:column;width:480px">${handle}${stats}</div>`;
}

export const onRequestGet: PagesFunction = async (ctx) => {
    const a = String(ctx.params.a ?? "").replace(/\.png$/, "");
    const b = String(ctx.params.b ?? "").replace(/\.png$/, "");
    if (!LOGIN_RE.test(a) || !LOGIN_RE.test(b)) return new Response("bad request", { status: 400 });

    // Cache key: use the incoming URL as-is (the page already appends ?r=<rev>
    // so a render-rev bump on the challenge page busts the cache automatically).
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(ctx.request.url);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const [pa, pb] = await Promise.all([loadProfile(a), loadProfile(b)]);
    const tally = statsLead(pa, pb);

    const header = `<div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex">${blockLogoHtml({ scale: 5, color: PAPER, dimColor: "transparent" })}</div><span style="font-size:13px;letter-spacing:2px;color:${DIM}">AGENT DUEL · LAST 30 DAYS</span></div>`;
    const arena = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:48px">${ledgerHtml(pa, GREEN)}<span style="display:flex;font-size:48px;font-weight:700;color:${DIM};font-family:'Gelasio'">vs</span>${ledgerHtml(pb, BLUE)}</div>`;
    const leadLine = tally.total > 0
        ? `<div style="display:flex;margin-top:44px"><span style="font-size:20px;color:${DIM}"><span style="color:${GREEN}">@${esc(a)}</span> leads ${tally.aLeads} of ${tally.total} · <span style="color:${BLUE}">@${esc(b)}</span> leads ${tally.bLeads} of ${tally.total}</span></div>`
        : "";
    const footer = footerHtml("COMPILED FROM LOCAL TRANSCRIPTS");
    const inner = `<div style="display:flex;flex-direction:column">${header}${arena}${leadLine}</div>`;
    const html = `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background:${CARD};padding:56px 64px;font-family:'JetBrains Mono'">${inner}${footer}</div>`;

    const { regular, bold, serif } = await loadOgFonts();
    let png: ArrayBuffer;
    try {
        const image = new ImageResponse(html, {
            width: 1200,
            height: 630,
            fonts: [
                { name: "JetBrains Mono", data: regular, weight: 400, style: "normal" },
                { name: "JetBrains Mono", data: bold,    weight: 700, style: "normal" },
                { name: "Gelasio",        data: serif,   weight: 700, style: "normal" },
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
            "cache-control": "public, max-age=3600, s-maxage=3600",
        },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
};
