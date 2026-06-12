import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitEnv, GitEnvLive } from "./git-env.ts";

const sh = (cwd: string, cmd: string[]) => Bun.spawnSync(cmd, { cwd });

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "gitenv-"));
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
};

describe("GitEnvLive", () => {
  test("primary tree detected; linked worktree is not primary", async () => {
    const repo = makeRepo();
    // Worktree OUTSIDE the repo so the primary tree stays clean - untracked
    // files count as dirty, matching enforce-worktree.sh's bare
    // `git status --porcelain` guard.
    const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "x");
    sh(repo, ["git", "worktree", "add", "-q", wt, "-b", "feat-x"]);
    const program = Effect.gen(function* () {
      const git = yield* GitEnv;
      return {
        primary: yield* git.isPrimaryTree(repo),
        linked: yield* git.isPrimaryTree(wt),
        branch: yield* git.currentBranch(repo),
        def: yield* git.defaultBranch(repo),
        root: yield* git.repoRoot(repo),
        dirty: yield* git.isDirty(repo),
        trackedDirty: yield* git.hasTrackedChanges(repo),
      };
    });
    const r = Effect.runSync(program.pipe(Effect.provide(GitEnvLive)));
    expect(r.primary).toBe(true);
    expect(r.linked).toBe(false);
    expect(r.branch).toBe("main");
    expect(r.def).toBe("main"); // no origin/HEAD -> refs/heads/main fallback
    expect(r.root).toBe(realpathSync(repo));
    expect(r.dirty).toBe(false);
    expect(r.trackedDirty).toBe(false);

    // Untracked files COUNT as dirty (bash guard parity).
    await Bun.write(join(repo, "untracked.txt"), "x");
    const dirtyAfter = Effect.runSync(
      Effect.gen(function* () {
        const git = yield* GitEnv;
        return {
          dirty: yield* git.isDirty(repo),
          trackedDirty: yield* git.hasTrackedChanges(repo),
        };
      }).pipe(Effect.provide(GitEnvLive)),
    );
    expect(dirtyAfter.dirty).toBe(true);
    expect(dirtyAfter.trackedDirty).toBe(false);
  });
  test("non-repo dir → safe defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "norepo-"));
    const program = Effect.gen(function* () {
      const git = yield* GitEnv;
      return { primary: yield* git.isPrimaryTree(dir), root: yield* git.repoRoot(dir) };
    });
    const r = Effect.runSync(program.pipe(Effect.provide(GitEnvLive)));
    expect(r.primary).toBe(false);
    expect(r.root).toBeNull();
  });
});
