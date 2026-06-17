// apps/site/app/routes/status.tsx
//
// Unlisted live-adoption page (not linked from nav). Client-fetches the same
// zero-consent signals as `bun scripts/adoption.ts`, straight from GitHub/npm,
// so it's always current with no backend. See app/lib/adoption.ts.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { formatCompact } from "~/lib/community";
import { fetchAdoption, type AdoptionStats } from "~/lib/adoption";

export const Route = createFileRoute("/status")({
    head: () => ({
        meta: [
            { title: "ax status - live adoption" },
            { name: "description", content: "Live, measured adoption for ax: installs, stars, releases. No surveys, no phone-home." },
            // Unlisted: keep it out of search results too.
            { name: "robots", content: "noindex" },
        ],
    }),
    component: StatusPage,
});

type State =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; stats: AdoptionStats };

function StatusPage() {
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        fetchAdoption()
            .then((stats) => alive && setState({ kind: "ready", stats }))
            .catch((e: unknown) =>
                alive && setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
            );
        return () => { alive = false; };
    }, []);

    return (
        <>
            <SiteHeader />
            <main className="status-page">
                <header className="status-head">
                    <h1>status</h1>
                    <p className="muted">
                        Live adoption, measured - not surveyed. Installs counted from GitHub release
                        downloads (an <code>install.sh</code> fetch isn't an install). Pulled straight
                        from the GitHub &amp; npm APIs on load.
                    </p>
                </header>

                {state.kind === "loading" && <p className="muted status-note">measuring…</p>}
                {state.kind === "error" && (
                    <p className="muted status-note">
                        couldn't load stats ({state.message}) - GitHub's anonymous API limit is 60/hr; try again shortly.
                    </p>
                )}
                {state.kind === "ready" && <Receipt stats={state.stats} />}
            </main>
            <SiteFooter />
        </>
    );
}

function Receipt({ stats }: { stats: AdoptionStats }) {
    const maxRelease = Math.max(1, ...stats.releases.map((r) => r.downloads));
    return (
        <div className="status-receipt">
            <dl className="status-cells">
                <Cell label="installs (all-time)" value={formatCompact(stats.totalDownloads)} hint="release binary downloads" />
                <Cell label="stars" value={formatCompact(stats.stars)} />
                <Cell label="forks" value={formatCompact(stats.forks)} />
                <Cell label="open issues" value={formatCompact(stats.openIssues)} hint="PRs excluded" />
                <Cell
                    label="npm / week"
                    value={stats.npm ? formatCompact(stats.npm.lastWeek) : "-"}
                    hint={stats.npm ? "axctl" : "not published yet"}
                />
            </dl>

            {stats.byPlatform.length > 0 && (
                <section className="status-block">
                    <h2>installs by platform</h2>
                    <ul className="status-bars">
                        {stats.byPlatform.map((p) => {
                            const pct = stats.totalDownloads ? Math.round((p.downloads / stats.totalDownloads) * 100) : 0;
                            return (
                                <li key={p.platform}>
                                    <span className="status-bar-label">{p.platform}</span>
                                    <span className="status-bar-track">
                                        <span className="status-bar-fill" style={{ width: `${pct}%` }} />
                                    </span>
                                    <span className="status-bar-val">{p.downloads} <span className="muted">({pct}%)</span></span>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}

            <section className="status-block">
                <h2>recent releases</h2>
                <ul className="status-bars">
                    {stats.releases.map((r) => {
                        const pct = Math.round((r.downloads / maxRelease) * 100);
                        return (
                            <li key={r.tag}>
                                <span className="status-bar-label">{r.tag}</span>
                                <span className="status-bar-track">
                                    <span className="status-bar-fill" style={{ width: `${pct}%` }} />
                                </span>
                                <span className="status-bar-val">{r.downloads}</span>
                            </li>
                        );
                    })}
                </ul>
            </section>

            <p className="muted status-foot">
                Reproduce locally: <code>bun scripts/adoption.ts</code>. Site traffic is on Cloudflare
                Web Analytics (browser page views), kept separate from these install numbers.
            </p>
        </div>
    );
}

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="status-cell">
            <dt>{label}</dt>
            <dd>{value}</dd>
            {hint && <span className="status-cell-hint muted">{hint}</span>}
        </div>
    );
}
