import { describe, expect, it } from "bun:test";
import { classify } from "./trust.ts";
import type { TeamArtifact, TrustState } from "./model.ts";

const art = (name: string): TeamArtifact => ({ kind: "skill", name, path: `/r/.ax/skills/${name}`, files: ["SKILL.md"] });

describe("classify", () => {
  it("buckets added / changed / unchanged by hash", () => {
    const arts = [art("a"), art("b"), art("c")];
    const hashes: Record<string, string> = { "skill:a": "h1", "skill:b": "h2", "skill:c": "h3" };
    const trust: TrustState = {
      "skill:b": { hash: "h2", activated_at: "x" },
      "skill:c": { hash: "OLD", activated_at: "x" },
    };
    const c = classify(arts, (a) => hashes[`${a.kind}:${a.name}`]!, trust);
    expect(c.added.map((x) => x.name)).toEqual(["a"]);
    expect(c.changed.map((x) => x.name)).toEqual(["c"]);
    expect(c.unchanged.map((x) => x.name)).toEqual(["b"]);
  });
});
