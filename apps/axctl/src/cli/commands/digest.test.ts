import { describe, expect, it } from "bun:test";
import { DigestSnapshot, DigestItem } from "../../digest/model.ts";
import { renderDigestCli } from "./digest.ts";

describe("renderDigestCli", () => {
  it("renders all stored items (not just top-3) with an empty-state line", () => {
    const empty = DigestSnapshot.make({ generated_at: new Date(0), window_days: 14, items: [] });
    expect(renderDigestCli(empty)).toContain("nothing to surface");
    const snap = DigestSnapshot.make({
      generated_at: new Date(0), window_days: 14,
      items: [DigestItem.make({ id: "cost:routing", kind: "cost", salience: 1, text: "routing save $42/wk", action: "ax dispatches --candidates", computed_at: new Date(0) })],
    });
    const out = renderDigestCli(snap);
    expect(out).toContain("routing save $42/wk");
    expect(out).toContain("ax dispatches --candidates");
  });
});
