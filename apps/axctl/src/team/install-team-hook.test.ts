import { describe, expect, it, afterEach } from "bun:test";
import { hookSnapshotPath, snapshotHook, isSafeHookName } from "./install-team-hook.ts";

describe("hookSnapshotPath / isSafeHookName", () => {
  it("maps to ~/.ax/hooks/<name>.ts", () => {
    expect(hookSnapshotPath("enforce-x", "/home/u")).toBe("/home/u/.ax/hooks/enforce-x.ts");
  });
  it("rejects path-escaping hook names", () => {
    expect(isSafeHookName("enforce-x")).toBe(true);
    expect(isSafeHookName("../evil")).toBe(false);
    expect(isSafeHookName("a/b")).toBe(false);
    expect(isSafeHookName("..")).toBe(false);
  });
});
describe("snapshotHook", () => {
  const home = `/tmp/ax-mesha-${process.pid}`;
  afterEach(() => Bun.spawnSync(["rm", "-rf", home]));
  it("writes the trusted content to the snapshot path", async () => {
    const p = await snapshotHook("enforce-x", "export default {}\n", home);
    expect(p).toBe(`${home}/.ax/hooks/enforce-x.ts`);
    expect(await Bun.file(p).text()).toBe("export default {}\n");
  });
  it("throws on an unsafe name (no write escapes ~/.ax/)", async () => {
    await expect(snapshotHook("../evil", "x", home)).rejects.toThrow();
  });
});
