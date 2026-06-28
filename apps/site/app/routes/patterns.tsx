// apps/site/app/routes/patterns.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { SiteHeader } from "~/components/landing-sections/site-header";
import {
    fetchCommunityPatterns,
    groupPatternsByCategory,
    patternAnchorId,
    PATTERN_CATEGORY_LABELS,
    type CommunityPattern,
    type CommunityPatternsResult,
    type PatternCategoryGroup,
    type PatternLinkRel,
} from "~/lib/community-patterns";
import { formatCompact } from "@ax/lib/shared/community";

export const Route = createFileRoute("/patterns")({
    head: () => ({
        meta: [
            { title: "ax patterns - community recovery mesh" },
            { name: "description", content: "Community taste patterns from the ax registry, grouped by category with linked recoveries and conflicts." },
        ],
    }),
    component: PatternsPage,
});

type State =
    | { kind: "loading" }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | { kind: "ready"; result: CommunityPatternsResult };

function PatternsPage() {
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        fetchCommunityPatterns()
            .then((result) => {
                if (!alive) return;
                setState({ kind: "ready", result });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound ? { kind: "empty" } : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, []);

    const groups = useMemo(
        () => state.kind === "ready" ? groupPatternsByCategory(state.result.patterns) : [],
        [state],
    );
    const totals = useMemo(() => {
        if (state.kind !== "ready") return { patterns: 0, sessions: 0, links: 0, dropped: 0 };
        return {
            patterns: state.result.patterns.length,
            sessions: state.result.patterns.reduce((sum, p) => sum + p.evidence.sessions, 0),
            links: state.result.patterns.reduce((sum, p) => sum + (p.links?.length ?? 0), 0),
            dropped: state.result.dropped.length,
        };
    }, [state]);

    return (
        <>
            <SiteHeader />
            <main className="patterns-page">
                <header className="pt-head">
                    <p className="lf-eyebrow">community registry</p>
                    <h1>patterns</h1>
                    <p className="muted">
                        Shared taste patterns from <code>community/patterns/</code>, grouped by the closed category enum. Relationship links stay inside this page so recovery paths are inspectable without trusting user HTML.
                    </p>
                    {state.kind === "ready" && (
                        <p className="pt-meta">
                            <strong>{totals.patterns}</strong> patterns
                            {" / "}<strong>{formatCompact(totals.sessions)}</strong> evidence sessions
                            {" / "}<strong>{totals.links}</strong> registry links
                            {totals.dropped > 0 && <> / {totals.dropped} dropped files</>}
                        </p>
                    )}
                </header>

                {state.kind === "loading" && <p className="pf-loading">loading patterns...</p>}
                {state.kind === "empty" && <EmptyPatterns />}
                {state.kind === "error" && <p className="pf-loading">couldn't load patterns: {state.message}</p>}

                {state.kind === "ready" && totals.patterns === 0 && <EmptyPatterns dropped={state.result.dropped.length} />}
                {state.kind === "ready" && totals.patterns > 0 && (
                    <>
                        <CategoryNav groups={groups} />
                        <div className="pt-category-stack">
                            {groups.map((group) => (
                                <PatternCategorySection key={group.category} group={group} />
                            ))}
                        </div>
                    </>
                )}
            </main>
            <SiteFooter />
        </>
    );
}

function CategoryNav({ groups }: { readonly groups: readonly PatternCategoryGroup[] }) {
    return (
        <nav className="pt-category-nav" aria-label="pattern categories">
            {groups.map((group) => (
                <a href={`#patterns-${group.category}`} key={group.category}>
                    <span>{group.label}</span>
                    <strong>{group.count}</strong>
                </a>
            ))}
        </nav>
    );
}

function PatternCategorySection({ group }: { readonly group: PatternCategoryGroup }) {
    return (
        <section className="pt-category-section" id={`patterns-${group.category}`} data-empty={group.count === 0}>
            <div className="pt-category-head">
                <div>
                    <p className="pt-cat">{group.category}</p>
                    <h2>{group.label}</h2>
                </div>
                <span className="pt-category-count">{group.count}</span>
            </div>

            {group.count === 0 ? (
                <p className="pt-category-empty">
                    No {group.label.toLowerCase()} patterns have landed in the registry yet.
                </p>
            ) : (
                <div className="pt-pattern-grid">
                    {group.patterns.map((pattern) => (
                        <PatternCard pattern={pattern} key={pattern.key} />
                    ))}
                </div>
            )}
        </section>
    );
}

function PatternCard({ pattern }: { readonly pattern: CommunityPattern }) {
    return (
        <article className="pt-pattern-card" id={patternAnchorId(pattern.key)}>
            <div className="pt-pattern-top">
                <span className="pt-cat">{PATTERN_CATEGORY_LABELS[pattern.category]}</span>
                <h3>{pattern.name}</h3>
            </div>

            <PatternBody pattern={pattern} />
            <PatternEvidence pattern={pattern} />
            <PatternRelations pattern={pattern} />

            <footer className="pt-pattern-foot">
                {pattern.author !== undefined ? (
                    <Link to="/u/$login" params={{ login: pattern.author.login }} search={{ vs: undefined }}>
                        @{pattern.author.login}
                    </Link>
                ) : (
                    <span>author pending</span>
                )}
                <a href={`#${patternAnchorId(pattern.key)}`} aria-label={`Link to ${pattern.key}`}>#{pattern.key}</a>
            </footer>
        </article>
    );
}

function PatternBody({ pattern }: { readonly pattern: CommunityPattern }) {
    if (pattern.category === "stack-choice") {
        return (
            <p className="pt-summary">
                <span className="pt-slot">{pattern.slot}</span>
                {" preference for "}<strong>{pattern.name}</strong>
                {pattern.over !== undefined && pattern.over.length > 0 && <> over {pattern.over.join(", ")}</>}
                {pattern.context !== undefined && <> in {pattern.context}</>}.
            </p>
        );
    }
    return <p className="pt-summary">{pattern.summary}</p>;
}

function PatternEvidence({ pattern }: { readonly pattern: CommunityPattern }) {
    return (
        <dl className="pt-evidence">
            <div>
                <dt>sessions</dt>
                <dd>{formatCompact(pattern.evidence.sessions)}</dd>
            </div>
            <div>
                <dt>confidence</dt>
                <dd>{formatPct(pattern.evidence.confidence)}</dd>
            </div>
            <div>
                <dt>trend</dt>
                <dd>{pattern.evidence.trend ?? "untracked"}</dd>
            </div>
            {pattern.evidence.last_reinforced !== undefined && (
                <div>
                    <dt>reinforced</dt>
                    <dd>{pattern.evidence.last_reinforced}</dd>
                </div>
            )}
        </dl>
    );
}

function PatternRelations({ pattern }: { readonly pattern: CommunityPattern }) {
    const links = pattern.links ?? [];
    if (links.length === 0) {
        return <p className="pt-no-links">No registry links yet.</p>;
    }
    return (
        <ul className="pt-link-list">
            {links.map((link, i) => (
                <li key={`${link.rel}-${link.ref}-${i}`} data-rel={link.rel}>
                    <span>{relLabel(link.rel)}</span>
                    <a href={`#${patternAnchorId(link.ref)}`}>{displayRef(link.ref)}</a>
                </li>
            ))}
        </ul>
    );
}

function relLabel(rel: PatternLinkRel): string {
    switch (rel) {
        case "recovered-by": return "recovered by";
        case "pairs-with": return "pairs with";
        case "conflicts-with": return "conflicts with";
    }
}

function displayRef(ref: string): string {
    const slash = ref.indexOf("/");
    return slash === -1 ? ref : ref.slice(slash + 1);
}

function formatPct(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function EmptyPatterns({ dropped = 0 }: { readonly dropped?: number }) {
    return (
        <section className="leaders-founding pt-empty">
            <p className="lf-eyebrow">community mesh</p>
            <h2 className="lf-headline">No shared patterns have landed yet.</h2>
            <p className="lf-lede">
                Patterns appear here after builders contribute reviewed taste-pattern JSON to the registry. The page will show category counts, evidence, authors, and recovery links as soon as the first files merge.
            </p>
            <p className="lf-foot muted">
                Start from <Link to="/leaders">the community leaders</Link> or run <code>ax contribute pattern</code> to open a reviewed registry PR.
                {dropped > 0 && <> {dropped} registry file(s) were skipped because they did not validate.</>}
            </p>
        </section>
    );
}
