// apps/site/app/routes/u.$login_.vs.$other.tsx
// Canonical, shareable head-to-head duel: /u/<a>/vs/<b>.
// Thin wrapper over ProfileDossier - presets the vs peer, reuses the overlay.
// The trailing `_` on `$login_` escapes the `u.$login` layout (whose component
// renders no <Outlet/>), so this route mounts standalone while keeping the URL
// path /u/$login/vs/$other (mirrors blog_.$slug, changelog_.$version).
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { ProfileDossier, UnclaimedDossier, type VsState } from "~/components/profile-dossier";
import { fetchProfile, type ProfileV1 } from "~/lib/community";
import { compareDecision, buildDuelOgImageUrl } from "~/lib/challenge";

export const Route = createFileRoute("/u/$login_/vs/$other")({
    beforeLoad: ({ params }) => {
        const d = compareDecision(params.login, params.other);
        if (d.kind === "redirect") throw redirect({ to: d.to });
        // invalid logins fall through to the component's error state
    },
    head: ({ params }) => ({
        meta: [
            { title: `@${params.login} vs @${params.other} - ax duel` },
            { name: "description", content: `Agent profile duel: @${params.login} vs @${params.other}, compiled from the ax graph.` },
            { property: "og:image", content: buildDuelOgImageUrl(params.login, params.other) },
            { name: "twitter:card", content: "summary_large_image" },
            { name: "twitter:image", content: buildDuelOgImageUrl(params.login, params.other) },
        ],
    }),
    component: DuelPage,
});

type State =
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; profile: ProfileV1 };

function DuelPage() {
    const { login, other } = Route.useParams();
    const [state, setState] = useState<State>({ kind: "loading" });
    const [vsState, setVsState] = useState<VsState>({ kind: "none" });

    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        fetchProfile(login)
            .then((profile) => {
                if (!alive) return;
                if (profile.github.toLowerCase() !== login.toLowerCase()) {
                    setState({ kind: "error", message: "profile identity mismatch" });
                    return;
                }
                setState({ kind: "ready", profile });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound ? { kind: "not-found" } : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [login]);

    useEffect(() => {
        let alive = true;
        setVsState({ kind: "loading", login: other });
        fetchProfile(other)
            .then((profile) => {
                if (!alive) return;
                if (profile.github.toLowerCase() !== other.toLowerCase()) {
                    setVsState({ kind: "error", login: other });
                    return;
                }
                setVsState({ kind: "ready", login: other, profile });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setVsState(notFound ? { kind: "not-found", login: other } : { kind: "error", login: other });
            });
        return () => { alive = false; };
    }, [other]);

    return (
        <>
            <SiteHeader />
            <main className="profile-page">
                {state.kind === "loading" && <p className="pf-loading">pulling the duel @{login} vs @{other}…</p>}
                {state.kind === "not-found" && <UnclaimedDossier login={login} />}
                {state.kind === "error" && <p className="pf-loading">couldn't load profile: {state.message}</p>}
                {state.kind === "ready" && <ProfileDossier profile={state.profile} vs={vsState} />}
            </main>
            <SiteFooter />
        </>
    );
}
