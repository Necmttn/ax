import { describe, expect, it } from "bun:test";
import { hashArtifact } from "./hash.ts";
import type { TeamArtifact } from "./model.ts";

const read = (contents: Record<string, string>) => (abs: string) => contents[abs] ?? "";

describe("hashArtifact", () => {
  const a: TeamArtifact = { kind: "skill", name: "tdd", path: "/r/.ax/skills/tdd", files: ["SKILL.md", "ref.md"] };
  it("is stable for identical content", () => {
    const r = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "b" });
    expect(hashArtifact(a, r)).toBe(hashArtifact(a, r));
  });
  it("changes when any file content changes", () => {
    const r1 = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "b" });
    const r2 = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "B" });
    expect(hashArtifact(a, r1)).not.toBe(hashArtifact(a, r2));
  });
  it("is independent of file order in `files`", () => {
    const r = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "b" });
    const reordered: TeamArtifact = { ...a, files: ["ref.md", "SKILL.md"] };
    expect(hashArtifact(a, r)).toBe(hashArtifact(reordered, r));
  });
  it("agent: path is the file itself, files = [basename]", () => {
    const ag: TeamArtifact = { kind: "agent", name: "rev", path: "/r/.ax/agents/rev.md", files: ["rev.md"] };
    const r = read({ "/r/.ax/agents/rev.md": "agent body" });
    expect(typeof hashArtifact(ag, r)).toBe("string");
    expect(hashArtifact(ag, r).length).toBeGreaterThan(0);
  });
});
