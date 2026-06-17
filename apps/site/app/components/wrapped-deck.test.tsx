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

function countArticles(html: string): number {
  return (html.match(/<article/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("WrappedDeck", () => {
  it("renders one <article> per card", () => {
    const cards: InsightCard[] = [
      { q: "How deep?", a: "73%", s: "supporting line" },
      { q: "Busiest day?", a: "Tuesday", s: "based on sessions" },
      { q: "Models used?", a: "3", s: "across all sessions" },
    ];
    const html = render(cards);
    expect(countArticles(html)).toBe(3);
  });

  it("rotates accents: green, blue, gold for 3 unpinned cards", () => {
    const cards: InsightCard[] = [
      { q: "Alpha", a: "1", s: "a" },
      { q: "Beta", a: "2", s: "b" },
      { q: "Gamma", a: "3", s: "c" },
    ];
    const html = render(cards);
    expect(html).toContain("accent-green");
    expect(html).toContain("accent-blue");
    expect(html).toContain("accent-gold");
    // verify order: green appears before blue, blue before gold
    const greenIdx = html.indexOf("accent-green");
    const blueIdx = html.indexOf("accent-blue");
    const goldIdx = html.indexOf("accent-gold");
    expect(greenIdx).toBeLessThan(blueIdx);
    expect(blueIdx).toBeLessThan(goldIdx);
  });

  it("pins accent-red regardless of index", () => {
    const cards: InsightCard[] = [
      { q: "First", a: "1", s: "first card - would normally be green" },
      { q: "Second", a: "2", s: "second card with pinned red", accent: "red" },
      { q: "Third", a: "3", s: "third card - would normally be gold" },
    ];
    const html = render(cards);
    // first card: accent-green (rotation, index 0)
    expect(html).toContain("accent-green");
    // second card: accent-red (pinned, index 1)
    expect(html).toContain("accent-red");
    // third card: accent-gold (rotation by raw index, rotation[2] = gold)
    expect(html).toContain("accent-gold");
    // the pinned card at index 1 consumed its rotation slot (blue), so blue
    // must be skipped entirely - proving rotation keys off the raw index.
    expect(html).not.toContain("accent-blue");
  });

  it("eyebrow renders the '$ ' prefix (aria-hidden) and question text", () => {
    const cards: InsightCard[] = [
      { q: "How deep do you go?", a: "73%", s: "supporting" },
    ];
    const html = render(cards);
    // the decorative shell prefix is wrapped aria-hidden so SR skips it
    expect(html).toContain('<span aria-hidden="true">$ </span>');
    // the question text is rendered outside the decorative span
    expect(html).toContain("How deep do you go?");
    expect(html).toContain("pv2-card-eyebrow");
  });

  it("renders viz node inside the strip", () => {
    const vizNode = <span data-testid="my-viz" className="pf-viz">bar</span>;
    const cards: InsightCard[] = [
      { q: "Depth?", a: "deep", s: "support", viz: vizNode },
    ];
    const html = render(cards);
    expect(html).toContain('data-testid="my-viz"');
    expect(html).toContain("pv2-card-strip");
    // strip should NOT have aria-hidden when viz is present
    expect(html).not.toContain('class="pv2-card-strip" aria-hidden');
  });

  it("marks strip aria-hidden when no viz is present", () => {
    const cards: InsightCard[] = [
      { q: "Quiet?", a: "yes", s: "no viz" },
    ];
    const html = render(cards);
    expect(html).toContain("aria-hidden");
  });
});
