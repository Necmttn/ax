import { describe, expect, test } from "bun:test";
import {
    fetchShareArtifact,
    inspectPayloadFromShare,
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
    });
});
