import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WrappedDeck } from "./wrapped-deck.tsx";
import type { InsightCard } from "./wrapped-deck.tsx";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function render(cards: ReadonlyArray<InsightCard>): string {
  return renderToStaticMarkup(<WrappedDeck cards={cards} />);
}

function countCards(html: string): number {
  // one shared @ax/recap-deck card == one `wr-card` instrument article
  return (html.match(/wr-card/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("WrappedDeck", () => {
  it("renders one recap-deck card per insight card", () => {
    const cards: InsightCard[] = [
      { q: "How deep?", a: "73%", s: "supporting line" },
      { q: "Busiest day?", a: "Tuesday", s: "based on sessions" },
      { q: "Models used?", a: "3", s: "across all sessions" },
    ];
    const html = render(cards);
    expect(countCards(html)).toBe(3);
    // each card is the shared nullframe instrument article
    expect((html.match(/rdx-card/g) ?? []).length).toBe(3);
  });

  it("rotates accents: green, blue, gold for 3 unpinned cards", () => {
    const cards: InsightCard[] = [
      { q: "Alpha", a: "1", s: "a" },
      { q: "Beta", a: "2", s: "b" },
      { q: "Gamma", a: "3", s: "c" },
    ];
    const html = render(cards);
    expect(html).toContain("acc-green");
    expect(html).toContain("acc-blue");
    expect(html).toContain("acc-gold");
    // verify order: green before blue, blue before gold
    const greenIdx = html.indexOf("acc-green");
    const blueIdx = html.indexOf("acc-blue");
    const goldIdx = html.indexOf("acc-gold");
    expect(greenIdx).toBeLessThan(blueIdx);
    expect(blueIdx).toBeLessThan(goldIdx);
  });

  it("pins the red accent to the package's alert channel, keyed off raw index", () => {
    const cards: InsightCard[] = [
      { q: "First", a: "1", s: "first card - would normally be green" },
      { q: "Second", a: "2", s: "second card pinned red", accent: "red" },
      { q: "Third", a: "3", s: "third card - would normally be gold" },
    ];
    const html = render(cards);
    // first card: acc-green (rotation, index 0)
    expect(html).toContain("acc-green");
    // second card: red -> alert channel (pinned, index 1)
    expect(html).toContain("acc-alert");
    expect(html).not.toContain("acc-red");
    // third card: acc-gold (rotation by raw index, rotation[2] = gold)
    expect(html).toContain("acc-gold");
    // the pinned card at index 1 consumed its rotation slot (blue), so blue is
    // skipped entirely - proving rotation keys off the raw index.
    expect(html).not.toContain("acc-blue");
  });

  it("eyebrow renders the '$ ' prefix (aria-hidden) and the question text", () => {
    const cards: InsightCard[] = [
      { q: "How deep do you go?", a: "73%", s: "supporting" },
    ];
    const html = render(cards);
    // the decorative shell prefix is wrapped aria-hidden so SR skips it
    expect(html).toContain('<span aria-hidden="true">$ </span>');
    // the question text renders in the package's wr-q eyebrow
    expect(html).toContain("How deep do you go?");
    expect(html).toContain("wr-q");
  });

  it("renders the grounded chart for a viz spec in the card chart region", () => {
    const cards: InsightCard[] = [
      { q: "Depth?", a: "deep", s: "support", viz: { kind: "bars", data: [3, 7, 12, 5] } },
    ];
    const html = render(cards);
    // CardViz dispatches kind:"bars" -> the package wr-bars chart markup
    expect(html).toContain("wr-bars");
    expect(html).toContain("wr-viz");
  });

  it("renders inside a dark .rdx recap band scope", () => {
    const cards: InsightCard[] = [{ q: "Q", a: "A", s: "s" }];
    const html = render(cards);
    expect(html).toContain("pv2-recap");
    expect(html).toContain('class="rdx pv2-recap"');
    expect(html).toContain('data-theme="dark"');
  });

  it("renders a viz-less card with a fallback chart so it still looks intentional", () => {
    const cards: InsightCard[] = [
      { q: "Quiet?", a: "yes", s: "no viz" },
    ];
    const html = render(cards);
    // copy still renders
    expect(html).toContain("Quiet?");
    expect(html).toContain("yes");
    expect(html).toContain("no viz");
    // the chart region is present (fallback spec), never an empty hole
    expect(html).toContain("wr-viz");
  });
});
