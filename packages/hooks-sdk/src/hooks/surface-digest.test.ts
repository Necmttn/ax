import { describe, expect, it } from "bun:test";
import { Verdict } from "../verdict.ts";
import { decideDigestVerdict } from "./surface-digest.ts";

const item = (id: string, sal: number) => ({
  id,
  kind: "cost" as const,
  salience: sal,
  text: id,
  action: "a",
  computed_at: new Date(0).toISOString(),
});

describe("decideDigestVerdict", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("injects rendered top-3 when snapshot is fresh and items unshown", () => {
    const snap = { generated_at: now.toISOString(), window_days: 14, items: [item("a", 3)] };
    const v = decideDigestVerdict(snap, {}, now, 24);
    expect(v.verdict._tag).toBe("Inject");
    expect(v.verdict._tag === "Inject" && v.verdict.context).toContain("[ax]");
    expect(v.shownIds).toEqual(["a"]);
  });

  it("allows (silent) when snapshot is null", () => {
    expect(decideDigestVerdict(null, {}, now, 24).verdict).toEqual(Verdict.allow);
  });

  it("allows (silent) when snapshot is stale beyond max-age hours", () => {
    const stale = {
      generated_at: new Date("2026-06-13T00:00:00Z").toISOString(),
      window_days: 14,
      items: [item("a", 3)],
    };
    expect(decideDigestVerdict(stale, {}, now, 24).verdict).toEqual(Verdict.allow);
  });

  it("allows (silent) when all items suppressed", () => {
    const snap = { generated_at: now.toISOString(), window_days: 14, items: [item("a", 3)] };
    const shown = {
      a: { last_shown_at: new Date("2026-06-15T11:00:00Z").toISOString(), shown_count: 1 },
    };
    expect(decideDigestVerdict(snap, shown, now, 24).verdict).toEqual(Verdict.allow);
  });
});
