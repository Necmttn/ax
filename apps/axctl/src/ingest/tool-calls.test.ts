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
        expect(toolKindForName("view_image")).toBe("builtin");
        expect(toolKindForName("update_plan")).toBe("builtin");
        expect(toolKindForName("get_goal")).toBe("builtin");
        expect(toolKindForName("list_mcp_resources")).toBe("builtin");
        expect(toolKindForName("spawn_agent")).toBe("builtin");
        expect(toolKindForName("wait_agent")).toBe("builtin");
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

    test("Script completed output is not flagged an error even when it mentions failed/error-handling/not found", () => {
        const result = parseCodexFunctionOutput(
            "Script completed in 0.2 seconds:\n" +
                "tests/error-handling.test.ts .... 12 passed, 0 failed\n" +
                "0 \"not found\" warnings\n" +
                "Wall time: 0.2 seconds",
        );
        expect(result.hasError).toBe(false);
        expect(result.exitCode).toBeNull();
        expect(result.durationMs).toBe(200);
    });

    test("Script failed output remains an error", () => {
        const result = parseCodexFunctionOutput(
            "Script failed in 0.1 seconds:\nTraceback...\nWall time: 0.1 seconds",
        );
        expect(result.hasError).toBe(true);
    });

    test("Script running with cell ID is a pending, non-error result", () => {
        const result = parseCodexFunctionOutput(
            "Script running with cell ID abc-123. Check back later for output.",
        );
        expect(result.hasError).toBe(false);
        expect(result.exitCode).toBeNull();
    });

    test("legacy exit code 0 with error-ish words in output remains a success", () => {
        const result = parseCodexFunctionOutput(
            "Process exited with code 0\nOutput:\n1 test failed but was retried and passed\n",
        );
        expect(result.hasError).toBe(false);
        expect(result.exitCode).toBe(0);
    });

    test("legacy nonzero exit code remains an error", () => {
        const result = parseCodexFunctionOutput(
            "Process exited with code 1\nOutput:\nall good here\n",
        );
        expect(result.hasError).toBe(true);
        expect(result.exitCode).toBe(1);
    });

    test("parses Wall time with and without a colon", () => {
        expect(
            parseCodexFunctionOutput("Script completed\nWall time: 0.2 seconds").durationMs,
        ).toBe(200);
        expect(
            parseCodexFunctionOutput("Script completed\nWall time 0.2 seconds").durationMs,
        ).toBe(200);
    });
});
