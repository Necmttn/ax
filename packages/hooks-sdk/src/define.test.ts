import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { defineHook, runHook } from "./define.ts";
import { Verdict } from "./verdict.ts";
import { GitEnvTest } from "./git-env.ts";

const blockCheckout = defineHook({
  name: "test-guard",
  events: ["PreToolUse"],
  matcher: { tools: ["Bash"] },
  run: (event) =>
    Effect.succeed(
      String(event.tool?.input.command ?? "").includes("git checkout")
        ? Verdict.block("no checkout")
        : Verdict.allow,
    ),
});

const fire = (stdin: object) =>
  Effect.runPromise(
    runHook(blockCheckout, JSON.stringify(stdin), {}).pipe(Effect.provide(GitEnvTest({}))),
  );

describe("runHook", () => {
  test("matching tool + matching predicate → block outcome", async () => {
    const r = await fire({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git checkout x" }, cwd: "/r" });
    expect(r).toEqual({ exitCode: 2, stderr: "no checkout" });
  });
  test("non-matching tool → allow without running predicate", async () => {
    const r = await fire({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/r/a.ts" }, cwd: "/r" });
    expect(r).toEqual({ exitCode: 0 });
  });
  test("non-matching event → allow", async () => {
    const r = await fire({ hook_event_name: "Stop", cwd: "/r" });
    expect(r).toEqual({ exitCode: 0 });
  });
  test("predicate defect → allow (hooks must fail open)", async () => {
    const boom = defineHook({
      name: "boom",
      events: ["PreToolUse"],
      run: () => Effect.sync(() => { throw new Error("bug"); }),
    });
    const r = await Effect.runPromise(
      runHook(boom, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: "/r" }), {}).pipe(
        Effect.provide(GitEnvTest({})),
      ),
    );
    expect(r.exitCode).toBe(0);
  });
});
