import { describe, expect, it, afterEach } from "bun:test";
import { overlayPath, committedPath, startExperiment, promoteExperiment, dropExperiment, isSafeKindName } from "./experiment.ts";

describe("paths + guard", () => {
  it("maps kind/name to overlay + committed paths", () => {
    expect(overlayPath("/r", "skill", "x")).toBe("/r/.ax.local/skills/x");
    expect(committedPath("/r", "agent", "y")).toBe("/r/.ax/agents/y.md");
    expect(overlayPath("/r", "hook", "z")).toBe("/r/.ax.local/hooks/z.ts");
  });
  it("rejects unsafe kind/name", () => {
    expect(isSafeKindName("skill", "x")).toBe(true);
    expect(isSafeKindName("skill", "../e")).toBe(false);
    expect(isSafeKindName("skill", "a/b")).toBe(false);
    expect(isSafeKindName("bogus", "x")).toBe(false);
    expect(isSafeKindName("skill", "..")).toBe(false);
  });
});

describe("start / promote / drop", () => {
  const root = `/tmp/ax-exp-${process.pid}`;
  afterEach(() => Bun.spawnSync(["rm", "-rf", root]));
  it("start copies a committed skill into the overlay", async () => {
    await Bun.write(`${root}/.ax/skills/tdd/SKILL.md`, "committed");
    await startExperiment(root, "skill", "tdd");
    expect(await Bun.file(`${root}/.ax.local/skills/tdd/SKILL.md`).text()).toBe("committed");
  });
  it("start scaffolds a new overlay skill when none committed", async () => {
    await startExperiment(root, "skill", "fresh");
    expect(await Bun.file(`${root}/.ax.local/skills/fresh/SKILL.md`).exists()).toBe(true);
  });
  it("start scaffolds a new overlay agent + hook", async () => {
    await startExperiment(root, "agent", "rev");
    await startExperiment(root, "hook", "guard");
    expect(await Bun.file(`${root}/.ax.local/agents/rev.md`).exists()).toBe(true);
    expect(await Bun.file(`${root}/.ax.local/hooks/guard.ts`).exists()).toBe(true);
  });
  it("promote moves overlay → committed and removes the overlay copy", async () => {
    await Bun.write(`${root}/.ax.local/skills/exp/SKILL.md`, "variant");
    await promoteExperiment(root, "skill", "exp");
    expect(await Bun.file(`${root}/.ax/skills/exp/SKILL.md`).text()).toBe("variant");
    expect(await Bun.file(`${root}/.ax.local/skills/exp/SKILL.md`).exists()).toBe(false);
  });
  it("drop removes the overlay artifact", async () => {
    await Bun.write(`${root}/.ax.local/skills/exp/SKILL.md`, "v");
    await dropExperiment(root, "skill", "exp");
    expect(await Bun.file(`${root}/.ax.local/skills/exp/SKILL.md`).exists()).toBe(false);
  });
  it("throws on unsafe name (no write escapes the repo)", async () => {
    await expect(startExperiment(root, "skill", "../evil")).rejects.toThrow();
    await expect(promoteExperiment(root, "skill", "../evil")).rejects.toThrow();
    await expect(dropExperiment(root, "skill", "../evil")).rejects.toThrow();
  });
});
