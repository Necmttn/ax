import { describe, expect, it } from "bun:test";
import { BASE_WEIGHT, salience, topForSnapshot } from "./rank.ts";

const mk = (over: Partial<{ id: string; kind: "cost" | "churn" | "improve" | "quota"; urgency: number; ageHours: number }>) => {
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

