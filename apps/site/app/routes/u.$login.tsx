// apps/site/app/routes/u.$login.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { fetchProfile, type ProfileV1 } from "~/lib/community";

export const Route = createFileRoute("/u/$login")({
    head: ({ params }) => ({
        meta: [
            { title: `@${params.login} - ax profile` },
            { name: "description", content: `${params.login}'s agent profile: usage, rig, and taste from the ax graph.` },
        ],
    }),
    component: ProfilePage,
});

type State =
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; profile: ProfileV1 };

function ProfilePage() {
    const { login } = Route.useParams();
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        fetchProfile(login)
            .then((profile) => alive && setState({ kind: "ready", profile }))
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound
                    ? { kind: "not-found" }
                    : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [login]);

    return (
        <>
            <SiteHeader />
            <main className="profile-page">
                {state.kind === "loading" && <p className="muted">loading @{login}…</p>}
                {state.kind === "not-found" && (
                    <section>
                        <h1>@{login} isn't on ax yet</h1>
                        <p>Publish your own profile: <code>ax profile publish</code></p>
                    </section>
                )}
                {state.kind === "error" && <p className="muted">couldn't load profile: {state.message}</p>}
                {state.kind === "ready" && <ProfileCard profile={state.profile} />}
            </main>
            <SiteFooter />
        </>
    );
}

const fmt = (n: number): string => Intl.NumberFormat("en-US", { notation: "compact" }).format(n);

function ProfileCard({ profile: p }: { profile: ProfileV1 }) {
    return (
        <article>
            <header>
                <h1>@{p.github}</h1>
                <p className="muted">last {p.window_days} days · updated {p.generated_at.slice(0, 10)} · powered by <Link to="/">ax</Link></p>
            </header>

            <section className="stat-row">
                <Stat label="sessions" value={fmt(p.stats.sessions)} />
                <Stat label="tokens" value={fmt(p.stats.tokens.total)} />
                {p.stats.cost_usd !== undefined && <Stat label="est. spend" value={`$${p.stats.cost_usd.toFixed(0)}`} />}
                <Stat label="streak" value={`${p.stats.streak_days}d`} />
                <Stat label="active days" value={String(p.stats.active_days)} />
            </section>

            <section>
                <h2>models</h2>
                {p.stats.models.map((m) => (
                    <div className="bar-row" key={m.name}>
                        <span className="bar-label">{m.name}</span>
                        <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, m.share * 100)}%` }} /></span>
                        <span className="bar-value">{(m.share * 100).toFixed(0)}%{m.cost_usd !== undefined ? ` · $${m.cost_usd.toFixed(0)}` : ""}</span>
                    </div>
                ))}
                <p className="muted">harnesses: {p.stats.harnesses.join(", ")}</p>
            </section>

            <section>
                <h2>rig</h2>
                <p className="muted">
                    {p.rig.skills.length} skills · {p.rig.hooks.length} hooks · routing table: {p.rig.routing_table ? "yes" : "no"}
                    {p.rig.rules ? ` · ${p.rig.rules.count} rules` : ""}
                </p>
                <ul>
                    {p.rig.skills.slice(0, 15).map((s) => (
                        <li key={`${s.source}:${s.name}`}>
                            {s.name} <span className="muted">({s.source}, {fmt(s.runs)} runs)</span>
                        </li>
                    ))}
                </ul>
            </section>

            {p.taste && p.taste.patterns.length > 0 && (
                <section>
                    <h2>taste</h2>
                    <ul>
                        {p.taste.patterns.map((t) => (
                            <li key={`${t.category}/${t.name}`}>
                                <strong>{t.category === "stack-choice" && t.slot ? `${t.slot}: ${t.name}` : t.name}</strong>
                                {t.summary ? <> - {t.summary}</> : null}
                                <span className="muted"> (confidence {t.evidence.confidence}, {t.evidence.sessions} sessions{t.evidence.trend ? `, ${t.evidence.trend}` : ""})</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </article>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="stat">
            <div className="stat-value">{value}</div>
            <div className="stat-label muted">{label}</div>
        </div>
    );
}
