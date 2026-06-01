import { describe, expect, test } from "bun:test";
import { codexContentToInspectorText, jsonlBlockToInspectorText } from "./session-inspect.ts";

describe("codexContentToInspectorText", () => {
    test("joins text blocks with newlines to match ingested turn offsets", () => {
        const text = codexContentToInspectorText([
            { type: "input_text", text: "<skills_instructions>x</skills_instructions>" },
            { type: "input_text", text: "<plugins_instructions>y</plugins_instructions>" },
        ]);

        expect(text).toBe("<skills_instructions>x</skills_instructions>\n<plugins_instructions>y</plugins_instructions>");
    });

    test("ignores non-text content blocks", () => {
        const text = codexContentToInspectorText([
            { type: "input_text", text: "before" },
            { type: "image", text: "ignored" },
            { type: "output_text", text: "after" },
        ]);

        expect(text).toBe("before\nafter");
    });
});

describe("jsonlBlockToInspectorText", () => {
    test("preserves Claude task notifications inside tool_result blocks", () => {
        const text = [
            "<task-notification>",
            "<task-id>abc</task-id>",
            "<status>completed</status>",
            "<summary>Agent completed</summary>",
            "</task-notification>",
        ].join("\n");

        expect(jsonlBlockToInspectorText({
            type: "tool_result",
            content: [{ type: "text", text }],
        })).toBe(text);
    });

    test("keeps ordinary tool results in the local-command wrapper", () => {
        expect(jsonlBlockToInspectorText({
            type: "tool_result",
            content: "done",
        })).toBe("<local-command-stdout>done</local-command-stdout>");
    });
});
