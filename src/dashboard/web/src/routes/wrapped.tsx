import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type {
    WrappedArchetype,
    WrappedFact,
    WrappedProfile,
    WrappedUsageDay,
} from "@shared/dashboard-types.ts";
import { fmtCount, fmtTs } from "@shared/formatters.ts";

const hourLabel = (hour: number | null): string => {
    if (hour == null) return "n/a";
    const suffix = hour < 12 ? "AM" : "PM";
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display} ${suffix}`;
};

const maybeCount = (value: number | null): string => (value == null ? "n/a" : fmtCount(value));

const scoreLabel = (archetype: WrappedArchetype): string =>
    `${Math.round(archetype.score)} score · ${archetype.confidence} confidence`;

const heatLevel = (day: WrappedUsageDay, max: number): number => {
    if (max <= 0 || day.sessions <= 0) return 0;
    return Math.max(1, Math.min(4, Math.ceil((day.sessions / max) * 4)));
};

const activityLabel = (day: WrappedUsageDay): string =>
    `${day.date}: ${fmtCount(day.sessions)} sessions, ${fmtCount(day.turns)} turns, ${
        day.tokens == null ? "tokens not available" : `${fmtCount(day.tokens)} tokens`
    }`;

export function WrappedRoute() {
    const wrappedQuery = useQuery({
        queryKey: ["wrapped"],
        queryFn: () => api.wrapped(),
    });
    const publicQuery = useQuery({
        queryKey: ["wrapped", "public-preview"],
        queryFn: () => api.wrappedPublicPreview(),
    });

    const data = wrappedQuery.data ?? null;
    const publicProfile = publicQuery.data ?? null;
    const loading = wrappedQuery.isLoading;
    const error = wrappedQuery.error ? String(wrappedQuery.error) : null;
    const publicError = publicQuery.error ? String(publicQuery.error) : null;

    return (
        <section className="panel wrapped-page">
            <header>
                <h2>Agent Wrapped</h2>
                <span className="meta">
                    {data
                        ? `${data.period.label} · generated ${fmtTs(data.generatedAt)}`
                        : ""}
                </span>
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data ? (
                <>
                    <WrappedHero profile={data} />
                    <MetricGrid profile={data} />
                    <DailyHeatmap days={data.usage.days} />
                    <Facts facts={data.facts} />
                    <PublicPreview
                        profile={publicProfile}
                        loading={publicQuery.isLoading}
                        error={publicError}
                    />
                </>
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
            </div>
            <div className="wrapped-score">
                <strong>{Math.round(archetype.score)}</strong>
                <span>{archetype.confidence} confidence</span>
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

function DailyHeatmap({ days }: { days: ReadonlyArray<WrappedUsageDay> }) {
    const maxSessions = useMemo(
        () => days.reduce((max, day) => Math.max(max, day.sessions), 0),
        [days],
    );

    return (
        <>
            <h3 className="wrapped-h3">Daily activity</h3>
            {days.length === 0 ? (
                <div className="empty">No daily activity in this period.</div>
            ) : (
                <>
                    <div className="wrapped-heatmap" aria-hidden="true">
                        {days.map((day) => (
                            <span
                                key={day.date}
                                className={`wrapped-day level-${heatLevel(day, maxSessions)}`}
                                title={activityLabel(day)}
                            >
                                <span>{day.date.slice(5)}</span>
                            </span>
                        ))}
                    </div>
                    <ul className="sr-only" aria-label="Daily activity values">
                        {days.map((day) => (
                            <li key={day.date}>{activityLabel(day)}</li>
                        ))}
                    </ul>
                </>
            )}
        </>
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

function PublicPreview({
    profile,
    loading,
    error,
}: {
    profile: WrappedProfile | null;
    loading: boolean;
    error: string | null;
}) {
    return (
        <>
            <h3 className="wrapped-h3">Public preview</h3>
            {error ? <div className="error">Public preview error: {error}</div> : null}
            {loading && !profile ? <div className="loading">Loading public preview…</div> : null}
            {profile ? (
                <div className="wrapped-public-preview">
                    <div>
                        <span className="badge keep">
                            {profile.privacy.publicSafe ? "public safe" : "check"}
                        </span>
                        <h4>{profile.primaryArchetype.label}</h4>
                        <p>{profile.primaryArchetype.publicLine}</p>
                        <small>{scoreLabel(profile.primaryArchetype)}</small>
                    </div>
                    <ul>
                        {profile.facts.length === 0 ? (
                            <li>No public facts available.</li>
                        ) : (
                            profile.facts.map((fact) => (
                                <li key={fact.id}>
                                    <strong>{fact.title}</strong>
                                    <span>{fact.publicText}</span>
                                </li>
                            ))
                        )}
                    </ul>
                    {profile.privacy.redactedFields.length > 0 ? (
                        <p className="wrapped-redactions">
                            Redacted: {profile.privacy.redactedFields.join(", ")}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}
