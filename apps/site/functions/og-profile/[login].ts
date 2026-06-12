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
    INK, PAPER, DIM, CARD, GREEN, RED,
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
    readonly harnesses?: ReadonlyArray<string>;
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
    readonly harnesses?: ReadonlyArray<string>;
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
    const BAR_W = 32; // bar width px
    const bars = slice.map((d, i) => {
        const h = Math.max(4, Math.round((d.sessions / maxSessions) * BAR_H));
        const color = i === busyIdx ? RED : GREEN;
        return `<div style="display:flex;flex-direction:column;justify-content:flex-end;height:${BAR_H}px"><div style="display:flex;width:${BAR_W}px;height:${h}px;background:${color}"></div></div>`;
    }).join("");
    // Full-bleed: fixed-width bars on a space-between 1072px track distribute
    // the slack as even gaps - exact edge-to-edge without fractional margins.
    // The caption NAMES the red bar: unexplained red reads as "error", named
    // red reads as "peak".
    const busy = slice[busyIdx];
    const peakLabel = busy
        ? ` · PEAK ${fmtDayLabel(busy.date)} · ${busy.sessions.toLocaleString("en-US")} SESSIONS`
        : "";
    return `<div style="display:flex;flex-direction:column"><div style="display:flex;align-items:flex-end;justify-content:space-between;width:1072px">${bars}</div><span style="font-size:13px;letter-spacing:2px;color:${DIM};margin-top:10px">DAILY SESSIONS · 30 DAYS${esc(peakLabel)}</span></div>`;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/** "2026-06-10" -> "JUN 10"; falls back to the raw string. */
function fmtDayLabel(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${month} ${Number(m[3])}` : iso;
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
    let harnesses: ReadonlyArray<string> | null = null;
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
        harnesses    = stub.harnesses ?? null;
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
        harnesses    = s.harnesses ?? null;
        daily        = gistProfile.activity?.daily ?? null;
    }

    // --- Build layout sections ---

    // Header row: block logo left (single-color paper, no shadow - the
    // two-tone treatment reads as mud below ~scale 8), kicker right.
    const logo   = blockLogoHtml({ scale: 5, color: PAPER, dimColor: "transparent" });
    const header = `<div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex">${logo}</div><span style="font-size:13px;letter-spacing:2px;color:${DIM}">AGENT TELEMETRY DOSSIER · LAST 30 DAYS</span></div>`;

    // Name row: serif @login left (green @ = live handle), harness chips
    // right - the chips claim the dead right half of the row.
    const chipNames = (harnesses ?? [])
        .filter((h) => !h.endsWith("-subagent"))
        .slice(0, 4);
    const chips = chipNames.length > 0
        ? `<div style="display:flex;align-items:center">${chipNames.map((h) =>
            `<div style="display:flex;padding:8px 16px;background:#262735;color:${DIM};font-size:14px;letter-spacing:2px;margin-left:10px">${esc(h.toUpperCase())}</div>`,
        ).join("")}</div>`
        : "";
    const loginHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:40px"><div style="display:flex;align-items:baseline"><span style="font-size:64px;font-weight:700;color:${GREEN};font-family:'Gelasio';margin-right:2px">@</span><span style="font-size:88px;font-weight:700;color:${INK};font-family:'Gelasio';line-height:1">${esc(login)}</span></div>${chips}</div>`;

    // Stat band - full-bleed via space-between (no trailing margins); the
    // green spend numeral is the hero and wins by SIZE, not just color.
    const noMr = { marginRight: 0 };
    const statBand1 = `<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:36px">${[
        statHtml(sessions != null ? sessions.toLocaleString("en-US") : "-", "SESSIONS", INK, noMr),
        statHtml(tokens  != null ? compactNumber(tokens)             : "-", "TOKENS", INK, noMr),
        statHtml(spendUsd != null ? compactUsd(spendUsd)             : "-", "EST. SPEND", GREEN, { size: 60, marginRight: 0 }),
        statHtml(streakDays  != null ? `${streakDays}d`             : "-", "STREAK", INK, noMr),
        statHtml(activeHours != null ? compactNumber(activeHours)   : "-", "HOURS", INK, noMr),
    ].join("")}</div>`;

    // Filler: bar chart or second stat row (fills dead space)
    let filler: string;
    if (daily && daily.length > 0) {
        filler = `<div style="display:flex;margin-top:44px">${barChartHtml(daily)}</div>`;
    } else if (parallelSessions != null || longestRunHours != null || commits != null || subagents != null) {
        filler = `<div style="display:flex;justify-content:space-between;margin-top:44px">${[
            statHtml(parallelSessions != null ? String(parallelSessions)          : "-", "PARALLEL", INK, { marginRight: 0 }),
            statHtml(longestRunHours  != null ? `${longestRunHours}h`             : "-", "LONGEST RUN", INK, { marginRight: 0 }),
            statHtml(commits          != null ? commits.toLocaleString("en-US")   : "-", "COMMITS", INK, { marginRight: 0 }),
            statHtml(subagents        != null ? compactNumber(subagents)          : "-", "SUBAGENTS", INK, { marginRight: 0 }),
        ].join("")}</div>`;
    } else {
        filler = "";
    }

    const footer = footerHtml("COMPILED FROM LOCAL TRANSCRIPTS");

    // Top bands live in one inner column with designed margin-top gaps;
    // outer space-between then has exactly two children, which pins the
    // footer to the bottom padding instead of inflating the chart-to-footer
    // gap with the leftover slack.
    const inner = `<div style="display:flex;flex-direction:column">${header}${loginHtml}${statBand1}${filler}</div>`;
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
