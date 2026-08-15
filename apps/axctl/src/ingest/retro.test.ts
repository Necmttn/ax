import { describe, expect, test } from "bun:test";
import { composeHeuristicRetro } from "./retro.ts";

const baseStat = {
    id: "session:abc",
    project: "ax",
    repository: null,
    turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    corrections: 0,
    distinct_tools: 0,
    distinct_files_edited: 0,
    top_tool: null,
    top_tool_count: 0,
    top_failed_tool: null,
    top_failed_tool_count: 0,
    top_file: null,
    produced_commits: 0,
    friction_kinds: [] as string[],
};

describe("composeHeuristicRetro", () => {
    test("empty session yields a tried summary but null worked/failed/next", () => {
        const r = composeHeuristicRetro({ ...baseStat, turns: 1 });
        expect(r.tried).toBe("1 turn(s)");
        expect(r.worked).toBeNull();
        expect(r.failed).toBeNull();
        expect(r.next).toBeNull();
    });

    test("clean tool usage with a commit -> worked text mentions commit", () => {
        const r = composeHeuristicRetro({
            ...baseStat,
            turns: 12,
            tool_calls: 20,
            distinct_tools: 4,
            top_tool: "Bash",
            top_tool_count: 7,
            top_file: "src/x.ts",
            distinct_files_edited: 3,
            produced_commits: 2,
        });
        expect(r.tried).toContain("12 turn(s)");
        expect(r.tried).toContain("Bash ×7");
        expect(r.tried).toContain("4 distinct tools");
        expect(r.tried).toContain("src/x.ts");
        expect(r.tried).toContain("3 files edited");
        expect(r.worked).toBe("2 commit(s) landed");
        expect(r.failed).toBeNull();
        expect(r.next).toBeNull();
    });

    test("recurring tool failure -> next suggests a pre-tool guard", () => {
        const r = composeHeuristicRetro({
            ...baseStat,
            turns: 30,
            tool_calls: 50,
            tool_errors: 5,
            top_failed_tool: "Bash",
            top_failed_tool_count: 5,
            friction_kinds: ["tool_error", "user_correction"],
        });
        expect(r.failed).toContain("Bash failed ×5");
        expect(r.failed).toContain("friction kinds: tool_error, user_correction");
        expect(r.next).toMatch(/package a pre-Bash guard/);
    });

    test("repeated user corrections (no tool failure) -> next suggests guidance skill", () => {
        const r = composeHeuristicRetro({
            ...baseStat,
            turns: 20,
            tool_calls: 30,
            corrections: 4,
        });
        expect(r.failed).toContain("4 user correction(s)");
        expect(r.next).toMatch(/guidance skill/);
    });
});
