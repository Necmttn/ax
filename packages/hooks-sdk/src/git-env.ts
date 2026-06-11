import { Context, Effect, Layer } from "effect";
import { realpathSync } from "node:fs";

export interface GitEnvService {
  /** is `dir` inside the PRIMARY working tree (not a linked worktree)? */
  readonly isPrimaryTree: (dir: string) => Effect.Effect<boolean>;
  /** uncommitted changes present? (status --porcelain non-empty) */
  readonly isDirty: (dir: string) => Effect.Effect<boolean>;
  /** current branch short name, null when detached/not a repo. */
  readonly currentBranch: (dir: string) => Effect.Effect<string | null>;
  /** repo toplevel for dir (walking up past not-yet-existing paths), null outside repos. */
  readonly repoRoot: (dir: string) => Effect.Effect<string | null>;
}

export class GitEnv extends Context.Service<GitEnv, GitEnvService>()(
  "@ax/hooks-sdk/GitEnv",
) {}

const gitCmd = (dir: string, args: string[]): string | null => {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) return null;
    return p.stdout.toString().trim();
  } catch {
    return null;
  }
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const liveShape: GitEnvService = {
  isPrimaryTree: (dir) =>
    Effect.sync(() => {
      const gd = gitCmd(dir, ["rev-parse", "--absolute-git-dir"]);
      const common = gitCmd(dir, ["rev-parse", "--git-common-dir"]);
      if (gd === null || common === null) return false;
      // --git-common-dir may return a relative path; resolve it against dir
      const absCommon = common.startsWith("/") ? common : `${dir}/${common}`;
      return real(gd) === real(absCommon);
    }),

  isDirty: (dir) =>
    Effect.sync(() => (gitCmd(dir, ["status", "--porcelain"]) ?? "") !== ""),

  currentBranch: (dir) =>
    Effect.sync(() => gitCmd(dir, ["symbolic-ref", "--short", "HEAD"])),

  repoRoot: (dir) =>
    Effect.sync(() => {
      // Walk up past path segments that don't exist yet (new files staged in
      // a new directory). git rev-parse --show-toplevel needs an existing cwd.
      let d = dir;
      for (;;) {
        const root = gitCmd(d, ["rev-parse", "--show-toplevel"]);
        if (root !== null) return real(root);
        const parent = d.replace(/\/[^/]+$/, "") || "/";
        if (parent === d || parent === "/") return null;
        d = parent;
      }
    }),
};

export const GitEnvLive: Layer.Layer<GitEnv> = Layer.succeed(GitEnv)(liveShape);

/** Test layer: canned answers per absolute path prefix. */
export const GitEnvTest = (answers: {
  primary?: ReadonlyArray<string>;
  dirty?: ReadonlyArray<string>;
  branches?: Record<string, string>;
  roots?: Record<string, string>;
}): Layer.Layer<GitEnv> =>
  Layer.succeed(GitEnv)({
    isPrimaryTree: (dir) =>
      Effect.succeed((answers.primary ?? []).some((p) => dir.startsWith(p))),
    isDirty: (dir) =>
      Effect.succeed((answers.dirty ?? []).some((p) => dir.startsWith(p))),
    currentBranch: (dir) =>
      Effect.succeed(
        Object.entries(answers.branches ?? {}).find(([p]) =>
          dir.startsWith(p),
        )?.[1] ?? null,
      ),
    repoRoot: (dir) =>
      Effect.succeed(
        Object.entries(answers.roots ?? {}).find(([p]) =>
          dir.startsWith(p),
        )?.[1] ?? null,
      ),
  });
