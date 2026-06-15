import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import routeDispatch, { RoutingTableSchema } from "./route-dispatch.ts";
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

// Force conserve mode for determinism in tests that check routing behavior.
beforeEach(() => {
  process.env.AX_SPEND_MODE = "conserve";
});
afterEach(() => {
  delete process.env.AX_SPEND_MODE;
});

// ---------------------------------------------------------------------------
// Explicit model → always allow (unless judgment+cheap → warn)
// ---------------------------------------------------------------------------

describe("explicit model set", () => {
  test("model='sonnet' → Allow (user made a deliberate choice, non-judgment)", async () => {
    const v = await run({ description: "locate all usages", model: "sonnet" });
    expect(v._tag).toBe("Allow");
  });

  test("model='haiku' on non-judgment → Allow", async () => {
    const v = await run({ description: "spec review of PR #42", model: "haiku" });
    // spec review is NOT judgment-strong (JUDGMENT_STRONG_RE requires quality/pr/final/adversarial/code review)
    expect(v._tag).toBe("Allow");
  });

  test("model='sonnet' on judgment (quality review) → Advise (catch-rate gate, reaches model via additionalContext)", async () => {
    // Rule 0: judgment+cheap → Advise, even with explicit model
    const v = await run({ description: "quality review of the diff", model: "sonnet" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("judgment work");
    }
  });

  test("model='' (empty string) treated as inherit → Advise (matches search-locate in conserve)", async () => {
    // Empty string: explicit=false → not treated as deliberate choice
    const v = await run({ description: "locate symbols", model: "" });
    // Matches the search-locate pattern → Advise in conserve mode
    expect(v._tag).toBe("Advise");
  });
});

// ---------------------------------------------------------------------------
// conserve mode: match+inherit → Advise (advisory, not rewrite)
// ---------------------------------------------------------------------------

describe("conserve + inherit: route-down classes advise cheaper model", () => {
  test("'spec review of PR' → Advise with sonnet", async () => {
    const v = await run({ description: "spec review of PR #42" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("sonnet");
      expect(v.context).toContain("conserve mode");
    }
  });

  test("'Locate all TODO comments' → Advise with haiku (case-insensitive)", async () => {
    const v = await run({ description: "Locate all TODO comments" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("haiku");
    }
  });

  test("'find usages of Foo' → Advise with haiku", async () => {
    const v = await run({ description: "find usages of Foo" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("haiku");
    }
  });

  test("'research the Effect v4 API' → Advise with sonnet", async () => {
    const v = await run({ description: "research the Effect v4 API" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("sonnet");
    }
  });

  test("'implement task: add route-dispatch hook' → Advise with sonnet", async () => {
    const v = await run({ description: "implement task: add route-dispatch hook" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("sonnet");
    }
  });
});

// ---------------------------------------------------------------------------
// splurge mode: match+inherit → Allow (subtractive, runs on strong model)
// ---------------------------------------------------------------------------

describe("splurge + inherit: no auto-route (subtractive)", () => {
  test("AX_SPEND_MODE=splurge + match + inherit → Allow (strong inherited model)", async () => {
    process.env.AX_SPEND_MODE = "splurge";
    const v = await run({ description: "spec review of PR #42" });
    expect(v._tag).toBe("Allow");
  });

  test("AX_SPEND_MODE=splurge + 'find usages' (route-down class) + inherit → Allow", async () => {
    process.env.AX_SPEND_MODE = "splurge";
    const v = await run({ description: "find usages of Foo" });
    expect(v._tag).toBe("Allow");
  });
});

// ---------------------------------------------------------------------------
// judgment-cheap: advise regardless of mode (reaches model via additionalContext)
// ---------------------------------------------------------------------------

describe("judgment work on cheap explicit model → Advise", () => {
  test("judgment+cheap conserve → Advise", async () => {
    process.env.AX_SPEND_MODE = "conserve";
    const v = await run({ description: "quality review of the diff", model: "sonnet" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("judgment work");
    }
  });

  test("judgment+cheap splurge → Advise (rule 0 always fires)", async () => {
    process.env.AX_SPEND_MODE = "splurge";
    const v = await run({ description: "code review of the PR", model: "haiku" });
    expect(v._tag).toBe("Advise");
  });

  test("explicit non-cheap on a route-down class → Allow (deliberate choice)", async () => {
    // description matches search-locate (haiku), but model is opus (non-cheap)
    // explicit=true, cheap=false, judgmentStrong=false → Rule 1: Allow
    const v = await run({ description: "find usages of Foo", model: "opus" });
    expect(v._tag).toBe("Allow");
  });
});

// ---------------------------------------------------------------------------
// Agent-type rules (default routing table)
// ---------------------------------------------------------------------------

describe("agentType rules", () => {
  test("subagent_type='Explore' → Advise with haiku (conserve)", async () => {
    const v = await run({ subagent_type: "Explore", description: "some task" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("haiku");
    }
  });

  test("subagent_type='codebase-locator' → Advise with haiku (conserve)", async () => {
    const v = await run({ subagent_type: "codebase-locator" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("haiku");
    }
  });

  test("subagent_type='codebase-analyzer' → Advise with sonnet (conserve)", async () => {
    const v = await run({ subagent_type: "codebase-analyzer" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("sonnet");
    }
  });

  test("agentType wins over description pattern when both match (haiku wins over sonnet)", async () => {
    // 'Explore' agent type → haiku; description 'research ...' → sonnet.
    // Agent type should win (more specific).
    const v = await run({ subagent_type: "Explore", description: "research the docs" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("haiku");
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
  test("no description but prompt starts with 'locate' → Advise with haiku (conserve)", async () => {
    const v = await run({ prompt: "locate all files that import Effect" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("haiku");
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
// Advise verdict contains the suggested model name
// ---------------------------------------------------------------------------

describe("advise verdict content", () => {
  test("Advise context mentions the suggested model and conserve mode", async () => {
    const v = await run({ description: "spec review of PR #42" });
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("sonnet");
      expect(v.context).toContain("conserve mode");
    }
  });
});

// ---------------------------------------------------------------------------
// Routing table fallback: corrupt file → defaults still fire
// ---------------------------------------------------------------------------

describe("routing table loading", () => {
  test("corrupt/absent routing table falls back to defaults and still advises on known pattern", async () => {
    // We cannot easily mock the fs call here without dependency injection,
    // but the real path (~/.ax/hooks/routing-table.json) likely does not exist
    // in CI. The default table is embedded, so the hook should still work.
    const v = await run({ description: "locate things" });
    // 'locate' matches the default search-locate pattern → Advise in conserve
    expect(v._tag).toBe("Advise");
    if (v._tag === "Advise") {
      expect(v.context).toContain("haiku");
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

// ---------------------------------------------------------------------------
// RoutingTableSchema export: accepts origin-tagged classes
// ---------------------------------------------------------------------------

describe("route-dispatch routing-table schema", () => {
  test("accepts origin-tagged classes written by ax routing compile/tune", () => {
    const decode = Schema.decodeUnknownResult(RoutingTableSchema);
    const result = decode({
      version: 1,
      classes: [
        { id: "spec-review", pattern: "^spec review", flags: "i", suggest: "sonnet", reason: "x", origin: "default" },
        { id: "mined", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "y", origin: "user" },
      ],
      agentTypes: { Explore: "haiku" },
    });
    expect(Result.isSuccess(result)).toBe(true);
  });

  test("decodes a legacy origin-less table", () => {
    // Pre-existing on-disk format: no origin fields anywhere.
    const decode = Schema.decodeUnknownResult(RoutingTableSchema);
    const result = decode({
      version: 1,
      classes: [
        { id: "spec-review", pattern: "^spec review", flags: "i", suggest: "sonnet", reason: "x" },
      ],
      agentTypes: { Explore: "haiku" },
    });
    expect(Result.isSuccess(result)).toBe(true);
  });

  test("tolerates unknown origin values", () => {
    // origin is a plain optional string, not a literal union: the hook never
    // reads origin, so an unrecognized value (e.g. a hand-edited "mined")
    // must NOT fail the whole-table decode and silently revert the user's
    // routing table to DEFAULT_TABLE.
    const decode = Schema.decodeUnknownResult(RoutingTableSchema);
    const result = decode({
      version: 1,
      classes: [
        { id: "mined", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "y", origin: "mined" },
      ],
    });
    expect(Result.isSuccess(result)).toBe(true);
  });
});
