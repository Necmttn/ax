import { describe, expect, test } from "bun:test";

import { missingWatchedSlugs, parseClaudeDocsIndex, parseCodexDocsIndex } from "./check-harness-docs-drift.ts";

describe("parseClaudeDocsIndex", () => {
    test("extracts direct Claude markdown doc links and preserves nested slugs", () => {
        const index = [
            "- [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage.md)",
            "- [Todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md)",
            "- [HTML page](https://code.claude.com/docs/en/settings)",
            "- [Other host](https://example.com/docs/en/hooks.md)",
            "- duplicate: https://code.claude.com/docs/en/monitoring-usage.md",
        ].join("\n");

        expect(parseClaudeDocsIndex(index)).toEqual([
            { slug: "monitoring-usage", title: "Monitoring usage" },
            { slug: "agent-sdk/todo-tracking", title: "Todo tracking" },
        ]);
    });
});

describe("parseCodexDocsIndex", () => {
    test("extracts learn.chatgpt.com markdown doc links and preserves nested slugs", () => {
        const index = [
            "## Config File",
            "- [Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced.md): More advanced configuration options for Codex local clients",
            "",
            "## Agent Configuration",
            "- [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md): Control which commands Codex can run outside the sandbox",
            "- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md): Use subagents in ChatGPT and Codex",
            "",
            "## Extend",
            "- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp.md): Give Codex access to third-party tools and context",
        ].join("\n");

        expect(parseCodexDocsIndex(index)).toEqual([
            { slug: "config-file/config-advanced", title: "Advanced Configuration" },
            { slug: "agent-configuration/rules", title: "Rules" },
            { slug: "agent-configuration/subagents", title: "Subagents" },
            { slug: "extend/mcp", title: "Model Context Protocol" },
        ]);
    });

    test("strips query strings and dedupes repeated links to the same slug", () => {
        const index = [
            "## Cli",
            "- [Command line options](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli): Options and flags for the Codex terminal client",
            "- [Slash commands in Codex CLI](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli): Control Codex during interactive sessions",
        ].join("\n");

        expect(parseCodexDocsIndex(index)).toEqual([
            { slug: "developer-commands", title: "Command line options" },
        ]);
    });

    test("ignores the old developers.openai.com host and non-markdown links", () => {
        const index = [
            "- [Old host](https://developers.openai.com/codex/hooks.md): stale link from the retired index",
            "- [Community](https://developers.openai.com/community/codex-for-oss): not a docs page",
            "- [Combined docs](https://learn.chatgpt.com/docs/llms-full.txt): not a single doc page",
            "- [Current](https://learn.chatgpt.com/docs/hooks.md): Run scripts or MCP tools during the Codex lifecycle",
        ].join("\n");

        expect(parseCodexDocsIndex(index)).toEqual([{ slug: "hooks", title: "Current" }]);
    });
});

describe("missingWatchedSlugs", () => {
    test("returns watched slugs missing from a parsed index in watched-list order", () => {
        expect(
            missingWatchedSlugs([{ slug: "hooks", title: "Hooks" }], [
                "hooks",
                "mcp",
                "agent-sdk/todo-tracking",
            ]),
        ).toEqual([
            "mcp",
            "agent-sdk/todo-tracking",
        ]);
    });
});
