import { describe, expect, it } from "bun:test";
import { DigestItem } from "./model.ts";
import { BASE_WEIGHT, salience, topForSnapshot, pickUnshown } from "./rank.ts";

const mk = (over: Partial<{ id: string; kind: DigestItem["kind"]; urgency: number; ageHours: number }>) => {
  const kind = over.kind ?? "cost";
  return {
    id: over.id ?? `${kind}:x`,
    kind,
    urgency: over.urgency ?? 1,
    ageHours: over.ageHours ?? 0,
    salience: over.urgency ?? 1,
    text: "t",
    action: "a",
    evidence: undefined as string | undefined,
  };
};

describe("salience", () => {
  it("multiplies base[kind] x urgency x recency, recency decays with age", () => {
    const fresh = salience(mk({ kind: "churn", urgency: 2, ageHours: 0 }));
    const old = salience(mk({ kind: "churn", urgency: 2, ageHours: 168 }));
    expect(fresh).toBeCloseTo(BASE_WEIGHT.churn * 2 * 1, 5);
    expect(old).toBeLessThan(fresh);
  });

  it("churn outranks quota at equal urgency + age", () => {
    expect(salience(mk({ kind: "churn" }))).toBeGreaterThan(salience(mk({ kind: "quota" })));
  });
});

describe("topForSnapshot", () => {
  it("sorts by salience desc and caps at 8", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      mk({ id: `cost:${i}`, urgency: i }),
    );
    const top = topForSnapshot(items, 8);
    expect(top).toHaveLength(8);
    expect(top[0].id).toBe("cost:11");
    expect(top.at(-1)!.id).toBe("cost:4");
  });
});

describe("pickUnshown", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const item = (id: string, sal: number): DigestItem =>
    DigestItem.make({ id, kind: "cost", salience: sal, text: "t", action: "a", computed_at: now });

  it("returns top-3 ranked when nothing is suppressed", () => {
    const snap = [item("a", 3), item("b", 2), item("c", 1), item("d", 0.5)];
    const picked = pickUnshown(snap, {}, now, 3);
    expect(picked.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("suppresses items shown within 6h", () => {
    const snap = [item("a", 3), item("b", 2)];
    const shown = { a: { last_shown_at: new Date("2026-06-15T09:00:00Z").toISOString(), shown_count: 1 } };
    expect(pickUnshown(snap, shown, now, 3).map((p) => p.id)).toEqual(["b"]);
  });

  it("suppresses items with shown_count >= 3", () => {
    const snap = [item("a", 3), item("b", 2)];
    const shown = { a: { last_shown_at: "2026-06-01T00:00:00Z", shown_count: 3 } };
    expect(pickUnshown(snap, shown, now, 3).map((p) => p.id)).toEqual(["b"]);
  });

  it("quiet day: all suppressed → empty array", () => {
    const snap = [item("a", 3)];
    const shown = { a: { last_shown_at: new Date("2026-06-15T11:00:00Z").toISOString(), shown_count: 1 } };
    expect(pickUnshown(snap, shown, now, 3)).toEqual([]);
  });
});
