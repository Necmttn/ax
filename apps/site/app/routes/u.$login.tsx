// apps/site/app/routes/u.$login.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { fetchProfile, type ProfileV1 } from "@ax/lib/shared/community";
import { ProfileDossier, UnclaimedDossier, type VsPeerState, type VsState } from "~/components/profile-dossier";
import { parseCompareLogins } from "~/lib/radar";
import { cachedFetchProfile } from "../profile-cache";

export const Route = createFileRoute("/u/$login")({
    validateSearch: (search: Record<string, unknown>) => ({
        vs: parseCompareLogins(search.vs).join(",") || undefined,
    }),
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
    const { vs } = Route.useSearch();
    const [state, setState] = useState<State>({ kind: "loading" });
    const [vsState, setVsState] = useState<VsState>({ kind: "none" });

    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        cachedFetchProfile(login)
            .then((profile) => {
                if (!alive) return;
                // Identity binding: the registered login must match the
                // gist's claimed github handle, else a hostile gist could
                // impersonate another user on its /u/ page.
                if (profile.github.toLowerCase() !== login.toLowerCase()) {
                    setState({ kind: "error", message: "profile identity mismatch" });
                    return;
                }
                setState({ kind: "ready", profile });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound
                    ? { kind: "not-found" }
                    : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [login]);

    useEffect(() => {
        let alive = true;
        const compareLogins = parseCompareLogins(vs, { exclude: login });
        if (compareLogins.length === 0) {
            setVsState({ kind: "none" });
            return () => { alive = false; };
        }

        const updatePeer = (next: VsPeerState) => {
            if (!alive) return;
            setVsState((current) => current.kind === "multi"
                ? {
                    kind: "multi",
                    peers: current.peers.map((peer) =>
                        peer.login.toLowerCase() === next.login.toLowerCase() ? next : peer,
                    ),
                }
                : current);
        };

        setVsState({
            kind: "multi",
            peers: compareLogins.map((peerLogin) => ({ kind: "loading", login: peerLogin })),
        });

        for (const peerLogin of compareLogins) {
            fetchProfile(peerLogin)
                .then((profile) => {
                    if (profile.github.toLowerCase() !== peerLogin.toLowerCase()) {
                        updatePeer({ kind: "error", login: peerLogin });
                        return;
                    }
                    updatePeer({ kind: "ready", login: peerLogin, profile });
                })
                .catch((e: unknown) => {
                    const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                    updatePeer(notFound ? { kind: "not-found", login: peerLogin } : { kind: "error", login: peerLogin });
                });
        }

        return () => { alive = false; };
    }, [vs, login]);

    return (
        <>
            <SiteHeader />
            <main className="landing-v2 profile-v2">
                {state.kind === "loading" && <p className="pf-loading">pulling the dossier on @{login}…</p>}
                {state.kind === "not-found" && <UnclaimedDossier login={login} />}
                {state.kind === "error" && <p className="pf-loading">couldn't load profile: {state.message}</p>}
                {state.kind === "ready" && <ProfileDossier profile={state.profile} vs={vsState} />}
            </main>
            <SiteFooter />
        </>
    );
}
