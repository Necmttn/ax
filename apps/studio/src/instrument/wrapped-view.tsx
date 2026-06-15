/**
 * Wrapped - the editorial recap, restyled in the instrument system. Restores
 * what Mission Control dropped from the old WrappedRoute: the agent-authored
 * recap card deck (ax wrapped publish) + interesting facts, bound to the real
 * api.wrapped() data. Reached from the rail (❖).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { WrappedCardDto, WrappedFact, WrappedProfile } from "@ax/lib/shared/dashboard-types";
import { fmtCount, fmtTs } from "@ax/lib/shared/formatters";
import { InstrumentShell } from "./shell.tsx";

const ACCENTS = ["green", "blue", "gold", "violet", "rose"] as const;
const BAR_COUNT = 22;

/** Deterministic strip for ungrounded cards (no Math.random → stable). */
function* seededBars(seed: string, count: number): Generator<number> {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    for (let i = 0; i < count; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
        yield 22 + (h % 78);
    }
}
const normalizeSeries = (s: ReadonlyArray<number>): number[] => {
    const max = Math.max(...s, 1);
    return s.map((v) => 8 + Math.round((Math.max(0, v) / max) * 92));
};

function DeckCard({ card, index }: { card: WrappedCardDto; index: number }) {
    const accent = ACCENTS[index % ACCENTS.length];
    const grounded = (card.series?.length ?? 0) >= 2;
    const bars = grounded ? normalizeSeries(card.series ?? []) : [...seededBars(card.headline, BAR_COUNT)];
    return (
        <article className={`rdx-card acc-${accent} wr-card`} style={{ animationDelay: `${(index % 8) * 0.05}s` }}>
            <div className="wr-strip" aria-hidden="true" title={grounded ? (card.series_label ?? undefined) : undefined}>
                {bars.map((b, i) => <i key={i} style={{ height: `${b}%` }} />)}
            </div>
            <span className="wr-q">$ {card.question}</span>
            <h3 className="wr-head">{card.headline}</h3>
            <p className="wr-body">{card.body}</p>
            {card.sensitivity === "sensitive" ? <span className="nf-flag">private</span> : null}
        </article>
    );
}

function Facts({ facts }: { facts: ReadonlyArray<WrappedFact> }) {
    if (facts.length === 0) return null;
    return (
        <section style={{ marginTop: 28 }}>
            <div className="wr-kicker rdx-label">interesting facts · {facts.length}</div>
            <div className="wr-facts">
                {facts.map((f) => (
                    <article className="wr-fact" key={f.id}>
                        <div className="wr-fact-head"><h4>{f.title}</h4><span className="wr-fact-tag">{f.sensitivity}</span></div>
                        <p>{f.publicText}</p>
                    </article>
                ))}
            </div>
        </section>
    );
}

export function WrappedView() {
    const q = useQuery({ queryKey: ["wrapped"], queryFn: () => api.wrapped() });
    const data: WrappedProfile | null = q.data ?? null;
    const cards = data?.cards ?? [];
    return (
        <InstrumentShell>
            <div className="wr-page">
                <header className="wr-mast">
                    <div>
                        <div className="wr-mast-title">Agent Wrapped</div>
                        <div className="rdx-label">{data ? `${data.period.label} · compiled ${fmtTs(data.generatedAt)}` : ""}</div>
                    </div>
                    {data ? <div className="rdx-label" style={{ textAlign: "right" }}>{fmtCount(data.usage.sessions)} sessions · {fmtCount(cards.length)} cards</div> : null}
                </header>

                {q.isLoading && !data ? <div className="rdx-label" style={{ padding: 24 }}>loading…</div> : null}

                {cards.length > 0 ? (
                    <div className="wr-deck">
                        {cards.map((c, i) => <DeckCard key={`${c.position}-${c.headline}`} card={c} index={i} />)}
                    </div>
                ) : data ? (
                    <div className="wr-empty rdx-card">
                        <div className="wr-head" style={{ fontSize: 22 }}>No recap cards yet</div>
                        <p className="wr-body">Run <code>ax wrapped publish</code> - an agent mines your graph and writes headline cards here.</p>
                    </div>
                ) : null}

                {data ? <Facts facts={data.facts} /> : null}
            </div>
        </InstrumentShell>
    );
}
