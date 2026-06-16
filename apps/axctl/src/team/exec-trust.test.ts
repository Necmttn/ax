import { describe, expect, it } from "bun:test";
import { classifyExec, execKey, type ExecTrustState } from "./exec-trust.ts";
import type { GatedArtifact } from "./model.ts";

const hook = (name: string): GatedArtifact => ({ kind: "hook", name, path: `/r/.ax/hooks/${name}.ts` });

describe("classifyExec", () => {
  it("buckets new / changed / trusted by sha256", () => {
    const hooks = [hook("a"), hook("b"), hook("c")];
    const sha: Record<string, string> = { a: "h1", b: "h2", c: "h3" };
    const trust: ExecTrustState = {
      "hook:b": { sha256: "h2", content: "...", trusted_at: "x" },
      "hook:c": { sha256: "OLD", content: "old body", trusted_at: "x" },
    };
    const r = classifyExec(hooks, (h) => sha[h.name], trust);
    expect(r.added.map((x) => x.name)).toEqual(["a"]);
    expect(r.changed.map((x) => x.name)).toEqual(["c"]);
    expect(r.trusted.map((x) => x.name)).toEqual(["b"]);
  });
  it("execKey is hook:name", () => {
    expect(execKey(hook("x"))).toBe("hook:x");
  });
});
