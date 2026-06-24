import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { dispatchEvent, dispatchInstallPlan, ALL_GUARDS, runDispatchMain } from "./dispatch.ts";
import { defineHook, type HookDefinition } from "./define.ts";
import { GitEnv, GitEnvTest } from "./git-env.ts";
import { Verdict } from "./verdict.ts";
import type { ProcessOutcome } from "./adapters/encode.ts";

const run = (
  stdin: string,
  guards: ReadonlyArray<HookDefinition>,
): Promise<ProcessOutcome> =>
  Effect.runPromise(
    dispatchEvent(stdin, {}, guards).pipe(Effect.provide(GitEnvTest({}))),
  );

const fixed = (
  name: string,
  tools: string[],
  verdict: Verdict,
): HookDefinition =>
  defineHook({
    name,
    events: ["PreToolUse"],
    matcher: { tools },
    run: () => Effect.succeed(verdict),
  });

const claudeEdit = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: "/repo/x.ts" },
  cwd: "/repo",
});

describe("dispatchEvent", () => {
  test("runs only guards whose matcher applies", async () => {
    const out = await run(claudeEdit, [
      fixed("for-edit", ["Edit"], Verdict.advise("edit advice")),
      fixed("for-bash", ["Bash"], Verdict.block("should not fire")),
    ]);
    // Bash guard must not have fired -> not a block.
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("edit advice");
  });

  test("a block from any matching guard exits 2 with the reason", async () => {
    const out = await run(claudeEdit, [
      fixed("a", ["Edit"], Verdict.advise("a")),
      fixed("b", ["Edit"], Verdict.block("nope")),
    ]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe("nope");
  });

  test("no matching guards -> allow (exit 0, no streams)", async () => {
    const out = await run(claudeEdit, [fixed("none", ["Bash"], Verdict.block("x"))]);
    expect(out).toEqual({ exitCode: 0 });
  });

  test("a guard defect fails open without suppressing the others", async () => {
    const exploding = defineHook({
      name: "boom",
      events: ["PreToolUse"],
      matcher: { tools: ["Edit"] },
      run: () =>
        Effect.sync(() => {
          throw new Error("kaboom");
        }),
    });
    const out = await run(claudeEdit, [
      exploding,
      fixed("survivor", ["Edit"], Verdict.advise("still here")),
    ]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("still here");
  });

  test("encodes per harness: codex advise is a no-op exit 0", async () => {
    const codexEdit = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
      cwd: "/repo",
      turn_id: "t1",
    });
    const out = await run(codexEdit, [fixed("a", ["Edit"], Verdict.advise("ctx"))]);
    // Advise only reaches the model on claude; codex -> bare allow.
    expect(out).toEqual({ exitCode: 0 });
  });

  test("guards requiring GitEnv resolve through the provided layer", async () => {
    const gitGuard = defineHook({
      name: "git",
      events: ["PreToolUse"],
      matcher: { tools: ["Edit"] },
      run: () =>
        Effect.gen(function* () {
          const git = yield* GitEnv;
          const branch = yield* git.currentBranch("/repo");
          return branch === "main" ? Verdict.block("on main") : Verdict.allow;
        }),
    });
    const out = await Effect.runPromise(
      dispatchEvent(claudeEdit, {}, [gitGuard]).pipe(
        Effect.provide(GitEnvTest({ branches: { "/repo": "main" } })),
      ),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe("on main");
  });
});

describe("ALL_GUARDS registry", () => {
  test("registers the four shipped guards by name", () => {
    expect(ALL_GUARDS.map((g) => g.name).sort()).toEqual(
      ["enforce-worktree", "enforce-worktree-write", "refresh-quota", "route-dispatch"].sort(),
    );
  });

  test("runDispatchMain is exported (entry wiring)", () => {
    expect(typeof runDispatchMain).toBe("function");
  });
});

describe("dispatchInstallPlan", () => {
  test("unions tool matchers per event across guards", () => {
    const plan = dispatchInstallPlan([
      defineHook({ name: "a", events: ["PreToolUse"], matcher: { tools: ["Edit"] }, run: () => Effect.succeed(Verdict.allow) }),
      defineHook({ name: "b", events: ["PreToolUse"], matcher: { tools: ["Write", "Edit"] }, run: () => Effect.succeed(Verdict.allow) }),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.event).toBe("PreToolUse");
    expect([...plan[0]!.tools!].sort()).toEqual(["Edit", "Write"]);
  });

  test("a matcher-less guard collapses its event to tools:null", () => {
    const plan = dispatchInstallPlan([
      defineHook({ name: "tool", events: ["PreToolUse"], matcher: { tools: ["Edit"] }, run: () => Effect.succeed(Verdict.allow) }),
      defineHook({ name: "session", events: ["SessionStart"], run: () => Effect.succeed(Verdict.allow) }),
    ]);
    const session = plan.find((e) => e.event === "SessionStart");
    expect(session?.tools).toBeNull();
  });

  test("real guard set: PreToolUse carries tool filters, SessionStart has none", () => {
    const plan = dispatchInstallPlan();
    const pre = plan.find((e) => e.event === "PreToolUse");
    const session = plan.find((e) => e.event === "SessionStart");
    // PreToolUse guards (enforce-worktree-write, route-dispatch) contribute named tools.
    expect(pre?.tools).toBeTruthy();
    expect(pre!.tools!).toContain("Edit");
    // refresh-quota fires at SessionStart with no tool filter.
    expect(session?.tools ?? null).toBeNull();
  });
});
