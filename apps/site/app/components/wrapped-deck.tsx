// apps/site/app/components/wrapped-deck.tsx
//
// Pure presentational component: a deck of "wrapped card" insight tiles for the
// profile-v2 page. No data fetching - the caller builds the cards array (each
// with a grounded VizSpec) from whatever data source it has. The deck renders
// the SHARED @ax/recap-deck cards (the nullframe `rdx-card`/`wr-*` instrument
// cards studio uses), wrapped in a `.rdx` dark-theme scope so the package tokens
// resolve. This is the single source of the wrapped-card look - byte-identical
// to the studio recap deck.

import type { JSX, ReactNode } from "react";
import { DeckCard, type DeckCardProps, type VizSpec } from "@ax/recap-deck";

/** Accents accepted at the call site. The package's red channel is named
 *  `"alert"`; we additionally accept `"red"` and translate it, so existing
 *  callers that pin the failure-rate card to `"red"` keep working. */
export type DeckAccent = DeckCardProps["accent"] | "red";

export type { VizSpec };

export interface InsightCard {
  /** Question eyebrow, e.g. "How deep do you go?" */
  readonly q: string;
  /** Big answer, e.g. "73%" (may be a fragment with <small>) */
  readonly a: ReactNode;
  /** Quiet supporting line */
  readonly s: string;
  /** Optional pinned accent; when absent, rotate through the default palette */
  readonly accent?: DeckAccent;
  /** Optional grounded chart spec rendered in the card's chart region */
  readonly viz?: VizSpec;
}

/** Accent rotation applied when a card has no pinned accent */
const ROTATE: ReadonlyArray<DeckCardProps["accent"]> = [
  "green",
  "blue",
  "gold",
  "violet",
  "rose",
];

/** Map the call-site accent onto the package's accent union (red -> alert). */
function toDeckAccent(accent: DeckAccent): DeckCardProps["accent"] {
  return accent === "red" ? "alert" : accent;
}

/** A clean, minimal decorative spec for cards with no grounded viz, so the
 *  chart region still reads as an intentional instrument readout (not empty). */
const FALLBACK_SPEC: VizSpec = {
  kind: "wave",
  data: [42, 58, 50, 66, 54, 70, 60, 74],
};

export function WrappedDeck({
  cards,
}: {
  readonly cards: ReadonlyArray<InsightCard>;
}): JSX.Element {
  return (
    <section className="rdx pv2-recap" data-theme="dark">
      <div className="wr-section">
        <div
          className="wr-deck"
          aria-label="profile insight cards"
          style={{ marginTop: 0 }}
        >
          {cards.map((card, i) => {
            const accent = toDeckAccent(card.accent ?? ROTATE[i % ROTATE.length]!);
            return (
              <DeckCard
                key={card.q}
                accent={accent}
                spec={card.viz ?? FALLBACK_SPEC}
                question={card.q}
                headline={card.a}
                body={card.s}
                index={i}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
