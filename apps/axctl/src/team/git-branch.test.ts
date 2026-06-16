import { describe, expect, it } from "bun:test";
import { isDefaultBranchName, isOnDefaultBranch, currentBranch } from "./git-branch.ts";

describe("isDefaultBranchName", () => {
  it("matches current to the resolved default", () => {
    expect(isDefaultBranchName("main", "main")).toBe(true);
    expect(isDefaultBranchName("feature/x", "main")).toBe(false);
  });
  it("falls back to main/master when default is unknown", () => {
    expect(isDefaultBranchName("main", null)).toBe(true);
    expect(isDefaultBranchName("master", null)).toBe(true);
    expect(isDefaultBranchName("dev", null)).toBe(false);
  });
});

describe("isOnDefaultBranch (integration)", () => {
  it("isOnDefaultBranch: true on the default branch, false on a feature branch, false detached", () => {
    const root = `/tmp/ax-gitbranch-${process.pid}`;
    // -c identity so the commit works in CI (no global git user) + init.defaultBranch=main
    // so the branch is "main" regardless of the runner's git config / version.
    Bun.spawnSync(["bash", "-c", `rm -rf ${root} && mkdir -p ${root} && cd ${root} && git -c init.defaultBranch=main init -q && git -c user.email=ci@ax.test -c user.name=ci commit -q --allow-empty -m init`]);
    expect(currentBranch(root)).toBe("main");
    expect(isOnDefaultBranch(root)).toBe(true);   // no origin → main/master fallback
    Bun.spawnSync(["bash", "-c", `cd ${root} && git checkout -q -b feature/x`]);
    expect(isOnDefaultBranch(root)).toBe(false);
    Bun.spawnSync(["bash", "-c", `cd ${root} && git checkout -q --detach`]);
    expect(isOnDefaultBranch(root)).toBe(false);  // detached HEAD not trusted
    Bun.spawnSync(["rm", "-rf", root]);
  });
});
