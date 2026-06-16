import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { scanWithOverlay } from "./overlay.ts";

let root: string;
beforeAll(async () => {
  root = `/tmp/ax-overlay-${process.pid}`;
  await Bun.write(`${root}/.ax/skills/shared/SKILL.md`, "committed shared");
  await Bun.write(`${root}/.ax/skills/tdd/SKILL.md`, "committed tdd");
  await Bun.write(`${root}/.ax/hooks/guard.ts`, "committed hook");
  await Bun.write(`${root}/.ax.local/skills/tdd/SKILL.md`, "OVERLAY tdd");
  await Bun.write(`${root}/.ax.local/skills/exp/SKILL.md`, "overlay-only");
  await Bun.write(`${root}/.ax.local/hooks/guard.ts`, "OVERLAY hook");
});
afterAll(() => Bun.spawnSync(["rm", "-rf", root]));

describe("scanWithOverlay", () => {
  it("overlay wins on collision; overlay-only appear; committed-only survive; each flagged", async () => {
    const { artifacts, gated } = await scanWithOverlay(root);
    const tdd = artifacts.find((a) => a.kind === "skill" && a.name === "tdd");
    expect(tdd?.path).toContain(".ax.local/skills/tdd");
    expect(tdd?.overlay).toBe(true);
    const shared = artifacts.find((a) => a.kind === "skill" && a.name === "shared");
    expect(shared?.path).toContain("/.ax/skills/shared");
    expect(shared?.overlay).toBe(false);
    expect(artifacts.find((a) => a.name === "exp")?.overlay).toBe(true);
    const guard = gated.find((g) => g.name === "guard");
    expect(guard?.path).toContain(".ax.local/hooks/guard");
    expect(guard?.overlay).toBe(true);
  });
  it("empty repo (no .ax or .ax.local) → empty", async () => {
    const r = await scanWithOverlay(`/tmp/ax-overlay-none-${process.pid}`);
    expect(r.artifacts).toEqual([]);
    expect(r.gated).toEqual([]);
  });
});
