import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import enforceWrite from "./enforce-worktree-write.ts";
import { GitEnvTest } from "../git-env.ts";

const layer = GitEnvTest({
  primary: ["/repo"],
  branches: { "/repo": "main", "/feat-repo": "feat/x" },
  roots: { "/repo": "/repo", "/feat-repo": "/feat-repo" },
});

const fire = (tool: string, input: Record<string, unknown>, cwd = "/repo") =>
  Effect.runPromise(
    enforceWrite
      .run({ harness: "codex", event: "PreToolUse", sessionId: null, cwd, tool: { name: tool, input }, raw: {} })
      .pipe(Effect.provide(layer)),
  );

describe("enforce-worktree-write", () => {
  test("Edit on main repo -> Block", async () => {
    expect((await fire("Edit", { file_path: "/repo/src/a.ts" }))._tag).toBe("Block");
  });
  test("Write on feature-branch repo -> Allow", async () => {
    expect((await fire("Write", { file_path: "/feat-repo/src/a.ts" }))._tag).toBe("Allow");
  });
  test("path under <root>/.claude/ -> Allow", async () => {
    expect((await fire("Write", { file_path: "/repo/.claude/worktrees/x/a.ts" }))._tag).toBe("Allow");
  });
  test("path under $HOME/.claude/ -> Allow", async () => {
    expect((await fire("Edit", { file_path: `${process.env.HOME}/.claude/settings.json` }))._tag).toBe("Allow");
  });
  test("path under $HOME/.ax/ -> Allow (hook workspace self-exemption)", async () => {
    expect((await fire("Edit", { file_path: `${process.env.HOME}/.ax/hooks/enforce-worktree.ts` }))._tag).toBe("Allow");
  });
  test("apply_patch with relative path resolved against cwd -> Block on main", async () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n+x\n*** End Patch";
    expect((await fire("apply_patch", { input: patch }))._tag).toBe("Block");
  });
  test("apply_patch on feature-branch cwd -> Allow", async () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n+x\n*** End Patch";
    expect((await fire("apply_patch", { input: patch }, "/feat-repo"))._tag).toBe("Allow");
  });
  test("apply_patch mixed paths: one in main repo -> Block (any-path-hits semantics)", async () => {
    const patch = "*** Begin Patch\n*** Update File: /feat-repo/ok.ts\n@@\n+x\n*** Update File: /repo/bad.ts\n@@\n+x\n*** End Patch";
    expect((await fire("apply_patch", { input: patch }, "/feat-repo"))._tag).toBe("Block");
  });
  test("non-repo path -> Allow", async () => {
    expect((await fire("Write", { file_path: "/tmp/scratch.txt" }))._tag).toBe("Allow");
  });
  test("missing file_path -> Allow", async () => {
    expect((await fire("Edit", {}))._tag).toBe("Allow");
  });
  test("bypass ALLOW_MAIN_WRITE=1 -> Allow", async () => {
    process.env.ALLOW_MAIN_WRITE = "1";
    try {
      expect((await fire("Edit", { file_path: "/repo/src/a.ts" }))._tag).toBe("Allow");
    } finally {
      delete process.env.ALLOW_MAIN_WRITE;
    }
  });
});
