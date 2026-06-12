import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    WrappedFact,
    WrappedProfile,
} from "@ax/lib/shared/dashboard-types";
import { fmtCount, fmtTs } from "@ax/lib/shared/formatters";
import { CopyButton } from "../components/copy-button.tsx";
import { WrappedCardGrid } from "../components/wrapped-cards.tsx";
import { TokenScale } from "../components/token-scale.tsx";

const hourLabel = (hour: number | null): string => {
    if (hour == null) return "n/a";
    const suffix = hour < 12 ? "AM" : "PM";
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display} ${suffix}`;
};

const maybeCount = (value: number | null): string => (value == null ? "n/a" : fmtCount(value));

export function WrappedRoute() {
    const wrappedQuery = useQuery({
        queryKey: ["wrapped"],
        queryFn: () => api.wrapped(),
    });

    const data = wrappedQuery.data ?? null;
    const loading = wrappedQuery.isLoading;
    const error = wrappedQuery.error ? String(wrappedQuery.error) : null;

    return (
        <section className="panel wrapped-page">
            <header>
                <h2>Agent Wrapped</h2>
                <span className="meta">
                    {data
                        ? `${data.period.label} · generated ${fmtTs(data.generatedAt)}`
                        : ""}
                </span>
                <GenerateBriefButton hasCards={(data?.cards?.length ?? 0) > 0} />
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data ? (
                (data.cards?.length ?? 0) > 0 ? (
                    <>
                        <WrappedCardGrid cards={data.cards ?? []} />
                        <ImproveCta />
                        <details open style={{ marginTop: 24 }}>
                            <summary style={{ cursor: "pointer" }}><strong>The numbers</strong></summary>
                            {/* The agent deck supersedes the mechanical hero +
                                facts - only the raw stats live here. */}
                            <MetricGrid profile={data} />
                            <TokenScale tokens={data.usage.totalTokens} />
                        </details>
                    </>
                ) : (
                    <>
                        <GenerateCta />
                        <WrappedHero profile={data} />
                        <MetricGrid profile={data} />
                        <TokenScale tokens={data.usage.totalTokens} />
                        <Facts facts={data.facts} />
                        <ImproveCta />
                    </>
                )
            ) : null}
        </section>
    );
}

function WrappedHero({ profile }: { profile: WrappedProfile }) {
    const archetype = profile.primaryArchetype;
    return (
        <div className="wrapped-hero">
            <div>
                <span className="badge review">Primary archetype</span>
                <h3>{archetype.label}</h3>
                <p className="wrapped-public-line">{archetype.publicLine}</p>
                <p className="wrapped-internal">{archetype.internalExplanation || "No internal explanation available."}</p>
                {/* The raw archetype score is an internal ranking value -
                    only the confidence band means anything to a reader. */}
                <small className="wrapped-confidence">{archetype.confidence} confidence</small>
            </div>
        </div>
    );
}

function MetricGrid({ profile }: { profile: WrappedProfile }) {
    const metrics = [
        ["Sessions", fmtCount(profile.usage.sessions)],
        ["Messages", fmtCount(profile.usage.messages)],
        ["Total tokens", maybeCount(profile.usage.totalTokens)],
        ["Active days", fmtCount(profile.usage.activeDays)],
        ["Current streak", `${fmtCount(profile.usage.currentStreakDays)}d`],
        ["Longest streak", `${fmtCount(profile.usage.longestStreakDays)}d`],
        ["Peak hour", hourLabel(profile.usage.peakHour)],
        ["Favorite model", profile.usage.favoriteModel ?? "n/a"],
    ] as const;

    return (
        <div className="wrapped-metrics" aria-label="Wrapped metrics">
            {metrics.map(([label, value]) => (
                <div className="wrapped-metric" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                </div>
            ))}
        </div>
    );
}


function Facts({ facts }: { facts: ReadonlyArray<WrappedFact> }) {
    return (
        <>
            <h3 className="wrapped-h3">Interesting facts</h3>
            {facts.length === 0 ? (
                <div className="empty">No interesting facts yet.</div>
            ) : (
                <div className="wrapped-facts">
                    {facts.map((fact) => (
                        <article className="wrapped-fact" key={fact.id}>
                            <header>
                                <h4>{fact.title}</h4>
                                <span className="badge archive">{fact.sensitivity}</span>
                            </header>
                            <p>{fact.publicText}</p>
                            {fact.internalText ? <small>{fact.internalText}</small> : null}
                        </article>
                    ))}
                </div>
            )}
        </>
    );
}


/** Header action: copies the generation brief for an agent session. */
function GenerateBriefButton({ hasCards }: { readonly hasCards: boolean }) {
    const query = useQuery({
        queryKey: ["wrapped", "generate-brief"],
        queryFn: () => api.wrappedGenerateBrief(),
        staleTime: Infinity,
    });
    if (!query.data) return null;
    return (
        <CopyButton
            text={query.data.brief}
            label={hasCards ? "Regenerate wrapped" : "Copy wrapped brief"}
        />
    );
}

/** Empty-deck call to action above the mechanical fallback view. */
function GenerateCta() {
    return (
        <div className="wrapped-cta panel">
            <h3 style={{ margin: "0 0 4px" }}>Make this page yours</h3>
            <p className="meta" style={{ margin: 0 }}>
                These are the mechanical numbers. Copy the wrapped brief (top right),
                paste it into an agent session, and it will mine your graph and publish
                headline cards here via <code>ax wrapped publish</code>.
            </p>
        </div>
    );
}

/** The bridge from "cool shareable recap" to the product's real job:
 *  the improve loop. Counts come from the (cached) next-actions feed. */
function ImproveCta() {
    const query = useQuery({
        queryKey: ["next-actions"],
        queryFn: () => api.nextActions(),
        staleTime: 60_000,
    });
    const count = query.data?.cards.length ?? 0;
    return (
        <div className="wrapped-improve-cta panel">
            <div>
                <h3 style={{ margin: "0 0 4px" }}>Now make it better</h3>
                <p className="meta" style={{ margin: 0 }}>
                    {count > 0
                        ? `ax mined ${count} concrete next actions from this data - proposals to decide, failures to fix, savings to route.`
                        : "ax mines your sessions for concrete next actions - proposals, failure fixes, routing savings."}
                </p>
            </div>
            <Link to="/improve" className="badge keep wrapped-improve-link">
                {count > 0 ? `What's next (${count}) →` : "Open the improve loop →"}
            </Link>
        </div>
    );
}
