import { describe, expect, test } from "bun:test";
import { decideProviderTurnParser, parseProviderTurn, providerTurnParser } from "./parse-turn.ts";
import type { ContentDocumentInput } from "./types.ts";

const turnInput = (
    text: string,
    labels: Record<string, unknown> = { provider: "codex", role: "user", messageKind: "task" },
): ContentDocumentInput => ({
    sourceKind: "turn",
    sourceRef: "session-a:1",
    text,
    labels,
});

describe("provider turn content parser", () => {
    test("accepts only non-empty turn documents", () => {
        expect(providerTurnParser.id).toBe("provider_turn");
        expect(decideProviderTurnParser(turnInput("hello")).decision).toBe("accept");
        expect(decideProviderTurnParser({ ...turnInput("hello"), sourceKind: "artifact" }).decision).toBe("reject");
        expect(decideProviderTurnParser(turnInput("   ")).decision).toBe("reject");
    });

    test("classifies Codex injected system blocks separately from user text", () => {
        const parsed = parseProviderTurn(turnInput([
            "<permissions instructions>sandbox=danger-full-access</permissions instructions>",
            "<skills_instructions>## Skills\n- tdd</skills_instructions>",
            "Can you update src/ingest/content-blocks/parse-turn.ts?",
        ].join("\n")));

        expect(parsed.blocks.map((block) => block.kind)).toEqual([
            "system_context",
            "system_context",
            "user_input",
        ]);
        expect(parsed.blocks[0]).toMatchObject({ heading: "permissions", startOffset: 0 });
        expect(parsed.atoms).toEqual(expect.arrayContaining([
            expect.objectContaining({
                blockSeq: 3,
                kind: "file_ref",
                value: "src/ingest/content-blocks/parse-turn.ts",
            }),
        ]));
    });

    test("splits assistant prose into low-level markdown sections", () => {
        const parsed = parseProviderTurn(turnInput([
            "## Plan",
            "- Update `src/ingest/turn-dissect.ts`",
            "- Run `bun test src/ingest/content-blocks/parse-turn.test.ts`",
            "",
            "```ts",
            "function buildContentBlocks() { return true }",
            "```",
        ].join("\n"), { provider: "claude", role: "assistant", messageKind: "assistant" }));

        expect(parsed.blocks.map((block) => block.kind)).toEqual([
            "assistant_text",
            "assistant_text_heading",
            "assistant_text_list_item",
            "assistant_text_list_item",
            "assistant_text_code",
        ]);
        expect(parsed.blocks.slice(1).every((block) => block.parentSeq === 1)).toBe(true);
        expect(parsed.atoms).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "file_ref", value: "src/ingest/turn-dissect.ts" }),
            expect.objectContaining({ kind: "command_ref", value: "bun test src/ingest/content-blocks/parse-turn.test.ts" }),
            expect.objectContaining({ kind: "symbol_ref", value: "buildContentBlocks" }),
        ]));
    });

    test("captures tool names, URLs, citations, and XML tags from assistant tool blocks", () => {
        const parsed = parseProviderTurn(turnInput(
            [
                "<tool_use name=\"Read\">{\"file_path\":\"src/cli/index.ts\"}</tool_use>",
                "See [docs](https://example.com/docs) and https://example.com/raw.",
            ].join("\n"),
            { provider: "claude", role: "assistant", messageKind: "assistant" },
        ));

        expect(parsed.blocks.map((block) => block.kind)).toEqual(["tool_use", "assistant_text"]);
        expect(parsed.atoms).toEqual(expect.arrayContaining([
            expect.objectContaining({ blockSeq: 1, kind: "tool_name", value: "Read" }),
            expect.objectContaining({ blockSeq: 1, kind: "xml_tag", value: "tool_use" }),
            expect.objectContaining({ kind: "file_ref", value: "src/cli/index.ts" }),
            expect.objectContaining({ kind: "citation_ref", value: "https://example.com/docs" }),
            expect.objectContaining({ kind: "url_ref", value: "https://example.com/raw" }),
        ]));
    });

    test("handles Pi/OpenCode/Cursor style plain turns through the same parser", () => {
        const providers = ["pi", "opencode", "cursor"] as const;

        for (const provider of providers) {
            const parsed = parseProviderTurn(turnInput(
                `Need to inspect CursorSessionStore and src/ingest/${provider}.ts`,
                { provider, role: "user", messageKind: "task" },
            ));

            expect(parsed.blocks[0]).toMatchObject({ kind: "user_input", role: "user" });
            expect(parsed.atoms).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: "symbol_ref", value: "CursorSessionStore" }),
                expect.objectContaining({ kind: "file_ref", value: `src/ingest/${provider}.ts` }),
            ]));
        }
    });
});
