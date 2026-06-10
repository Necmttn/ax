import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { GitEnv } from "../git-env.ts";
import { Verdict } from "../verdict.ts";

const GIT_CMD = /(^|[^a-zA-Z0-9_-])git\s/;
const MERGE_REBASE = /git\s+(?:\S.*\s)?(merge|rebase)(\s|$)/;
const RESET_HARD = /git\s+(?:\S.*\s)?reset\s+.*--hard/;
const CHECKOUT_SWITCH = /git\s+(?:\S.*\s)?(checkout|switch)\s/;
const CREATE_B = /checkout\s+-[bB]\s/;
const CREATE_C = /switch\s+-[cC]\s/;
const FILE_RESTORE = /checkout\s+--(\s|$)/;
const DOT_RESTORE = /checkout\s+\.(\s|$)/;
const GIT_DASH_C = /git\s+-C\s+("([^"]+)"|'([^']+)'|([^\s]+))/;
const SWITCH_TO_BRANCH = /(^|[^a-zA-Z0-9_-])git\s+(checkout|switch)\s+/;

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

Bypass: ALLOW_DIRTY_MAIN_MUTATION=1`;

const blockSwitchMsg = `BLOCKED: Do not switch branches on the primary working tree.

Use a worktree instead:
  git worktree add .claude/worktrees/<task-name> -b <branch-name>

Allowed here: git checkout -b / git switch -c (create), git checkout -- <file>
(restore). Bypass (rare): prefix with ALLOW_BRANCH_CHECKOUT=1`;

const hook = defineHook({
  name: "enforce-worktree",
  events: ["PreToolUse"],
  matcher: { tools: ["Bash"] },
  run: (event) =>
    Effect.gen(function* () {
      const git = yield* GitEnv;
      const command = String(event.tool?.input.command ?? "");
      if (command === "") return Verdict.allow;

      // ---- Guard B ----
      if (process.env.ALLOW_DIRTY_MAIN_MUTATION !== "1" && GIT_CMD.test(command)) {
        let guarded = MERGE_REBASE.test(command) || RESET_HARD.test(command);
        if (!guarded && CHECKOUT_SWITCH.test(command)) {
          guarded = !(CREATE_B.test(command) || CREATE_C.test(command) || FILE_RESTORE.test(command) || DOT_RESTORE.test(command));
        }
        if (guarded) {
          const m = command.match(GIT_DASH_C);
          const target = m ? (m[2] ?? m[3] ?? m[4] ?? event.cwd) : event.cwd;
          if ((yield* git.isPrimaryTree(target)) && (yield* git.isDirty(target))) {
            const branch = (yield* git.currentBranch(target)) ?? "(detached)";
            return Verdict.block(blockDirtyMsg(target, branch, command));
          }
        }
      }

      // ---- Guard A ----
      if (process.env.ALLOW_BRANCH_CHECKOUT === "1") return Verdict.allow;
      if (!SWITCH_TO_BRANCH.test(command)) return Verdict.allow;
      if (GIT_DASH_C.test(command)) return Verdict.allow;
      if (/git\s+checkout\s+-[bB]\s/.test(command)) return Verdict.allow;
      if (/git\s+switch\s+-[cC]\s/.test(command)) return Verdict.allow;
      if (/git\s+checkout\s+--\s/.test(command)) return Verdict.allow;
      if (/git\s+checkout\s+\.\s*$/.test(command)) return Verdict.allow;
      if (!(yield* git.isPrimaryTree(event.cwd))) return Verdict.allow;
      return Verdict.block(blockSwitchMsg);
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
