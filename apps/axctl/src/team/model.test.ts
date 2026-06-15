import { describe, expect, it } from "bun:test";
import { artifactKey, type TeamArtifact } from "./model.ts";

describe("artifactKey", () => {
  it("is kind:name", () => {
    const a: TeamArtifact = { kind: "skill", name: "tdd", path: "/r/.ax/skills/tdd", files: ["SKILL.md"] };
    expect(artifactKey(a)).toBe("skill:tdd");
  });
  it("distinguishes kinds", () => {
    const a: TeamArtifact = { kind: "agent", name: "tdd", path: "/r/.ax/agents/tdd.md", files: ["tdd.md"] };
    expect(artifactKey(a)).toBe("agent:tdd");
  });
});
