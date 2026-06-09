import { describe, expect, test } from "bun:test";
import { argPreview, categoryOf } from "./tool-presentation.ts";

describe("categoryOf", () => {
    test("maps known tool families", () => {
        expect(categoryOf("WebFetch")).toBe("net");
        expect(categoryOf("WebSearch")).toBe("net");
        expect(categoryOf("Read")).toBe("file");
        expect(categoryOf("Edit")).toBe("edit");
        expect(categoryOf("Write")).toBe("edit");
        expect(categoryOf("MultiEdit")).toBe("edit");
        expect(categoryOf("Bash")).toBe("sh");
        expect(categoryOf("Grep")).toBe("search");
        expect(categoryOf("Glob")).toBe("search");
        expect(categoryOf("ToolSearch")).toBe("search");
        expect(categoryOf("Task")).toBe("agent");
        expect(categoryOf("Agent")).toBe("agent");
    });
    test("unknown tool falls back to other", () => {
        expect(categoryOf("SomethingNovel")).toBe("other");
    });
    test("matches case-insensitively on known prefixes", () => {
        expect(categoryOf("mcp__server__web_search")).toBe("net");
    });
});

describe("argPreview", () => {
    test("WebFetch shows url", () => {
        expect(argPreview("WebFetch", { url: "https://paxel.ai/about" }, null)).toBe("https://paxel.ai/about");
    });
    test("Read shows path + offset/limit", () => {
        expect(argPreview("Read", { file_path: "src/exporter.ts", offset: 245, limit: 30 }, null))
            .toBe("src/exporter.ts:245 +30");
    });
    test("Bash shows the command", () => {
        expect(argPreview("Bash", null, "git status -s")).toBe("git status -s");
    });
    test("ToolSearch shows the query", () => {
        expect(argPreview("ToolSearch", { query: "select:WebFetch,WebSearch" }, null)).toBe("select:WebFetch,WebSearch");
    });
    test("Edit shows file_path", () => {
        expect(argPreview("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, null)).toBe("a.ts");
    });
    test("Task shows subagent_type + description", () => {
        expect(argPreview("Task", { subagent_type: "codebase-locator", description: "find tool rows" }, null))
            .toBe("codebase-locator: find tool rows");
    });
    test("generic input shows first non-empty key:value", () => {
        expect(argPreview("Unknown", { foo: "", bar: "baz" }, null)).toBe("bar: baz");
    });
    test("empty input + no command yields empty string", () => {
        expect(argPreview("Unknown", {}, null)).toBe("");
        expect(argPreview("Unknown", null, null)).toBe("");
    });
});
