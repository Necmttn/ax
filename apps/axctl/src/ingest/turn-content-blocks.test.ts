import { describe, expect, test } from "bun:test";
import {
    buildTurnContentBlockStatements,
    buildTurnContentDocumentWrites,
    turnRowToContentDocumentWrite,
} from "./turn-content-blocks.ts";

describe("turn content block derivation", () => {
    test("maps turn rows into content document writes linked to turn/session/event", () => {
        const write = turnRowToContentDocumentWrite({
            id: "turn:`session-a__000001`",
            session: "session:`session-a`",
            agent_event: "agent_event:`codex__session_a__event_1`",
            seq: 1,
            role: "user",
            message_kind: "task",
            intent_kind: "organic_task",
            text: "Please inspect src/ingest/codex.ts",
            text_excerpt: "Please inspect src/ingest/codex.ts",
            has_tool_use: false,
            has_error: false,
        });

        expect(write).toMatchObject({
            sourceKind: "turn",
            sourceRef: "session-a__000001",
            turnId: "session-a__000001",
            sessionId: "session-a",
            agentEventId: "codex__session_a__event_1",
            title: "user turn 1",
        });
        expect(write?.parsed.blocks[0]).toMatchObject({ kind: "user_input", role: "user" });
        expect(write?.parsed.atoms).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "file_ref", value: "src/ingest/codex.ts" }),
            expect.objectContaining({ kind: "section_alias", value: "reference" }),
        ]));
    });

    test("turn document writes include semantic section alias atoms", () => {
        const write = turnRowToContentDocumentWrite({
            id: "turn:`session-a__000002`",
            session: "session:`session-a`",
            seq: 2,
            role: "user",
            message_kind: "task",
            text: [
                "Budget:",
                "- Hard limit: none",
                "",
                "<objective>",
                "Ship section aliases.",
                "</objective>",
            ].join("\n"),
        });

        expect(write?.parsed.classifierVersions).toMatchObject({
            section_aliases: "turn-section-aliases-v1",
        });
        expect(write?.parsed.atoms).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "section_alias", value: "budget" }),
            expect.objectContaining({ kind: "section_alias", value: "objective" }),
        ]));
        expect(write?.parsed.blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                labels: expect.objectContaining({
                    semantic_aliases: expect.arrayContaining(["budget"]),
                    primary_semantic_alias: "budget",
                }),
            }),
        ]));
    });

    test("skips empty turn rows", () => {
        expect(buildTurnContentDocumentWrites([
            { id: "turn:a", text: "   " },
            { id: "turn:b", text: null },
            { id: "turn:c", text: "real" },
        ])).toHaveLength(1);
    });

    test("builds reset statements before per-document upserts on full derive", () => {
        const statements = buildTurnContentBlockStatements([
            {
                id: "turn:`session-a__000001`",
                session: "session:`session-a`",
                seq: 1,
                role: "assistant",
                message_kind: "assistant",
                text: "Done in `src/ingest/turn-content-blocks.ts`",
            },
        ], { reset: true });

        expect(statements.slice(0, 3)).toEqual([
            "DELETE content_atom WHERE source_kind = \"turn\";",
            "DELETE content_block WHERE source_kind = \"turn\";",
            "DELETE content_document WHERE source_kind = \"turn\";",
        ]);
        expect(statements.join("\n")).toContain("UPSERT content_document:`turn__session_a_000001");
        expect(statements.join("\n")).toContain("turn: turn:`session-a__000001`");
        expect(statements.join("\n")).toContain("session: session:`session-a`");
    });

    test("incremental statements only clear the specific document children", () => {
        const statements = buildTurnContentBlockStatements([
            { id: "turn:`session-a__000001`", text: "hello" },
        ], { reset: false });

        expect(statements[0]).toContain("DELETE content_atom WHERE document = content_document:");
        expect(statements[1]).toContain("DELETE content_block WHERE document = content_document:");
        expect(statements.some((statement) => statement === "DELETE content_atom WHERE source_kind = \"turn\";"))
            .toBe(false);
    });
});
