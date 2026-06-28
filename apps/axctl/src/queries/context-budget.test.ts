import { describe, expect, test } from "bun:test";
import {
  buildContextDriftRows,
  buildStartupBudgetSources,
  MCP_TOOL_DEFINITION_TOKENS_PER_SERVER,
  type ContextBudgetResult,
} from "./context-budget.ts";

describe("ContextBudgetResult", () => {
  test("carries a contentTypes breakdown field", () => {
    const sample: ContextBudgetResult["contentTypes"] = {
      rows: [{ category: "code", calls: 1, bytes: 4, estTokens: 1, tokenShare: 1 }],
      totals: { calls: 1, bytes: 4, estTokens: 1 },
    };
    expect(sample.rows[0].category).toBe("code");
  });

  test("rolls skills, CLAUDE.md, harness prompt, and MCP estimates into startup sources", () => {
    const budget = buildStartupBudgetSources({
      skillIndexChars: 400,
      skillIndexTokens: 100,
      skillCount: 2,
      guidanceRows: [
        {
          kind: "memory",
          scope: "user",
          safe_path: "~/.claude/CLAUDE.md",
          authority_hash: "user-authority",
          bytes: 80,
          token_estimate: 20,
          mcp_server_names_json: null,
        },
        {
          kind: "guidance_doc",
          scope: "project",
          safe_path: "$PROJECT/CLAUDE.md",
          authority_hash: "project-authority",
          bytes: 40,
          token_estimate: 10,
          mcp_server_names_json: null,
        },
        {
          kind: "guidance_doc",
          scope: "project",
          safe_path: "$PROJECT/CLAUDE.md",
          authority_hash: "stale-project-authority",
          bytes: 800,
          token_estimate: 200,
          mcp_server_names_json: null,
        },
        {
          kind: "settings_config",
          scope: "user",
          safe_path: "~/.claude/settings.json",
          authority_hash: "user-authority",
          bytes: 200,
          token_estimate: 50,
          mcp_server_names_json: JSON.stringify(["github", "linear"]),
        },
        {
          kind: "mcp_server",
          scope: "project",
          safe_path: "$PROJECT/.mcp.json",
          authority_hash: "project-authority",
          bytes: 60,
          token_estimate: 15,
          mcp_server_names_json: JSON.stringify(["github"]),
        },
      ],
      authorityHashes: new Set(["user-authority", "project-authority"]),
    });

    expect(budget.sources.map((row) => row.category)).toEqual([
      "skills",
      "claude_md",
      "claude_md",
      "harness_base",
      "mcp_tools",
    ]);
    expect(budget.sources.find((row) => row.source === "CLAUDE.md · global")).toMatchObject({
      tokens: 20,
      estimated: false,
      entries: 1,
    });
    expect(budget.sources.find((row) => row.source === "MCP tool definitions")).toMatchObject({
      tokens: 2 * MCP_TOOL_DEFINITION_TOKENS_PER_SERVER,
      estimated: true,
      entries: 2,
    });
    expect(budget.totals.startup_tokens).toBe(
      budget.sources.reduce((sum, row) => sum + row.tokens, 0),
    );
    expect(budget.totals.measured_startup_tokens).toBe(130);
  });

  test("maps skill and CLAUDE.md revisions into one context drift feed", () => {
    const rows = buildContextDriftRows({
      skillRows: [
        {
          name: "tdd",
          scope: "user",
          change: "changed",
          bytes: 120,
          prev_bytes: 80,
          ts: new Date("2026-06-02T00:00:00Z"),
        },
      ],
      guidanceRows: [
        {
          source_path: "$PROJECT/CLAUDE.md",
          scope: "project",
          change: "changed",
          bytes: 200,
          prev_bytes: 100,
          observed_at: new Date("2026-06-03T00:00:00Z"),
        },
      ],
      limit: 10,
    });

    expect(rows.map((row) => row.kind)).toEqual(["claude_md", "skill"]);
    expect(rows[0]).toMatchObject({
      name: "CLAUDE.md · project",
      scope: "project",
      byte_delta: 100,
      token_delta: 25,
    });
    expect(rows[1]).toMatchObject({
      name: "tdd",
      kind: "skill",
      byte_delta: 40,
      token_delta: 10,
    });
  });
});
