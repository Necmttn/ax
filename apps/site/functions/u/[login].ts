/**
 * Edge head-rewrite for /u/<login> profile pages. The /u/ route is a SPA:
 * og:image and title are generic by default. This function serves the same
 * SPA shell with the head rewritten at the edge so crawlers (Slack, X,
 * Discord) see the real profile poster + a stat-based description instead
 * of the site's generic card.
 *
 * Mirrors the /s/[owner]/[gistId].ts approach:
 * - Serves SPA shell from /
 * - Best-effort fetches registration + profile for real stat line
 * - Falls back to static copy on any failure
 * - Uses buildProfileOgImageUrl for the og:image value
 */
import { buildProfileOgImageUrl } from "../_lib/og-meta";

interface Env {
    readonly ASSETS: { fetch: (req: Request) => Promise<Response> };
}

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";

// Inline types - functions cannot import from app/ code.
interface Registration {
    readonly github: string;
    readonly gist_id: string;
}
interface ProfileStats {
    readonly sessions: number;
    readonly tokens: { readonly total: number };
    readonly cost_usd?: number;
    readonly streak_days: number;
}
interface ProfileV1 {
    readonly v: 1;
    readonly github: string;
    readonly window_days: number;
    readonly stats: ProfileStats;
}

function compactNum(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
    const login = String(ctx.params.login ?? "");
    if (!LOGIN_RE.test(login)) {
        return ctx.env.ASSETS.fetch(ctx.request);
    }

    // Serve the SPA shell (same document the route serves today; only the head changes).
    const shellUrl = new URL(ctx.request.url);
    shellUrl.pathname = "/";
    shellUrl.search = "";
    const shell = await ctx.env.ASSETS.fetch(new Request(shellUrl.toString(), { headers: ctx.request.headers }));

    const title = `@${login} - ax profile`;
    let desc = "agent telemetry dossier: sessions, tokens, model split, rig, and taste - measured by ax";

    // Best-effort: fetch registration → profile for a real stat line.
    // Any error falls back to the generic description.
    try {
        const regRes = await fetch(
            `${REPO_RAW}/community/users/${login.toLowerCase()}.json`,
            { headers: { "user-agent": "ax-profile-meta" }, cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit,
        );
        if (regRes.ok) {
            const reg = (await regRes.json()) as Registration;
            if (typeof reg.gist_id === "string" && typeof reg.github === "string") {
                const profRes = await fetch(
                    `https://gist.githubusercontent.com/${reg.github}/${reg.gist_id}/raw/ax-profile.json`,
                    { headers: { "user-agent": "ax-profile-meta" }, cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit,
                );
                if (profRes.ok) {
                    const profile = (await profRes.json()) as ProfileV1;
                    if (profile.v === 1) {
                        const s = profile.stats;
                        const bits = [
                            `${s.sessions} sessions`,
                            `${compactNum(s.tokens.total)} tokens`,
                            s.cost_usd !== undefined
                                ? `~$${s.cost_usd >= 1000 ? `${(s.cost_usd / 1000).toFixed(1)}K` : s.cost_usd.toFixed(0)} spent`
                                : null,
                            `${s.streak_days}d streak`,
                        ].filter(Boolean).join(" · ");
                        desc = `${bits} - agent telemetry compiled by ax over ${profile.window_days} days`;
                    }
                }
            }
        }
    } catch {
        // generic desc stands
    }

    const og = buildProfileOgImageUrl(login);
    const pageUrl = `https://ax.necmttn.com/u/${login}`;

    const set = (attr: "property" | "name", key: string, content: string) => ({
        selector: `meta[${attr}="${key}"]`,
        handler: { element: (el: Element) => el.setAttribute("content", content) },
    });

    const rules = [
        set("property", "og:image", og),
        set("name", "twitter:image", og),
        set("property", "og:image:width", "1200"),
        set("property", "og:image:height", "630"),
        set("property", "og:title", title),
        set("name", "twitter:title", title),
        set("property", "og:description", desc),
        set("name", "twitter:description", desc),
        set("property", "og:url", pageUrl),
        set("name", "twitter:card", "summary_large_image"),
    ];

    let rewriter = new HTMLRewriter().on("title", {
        element: (el) => { el.setInnerContent(`${title} - ax`); },
    });
    for (const r of rules) rewriter = rewriter.on(r.selector, r.handler);
    return rewriter.transform(shell);
};
