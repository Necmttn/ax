/**
 * Edge head-rewrite for shared-session pages. The /s/ route is a SPA: its
 * per-session og:image / title tags are injected client-side, which crawlers
 * (Slack, X, Discord) never execute - they were unfurling every share with
 * the generic site card. This function serves the same SPA shell but rewrites
 * the head at the edge so the link preview is the session's own poster
 * (/og/:owner/:gistId) and, when the gist manifest is reachable, its real
 * title and numbers.
 */
interface Env {
    readonly ASSETS: { fetch: (req: Request) => Promise<Response> };
}

interface Manifest {
    readonly kind?: string;
    readonly session?: { readonly summary?: string };
    readonly totals?: {
        readonly cost_usd: number | null;
        readonly turns: number;
        readonly subagents: number;
    };
}

const cleanSummary = (raw: string | undefined): string | null => {
    const text = (raw ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return text.length > 90 ? `${text.slice(0, 89)}…` : text;
};

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
    const owner = String(ctx.params.owner ?? "");
    const gistId = String(ctx.params.gistId ?? "");
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[a-f0-9]+$/.test(gistId)) {
        return ctx.env.ASSETS.fetch(ctx.request);
    }

    // The SPA shell (the prerendered index) - same document the route serves
    // today; only the head changes.
    const shellUrl = new URL(ctx.request.url);
    shellUrl.pathname = "/";
    shellUrl.search = "";
    const shell = await ctx.env.ASSETS.fetch(new Request(shellUrl.toString(), { headers: ctx.request.headers }));

    // Best-effort real title/description from the share manifest (edge-cached
    // upstream by GitHub; a failure falls back to generic copy).
    let title = "Shared ax session";
    let desc = "A recorded AI coding-agent session - every turn, tool call, and dollar.";
    try {
        const res = await fetch(
            `https://gist.githubusercontent.com/${owner}/${gistId}/raw/index.json`,
            { headers: { "user-agent": "ax-share-meta" }, cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit,
        );
        if (res.ok) {
            const manifest = (await res.json()) as Manifest;
            title = cleanSummary(manifest.session?.summary) ?? title;
            const t = manifest.totals;
            if (t) {
                const bits = [
                    `${t.turns.toLocaleString("en-US")} turns`,
                    t.subagents > 0 ? `${t.subagents} subagents` : null,
                    t.cost_usd != null ? `$${t.cost_usd >= 100 ? t.cost_usd.toFixed(0) : t.cost_usd.toFixed(2)}` : null,
                ].filter(Boolean).join(" · ");
                desc = `Recorded agent session - ${bits}. Every turn, tool call, and dollar.`;
            }
        }
    } catch {
        // generic copy stands
    }

    const og = `https://ax.necmttn.com/og/${owner}/${gistId}`;
    const pageUrl = `https://ax.necmttn.com/s/${owner}/${gistId}`;
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
    ];
    let rewriter = new HTMLRewriter().on("title", {
        element: (el) => {
            el.setInnerContent(`${title} - ax`);
        },
    });
    for (const r of rules) rewriter = rewriter.on(r.selector, r.handler);
    return rewriter.transform(shell);
};
