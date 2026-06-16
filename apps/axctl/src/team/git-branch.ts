/** Pure: is `current` the trusted default? If `defaultBranch` is known, exact
 *  match; else fall back to the conventional main/master. */
export const isDefaultBranchName = (current: string, defaultBranch: string | null): boolean =>
  defaultBranch ? current === defaultBranch : current === "main" || current === "master";

const git = (args: string[], cwd: string): string | null => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
};

export const currentBranch = (cwd: string): string | null => git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);

/** origin's default branch (e.g. "main" from refs/remotes/origin/HEAD); null if undetermined. */
export const defaultBranch = (cwd: string): string | null => {
  const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd); // "refs/remotes/origin/main"
  return ref ? ref.split("/").pop() ?? null : null;
};

/** True when the repo at cwd is on its trusted default branch. Detached HEAD is NOT trusted. */
export const isOnDefaultBranch = (cwd: string): boolean => {
  const cur = currentBranch(cwd);
  if (!cur || cur === "HEAD") return false;
  return isDefaultBranchName(cur, defaultBranch(cwd));
};
