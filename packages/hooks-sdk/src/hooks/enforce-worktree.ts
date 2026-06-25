import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { readEnv, type HookEvent } from "../event.ts";
import { GitEnv } from "../git-env.ts";
import { Verdict } from "../verdict.ts";
import { findGitInvocations, type GitInvocation } from "./git-command.ts";

/** checkout forms that only restore files - always allowed. */
const isRestore = (verb: string, args: ReadonlyArray<string>): boolean => {
  if (verb !== "checkout") return false;
  const a0 = args[0];
  if (a0 === "--") return true; // file restore
  if (a0 === "." && args.length === 1) return true; // restore all
  return false;
};

/** checkout/switch forms that create a branch. */
const isCreate = (verb: string, args: ReadonlyArray<string>): boolean => {
  const a0 = args[0];
  if (verb === "checkout") return a0 === "-b" || a0 === "-B";
  if (verb === "switch") return a0 === "-c" || a0 === "-C";
  return false;
};

/** the branch/ref a plain checkout/switch targets (first non-flag arg). */
const switchTarget = (args: ReadonlyArray<string>): string | null =>
  args.find((a) => !a.startsWith("-")) ?? null;

/** Guard B verb set: ops that rewrite the target tree's state/history. */
const isGuardedMutation = (inv: GitInvocation): boolean => {
  if (inv.verb === "merge" || inv.verb === "rebase") return true;
  if (inv.verb === "reset" && inv.args.includes("--hard")) return true;
  if (
    (inv.verb === "checkout" || inv.verb === "switch") &&
    !isCreate(inv.verb, inv.args) &&
    !isRestore(inv.verb, inv.args)
  ) {
    return true;
  }
  return false;
};

const hasBypass = (name: string, inv: GitInvocation, event: HookEvent): boolean =>
  readEnv(event, name) === "1" || inv.env?.[name] === "1";

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

const blockSwitchMsg = (def: string) =>
  `BLOCKED: the primary working tree stays on '${def}'.

Feature work happens in a linked worktree:
  git worktree add .claude/worktrees/<task-name> -b <branch-name>

Allowed here: git checkout ${def} (return to ${def}), git checkout -- <file>
(file restore). Bypass (rare): prefix with ALLOW_BRANCH_CHECKOUT=1
(this guard is an ax SDK hook - author your own: ax hooks init)`;

const blockWorktreeDefaultMsg = (def: string) =>
  `BLOCKED: do not check out '${def}' in a linked worktree.

A branch can live in only one worktree at a time - holding '${def}' here
locks the primary working tree off '${def}'.

Do this instead:
  git checkout --detach origin/${def}   # inspect ${def} without holding it

Bypass (rare): prefix with ALLOW_BRANCH_CHECKOUT=1
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
        if (hasBypass("ALLOW_DIRTY_MAIN_MUTATION", inv, event)) continue;
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

      // ---- Guard A: the primary tree stays parked on the default branch ----
      // Block branch create AND switch on the primary tree (only returning to
      // the default branch is allowed); block linked worktrees from TAKING
      // the default branch - a branch lives in one worktree at a time, so a
      // worktree holding it locks the primary tree off it.
      if (readEnv(event, "ALLOW_BRANCH_CHECKOUT") === "1") return Verdict.allow;
      for (const inv of invocations) {
        if (hasBypass("ALLOW_BRANCH_CHECKOUT", inv, event)) continue;
        if (inv.verb !== "checkout" && inv.verb !== "switch") continue;
        if (isRestore(inv.verb, inv.args)) continue;
        // Target tree: explicit `git -C <path>` wins, else the event cwd.
        const target = inv.cPath ?? event.cwd;
        if (yield* git.isPrimaryTree(target)) {
          const def = yield* git.defaultBranch(target);
          if (
            !isCreate(inv.verb, inv.args) &&
            switchTarget(inv.args) === def
          ) {
            continue; // returning the primary tree home
          }
          return Verdict.block(blockSwitchMsg(def));
        }
        if (isCreate(inv.verb, inv.args)) continue;
        if ((yield* git.repoRoot(target)) === null) continue; // not a repo
        const def = yield* git.defaultBranch(target);
        if (switchTarget(inv.args) === def) {
          return Verdict.block(blockWorktreeDefaultMsg(def));
        }
      }
      return Verdict.allow;
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
