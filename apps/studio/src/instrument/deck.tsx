/** The agent-authored recap deck (ax wrapped publish cards) as instrument
 *  cards. Merged into Mission Control. Each card keys a channel colour. */
import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";

const ACCENTS = ["green", "blue", "gold", "violet", "rose"] as const;
const BAR_COUNT = 22;

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

export function RecapDeck({ cards }: { cards: ReadonlyArray<WrappedCardDto> }) {
    if (cards.length === 0) return null;
    return (
        <section className="wr-section">
            <div className="wr-kicker rdx-label">the recap · {cards.length} cards</div>
            <div className="wr-deck">
                {cards.map((c, i) => <DeckCard key={`${c.position}-${c.headline}`} card={c} index={i} />)}
            </div>
        </section>
    );
}
