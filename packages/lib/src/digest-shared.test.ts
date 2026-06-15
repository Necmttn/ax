import { describe, expect, it } from "bun:test";
import {
  type DigestItemJson,
  type DigestSnapshotJson,
  type ShownState,
  isSnapshotFresh,
  mergeShownState,
  pickUnshownJson,
  renderDigestJson,
} from "./digest-shared.ts";

const item = (id: string, sal: number): DigestItemJson => ({
  id,
  kind: "cost",
  salience: sal,
  text: `text-${id}`,
  action: `action-${id}`,
  computed_at: new Date(0).toISOString(),
});

const now = new Date("2026-06-15T12:00:00Z");

describe("pickUnshownJson", () => {
  it("returns top-3 items sorted by salience descending", () => {
    const items = [item("a", 1), item("b", 3), item("c", 2), item("d", 4)];
    const result = pickUnshownJson(items, {}, now);
    expect(result.map((i) => i.id)).toEqual(["d", "b", "c"]);
  });

  it("suppresses items shown within the 6-hour window", () => {
    const items = [item("a", 5), item("b", 3)];
    const shown: ShownState = {
      a: { last_shown_at: new Date("2026-06-15T09:00:00Z").toISOString(), shown_count: 1 },
    };
    const result = pickUnshownJson(items, shown, now);
    expect(result.map((i) => i.id)).toEqual(["b"]);
  });

  it("suppresses items with shown_count >= 3 regardless of time", () => {
    const items = [item("a", 5), item("b", 3)];
    const shown: ShownState = {
      // shown 10 days ago but count is maxed
      a: { last_shown_at: new Date("2026-06-05T00:00:00Z").toISOString(), shown_count: 3 },
    };
    const result = pickUnshownJson(items, shown, now);
    expect(result.map((i) => i.id)).toEqual(["b"]);
  });

  it("returns empty array when all items are suppressed (quiet day)", () => {
    const items = [item("a", 5)];
    const shown: ShownState = {
      a: { last_shown_at: new Date("2026-06-15T11:00:00Z").toISOString(), shown_count: 1 },
    };
    const result = pickUnshownJson(items, shown, now);
    expect(result).toEqual([]);
  });

  it("shows item whose suppress window has expired", () => {
    const items = [item("a", 5)];
    const shown: ShownState = {
      // 8 hours ago - beyond the 6h window
      a: { last_shown_at: new Date("2026-06-15T04:00:00Z").toISOString(), shown_count: 1 },
    };
    const result = pickUnshownJson(items, shown, now);
    expect(result.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("renderDigestJson", () => {
  it("returns empty string for no items (no bare header)", () => {
    expect(renderDigestJson([])).toBe("");
  });

  it("renders header, bullets with action arrow, and footer", () => {
    const items = [item("x", 1)];
    const out = renderDigestJson(items);
    expect(out).toContain("[ax] since last session:");
    expect(out).toContain("• text-x → action-x");
    expect(out).toContain("run `ax` for the full board.");
  });

  it("renders multiple bullets in order", () => {
    const items = [item("p", 2), item("q", 1)];
    const out = renderDigestJson(items);
    const lines = out.split("\n");
    expect(lines[0]).toBe("[ax] since last session:");
    expect(lines[1]).toContain("text-p");
    expect(lines[2]).toContain("text-q");
    expect(lines[lines.length - 1]).toBe("run `ax` for the full board.");
  });
});

describe("isSnapshotFresh", () => {
  const makeSnap = (generated_at: string): DigestSnapshotJson => ({
    generated_at,
    window_days: 14,
    items: [],
  });

  it("returns true when snapshot is within max-age hours", () => {
    const recent = new Date(now.getTime() - 1 * 3600_000).toISOString(); // 1h ago
    expect(isSnapshotFresh(makeSnap(recent), now, 24)).toBe(true);
  });

  it("returns false when snapshot is stale beyond max-age hours", () => {
    const old = new Date(now.getTime() - 25 * 3600_000).toISOString(); // 25h ago
    expect(isSnapshotFresh(makeSnap(old), now, 24)).toBe(false);
  });

  it("returns false when generated_at is a malformed date string", () => {
    expect(isSnapshotFresh(makeSnap("not-a-date"), now, 24)).toBe(false);
  });
});

describe("mergeShownState", () => {
  const ts1 = "2026-06-01T00:00:00Z";
  const ts2 = "2026-06-10T00:00:00Z";
  const writeNow = new Date("2026-06-15T12:00:00Z");

  it("drops a prev id NOT in liveIds (resolved)", () => {
    const prev: ShownState = { "churn:GONE": { last_shown_at: ts1, shown_count: 2 } };
    const result = mergeShownState(prev, [], new Set(), writeNow);
    expect(result["churn:GONE"]).toBeUndefined();
  });

  it("carries a prev id that IS in liveIds but wasn't shown this fire (unchanged)", () => {
    const prev: ShownState = { "cost:routing": { last_shown_at: ts2, shown_count: 1 } };
    const result = mergeShownState(prev, [], new Set(["cost:routing"]), writeNow);
    expect(result["cost:routing"]).toEqual({ last_shown_at: ts2, shown_count: 1 });
  });

  it("increments a shown id's count and bumps last_shown_at", () => {
    const prev: ShownState = { "improve:foo": { last_shown_at: ts1, shown_count: 1 } };
    const result = mergeShownState(prev, ["improve:foo"], new Set(["improve:foo"]), writeNow);
    expect(result["improve:foo"]).toEqual({
      last_shown_at: writeNow.toISOString(),
      shown_count: 2,
    });
  });

  it("inserts a new shown id at count 1", () => {
    const result = mergeShownState({}, ["cost:new"], new Set(["cost:new"]), writeNow);
    expect(result["cost:new"]).toEqual({
      last_shown_at: writeNow.toISOString(),
      shown_count: 1,
    });
  });
});
