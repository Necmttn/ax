import { describe, expect, test } from "bun:test";
import {
    extractCommandTool,
    normalizeCommand,
    parseCodexFunctionOutput,
    toolKindForName,
} from "./tool-calls.ts";

describe("tool call normalization", () => {
    test("classifies known tool name shapes", () => {
        expect(toolKindForName("Bash")).toBe("builtin");
        expect(toolKindForName("exec_command")).toBe("builtin");
        expect(toolKindForName("write_stdin")).toBe("builtin");
        expect(toolKindForName("apply_patch")).toBe("builtin");
        expect(toolKindForName("mcp__browser__open")).toBe("mcp");
        expect(toolKindForName("Skill")).toBe("skill");
        expect(toolKindForName("/insights")).toBe("slash_command");
    });

    test("extracts the executable tool from shell commands", () => {
        expect(extractCommandTool("git status --short")).toBe("git");
        expect(extractCommandTool("bun test src/ingest/tool-calls.test.ts")).toBe("bun");
        expect(extractCommandTool("cd src && bun test")).toBe("bun");
        expect(extractCommandTool("cd src\nbun test")).toBe("bun");
        expect(extractCommandTool("time -p git status")).toBe("git");
    });

    test("normalizes shell commands to stable command patterns", () => {
        expect(normalizeCommand("git status --short")).toBe("git status");
        expect(normalizeCommand("bun test src/ingest/tool-calls.test.ts")).toBe("bun test");
        expect(normalizeCommand("cd src\nbun test")).toBe("bun test");
        expect(normalizeCommand("time -p git status")).toBe("git status");
        expect(normalizeCommand("surreal sql --endpoint http://127.0.0.1:8521")).toBe(
            "surreal sql",
        );
    });

    test("parses Codex function output metadata and excerpt", () => {
        expect(
            parseCodexFunctionOutput(
                "Chunk ID: abc\nWall time: 0.1000 seconds\nProcess exited with code 2\nOriginal token count: 30\nOutput:\nrg: missing\n",
            ),
        ).toEqual({
            exitCode: 2,
            durationMs: 100,
            outputExcerpt: "rg: missing",
            hasError: true,
        });
    });
});
