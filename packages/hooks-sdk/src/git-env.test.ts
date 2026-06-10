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
  test("primary tree detected; linked worktree is not primary", () => {
    const repo = makeRepo();
    const wt = join(repo, ".claude", "worktrees", "x");
    sh(repo, ["git", "worktree", "add", "-q", wt, "-b", "feat-x"]);
    const program = Effect.gen(function* () {
      const git = yield* GitEnv;
      return {
        primary: yield* git.isPrimaryTree(repo),
        linked: yield* git.isPrimaryTree(wt),
        branch: yield* git.currentBranch(repo),
        root: yield* git.repoRoot(repo),
        dirty: yield* git.isDirty(repo),
      };
    });
    const r = Effect.runSync(program.pipe(Effect.provide(GitEnvLive)));
    expect(r.primary).toBe(true);
    expect(r.linked).toBe(false);
    expect(r.branch).toBe("main");
    expect(r.root).toBe(realpathSync(repo));
    expect(r.dirty).toBe(false);
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
