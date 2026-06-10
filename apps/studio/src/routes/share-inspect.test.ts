import { describe, expect, test } from "bun:test";
import {
    fetchShareArtifact,
    fetchShareFile,
    fetchShareManifest,
    gistRawUrl,
    inspectPayloadFromShare,
    isShareManifest,
    rawSessionFileUrl,
    spanKindForShareTurn,
} from "./share-inspect.tsx";

type ShareTurn = Parameters<typeof spanKindForShareTurn>[0];

function turn(partial: Partial<ShareTurn>): ShareTurn {
    return {
        id: "turn:test",
        seq: 1,
        role: "user",
        text: "hello",
        ...partial,
    };
}

describe("spanKindForShareTurn", () => {
    test("uses intent_kind to keep slash-command wrappers out of user input", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "task",
            intent_kind: "wrapper_instruction",
            text: "## Your task\nReview the diff.",
        }))).toBe("wrapper_instruction");
    });

    test("uses intent_kind to preserve skill context exported as user role rows", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "context",
            intent_kind: "skill_context",
            text: "Base directory for this skill: ~/.claude/skills/review-all",
        }))).toBe("skill_context");
    });

    test("plain user tasks remain user input", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "task",
            intent_kind: "organic_task",
            text: "lets run review all command",
        }))).toBe("user_input");
    });
});

describe("fetchShareArtifact", () => {
    test("loads ax-session.json directly from gist raw content", async () => {
        const calls: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return new Response(JSON.stringify({
                schema_version: 1,
                exported_at: "2026-05-31T00:00:00.000Z",
                session: { id: "session-1", source: "codex" },
                stats: {
                    turns: 1,
                    tool_calls: 0,
                    files_changed: 0,
                    skills_used: 0,
                    failures: 0,
                },
                turns: [{
                    id: "turn-1",
                    seq: 1,
                    role: "user",
                    text: "hello",
                }],
            }), {
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const artifact = await fetchShareArtifact("Necmttn", "abc123");

            expect(artifact.session.id).toBe("session-1");
            expect(calls).toEqual([rawSessionFileUrl("Necmttn", "abc123")]);
            expect(calls[0]).not.toContain("api.github.com");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe("isShareManifest", () => {
    test("accepts a v3 manifest, rejects a session artifact", () => {
        expect(isShareManifest({
            schema_version: 3,
            kind: "manifest",
            session: { id: "s1", source: "claude" },
            totals: { cost_usd: null, duration_ms: null, tool_calls: 0, turns: 0, subagents: 0, failures: 0 },
            root_file: "session.json",
            subagents: [],
        })).toBe(true);
        expect(isShareManifest({ schema_version: 3, session: { id: "s1" }, turns: [] })).toBe(false);
    });

    test("accepts a v4 manifest (current CLI export version)", () => {
        expect(isShareManifest({
            schema_version: 4,
            kind: "manifest",
            session: { id: "s1", source: "claude" },
            totals: { cost_usd: null, duration_ms: null, tool_calls: 0, turns: 0, subagents: 0, failures: 0 },
            root_file: "session.json",
            subagents: [],
        })).toBe(true);
        expect(isShareManifest({ schema_version: 5, kind: "manifest", session: { id: "s1" }, totals: {}, root_file: "session.json", subagents: [] })).toBe(false);
    });
});

describe("fetchShareManifest", () => {
    const withFetch = async (
        handler: (url: string) => Response,
        run: () => Promise<void>,
    ) => {
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
        try {
            await run();
        } finally {
            globalThis.fetch = original;
        }
    };

    test("fetches index.json from gist raw content", async () => {
        const manifest = {
            schema_version: 3,
            kind: "manifest",
            exported_at: "2026-06-01T00:00:00.000Z",
            session: { id: "root1", source: "claude" },
            stats: { turns: 1, tool_calls: 0, files_changed: 0, skills_used: 0, failures: 0 },
            root_file: "session.json",
            totals: { cost_usd: 1.5, duration_ms: 1000, tool_calls: 0, turns: 1, subagents: 1, failures: 0 },
            subagents: [],
        };
        await withFetch(
            (url) => {
                expect(url).toBe(gistRawUrl("Necmttn", "abc123", "index.json"));
                return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
            },
            async () => {
                const result = await fetchShareManifest("Necmttn", "abc123");
                expect(result?.totals.cost_usd).toBe(1.5);
                expect(result?.root_file).toBe("session.json");
            },
        );
    });

    test("returns null for a legacy gist with no manifest (404)", async () => {
        await withFetch(
            () => new Response("Not Found", { status: 404 }),
            async () => {
                expect(await fetchShareManifest("Necmttn", "legacy")).toBeNull();
            },
        );
    });

    test("fetchShareFile loads a named subagent file", async () => {
        await withFetch(
            (url) => {
                expect(url).toBe(gistRawUrl("Necmttn", "abc123", "subagent-x.json"));
                return new Response(JSON.stringify({
                    schema_version: 3,
                    exported_at: "2026-06-01T00:00:00.000Z",
                    session: { id: "claude-subagent-x", source: "claude-subagent" },
                    stats: { turns: 2, tool_calls: 0, files_changed: 0, skills_used: 0, failures: 0 },
                    turns: [],
                }), { headers: { "content-type": "application/json" } });
            },
            async () => {
                const artifact = await fetchShareFile("Necmttn", "abc123", "subagent-x.json");
                expect(artifact.session.id).toBe("claude-subagent-x");
                expect(artifact.schema_version).toBe(3);
            },
        );
    });
});

describe("inspectPayloadFromShare", () => {
    test("preserves exported content blocks for the shared inspector", () => {
        const payload = inspectPayloadFromShare({
            schema_version: 1,
            exported_at: "2026-05-31T00:00:00.000Z",
            ax_version: "0.5.0",
            session: { id: "session-1", source: "codex" },
            stats: {
                turns: 1,
                tool_calls: 0,
                files_changed: 0,
                skills_used: 0,
                failures: 0,
            },
            turns: [{
                id: "turn-1",
                seq: 1,
                role: "assistant",
                text: "I'll patch it.",
                content: {
                    document_id: "content_document:session-1-1",
                    parser_id: "codex-jsonl",
                    parser_version: "1",
                    blockset_hash: null,
                    blocks: [{
                        seq: 0,
                        parent_seq: null,
                        kind: "text",
                        role: "assistant",
                        heading: null,
                        text: "I'll patch it.",
                        text_excerpt: "I'll patch it.",
                        start_offset: 0,
                        end_offset: 14,
                        confidence: 1,
                        atoms: [],
                    }],
                },
            }],
        }, "gist:Necmttn/abc123");

        expect(payload.turns[0]?.raw_text).toBe("I'll patch it.");
        expect(payload.turns[0]?.content?.blocks[0]?.text).toBe("I'll patch it.");
        expect(payload.token_usage).toBeNull();
    });

    test("v4 artifact: tool_calls pass through to the inspect payload", () => {
        const artifact = {
            schema_version: 4, exported_at: "2026-06-09T00:00:00Z",
            session: { id: "s1", source: "claude" },
            stats: { turns: 1, tool_calls: 1, files_changed: 0, skills_used: 0, failures: 0 },
            turns: [{
                id: "t0", seq: 0, role: "assistant", text: "",
                tool_calls: [{ seq: 0, name: "WebFetch", category: "net", input: { url: "https://paxel.ai" }, command: null, output_excerpt: null, has_error: false, tokens: 228 }],
            }],
        } as any;
        const payload = inspectPayloadFromShare(artifact, "gist:x/y");
        expect(payload.turns[0]!.tool_calls?.[0]?.name).toBe("WebFetch");
    });

    test("v3 artifact still renders (baked text path, no crash)", () => {
        const artifact = {
            schema_version: 3, exported_at: "2026-06-09T00:00:00Z",
            session: { id: "s1", source: "claude" },
            stats: { turns: 1, tool_calls: 1, files_changed: 0, skills_used: 0, failures: 0 },
            turns: [{ id: "t0", seq: 0, role: "assistant", text: "🔧 WebFetch\n  url: https://paxel.ai", has_tool_use: true }],
        } as any;
        const payload = inspectPayloadFromShare(artifact, "gist:x/y");
        expect(payload.turns[0]!.raw_text).toContain("🔧");
        expect(payload.turns[0]!.tool_calls).toBeUndefined();
    });

    test("carries token usage into the shared cost lens when exported", () => {
        const payload = inspectPayloadFromShare({
            schema_version: 1,
            exported_at: "2026-05-31T00:00:00.000Z",
            ax_version: "0.5.0",
            session: { id: "session-1", source: "codex" },
            stats: {
                turns: 1,
                tool_calls: 0,
                files_changed: 0,
                skills_used: 0,
                failures: 0,
            },
            token_usage: {
                model: "gpt-5",
                prompt_tokens: 100,
                completion_tokens: 20,
                cache_creation_input_tokens: 30,
                cache_read_input_tokens: 40,
                estimated_tokens: 190,
                estimated_input_cost_usd: 0.01,
                estimated_output_cost_usd: 0.02,
                estimated_cache_creation_cost_usd: 0.003,
                estimated_cache_read_cost_usd: 0.001,
                estimated_cost_usd: 0.034,
                pricing_source: "test",
            },
            turns: [{
                id: "turn-1",
                seq: 1,
                role: "user",
                text: "hello",
            }],
        }, "gist:Necmttn/abc123");

        expect(payload.token_usage?.estimated_cost_usd).toBe(0.034);
    });
});
