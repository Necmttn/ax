import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { scanAxFolder } from "./scan.ts";

let root: string;
beforeAll(async () => {
  root = `/tmp/ax-team-scan-${process.pid}`;
  await Bun.write(`${root}/.ax/skills/tdd/SKILL.md`, "tdd skill");
  await Bun.write(`${root}/.ax/skills/tdd/ref.md`, "ref");
  await Bun.write(`${root}/.ax/agents/reviewer.md`, "agent");
  await Bun.write(`${root}/.ax/hooks/guard.ts`, "export default {}");
});
afterAll(() => { Bun.spawnSync(["rm", "-rf", root]); });

describe("scanAxFolder", () => {
  it("finds skills (with bundled files), agents, and gates hooks", async () => {
    const { artifacts, gated } = await scanAxFolder(root);
    const skill = artifacts.find((a) => a.kind === "skill" && a.name === "tdd");
    expect([...(skill?.files ?? [])].sort()).toEqual(["SKILL.md", "ref.md"]);
    expect(artifacts.find((a) => a.kind === "agent" && a.name === "reviewer")).toBeTruthy();
    expect(gated.map((g) => g.name)).toEqual(["guard"]);
  });
  it("returns empty for a repo with no .ax/", async () => {
    const { artifacts, gated } = await scanAxFolder(`/tmp/ax-team-none-${process.pid}-nonexistent`);
    expect(artifacts).toEqual([]);
    expect(gated).toEqual([]);
  });
});
