import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import routeDispatch from "./route-dispatch.ts";
import { GitEnvTest } from "../git-env.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const layer = GitEnvTest({});

type AgentInput = {
  subagent_type?: string;
  model?: string;
  description?: string;
  prompt?: string;
};

const run = (input: AgentInput) =>
  Effect.runPromise(
    routeDispatch
      .run({
        harness: "claude",
        event: "PreToolUse",
        sessionId: null,
        cwd: "/repo",
        tool: { name: "Agent", input: input as Record<string, unknown> },
        raw: {},
      })
      .pipe(Effect.provide(layer)),
  );

// ---------------------------------------------------------------------------
// Explicit model → always allow
// ---------------------------------------------------------------------------

describe("explicit model set", () => {
  test("model='sonnet' → Allow (user made a deliberate choice)", async () => {
    const v = await run({ description: "locate all usages", model: "sonnet" });
    expect(v._tag).toBe("Allow");
  });

  test("model='haiku' → Allow", async () => {
    const v = await run({ description: "spec review of PR #42", model: "haiku" });
    expect(v._tag).toBe("Allow");
  });

  test("model='' (empty string) is treated as unset → may warn", async () => {
    // Empty string is falsy - we treat it the same as absent
    const v = await run({ description: "locate symbols", model: "" });
    // Should warn (matches search-locate) rather than allow
    expect(v._tag).toBe("Warn");
  });
});

// ---------------------------------------------------------------------------
// Description-based matches (default routing table)
// ---------------------------------------------------------------------------

describe("description matches default routing table", () => {
  test("'spec review of PR' → Warn with sonnet suggestion", async () => {
    const v = await run({ description: "spec review of PR #42" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("sonnet");
      expect(v.message).toContain("spec-compliance checklist review");
    }
  });

  test("'Locate all TODO comments' → Warn with haiku suggestion (case-insensitive)", async () => {
    const v = await run({ description: "Locate all TODO comments" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("haiku");
    }
  });

  test("'find usages of Foo' → Warn with haiku", async () => {
    const v = await run({ description: "find usages of Foo" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("haiku");
    }
  });

  test("'research the Effect v4 API' → Warn with sonnet", async () => {
    const v = await run({ description: "research the Effect v4 API" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("sonnet");
      expect(v.message).toContain("web/docs research");
    }
  });

  test("'implement task: add route-dispatch hook' → Warn with sonnet", async () => {
    const v = await run({ description: "implement task: add route-dispatch hook" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("sonnet");
    }
  });
});

// ---------------------------------------------------------------------------
// Agent-type rules (default routing table)
// ---------------------------------------------------------------------------

describe("agentType rules", () => {
  test("subagent_type='Explore' → Warn with haiku", async () => {
    const v = await run({ subagent_type: "Explore", description: "some task" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("haiku");
      expect(v.message).toContain("Explore");
    }
  });

  test("subagent_type='codebase-locator' → Warn with haiku", async () => {
    const v = await run({ subagent_type: "codebase-locator" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("haiku");
    }
  });

  test("subagent_type='codebase-analyzer' → Warn with sonnet", async () => {
    const v = await run({ subagent_type: "codebase-analyzer" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("sonnet");
    }
  });

  test("agentType wins over description pattern when both match", async () => {
    // 'Explore' agent type → haiku; description 'research ...' → sonnet.
    // Agent type should win (more specific).
    const v = await run({ subagent_type: "Explore", description: "research the docs" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("haiku");
    }
  });
});

// ---------------------------------------------------------------------------
// No match → allow
// ---------------------------------------------------------------------------

describe("no match", () => {
  test("unknown description → Allow", async () => {
    const v = await run({ description: "write a comprehensive e2e test suite" });
    expect(v._tag).toBe("Allow");
  });

  test("unknown subagent_type + unmatched description → Allow", async () => {
    const v = await run({ subagent_type: "general-purpose", description: "do the thing" });
    expect(v._tag).toBe("Allow");
  });

  test("no input fields → Allow", async () => {
    const v = await run({});
    expect(v._tag).toBe("Allow");
  });
});

// ---------------------------------------------------------------------------
// Prompt fallback (first 120 chars used when description absent)
// ---------------------------------------------------------------------------

describe("prompt fallback", () => {
  test("no description but prompt starts with 'locate' → Warn (haiku)", async () => {
    const v = await run({ prompt: "locate all files that import Effect" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("haiku");
    }
  });

  test("prompt longer than 120 chars - only first 120 chars matched", async () => {
    // Pad with characters that would not match, then put a pattern at end
    const padding = "x".repeat(130);
    const v = await run({ prompt: `${padding} spec review of PR` });
    // The pattern won't be in the first 120 chars - should allow
    expect(v._tag).toBe("Allow");
  });
});

// ---------------------------------------------------------------------------
// Warn message contains key fields
// ---------------------------------------------------------------------------

describe("warn message format", () => {
  test("message includes description label, model suggestion, and cost hint", async () => {
    const v = await run({ description: "spec review of PR #42" });
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("ax routing:");
      expect(v.message).toContain('"spec review of PR #42"');
      expect(v.message).toContain("sonnet");
      expect(v.message).toContain("cheaper");
      expect(v.message).toContain("Explicit model silences this");
    }
  });
});

// ---------------------------------------------------------------------------
// Routing table fallback: corrupt file → defaults still fire
// ---------------------------------------------------------------------------

describe("routing table loading", () => {
  test("corrupt/absent routing table falls back to defaults and still warns on known pattern", async () => {
    // We cannot easily mock the fs call here without dependency injection,
    // but the real path (~/.ax/hooks/routing-table.json) likely does not exist
    // in CI. The default table is embedded, so the hook should still work.
    // This test verifies the default table is active when the file is absent.
    const v = await run({ description: "locate things" });
    // 'locate' matches the default search-locate pattern → Warn
    expect(v._tag).toBe("Warn");
    if (v._tag === "Warn") {
      expect(v.message).toContain("haiku");
    }
  });
});

// ---------------------------------------------------------------------------
// Defect → fail open
// ---------------------------------------------------------------------------

describe("defect handling", () => {
  test("predicate defect → Allow (fail open via runHook contract)", async () => {
    // The define.ts runHook wrapper catches defects and returns allow.
    // We test this via runHook directly.
    const { runHook } = await import("../define.ts");
    const boom = {
      name: "boom",
      events: ["PreToolUse"] as const,
      matcher: { tools: ["Agent"] },
      run: () => Effect.sync((): never => { throw new Error("simulated defect"); }),
    };
    const result = await Effect.runPromise(
      runHook(
        boom,
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: { description: "spec review" },
          cwd: "/repo",
        }),
        {},
      ).pipe(Effect.provide(layer)),
    );
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Non-Agent tool → does not match (matcher guard)
// ---------------------------------------------------------------------------

describe("matcher guard", () => {
  test("Bash tool → does not fire (matcher filters it out)", async () => {
    const { runHook } = await import("../define.ts");
    const result = await Effect.runPromise(
      runHook(
        routeDispatch,
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          cwd: "/repo",
        }),
        {},
      ).pipe(Effect.provide(layer)),
    );
    expect(result.exitCode).toBe(0);
    // No systemMessage in stdout (warn would produce it)
    expect(result.stdout).toBeUndefined();
  });
});
