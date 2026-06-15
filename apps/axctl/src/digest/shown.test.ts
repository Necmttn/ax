import { describe, expect, it } from "bun:test";
import { recordShown, pruneResolved, type ShownState } from "./shown.ts";

describe("recordShown", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  it("inserts new ids with count 1", () => {
    const next = recordShown({}, ["a", "b"], now);
    expect(next.a.shown_count).toBe(1);
    expect(next.a.last_shown_at).toBe(now.toISOString());
    expect(next.b.shown_count).toBe(1);
  });
  it("increments existing ids and bumps last_shown_at", () => {
    const prev: ShownState = { a: { last_shown_at: "2026-06-01T00:00:00Z", shown_count: 1 } };
    const next = recordShown(prev, ["a"], now);
    expect(next.a.shown_count).toBe(2);
    expect(next.a.last_shown_at).toBe(now.toISOString());
  });
});

describe("pruneResolved", () => {
  it("drops shown ids not present in the live id set", () => {
    const prev: ShownState = {
      a: { last_shown_at: "x", shown_count: 1 },
      gone: { last_shown_at: "x", shown_count: 2 },
    };
    const next = pruneResolved(prev, new Set(["a"]));
    expect(Object.keys(next)).toEqual(["a"]);
  });
});
