import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";

/**
 * Trace cards - the ax-native wrapped deck, rendered as nullframe-style dark
 * instrument tiles. Each card opens with an activity-bar strip in the card's
 * accent (the house sparkline material, real series when grounded), then a
 * monospace query eyebrow, a serif headline, and a quiet body. Cards slam in
 * on a stagger and sweep a shine on hover (CSS, see .wrapped-board .nf-card).
 */
export function WrappedCardGrid({
    cards,
    startIndex = 0,
}: {
    readonly cards: ReadonlyArray<WrappedCardDto>;
    /** Stagger offset so the deck animates in after the stats bento. */
    readonly startIndex?: number;
}) {
    return (
        <>
            {cards.map((card, i) => (
                <WrappedCardView
                    key={`${card.position}-${card.headline}`}
                    card={card}
                    index={startIndex + i}
                />
            ))}
        </>
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

const BAR_COUNT = 24;

/** Normalize a real data series into 8..100% bar heights. */
const normalizeSeries = (series: ReadonlyArray<number>): number[] => {
    const max = Math.max(...series, 1);
    return series.map((v) => 8 + Math.round((Math.max(0, v) / max) * 92));
};

function WrappedCardView({ card, index }: { readonly card: WrappedCardDto; readonly index: number }) {
    const accent = ACCENTS[index % ACCENTS.length];
    // Grounded cards draw their REAL series (e.g. daily sessions on the
    // card's model); ungrounded ones get a deterministic decorative strip.
    const grounded = (card.series?.length ?? 0) >= 2;
    const bars = grounded
        ? normalizeSeries(card.series ?? [])
        : [...seededBars(card.headline, BAR_COUNT)];
    return (
        <article
            className={`nf-card accent-${accent}`}
            style={{ animationDelay: `${index * 0.06}s` }}
        >
            <div className="nf-strip" aria-hidden="true" title={grounded ? (card.series_label ?? undefined) : undefined}>
                {bars.map((h, i) => (
                    <i key={i} style={{ height: `${h}%` }} />
                ))}
            </div>
            <span className="nf-eyebrow">$ {card.question}</span>
            <h3 className="nf-headline">{card.headline}</h3>
            <p className="nf-body">{card.body}</p>
            {card.sensitivity === "sensitive" ? <span className="nf-flag">private</span> : null}
        </article>
    );
}
