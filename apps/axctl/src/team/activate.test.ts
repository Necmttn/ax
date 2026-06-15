import { describe, expect, it, afterEach } from "bun:test";
import { runtimeTarget, activateArtifact, isSafeName } from "./activate.ts";
import type { TeamArtifact } from "./model.ts";

describe("runtimeTarget", () => {
  it("maps skill → ~/.claude/skills/<name>, agent → ~/.claude/agents/<name>.md", () => {
    expect(runtimeTarget({ kind: "skill", name: "tdd", path: "x", files: [] }, "/home/u"))
      .toBe("/home/u/.claude/skills/tdd");
    expect(runtimeTarget({ kind: "agent", name: "rev", path: "x", files: [] }, "/home/u"))
      .toBe("/home/u/.claude/agents/rev.md");
  });
});

describe("isSafeName", () => {
  it("rejects path-escaping names", () => {
    expect(isSafeName("tdd")).toBe(true);
    expect(isSafeName("../../evil")).toBe(false);
    expect(isSafeName("a/b")).toBe(false);
    expect(isSafeName("..")).toBe(false);
  });
});

describe("activateArtifact", () => {
  const home = `/tmp/ax-team-act-${process.pid}`;
  afterEach(() => Bun.spawnSync(["rm", "-rf", home]));
  it("copies a skill dir into the runtime", async () => {
    const src = `/tmp/ax-team-src-${process.pid}`;
    await Bun.write(`${src}/SKILL.md`, "hi");
    const a: TeamArtifact = { kind: "skill", name: "tdd", path: src, files: ["SKILL.md"] };
    await activateArtifact(a, home);
    expect(await Bun.file(`${home}/.claude/skills/tdd/SKILL.md`).text()).toBe("hi");
    Bun.spawnSync(["rm", "-rf", src]);
  });
  it("copies an agent file into the runtime", async () => {
    const src = `/tmp/ax-team-srcag-${process.pid}.md`;
    await Bun.write(src, "agent body");
    const a: TeamArtifact = { kind: "agent", name: "rev", path: src, files: ["rev.md"] };
    await activateArtifact(a, home);
    expect(await Bun.file(`${home}/.claude/agents/rev.md`).text()).toBe("agent body");
    Bun.spawnSync(["rm", "-f", src]);
  });
  it("throws on unsafe artifact name", async () => {
    const a: TeamArtifact = { kind: "skill", name: "../../evil", path: "/tmp/x", files: [] };
    expect(activateArtifact(a, home)).rejects.toThrow("unsafe artifact name");
  });
});
