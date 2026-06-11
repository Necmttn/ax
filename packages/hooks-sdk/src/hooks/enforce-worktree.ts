import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { GitEnv } from "../git-env.ts";
import { Verdict } from "../verdict.ts";
import { findGitInvocations, type GitInvocation } from "./git-command.ts";

/** checkout/switch forms that create a branch or restore files - always allowed. */
const isCreateOrRestore = (verb: string, args: ReadonlyArray<string>): boolean => {
  const a0 = args[0];
  if (verb === "checkout") {
    if (a0 === "-b" || a0 === "-B") return true; // create
    if (a0 === "--") return true; // file restore
    if (a0 === "." && args.length === 1) return true; // restore all
    return false;
  }
  if (verb === "switch") {
    return a0 === "-c" || a0 === "-C"; // create
  }
  return false;
};

/** Guard B verb set: ops that rewrite the target tree's state/history. */
const isGuardedMutation = (inv: GitInvocation): boolean => {
  if (inv.verb === "merge" || inv.verb === "rebase") return true;
  if (inv.verb === "reset" && inv.args.includes("--hard")) return true;
  if (
    (inv.verb === "checkout" || inv.verb === "switch") &&
    !isCreateOrRestore(inv.verb, inv.args)
  ) {
    return true;
  }
  return false;
};

const hasBypass = (name: string, inv: GitInvocation): boolean =>
  process.env[name] === "1" || inv.env?.[name] === "1";

const blockDirtyMsg = (target: string, branch: string, command: string) =>
  `BLOCKED: history-mutating git op against a DIRTY primary working tree.

  target tree : ${target}
  on branch   : ${branch}  (has uncommitted changes)
  command     : ${command}

That tree has uncommitted work - merging/rebasing/resetting into it can land
on the WRONG branch and tangle two people's work.

Do this instead:
  - Land your work via a PR merge, OR
  - Merge from a CLEAN checkout (fresh linked worktree).

Bypass: ALLOW_DIRTY_MAIN_MUTATION=1
(this guard is an ax SDK hook - author your own: ax hooks init)`;

const blockSwitchMsg = `BLOCKED: Do not switch branches on the primary working tree.

Use a worktree instead:
  git worktree add .claude/worktrees/<task-name> -b <branch-name>

Allowed here: git checkout -b / git switch -c (create), git checkout -- <file>
(restore). Bypass (rare): prefix with ALLOW_BRANCH_CHECKOUT=1
(this guard is an ax SDK hook - author your own: ax hooks init)`;

const hook = defineHook({
  name: "enforce-worktree",
  events: ["PreToolUse"],
  matcher: { tools: ["Bash"] },
  run: (event) =>
    Effect.gen(function* () {
      const git = yield* GitEnv;
      const command = String(event.tool?.input.command ?? "");
      if (command === "") return Verdict.allow;

      const invocations = findGitInvocations(command);
      if (invocations.length === 0) return Verdict.allow;

      // ---- Guard B: history mutation into a DIRTY primary tree ----
      for (const inv of invocations) {
        if (hasBypass("ALLOW_DIRTY_MAIN_MUTATION", inv)) continue;
        if (!isGuardedMutation(inv)) continue;
        // Target tree: explicit `git -C <path>` wins, else the event cwd.
        const target = inv.cPath ?? event.cwd;
        if (
          (yield* git.isPrimaryTree(target)) &&
          (yield* git.hasTrackedChanges(target))
        ) {
          const branch = (yield* git.currentBranch(target)) ?? "(detached)";
          return Verdict.block(blockDirtyMsg(target, branch, command));
        }
      }

      // ---- Guard A: branch switching on the primary tree (cwd-scoped) ----
      if (process.env.ALLOW_BRANCH_CHECKOUT === "1") return Verdict.allow;
      for (const inv of invocations) {
        if (hasBypass("ALLOW_BRANCH_CHECKOUT", inv)) continue;
        if (inv.verb !== "checkout" && inv.verb !== "switch") continue;
        // Explicit `git -C <path>` targets another tree - guard B territory.
        if (inv.cPath !== null) continue;
        if (isCreateOrRestore(inv.verb, inv.args)) continue;
        if (yield* git.isPrimaryTree(event.cwd)) {
          return Verdict.block(blockSwitchMsg);
        }
      }
      return Verdict.allow;
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
