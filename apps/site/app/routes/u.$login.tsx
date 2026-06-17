// apps/site/app/routes/u.$login.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { fetchProfile, type ProfileV1 } from "~/lib/community";
import { ProfileDossier, UnclaimedDossier, LOGIN_RE, type VsState } from "~/components/profile-dossier";

export const Route = createFileRoute("/u/$login")({
    validateSearch: (search: Record<string, unknown>) => ({
        vs: typeof search.vs === "string" && LOGIN_RE.test(search.vs) ? search.vs : undefined,
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
        fetchProfile(login)
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
        if (!vs || vs.toLowerCase() === login.toLowerCase()) {
            // self-compare is allowed (proves the overlay path); only skip the
            // empty case so we don't double-render the same series silently.
            if (!vs) { setVsState({ kind: "none" }); return; }
        }
        setVsState({ kind: "loading", login: vs });
        fetchProfile(vs)
            .then((profile) => {
                if (!alive) return;
                if (profile.github.toLowerCase() !== vs.toLowerCase()) {
                    setVsState({ kind: "error", login: vs });
                    return;
                }
                setVsState({ kind: "ready", login: vs, profile });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setVsState(notFound ? { kind: "not-found", login: vs } : { kind: "error", login: vs });
            });
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
