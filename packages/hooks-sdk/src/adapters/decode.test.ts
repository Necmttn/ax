import { describe, expect, test } from "bun:test";
import { decodeHookInput } from "./decode.ts";
import claudeFix from "./fixtures/claude-pretooluse.json";
import codexFix from "./fixtures/codex-pretooluse.json";

describe("decodeHookInput", () => {
  test("claude stdin JSON", () => {
    const e = decodeHookInput(JSON.stringify(claudeFix), {});
    expect(e.harness).toBe("claude");
    expect(e.event).toBe("PreToolUse");
    expect(e.tool?.name).toBe("Bash");
    expect(e.tool?.input.command).toBe("git checkout main");
    expect(e.cwd).toBe("/Users/u/Projects/ax");
  });
  test("codex stdin JSON detected via turn_id", () => {
    const e = decodeHookInput(JSON.stringify(codexFix), {});
    expect(e.harness).toBe("codex");
    expect(e.sessionId).toBe("th-456");
  });
  test("legacy env-var fallback (old claude PreToolUse shape)", () => {
    const e = decodeHookInput("", {
      TOOL_NAME: "Bash",
      TOOL_INPUT_command: "git merge x",
      CWD: "/tmp/repo",
    });
    expect(e.harness).toBe("claude");
    expect(e.tool?.input.command).toBe("git merge x");
    expect(e.cwd).toBe("/tmp/repo");
  });
  test("non-tool event has null tool", () => {
    const e = decodeHookInput(
      JSON.stringify({ hook_event_name: "SessionStart", cwd: "/x", session_id: "s" }),
      {},
    );
    expect(e.tool).toBeNull();
    expect(e.event).toBe("SessionStart");
  });
});
