import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
    fetchSkillAdoption,
    formatCompact,
    validateSkillRouteKey,
    type SkillAdoption,
} from "@ax/lib/shared/community";

const PROFILE_FANOUT_CAP = 24;

export const Route = createFileRoute("/skills/$key")({
    head: ({ params }) => {
        const parsed = safeParseKey(params.key);
        const title = parsed === null ? "skill not found - ax" : `${parsed.identity} adoption - ax skills`;
        return {
            meta: [
                { title },
                { name: "description", content: "Community adoption for an ax skill, compiled from public opt-in profile gists." },
            ],
        };
    },
    component: SkillPage,
});

type State =
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; adoption: SkillAdoption };

function safeParseKey(key: string): ReturnType<typeof validateSkillRouteKey> | null {
    try {
        return validateSkillRouteKey(key);
    } catch {
        return null;
    }
}

function SkillPage() {
    const { key } = Route.useParams();
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        fetchSkillAdoption(key, { maxProfiles: PROFILE_FANOUT_CAP })
            .then((adoption) => {
                if (alive) setState({ kind: "ready", adoption });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound =
                    typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                const invalid = e instanceof Error && e.message === "invalid skill key";
                setState(notFound || invalid
                    ? { kind: "not-found" }
                    : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [key]);

    return (
        <>
            <SiteHeader />
            <main className="skill-page">
                {state.kind === "loading" && <p className="pf-loading">pulling the skill dossier...</p>}
                {state.kind === "not-found" && <SkillNotFound routeKey={key} />}
                {state.kind === "error" && <p className="pf-loading">couldn't load skill adoption: {state.message}</p>}
                {state.kind === "ready" && <SkillDossier adoption={state.adoption} />}
            </main>
            <SiteFooter />
        </>
    );
}

function SkillDossier({ adoption }: { readonly adoption: SkillAdoption }) {
    const maxRuns = Math.max(1, ...adoption.users.map((u) => u.runs));
    return (
        <>
            <header className="sk-head">
                <Link className="sk-back" to="/leaders">leaders</Link>
                <p className="sk-eyebrow">skill dossier</p>
                <h1>
                    {adoption.source !== "local" && (
                        <>
                            <span className="sk-source">{adoption.source}</span>{" "}
                        </>
                    )}
                    {adoption.name}
                </h1>
                <p className="sk-headline">
                    used by <strong>{formatCompact(adoption.stats.users)}</strong>{" "}
                    {adoption.stats.users === 1 ? "dev" : "devs"}{" · "}
                    <strong>{formatCompact(adoption.stats.runs)}</strong> runs/30d
                </p>
                <p className="sk-meta">
                    aggregate from skill-stats.json - profile roster fetched from public opt-in gists
                </p>
            </header>

            <section className="sk-users" aria-labelledby="skill-users-heading">
                <div className="sk-section-head">
                    <h2 id="skill-users-heading">who runs it</h2>
                    <span>
                        {adoption.users.length} matched
                        {adoption.truncated && <> - first {adoption.fetchedProfiles} of {adoption.rosterCount} profiles sampled</>}
                    </span>
                </div>
                {adoption.users.length === 0 ? (
                    <p className="pf-quiet">
                        No fetched public profile lists this skill yet. The aggregate row can still lead
                        when the matching registered profiles are outside the capped sample or have not
                        republished their gist.
                    </p>
                ) : (
                    <ol className="sk-user-list">
                        {adoption.users.map((user, i) => (
                            <li className="sk-user" key={user.login}>
                                <span className="sk-user-rank">{i + 1}</span>
                                <Link className="sk-user-link" to="/u/$login" params={{ login: user.login }} search={{ vs: undefined }}>
                                    <img
                                        className="lb-avatar"
                                        src={`https://github.com/${user.login}.png?size=64`}
                                        alt=""
                                        width={32}
                                        height={32}
                                        loading="lazy"
                                    />
                                    <span>@{user.login}</span>
                                </Link>
                                <span className="sk-user-source">{user.source}</span>
                                <span className="sk-user-runs">
                                    <span className="sk-bar" style={{ width: `${Math.max(5, (user.runs / maxRuns) * 100)}%` }} aria-hidden />
                                    <span>{formatCompact(user.runs)} runs</span>
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </section>
        </>
    );
}

function SkillNotFound({ routeKey }: { readonly routeKey: string }) {
    const parsed = safeParseKey(routeKey);
    return (
        <section className="sk-empty">
            <p className="sk-eyebrow">404</p>
            <h1>skill not found</h1>
            <p className="muted">
                {parsed === null
                    ? "That skill key is not a valid source:name route."
                    : `No community skill-stats row exists for ${parsed.key}.`}
            </p>
            <Link className="sk-empty-link" to="/leaders">back to leaders</Link>
        </section>
    );
}
