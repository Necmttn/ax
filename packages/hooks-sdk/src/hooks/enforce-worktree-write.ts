import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { GitEnv } from "../git-env.ts";
import { Verdict } from "../verdict.ts";
import { extractPatchPaths } from "./patch-paths.ts";

const blockMsg = (branch: string, file: string, root: string) =>
  `BLOCKED: Do not write code while the repo is on '${branch}'.

Create a worktree first, then make ALL edits inside it:

  git worktree add "${root}/.claude/worktrees/<task-name>" -b <branch-name>

The primary working tree stays on '${branch}'; feature work happens in
worktrees and lands via PR merge.

Target file that triggered this block:
  ${file}

Bypass for rare config/doc edits: ALLOW_MAIN_WRITE=1
(this guard is an ax SDK hook - author your own: ax hooks init)`;

/** Target paths for this tool call: file_path for Write/Edit/MultiEdit,
 *  patch-envelope paths for apply_patch (relative -> resolved against cwd). */
const targetPaths = (toolName: string, input: Record<string, unknown>, cwd: string): string[] => {
  if (toolName === "apply_patch") {
    const body = String(input.input ?? input.patch ?? input.command ?? "");
    return extractPatchPaths(body).map((p) => (p.startsWith("/") ? p : `${cwd}/${p}`));
  }
  const fp = input.file_path;
  return typeof fp === "string" && fp !== "" ? [fp] : [];
};

const hook = defineHook({
  name: "enforce-worktree-write",
  events: ["PreToolUse"],
  matcher: { tools: ["Write", "Edit", "MultiEdit", "apply_patch"] },
  run: (event) =>
    Effect.gen(function* () {
      if (process.env.ALLOW_MAIN_WRITE === "1") return Verdict.allow;
      const git = yield* GitEnv;
      const home = process.env.HOME ?? "";
      const paths = targetPaths(event.tool?.name ?? "", event.tool?.input ?? {}, event.cwd);
      for (const filePath of paths) {
        if (home && (filePath.startsWith(`${home}/.claude/`) || filePath.startsWith(`${home}/.ax/`))) continue;
        const dir = filePath.replace(/\/[^/]+$/, "") || "/";
        const root = yield* git.repoRoot(dir);
        if (root === null) continue;
        if (filePath.startsWith(`${root}/.claude/`)) continue;
        const branch = yield* git.currentBranch(root);
        if (branch === "main" || branch === "master") {
          return Verdict.block(blockMsg(branch, filePath, root));
        }
      }
      return Verdict.allow;
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
