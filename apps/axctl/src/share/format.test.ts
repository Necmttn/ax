import { describe, expect, it } from "bun:test";
import { minimalShareArtifact } from "./artifact.ts";
import { formatSharePreview, formatShareSuccess } from "./format.ts";

describe("share formatter", () => {
    it("prints a concise default private preview", () => {
        const artifact = {
            ...minimalShareArtifact({ id: "abc123", source: "codex" }),
            stats: { turns: 3, tool_calls: 2, files_changed: 1, skills_used: 1, failures: 0 },
        };

        const text = formatSharePreview(artifact);
        expect(text).toContain("Session abc123");
        expect(text).toContain("source: codex");
        expect(text).toContain("turns: 3");
        expect(text).toContain("publish target: secret/unlisted Gist");
    });

    it("prints a public preview when requested", () => {
        const artifact = minimalShareArtifact({ id: "abc123", source: "codex" });

        const text = formatSharePreview(artifact, { public: true });

        expect(text).toContain("publish target: public Gist");
        expect(text).not.toContain("secret/unlisted Gist");
    });

    it("renders whole-trace cost and subagent count when present", () => {
        const child = {
            ...minimalShareArtifact({ id: "child1", source: "codex" }),
            token_usage: {
                model: "gpt-5",
                prompt_tokens: 0,
                completion_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                estimated_tokens: 0,
                estimated_cost_usd: 0.5,
                pricing_source: "test",
            },
        };
        const artifact = {
            ...minimalShareArtifact({ id: "abc123", source: "codex" }),
            token_usage: {
                model: "gpt-5",
                prompt_tokens: 0,
                completion_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                estimated_tokens: 0,
                estimated_cost_usd: 1.25,
                pricing_source: "test",
            },
            children: [child],
        };

        const text = formatSharePreview(artifact);
        expect(text).toContain("subagents: 1");
        expect(text).toContain("cost: $1.75");
    });

    it("falls back to estimated tokens when cost is unavailable", () => {
        const artifact = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: {
                model: "claude-opus-4-8",
                prompt_tokens: null,
                completion_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                estimated_tokens: 921199,
                estimated_cost_usd: null,
                pricing_source: null,
            },
        };

        const text = formatSharePreview(artifact);
        expect(text).toContain("tokens: ~921,199 (cost unavailable)");
        expect(text).not.toContain("cost:");
    });

    it("omits cost and subagents lines when absent", () => {
        const text = formatSharePreview(
            minimalShareArtifact({ id: "abc123", source: "codex" }),
        );
        expect(text).not.toContain("cost:");
        expect(text).not.toContain("subagents:");
    });

    it("prints the share URL after publishing", () => {
        const text = formatShareSuccess({ owner: "necmttn", gistId: "abc123" });

        expect(text).toContain("Published session share:");
        expect(text).toContain("https://ax.necmttn.com/s/necmttn/abc123");
    });
});
