import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import enforceWorktree from "./enforce-worktree.ts";
import { GitEnvTest } from "../git-env.ts";

const run = (
  command: string,
  opts?: { dirty?: boolean; trackedDirty?: boolean; primary?: boolean; cwd?: string },
) => {
  const cwd = opts?.cwd ?? "/repo";
  const layer = GitEnvTest({
    primary: (opts?.primary ?? true) ? ["/repo"] : [],
    dirty: opts?.dirty ? ["/repo"] : [],
    trackedDirty: opts?.trackedDirty ? ["/repo"] : [],
    branches: { "/repo": "main" },
    roots: { "/repo": "/repo" },
    defaults: { "/repo": "main" },
  });
  return Effect.runPromise(
    enforceWorktree
      .run({
        harness: "claude", event: "PreToolUse", sessionId: null, cwd,
        tool: { name: "Bash", input: { command } },
        raw: {},
      })
      .pipe(Effect.provide(layer)),
  );
};

const withEnv = async (k: string, fn: () => Promise<unknown>) => {
  process.env[k] = "1";
  try { return await fn(); } finally { delete process.env[k]; }
};

describe("guard A: primary tree stays on the default branch", () => {
  test("git checkout main -> Allow (returning home)", async () => {
    expect((await run("git checkout main"))._tag).toBe("Allow");
  });
  test("git switch main -> Allow (returning home)", async () => {
    expect((await run("git switch main"))._tag).toBe("Allow");
  });
  test("git checkout feat -> Block", async () => {
    expect((await run("git checkout feat"))._tag).toBe("Block");
  });
  test("git switch other -> Block", async () => {
    expect((await run("git switch other"))._tag).toBe("Block");
  });
  test("git checkout -b new -> Block (create drifts primary off main)", async () => {
    expect((await run("git checkout -b new"))._tag).toBe("Block");
  });
  test("git switch -c new -> Block", async () => {
    expect((await run("git switch -c new"))._tag).toBe("Block");
  });
  test("git checkout -B hotfix -> Block (uppercase create)", async () => {
    expect((await run("git checkout -B hotfix"))._tag).toBe("Block");
  });
  test("git checkout -- file -> Allow", async () => {
    expect((await run("git checkout -- src/a.ts"))._tag).toBe("Allow");
  });
  test("git checkout . -> Allow", async () => {
    expect((await run("git checkout ."))._tag).toBe("Allow");
  });
  test("git -C /repo checkout feat from elsewhere -> Block (the -C hole)", async () => {
    expect((await run("git -C /repo checkout feat", { cwd: "/elsewhere" }))._tag).toBe("Block");
  });
  test("bypass ALLOW_BRANCH_CHECKOUT=1 -> Allow", async () => {
    const r = await withEnv("ALLOW_BRANCH_CHECKOUT", () => run("git checkout feat"));
    expect((r as { _tag: string })._tag).toBe("Allow");
  });
  test("inline bypass ALLOW_BRANCH_CHECKOUT=1 -> Allow", async () => {
    expect((await run("ALLOW_BRANCH_CHECKOUT=1 git checkout feat"))._tag).toBe("Allow");
  });
  test("ALLOW_DIRTY_MAIN_MUTATION=1 does NOT bypass guard A", async () => {
    const r = await withEnv("ALLOW_DIRTY_MAIN_MUTATION", () => run("git checkout feat"));
    expect((r as { _tag: string })._tag).toBe("Block");
  });
});

describe("guard A: linked worktree must not take the default branch", () => {
  test("git checkout main in worktree -> Block (locks primary off main)", async () => {
    expect((await run("git checkout main", { primary: false }))._tag).toBe("Block");
  });
  test("git switch main in worktree -> Block", async () => {
    expect((await run("git switch main", { primary: false }))._tag).toBe("Block");
  });
  test("git checkout feat in worktree -> Allow", async () => {
    expect((await run("git checkout feat", { primary: false }))._tag).toBe("Allow");
  });
  test("git checkout -b new in worktree -> Allow", async () => {
    expect((await run("git checkout -b new", { primary: false }))._tag).toBe("Allow");
  });
  test("git checkout --detach in worktree -> Allow (inspect without holding)", async () => {
    expect((await run("git checkout --detach abc123", { primary: false }))._tag).toBe("Allow");
  });
  test("non-repo dir -> Allow (no repo, nothing to guard)", async () => {
    expect((await run("git checkout main", { primary: false, cwd: "/elsewhere" }))._tag).toBe("Allow");
  });
  test("inline bypass ALLOW_BRANCH_CHECKOUT=1 in worktree -> Allow", async () => {
    expect((await run("ALLOW_BRANCH_CHECKOUT=1 git checkout main", { primary: false }))._tag).toBe("Allow");
  });
});

describe("guard B: history mutation into dirty primary tree", () => {
  test("git merge x, dirty primary -> Block", async () => {
    expect((await run("git merge x", { trackedDirty: true }))._tag).toBe("Block");
  });
  test("git -C /repo merge x, dirty -> Block (the -C hole)", async () => {
    expect((await run("git -C /repo merge --ff-only feat", { trackedDirty: true }))._tag).toBe("Block");
  });
  test("git reset --hard, dirty -> Block; plain reset -> Allow", async () => {
    expect((await run("git reset --hard HEAD~1", { trackedDirty: true }))._tag).toBe("Block");
    expect((await run("git reset HEAD~1", { trackedDirty: true }))._tag).toBe("Allow");
  });
  test("git merge x, CLEAN primary -> Allow (PR land flow untouched)", async () => {
    expect((await run("git merge x", { dirty: false }))._tag).toBe("Allow");
  });
  test("non-git command -> Allow", async () => {
    expect((await run("echo git merge"))._tag).toBe("Allow");
  });
  test("echo git merge, dirty primary -> Allow (substring false-positive regression)", async () => {
    expect((await run("echo git merge", { trackedDirty: true }))._tag).toBe("Allow");
  });
  test('echo "git merge x", dirty primary -> Allow', async () => {
    expect((await run('echo "git merge x"', { trackedDirty: true }))._tag).toBe("Allow");
  });
  test("cd /x && git merge y, dirty -> Block", async () => {
    expect((await run("cd /x && git merge y", { trackedDirty: true }))._tag).toBe("Block");
  });
  test("FOO=1 git merge x, dirty -> Block", async () => {
    expect((await run("FOO=1 git merge x", { trackedDirty: true }))._tag).toBe("Block");
  });
  test("git -c user.name=x merge y, dirty -> Block", async () => {
    expect((await run("git -c user.name=x merge y", { trackedDirty: true }))._tag).toBe("Block");
  });
  test("something | git rebase main, dirty -> Block", async () => {
    expect((await run("something | git rebase main", { trackedDirty: true }))._tag).toBe("Block");
  });
  test("bypass ALLOW_DIRTY_MAIN_MUTATION=1 -> Allow", async () => {
    const r = await withEnv("ALLOW_DIRTY_MAIN_MUTATION", () => run("git merge x", { trackedDirty: true }));
    expect((r as { _tag: string })._tag).toBe("Allow");
  });
  test("inline bypass ALLOW_DIRTY_MAIN_MUTATION=1 -> Allow", async () => {
    expect((await run("ALLOW_DIRTY_MAIN_MUTATION=1 git merge x", { trackedDirty: true }))._tag).toBe("Allow");
  });
  test("untracked-only tree is not dirty for history mutation guard", async () => {
    expect((await run("git merge x", { dirty: true, trackedDirty: false }))._tag).toBe("Allow");
  });
});
