import { describe, expect, it } from "bun:test";
import { DigestItem } from "./model.ts";
import { renderDigest } from "./render.ts";

const item = (text: string, action: string): DigestItem =>
  DigestItem.make({ id: text, kind: "cost", salience: 1, text, action, computed_at: new Date(0) });

describe("renderDigest", () => {
  it("returns empty string for no items (no bare header)", () => {
    expect(renderDigest([])).toBe("");
  });
  it("renders a header, one bullet per item with action arrow, and a footer", () => {
    const out = renderDigest([item("routing could save ~$42/wk", "ax dispatches --candidates")]);
    expect(out).toContain("[ax] since last session:");
    expect(out).toContain("• routing could save ~$42/wk → ax dispatches --candidates");
    expect(out).toContain("run `ax` for the full board.");
  });
});
