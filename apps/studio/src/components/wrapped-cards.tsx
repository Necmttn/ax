import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";

/**
 * Trace cards - the ax-native wrapped deck. Each card opens with an
 * activity-bar strip in the card's accent (the house sparkline/heatmap
 * material), then a monospace query eyebrow, a serif headline, and a quiet
 * body. Accents rotate through the studio's luminance-matched palette;
 * the bars are deterministic per headline so the deck is stable.
 */
export function WrappedCardGrid({ cards }: { readonly cards: ReadonlyArray<WrappedCardDto> }) {
    return (
        <div className="wrapped-cards" aria-label="Wrapped recap cards">
            {cards.map((card, i) => (
                <WrappedCardView key={`${card.position}-${card.headline}`} card={card} index={i} />
            ))}
        </div>
    );
}

const ACCENTS = ["green", "blue", "gold", "violet", "rose"] as const;

/** Tiny deterministic PRNG seeded from a string - no Math.random so the
 *  strip never flickers between renders. */
function* seededBars(seed: string, count: number): Generator<number> {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    for (let i = 0; i < count; i++) {
        h ^= h << 13;
        h ^= h >>> 17;
        h ^= h << 5;
        h >>>= 0;
        // 25%..100% of strip height
        yield 25 + (h % 76);
    }
}

const BAR_COUNT = 22;

function WrappedCardView({ card, index }: { readonly card: WrappedCardDto; readonly index: number }) {
    const accent = ACCENTS[index % ACCENTS.length];
    const bars = [...seededBars(card.headline, BAR_COUNT)];
    return (
        <article className={`wrapped-card accent-${accent}`}>
            <div className="wrapped-card-strip" aria-hidden="true">
                {bars.map((h, i) => (
                    <i key={i} style={{ height: `${h}%` }} />
                ))}
            </div>
            <div className="wrapped-card-copy">
                <span className="wrapped-card-eyebrow">$ {card.question}</span>
                <h3 className="wrapped-card-headline">{card.headline}</h3>
                <p className="wrapped-card-body">{card.body}</p>
                {card.sensitivity === "sensitive" ? (
                    <span className="badge archive wrapped-card-flag">private</span>
                ) : null}
            </div>
        </article>
    );
}
