import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    WrappedFact,
    WrappedProfile,
    WrappedUsageDay,
} from "@ax/lib/shared/dashboard-types";
import { fmtCount, fmtTs } from "@ax/lib/shared/formatters";
import { CopyButton } from "../components/copy-button.tsx";
import { WrappedCardGrid } from "../components/wrapped-cards.tsx";
import { TokenScale } from "../components/token-scale.tsx";
import { CellGrid } from "../components/viz/cell-grid.tsx";
import { Segbar } from "../components/viz/segbar.tsx";
import { GlyphReel } from "../components/viz/glyph-reel.tsx";

const hourLabel = (hour: number | null): string => {
    if (hour == null) return "n/a";
    const suffix = hour < 12 ? "AM" : "PM";
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display} ${suffix}`;
};

const maybeCount = (value: number | null): string => (value == null ? "n/a" : fmtCount(value));

/** Hash an archetype id to a stable glyph-reel starting pattern. */
const seedFrom = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
};

/**
 * Map the daily-activity series to 0-4 contribution levels. We rank by tokens
 * when present (the real spend signal), else fall back to session count, and
 * bucket against the max so the busiest day lands at level 4.
 */
const dayLevels = (days: ReadonlyArray<WrappedUsageDay>): number[] => {
    const val = (d: WrappedUsageDay) => (d.tokens != null && d.tokens > 0 ? d.tokens : d.sessions);
    const max = Math.max(1, ...days.map(val));
    return days.map((d) => {
        const v = val(d);
        if (v <= 0) return 0;
        const r = v / max;
        return r > 0.66 ? 4 : r > 0.4 ? 3 : r > 0.15 ? 2 : 1;
    });
};

export function WrappedRoute() {
    const wrappedQuery = useQuery({
        queryKey: ["wrapped"],
        queryFn: () => api.wrapped(),
    });

    const data = wrappedQuery.data ?? null;
    const loading = wrappedQuery.isLoading;
    const error = wrappedQuery.error ? String(wrappedQuery.error) : null;
    const hasCards = (data?.cards?.length ?? 0) > 0;
    // The board needs the usage rollup + an archetype; a not-yet-ready profile
    // (or an older daemon) can ship neither, so gate on both before rendering.
    const boardReady = Boolean(data?.usage && data?.primaryArchetype);

    return (
        <section className="panel wrapped-page">
            <header>
                <h2>Agent Wrapped</h2>
                <span className="meta">
                    {data
                        ? `${data.period.label} · generated ${fmtTs(data.generatedAt)}`
                        : ""}
                </span>
                <GenerateBriefButton hasCards={hasCards} />
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data && boardReady ? (
                <>
                    <div className="wrapped-board">
                        <div className="nf-grid">
                            <StatsBento profile={data} />
                            {hasCards ? (
                                <WrappedCardGrid cards={data.cards ?? []} startIndex={8} />
                            ) : null}
                        </div>
                    </div>

                    {hasCards ? <ImproveCta /> : <GenerateCta />}

                    <details open style={{ marginTop: 24 }}>
                        <summary style={{ cursor: "pointer" }}><strong>The numbers</strong></summary>
                        {/* Raw mechanical stats live here; the board above is the recap. */}
                        <MetricGrid profile={data} />
                        <TokenScale tokens={data.usage.totalTokens} />
                    </details>

                    {hasCards ? null : <ImproveCta />}
                    {hasCards ? null : <Facts facts={data.facts} />}
                </>
            ) : data ? (
                <div className="empty" style={{ marginTop: 16 }}>
                    Wrapped isn’t ready yet - ingest more sessions, then refresh.
                </div>
            ) : null}
        </section>
    );
}

/**
 * The dark instrument board: an archetype hero (glyph reel), Doto-numeral stat
 * cards, a real contribution heatmap of daily activity, and a streak segbar.
 * All cells/segments slam in on a stagger and pause under reduced motion.
 */
function StatsBento({ profile }: { profile: WrappedProfile }) {
    const u = profile.usage;
    const arch = profile.primaryArchetype;
    const days = u.days ?? [];
    const levels = dayLevels(days);
    const cols = Math.min(days.length || 1, 26);
    const litWeeks = Math.ceil((days.length || 0) / 7);
    const streakCap = Math.max(7, u.longestStreakDays || 7);

    return (
        <>
            <article className="nf-card nf-hero" style={{ animationDelay: "0s" }}>
                <div className="nf-meta">
                    <span>Archetype · primary</span>
                    <span className="nf-tag">{arch.confidence} confidence</span>
                </div>
                <div className="nf-hero-art">
                    <GlyphReel seed={seedFrom(arch.id || arch.label)} />
                </div>
                <div>
                    <div className="nf-hero-label">{arch.label}</div>
                    <p className="nf-hero-line">{arch.publicLine}</p>
                </div>
            </article>

            <StatCard label="Sessions" doto value={fmtCount(u.sessions)} sub={`${fmtCount(u.messages)} messages`} delay={0.07} />

            <StatCard
                label="Tokens"
                value={maybeCount(u.totalTokens)}
                sub={u.tokenComparison ?? "all-time spend"}
                delay={0.14}
            />

            <article className="nf-card nf-span-2" style={{ animationDelay: "0.21s" }}>
                <div className="nf-meta">
                    <span>Activity · daily</span>
                    <span className="nf-tag live"><span className="ax-led" />LIVE</span>
                </div>
                <div className="nf-cellwrap">
                    {levels.length ? (
                        <CellGrid levels={levels} cols={cols} />
                    ) : (
                        <span className="nf-sub">no activity yet</span>
                    )}
                </div>
                <div className="nf-meta" style={{ marginTop: 12 }}>
                    <span>{fmtCount(u.activeDays)} active days</span>
                    <span>{litWeeks} weeks</span>
                </div>
            </article>

            <article className="nf-card" style={{ animationDelay: "0.28s" }}>
                <div className="nf-meta">
                    <span>Streak</span>
                </div>
                <div className="nf-doto">
                    {fmtCount(u.currentStreakDays)}<small>d</small>
                </div>
                <div className="nf-segbar">
                    <Segbar
                        total={streakCap}
                        on={Math.min(streakCap, u.currentStreakDays)}
                        color="orange"
                        wave
                    />
                </div>
                <div className="nf-sub">best {fmtCount(u.longestStreakDays)} days</div>
            </article>

            <StatCard label="Peak hour" value={hourLabel(u.peakHour)} sub="most active" delay={0.35} />

            <article className="nf-card" style={{ animationDelay: "0.42s" }}>
                <div className="nf-meta">
                    <span>Top model</span>
                </div>
                <div className="nf-metric" style={{ fontSize: 22, overflowWrap: "anywhere" }}>
                    {u.favoriteModel ?? "n/a"}
                </div>
                <div className="nf-sub">most-used model</div>
            </article>
        </>
    );
}

function StatCard({
    label,
    value,
    sub,
    doto = false,
    delay = 0,
}: {
    readonly label: string;
    readonly value: string;
    readonly sub: string;
    readonly doto?: boolean;
    readonly delay?: number;
}) {
    return (
        <article className="nf-card" style={{ animationDelay: `${delay}s` }}>
            <div className="nf-meta">
                <span>{label}</span>
            </div>
            <div className={doto ? "nf-doto" : "nf-metric"}>{value}</div>
            <div className="nf-sub">{sub}</div>
        </article>
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
                The board shows your real numbers. Copy the wrapped brief (top right),
                paste it into an agent session, and it will mine your graph and publish
                headline cards into the deck via <code>ax wrapped publish</code>.
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
