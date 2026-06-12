/**
 * Profile OG card (1200x630 PNG) - dense agent telemetry dossier.
 *
 * Data path v0: community/users/<login>.json → gist ax-profile.json.
 * Falls back to ?data=<url-encoded JSON> for local/preview testing without
 * a published registration.
 *
 * Route: /og-profile/<login> - avoids collision with /og/[owner]/[gistId].
 *
 * Satori rules (same as share card): display:flex everywhere, integer px,
 * margin-right not gap, no overflow/border-radius on tracks, no raw svg,
 * hex colors only (no rgb() - commas break workers-og style parser),
 * no flex-wrap (takes display:flex down with it).
 */
import { ImageResponse } from "workers-og";
import { OG_RENDER_REV } from "../_lib/og-meta";
import {
    INK, DIM, CARD, GREEN, RED,
    esc, statHtml, footerHtml, blockLogoHtml, compactNumber, compactUsd, loadOgFonts,
} from "../_lib/og-kit";

const LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;
const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";

// ---------------------------------------------------------------------------
// Incoming data shapes - two paths: registered gist or ?data= query stub
// ---------------------------------------------------------------------------
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
    readonly parallel_sessions?: number;
    readonly longest_run_hours?: number;
    readonly commits?: number;
    readonly subagents_total?: number;
}

interface DailyActivity {
    readonly date: string;
    readonly sessions: number;
}

interface ProfileV1 {
    readonly v: 1;
    readonly github: string;
    readonly window_days: number;
    readonly stats: ProfileStats;
    readonly insights?: ProfileInsights;
    readonly activity?: { readonly daily?: ReadonlyArray<DailyActivity> };
}

// Loose shape for the ?data= stub - all fields optional
interface ProfileStub {
    readonly sessions?: number;
    readonly tokens?: number;
    readonly estimated_spend_usd?: number | null;
    readonly streak_days?: number;
    readonly active_hours?: number;
    readonly parallel_sessions?: number;
    readonly longest_run_hours?: number;
    readonly commits?: number;
    readonly subagents?: number;
    readonly activity?: { readonly daily?: ReadonlyArray<DailyActivity> };
}

// ---------------------------------------------------------------------------
// Mini bar chart - 30 bars, satori-safe (margin-right not gap, fixed widths)
// ---------------------------------------------------------------------------
function barChartHtml(daily: ReadonlyArray<DailyActivity>): string {
    const slice = daily.slice(-30);
    if (slice.length === 0) return "";
    const maxSessions = Math.max(1, ...slice.map((d) => d.sessions));
    const busyIdx = slice.reduce((best, d, i) =>
        d.sessions > (slice[best]?.sessions ?? 0) ? i : best, 0);
    const BAR_H = 80; // max bar height px
    const BAR_W = 28; // bar width px
    const bars = slice.map((d, i) => {
        const h = Math.max(4, Math.round((d.sessions / maxSessions) * BAR_H));
        const color = i === busyIdx ? RED : GREEN;
        return `<div style="display:flex;flex-direction:column;justify-content:flex-end;height:${BAR_H}px;margin-right:4px"><div style="display:flex;width:${BAR_W}px;height:${h}px;background:${color}"></div></div>`;
    }).join("");
    return `<div style="display:flex;flex-direction:column"><div style="display:flex;align-items:flex-end">${bars}</div><span style="font-size:13px;letter-spacing:2px;color:${DIM};margin-top:10px">DAILY SESSIONS · 30 DAYS</span></div>`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const onRequestGet: PagesFunction = async (ctx) => {
    const login = String(ctx.params.login ?? "").replace(/\.png$/, "");
    if (!LOGIN_RE.test(login)) {
        return new Response("bad request", { status: 400 });
    }

    // Cache key includes render revision; bumping OG_RENDER_REV busts old renders.
    const cache = (caches as unknown as { default: Cache }).default;
    const u = new URL(ctx.request.url);
    u.searchParams.set("r", String(OG_RENDER_REV));
    const cacheKey = new Request(u.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // --- Resolve profile data ---
    // Path A: ?data= stub (local testing / preview)
    const rawStub = u.searchParams.get("data");
    let stub: ProfileStub | null = null;
    if (rawStub) {
        try { stub = JSON.parse(rawStub) as ProfileStub; } catch { /* ignore */ }
    }

    // Path B: registered gist via community/users/<login>.json
    let gistProfile: ProfileV1 | null = null;
    if (!stub) {
        try {
            const regRes = await fetch(
                `${REPO_RAW}/community/users/${login.toLowerCase()}.json`,
                { headers: { "user-agent": "ax-og-profile" } },
            );
            if (regRes.ok) {
                const reg = (await regRes.json()) as Registration;
                if (typeof reg.gist_id === "string" && typeof reg.github === "string") {
                    const profileRes = await fetch(
                        `https://gist.githubusercontent.com/${reg.github}/${reg.gist_id}/raw/ax-profile.json`,
                        { headers: { "user-agent": "ax-og-profile" } },
                    );
                    if (profileRes.ok) {
                        const p = (await profileRes.json()) as ProfileV1;
                        if (p.v === 1) gistProfile = p;
                    }
                }
            }
        } catch { /* fallthrough to placeholder card */ }
    }

    // --- Extract normalized fields for layout ---
    let sessions: number | null    = null;
    let tokens: number | null      = null;
    let spendUsd: number | null    = null;
    let streakDays: number | null  = null;
    let activeHours: number | null = null;
    let parallelSessions: number | null  = null;
    let longestRunHours: number | null   = null;
    let commits: number | null     = null;
    let subagents: number | null   = null;
    let daily: ReadonlyArray<DailyActivity> | null = null;

    if (stub) {
        sessions     = stub.sessions ?? null;
        tokens       = stub.tokens ?? null;
        spendUsd     = stub.estimated_spend_usd ?? null;
        streakDays   = stub.streak_days ?? null;
        activeHours  = stub.active_hours ?? null;
        parallelSessions = stub.parallel_sessions ?? null;
        longestRunHours  = stub.longest_run_hours ?? null;
        commits      = stub.commits ?? null;
        subagents    = stub.subagents ?? null;
        daily        = stub.activity?.daily ?? null;
    } else if (gistProfile) {
        const s  = gistProfile.stats;
        const ins = gistProfile.insights;
        sessions     = s.sessions;
        tokens       = s.tokens.total;
        spendUsd     = s.cost_usd ?? null;
        streakDays   = s.streak_days;
        activeHours  = ins?.hours_total ?? null;
        parallelSessions = ins?.parallel_sessions ?? null;
        longestRunHours  = ins?.longest_run_hours ?? null;
        commits      = ins?.commits ?? null;
        subagents    = ins?.subagents_total ?? null;
        daily        = gistProfile.activity?.daily ?? null;
    }

    // --- Build layout sections ---

    // Header row: block logo left, kicker right
    const logo   = blockLogoHtml({ scale: 4, color: INK, dimColor: DIM });
    const header = `<div style="display:flex;justify-content:space-between;align-items:flex-start"><div style="display:flex">${logo}</div><span style="font-size:13px;letter-spacing:3px;color:${DIM}">AGENT TELEMETRY DOSSIER · LAST 30 DAYS</span></div>`;

    // Big @login in Gelasio serif
    const loginHtml = `<div style="display:flex;align-items:baseline;margin-top:12px"><span style="font-size:48px;font-weight:700;color:${DIM};font-family:'Gelasio';margin-right:4px">@</span><span style="font-size:88px;font-weight:700;color:${INK};font-family:'Gelasio';line-height:1">${esc(login)}</span></div>`;

    // Stat band 1 - humanized numerals (19.6B, ~$22.9K, 2.3K) per the
    // profile design language.
    const statBand1 = `<div style="display:flex">${[
        statHtml(sessions != null ? sessions.toLocaleString("en-US") : "-", "SESSIONS"),
        statHtml(tokens  != null ? compactNumber(tokens)             : "-", "TOKENS"),
        statHtml(spendUsd != null ? compactUsd(spendUsd)             : "-", "EST. SPEND", GREEN),
        statHtml(streakDays  != null ? `${streakDays}d`             : "-", "STREAK"),
        statHtml(activeHours != null ? compactNumber(activeHours)   : "-", "HOURS"),
    ].join("")}</div>`;

    // Filler: bar chart or second stat row (fills dead space)
    let filler: string;
    if (daily && daily.length > 0) {
        filler = barChartHtml(daily);
    } else if (parallelSessions != null || longestRunHours != null || commits != null || subagents != null) {
        filler = `<div style="display:flex">${[
            statHtml(parallelSessions != null ? String(parallelSessions)          : "-", "PARALLEL"),
            statHtml(longestRunHours  != null ? `${longestRunHours}h`             : "-", "LONGEST RUN"),
            statHtml(commits          != null ? commits.toLocaleString("en-US")   : "-", "COMMITS"),
            statHtml(subagents        != null ? compactNumber(subagents)          : "-", "SUBAGENTS"),
        ].join("")}</div>`;
    } else {
        filler = "";
    }

    const footer = footerHtml("COMPILED FROM LOCAL TRANSCRIPTS");

    // justify-content:space-between distributes sections across full 630px
    const html = `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background:${CARD};padding:56px 64px;font-family:'JetBrains Mono'">${header}${loginHtml}${statBand1}${filler}${footer}</div>`;

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
