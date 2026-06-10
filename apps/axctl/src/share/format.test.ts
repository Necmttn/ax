import { describe, expect, it } from "bun:test";
import { minimalShareArtifact, type AxSessionShare } from "./artifact.ts";
import { formatSharePreview, formatShareSuccess, hasStaleUsage } from "./format.ts";

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

const SESSION_USAGE = {
    model: "claude-opus-4-5",
    prompt_tokens: null,
    completion_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_tokens: 5000,
    estimated_cost_usd: 0.05,
    pricing_source: "test",
};

const TURN_USAGE = {
    ...SESSION_USAGE,
    seq: 2,
    fresh_input_tokens: null,
    usage_source: "api",
    usage_quality: "exact",
};

describe("hasStaleUsage", () => {
    it("returns true when session-level usage exists but no turns have token_usage", () => {
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: SESSION_USAGE,
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
                { id: "t2", seq: 2, role: "assistant", text: "world" },
            ],
        };
        expect(hasStaleUsage(artifact)).toBe(true);
    });

    it("returns false when at least one turn has token_usage", () => {
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: SESSION_USAGE,
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
                {
                    id: "t2",
                    seq: 2,
                    role: "assistant",
                    text: "world",
                    token_usage: TURN_USAGE,
                },
            ],
        };
        expect(hasStaleUsage(artifact)).toBe(false);
    });

    it("returns false when there is no session-level usage", () => {
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
            ],
        };
        expect(hasStaleUsage(artifact)).toBe(false);
    });

    it("returns false when session usage values are zero", () => {
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: {
                ...SESSION_USAGE,
                estimated_tokens: 0,
                estimated_cost_usd: 0,
            },
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
            ],
        };
        expect(hasStaleUsage(artifact)).toBe(false);
    });

    it("returns false when a descendant turn has token_usage", () => {
        const child: AxSessionShare = {
            ...minimalShareArtifact({ id: "child1", source: "claude" }),
            token_usage: SESSION_USAGE,
            turns: [
                {
                    id: "ct1",
                    seq: 1,
                    role: "assistant",
                    text: "sub",
                    token_usage: { ...TURN_USAGE, seq: 1 },
                },
            ],
        };
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: SESSION_USAGE,
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
            ],
            children: [child],
        };
        expect(hasStaleUsage(artifact)).toBe(false);
    });

    it("returns true when session usage uses estimated_tokens only (no cost) and no turns have usage", () => {
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: {
                ...SESSION_USAGE,
                estimated_cost_usd: null,
                estimated_tokens: 3000,
            },
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
            ],
        };
        expect(hasStaleUsage(artifact)).toBe(true);
    });
});
