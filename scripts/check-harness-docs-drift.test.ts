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
    test("extracts Codex Source sections and preserves nested slugs", () => {
        const index = [
            "# Advanced configuration",
            "Source: https://developers.openai.com/codex/config-advanced.md",
            "",
            "# Sandboxing",
            "Source: https://developers.openai.com/codex/concepts/sandboxing.md",
            "",
            "Raw current-format link: https://developers.openai.com/codex/hooks.md",
            "Source: https://example.com/codex/permissions.md",
            "Source: https://developers.openai.com/codex/config-advanced.md",
        ].join("\n");

        expect(parseCodexDocsIndex(index)).toEqual([
            { slug: "config-advanced", title: "config-advanced" },
            { slug: "concepts/sandboxing", title: "sandboxing" },
            { slug: "hooks", title: "hooks" },
        ]);
    });

    test("extracts current full-export links and heading-only watched pages", () => {
        const index = [
            "# Agent approvals & security",
            "See [sandboxing](https://developers.openai.com/codex/concepts/sandboxing).",
            "",
            "# Codex App Server",
            "Use app-server when embedding Codex.",
            "",
            '<a href="/codex/sdk">Codex SDK</a>',
            "Raw URL: https://developers.openai.com/codex/hooks",
        ].join("\n");

        expect(parseCodexDocsIndex(index)).toEqual([
            { slug: "concepts/sandboxing", title: "sandboxing" },
            { slug: "hooks", title: "hooks" },
            { slug: "sdk", title: "sdk" },
            { slug: "agent-approvals-security", title: "Agent approvals & security" },
            { slug: "app-server", title: "Codex App Server" },
        ]);
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
