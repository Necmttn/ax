// apps/site/app/components/wrapped-deck.tsx
//
// Pure presentational component: a deck of "wrapped card" insight tiles for
// the profile-v2 page. No data fetching - the caller builds the cards array
// from whatever data source it has.

import type { JSX, ReactNode } from "react";

export type WrappedAccent =
  | "green"
  | "blue"
  | "gold"
  | "violet"
  | "rose"
  | "red"
  | "ink";

export interface InsightCard {
  /** Question eyebrow, e.g. "How deep do you go?" */
  readonly q: string;
  /** Big answer, e.g. "73%" (may be a fragment with <small>) */
  readonly a: ReactNode;
  /** Quiet supporting line */
  readonly s: string;
  /** Optional pinned accent; when absent, rotate through the default palette */
  readonly accent?: WrappedAccent;
  /** Optional pre-built mini-viz node rendered inside the strip */
  readonly viz?: ReactNode;
}

/** Accent rotation applied when a card has no pinned accent */
const ROTATE: ReadonlyArray<WrappedAccent> = [
  "green",
  "blue",
  "gold",
  "violet",
  "rose",
];

export function WrappedDeck({
  cards,
}: {
  readonly cards: ReadonlyArray<InsightCard>;
}): JSX.Element {
  return (
    <div className="pv2-deck" aria-label="profile insight cards">
      {cards.map((card, i) => {
        const accent = card.accent ?? ROTATE[i % ROTATE.length]!;
        const hasViz = card.viz != null;
        return (
          <article key={card.q} className={`pv2-card accent-${accent}`}>
            <div
              className="pv2-card-strip"
              aria-hidden={hasViz ? undefined : true}
            >
              {hasViz ? card.viz : null}
            </div>
            <div className="pv2-card-copy">
              <span className="pv2-card-eyebrow">$ {card.q}</span>
              <h3 className="pv2-card-headline">{card.a}</h3>
              <p className="pv2-card-body">{card.s}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
