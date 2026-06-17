import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { DuelDossier } from "./profile-duel.tsx";
import type { ProfileV1 } from "~/lib/community";

// DuelDossier renders TanStack <Link>s, which need a RouterProvider context.
// Mount the element as the root route component over a memory history and load
// once so RouterProvider renders synchronously to static markup.
async function renderInRouter(ui: ReactElement): Promise<string> {
    const rootRoute = createRootRoute({ component: () => ui });
    const router = createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    return renderToStaticMarkup(<RouterProvider router={router} />);
}

// Minimal-but-valid ProfileV1 builder; overrides merge shallowly into stats.
function profile(github: string, over: Partial<ProfileV1> = {}, stats: Partial<ProfileV1["stats"]> = {}): ProfileV1 {
    return {
        v: 1,
        github,
        generated_at: "2026-06-17T00:00:00Z",
        window_days: 30,
        stats: {
            sessions: 100,
            active_days: 20,
            streak_days: 5,
            tokens: { prompt: 1_000_000, completion: 500_000, total: 1_500_000 },
            cost_usd: 250,
            models: [{ name: "claude-opus", share: 1 }],
            harnesses: ["claude"],
            ...stats,
        },
        rig: { skills: [], hooks: [], routing_table: false },
        ...over,
    };
}

describe("DuelDossier", () => {
    it("renders both handles flanking a VS hero", async () => {
        const html = await renderInRouter(<DuelDossier a={profile("alice")} b={profile("bob")} />);
        expect(html).toContain("@alice");
        expect(html).toContain("@bob");
        expect(html).toContain("duel-vs");
        expect(html).toContain(">VS<");
        expect(html).toContain("duel-hero");
    });

    it("scores the per-axis tally and shows the lead line", async () => {
        // alice moves vastly more tokens -> she should lead SCALE at least
        const a = profile("alice", {}, { tokens: { prompt: 5e10, completion: 5e10, total: 1e11 } });
        const b = profile("bob", {}, { tokens: { prompt: 1, completion: 1, total: 100 } });
        const html = await renderInRouter(<DuelDossier a={a} b={b} />);
        expect(html).toContain("duel-score-tally");
        // a leads -> her handle precedes the score line
        expect(html).toContain("leads");
    });

    it("renders the overlaid radar with both series legend chips", async () => {
        const html = await renderInRouter(<DuelDossier a={profile("alice")} b={profile("bob")} />);
        expect(html).toContain("pf-radar");
        expect(html).toContain("pf-radar-legend");
        expect(html).toContain("pf-rawvals-table");
    });

    it("guards missing optional data with quiet empty notes, never crashes", async () => {
        // no activity, no insights, no taste, no skills on either side
        const html = await renderInRouter(<DuelDossier a={profile("alice")} b={profile("bob")} />);
        expect(html).toContain("pf-quiet");
        expect(html).toContain("no daily activity recorded");
        expect(html).toContain("no skills recorded");
    });

    it("compares vitals with a winner marker on the higher side", async () => {
        const a = profile("alice", {}, { sessions: 200 });
        const b = profile("bob", {}, { sessions: 50 });
        const html = await renderInRouter(<DuelDossier a={a} b={b} />);
        expect(html).toContain("duel-vital-row");
        expect(html).toContain("duel-vital-label");
        // alice (200 sessions) leads -> her value cell carries the lead class
        expect(html).toContain("duel-vital-val--a is-lead");
    });

    it("keeps the challenge buttons (copy duel link / post on X)", async () => {
        const html = await renderInRouter(<DuelDossier a={profile("alice")} b={profile("bob")} />);
        expect(html).toContain("copy duel link");
        expect(html).toContain("post on X");
        expect(html).toContain("twitter.com/intent/tweet");
    });
});
