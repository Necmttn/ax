// apps/site/app/components/wrapped-deck.tsx
//
// Pure presentational component: a deck of "wrapped card" insight tiles for
// the profile-v2 page. No data fetching - the caller builds the cards array
// (each with a grounded VizSpec) from whatever data source it has. The deck
// renders as a DARK recap band: the `.browser--instrument` wrapper pulls in the
// instrument dark token block + the `.mc-*` chart rules from globals.css, so the
// charts pop the same way they do in the studio "Agent Wrapped" recap.

import type { JSX, ReactNode } from "react";
import { CardViz, VIZ_CENTERED, type VizSpec } from "./card-viz";

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
  /** Optional grounded chart spec rendered in the card's chart region */
  readonly viz?: VizSpec;
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
    <div className="pv2-deck-band browser--instrument">
      <div className="pv2-deck" aria-label="profile insight cards">
        {cards.map((card, i) => {
          const accent = card.accent ?? ROTATE[i % ROTATE.length]!;
          const hasViz = card.viz != null;
          const centered = hasViz && VIZ_CENTERED.has(card.viz!.kind);
          return (
            <article key={card.q} className={`pv2-card accent-${accent}`}>
              <div
                className={`pv2-card-viz${centered ? " pv2-card-viz--center" : ""}`}
                aria-hidden={hasViz ? undefined : true}
              >
                {hasViz ? <CardViz spec={card.viz!} /> : null}
              </div>
              <div className="pv2-card-copy">
                <span className="pv2-card-eyebrow">
                  <span aria-hidden="true">$ </span>
                  {card.q}
                </span>
                <h3 className="pv2-card-headline">{card.a}</h3>
                <p className="pv2-card-body">{card.s}</p>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
