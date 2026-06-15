/** The agent-authored recap deck (ax wrapped publish cards) as instrument
 *  cards. Each card keys a channel colour and renders an APPROVED viz from the
 *  registry - declared by the card's `viz` spec, or assigned positionally until
 *  the wrapped agent emits one. */
import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";
import { CardViz, VIZ_KINDS, type VizKind, type VizSpec } from "./card-viz.tsx";

const ACCENTS = ["green", "blue", "gold", "violet", "rose"] as const;
const N = 24;

function* seededBars(seed: string, count: number): Generator<number> {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    for (let i = 0; i < count; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
        yield 14 + (h % 86);
    }
}
const resample = (s: ReadonlyArray<number>, count: number): number[] => {
    const max = Math.max(...s, 1);
    return Array.from({ length: count }, (_, i) => 8 + Math.round((s[Math.floor((i / count) * s.length)] / max) * 92));
};

/** Resolve a card to an approved viz spec: the card's own `viz` if present,
 *  else a positional kind over the card's series (or a seeded decorative one). */
function specFor(card: WrappedCardDto, index: number): VizSpec {
    const declared = (card as { viz?: { kind?: string; data?: number[]; label?: string } }).viz;
    const grounded = (card.series?.length ?? 0) >= 2;
    const data = declared?.data ?? (grounded ? resample(card.series ?? [], N) : [...seededBars(card.headline, N)]);
    const kind: VizKind = (declared?.kind && VIZ_KINDS.includes(declared.kind as VizKind))
        ? declared.kind as VizKind
        : VIZ_KINDS[index % VIZ_KINDS.length];
    return { kind, data, label: declared?.label ?? card.series_label ?? undefined };
}

function DeckCard({ card, index }: { card: WrappedCardDto; index: number }) {
    const accent = ACCENTS[index % ACCENTS.length];
    return (
        <article className={`rdx-card acc-${accent} wr-card`} style={{ animationDelay: `${(index % 8) * 0.05}s` }}>
            <div className="wr-viz"><CardViz spec={specFor(card, index)} /></div>
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
