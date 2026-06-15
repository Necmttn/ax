import { describe, expect, it } from "bun:test";
import { DigestItem } from "./model.ts";
import { assembleSnapshot } from "./snapshot.ts";

describe("assembleSnapshot", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const mk = (id: string, kind: DigestItem["kind"], sal: number): DigestItem =>
    DigestItem.make({ id, kind, salience: sal, text: id, action: "a", computed_at: now });

  it("merges all source items, ranks, caps at 8, stamps window + generated_at", () => {
    const items = Array.from({ length: 10 }, (_, i) => mk(`cost:${i}`, "cost", i));
    const snap = assembleSnapshot(items, { now, windowDays: 14 });
    expect(snap.items).toHaveLength(8);
    expect(snap.items[0].id).toBe("cost:9");
    expect(snap.window_days).toBe(14);
    expect(snap.generated_at).toEqual(now);
  });
});
