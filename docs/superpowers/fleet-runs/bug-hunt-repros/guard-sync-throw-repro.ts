import { Effect } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/node_modules/effect/dist/index.js";
import { dispatchEvent } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/packages/hooks-sdk/src/dispatch.ts";
import { GitEnvTest } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/packages/hooks-sdk/src/git-env.ts";
import { Verdict } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cli-hooks/packages/hooks-sdk/src/verdict.ts";

const input = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: {},
});
const boom = {
  name: "boom",
  events: ["PreToolUse"] as const,
  matcher: { tools: ["Edit"] },
  run: () => { throw new Error("sync boom"); },
};
const blocker = {
  name: "blocker",
  events: ["PreToolUse"] as const,
  matcher: { tools: ["Edit"] },
  run: () => Effect.succeed(Verdict.block("must block")),
};

try {
  console.log(await Effect.runPromise(
    dispatchEvent(input, {}, [boom, blocker]).pipe(Effect.provide(GitEnvTest({}))),
  ));
} catch (error) {
  console.log(`rejected before blocker: ${error}`);
}
