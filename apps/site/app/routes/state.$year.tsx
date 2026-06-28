import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { StateReportDossier } from "~/components/state-report";
import { parseStateYearParam } from "~/lib/state-report";
import { fetchStateReport, type StateReport } from "@ax/lib/shared/community";

type LoaderData = { readonly year: number };

function loadStateYear({ params }: { params: { year: string } }): LoaderData {
    const year = parseStateYearParam(params.year);
    if (year === null) throw notFound();
    return { year };
}

export const Route = createFileRoute("/state/$year")({
    head: ({ loaderData }) => {
        const year = (loaderData as LoaderData | undefined)?.year;
        return {
            meta: [
                { title: year ? `State of Agent Engineering ${year} - ax` : "State of Agent Engineering - ax" },
                {
                    name: "description",
                    content: "Measured, not asked: anonymized community distributions from opt-in ax profiles.",
                },
            ],
        };
    },
    loader: loadStateYear,
    component: StatePage,
});

type State =
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; report: StateReport };

function StatePage() {
    const { year } = Route.useLoaderData() as LoaderData;
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        fetchStateReport(year)
            .then((report) => {
                if (alive) setState({ kind: "ready", report });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFoundState =
                    typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFoundState
                    ? { kind: "not-found" }
                    : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [year]);

    return (
        <>
            <SiteHeader />
            <main className="state-page profile-v2">
                {state.kind === "loading" && <p className="pf-loading">pulling the state report...</p>}
                {state.kind === "not-found" && <MissingState year={year} />}
                {state.kind === "error" && <p className="pf-loading">couldn't load state report: {state.message}</p>}
                {state.kind === "ready" && <StateReportDossier report={state.report} />}
            </main>
            <SiteFooter />
        </>
    );
}

function MissingState({ year }: { readonly year: number }) {
    return (
        <section className="sk-empty">
            <p className="sk-eyebrow">404</p>
            <h1>state report not found</h1>
            <p className="muted">
                No compiled community state report exists for {year}. Published years appear
                here after the nightly community compile writes <code>community/state/{year}.json</code>.
            </p>
            <a className="sk-empty-link" href="/leaders">back to leaders</a>
        </section>
    );
}
