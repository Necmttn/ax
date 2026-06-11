import { describe, expect, test } from "bun:test";
import { findGitInvocations } from "./git-command.ts";

describe("findGitInvocations", () => {
  test("simple git command", () => {
    expect(findGitInvocations("git merge x")).toEqual([
      { verb: "merge", cPath: null, args: ["x"] },
    ]);
  });

  test("no git invocation: git is an argument, not the command", () => {
    expect(findGitInvocations("echo git merge")).toEqual([]);
    expect(findGitInvocations('echo "git merge x"')).toEqual([]);
    expect(findGitInvocations("rg 'git rebase' docs/")).toEqual([]);
  });

  test("global -C space form, plain + quoted", () => {
    expect(findGitInvocations("git -C /repo merge --ff-only feat")).toEqual([
      { verb: "merge", cPath: "/repo", args: ["--ff-only", "feat"] },
    ]);
    expect(findGitInvocations(`git -C "/repo" status`)).toEqual([
      { verb: "status", cPath: "/repo", args: [] },
    ]);
    expect(findGitInvocations("git -C '/repo' status")).toEqual([
      { verb: "status", cPath: "/repo", args: [] },
    ]);
  });

  test("global -c <k=v> skips its value", () => {
    expect(findGitInvocations("git -c user.name=x merge y")).toEqual([
      { verb: "merge", cPath: null, args: ["y"] },
    ]);
  });

  test("--git-dir / --work-tree: inline and space forms", () => {
    expect(findGitInvocations("git --git-dir=/g/.git merge x")).toEqual([
      { verb: "merge", cPath: null, args: ["x"] },
    ]);
    expect(findGitInvocations("git --git-dir /g/.git merge x")).toEqual([
      { verb: "merge", cPath: null, args: ["x"] },
    ]);
    expect(findGitInvocations("git --work-tree=/w rebase main")).toEqual([
      { verb: "rebase", cPath: null, args: ["main"] },
    ]);
    expect(findGitInvocations("git --work-tree /w rebase main")).toEqual([
      { verb: "rebase", cPath: null, args: ["main"] },
    ]);
  });

  test("other global flags are skipped", () => {
    expect(findGitInvocations("git --no-pager log")).toEqual([
      { verb: "log", cPath: null, args: [] },
    ]);
  });

  test("leading VAR=value tokens are stripped", () => {
    expect(findGitInvocations("FOO=1 git merge x")).toEqual([
      { verb: "merge", cPath: null, args: ["x"] },
    ]);
    expect(findGitInvocations("A=1 B=2 git status")).toEqual([
      { verb: "status", cPath: null, args: [] },
    ]);
  });

  test("multi-segment: &&, ||, ;, |, newline", () => {
    expect(findGitInvocations("git fetch && git merge x")).toEqual([
      { verb: "fetch", cPath: null, args: [] },
      { verb: "merge", cPath: null, args: ["x"] },
    ]);
    expect(findGitInvocations("cd /x && git merge y")).toEqual([
      { verb: "merge", cPath: null, args: ["y"] },
    ]);
    expect(findGitInvocations("something | git rebase main")).toEqual([
      { verb: "rebase", cPath: null, args: ["main"] },
    ]);
    expect(findGitInvocations("git fetch || git pull")).toEqual([
      { verb: "fetch", cPath: null, args: [] },
      { verb: "pull", cPath: null, args: [] },
    ]);
    expect(findGitInvocations("git add .; git status")).toEqual([
      { verb: "add", cPath: null, args: ["."] },
      { verb: "status", cPath: null, args: [] },
    ]);
    expect(findGitInvocations("git add .\ngit status")).toEqual([
      { verb: "add", cPath: null, args: ["."] },
      { verb: "status", cPath: null, args: [] },
    ]);
  });

  test("flags only, no verb -> no invocation", () => {
    expect(findGitInvocations("git --version")).toEqual([]);
    expect(findGitInvocations("git -C /repo")).toEqual([]);
  });

  test("empty / whitespace command", () => {
    expect(findGitInvocations("")).toEqual([]);
    expect(findGitInvocations("   ")).toEqual([]);
  });
});
