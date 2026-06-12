import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";

/**
 * Paxel-style recap card grid: eyebrow question, BIG headline, two
 * supporting lines, dithered halftone art header. The headline carries the
 * card. Art + rotation jitter are deterministic per index so the deck is
 * stable across renders.
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

/** Deterministic visual variant: art density/shape + rotation by index. */
const variant = (i: number) => ({
    art: `wrapped-card-art v${i % 4}`,
    rotation: [-1.2, 0.8, -0.5, 1.1, -0.9, 0.4][i % 6] ?? 0,
});

function WrappedCardView({ card, index }: { readonly card: WrappedCardDto; readonly index: number }) {
    const v = variant(index);
    return (
        <article
            className="wrapped-card"
            style={{ transform: `rotate(${v.rotation}deg)` }}
        >
            <div className={v.art} aria-hidden="true">
                <span className="wrapped-card-dots">
                    <i />
                    <i />
                    <i />
                </span>
            </div>
            <div className="wrapped-card-copy">
                <span className="wrapped-card-eyebrow">{card.question}</span>
                <h3 className="wrapped-card-headline">{card.headline}</h3>
                <p className="wrapped-card-body">{card.body}</p>
                {card.sensitivity === "sensitive" ? (
                    <span className="badge archive wrapped-card-flag">private</span>
                ) : null}
            </div>
        </article>
    );
}
