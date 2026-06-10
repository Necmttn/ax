import { describe, expect, test } from "bun:test";
import { classifyToolFileEvidence } from "../ingest/tool-file-evidence.ts";
import {
    canonicalEditToolName,
    editOrReadToolSqlFilter,
    editToolSqlFilter,
    isApplyPatchCall,
    isEditTool,
    isReadTool,
} from "./tool-classes.ts";

describe("isEditTool", () => {
    test("Claude edit tool names (any casing)", () => {
        for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write"]) {
            expect(isEditTool({ name })).toBe(true);
        }
    });
    test("codex apply_patch as a tool name", () => {
        expect(isEditTool({ name: "apply_patch" })).toBe(true);
    });
    test("codex/pi shell edits via command_norm", () => {
        for (const command_norm of ["apply_patch", "tee", "patch", "dd"]) {
            expect(isEditTool({ name: "exec_command", command_norm })).toBe(true);
        }
    });
    test("cursor edit tools", () => {
        expect(isEditTool({ name: "edit_file" })).toBe(true);
        expect(isEditTool({ name: "apply_diff" })).toBe(true);
    });
    test("reads / plain shell are not edits", () => {
        expect(isEditTool({ name: "Read" })).toBe(false);
        expect(isEditTool({ name: "exec_command", command_norm: "rg" })).toBe(false);
        expect(isEditTool({ name: "Bash", command_norm: "bun" })).toBe(false);
        expect(isEditTool({ name: "Bash", command_norm: null })).toBe(false);
    });
});

describe("isReadTool", () => {
    test("Claude read/search tool names", () => {
        for (const name of ["Read", "Grep", "Glob"]) expect(isReadTool({ name })).toBe(true);
    });
    test("shell reads/searches via command_norm (codex exec_command, claude Bash)", () => {
        for (const command_norm of ["cat", "sed", "nl", "head", "tail", "less", "rg", "grep", "git grep", "fd", "find"]) {
            expect(isReadTool({ name: "exec_command", command_norm })).toBe(true);
            expect(isReadTool({ name: "Bash", command_norm })).toBe(true);
        }
    });
    test("edit classification wins over read", () => {
        expect(isReadTool({ name: "apply_patch" })).toBe(false);
        expect(isReadTool({ name: "Read", command_norm: "apply_patch" })).toBe(false);
    });
    test("plain shell / other tools are not reads", () => {
        expect(isReadTool({ name: "Bash", command_norm: "bun" })).toBe(false);
        expect(isReadTool({ name: "TodoWrite" })).toBe(false);
        expect(isReadTool({ name: "exec_command", command_norm: null })).toBe(false);
    });
    test("agrees with the ingest file-evidence classifier on read/search inputs", () => {
        // Every input the file-evidence classifier marks read/search must be a
        // metrics read too (modulo edit precedence) - guards set drift.
        const inputs = [
            { name: "Read", commandNorm: null },
            { name: "grep", commandNorm: null },
            { name: "Glob", commandNorm: null },
            { name: "Bash", commandNorm: "cat" },
            { name: "Bash", commandNorm: "sed" },
            { name: "exec_command", commandNorm: "rg" },
            { name: "exec_command", commandNorm: "git grep" },
            { name: "Bash", commandNorm: "fd" },
        ];
        for (const input of inputs) {
            const evidenceKinds = classifyToolFileEvidence(input);
            expect(evidenceKinds.length).toBeGreaterThan(0);
            expect(isReadTool({ name: input.name, command_norm: input.commandNorm })).toBe(true);
        }
    });
});

describe("isApplyPatchCall", () => {
    test("matches the tool name and the exec command form", () => {
        expect(isApplyPatchCall({ name: "apply_patch" })).toBe(true);
        expect(isApplyPatchCall({ name: "exec_command", command_norm: "apply_patch" })).toBe(true);
        expect(isApplyPatchCall({ name: "Edit" })).toBe(false);
        expect(isApplyPatchCall({ name: "exec_command", command_norm: "tee" })).toBe(false);
    });
});

describe("canonicalEditToolName", () => {
    test("maps provider-cased edit names onto Claude casing", () => {
        expect(canonicalEditToolName("edit")).toBe("Edit");
        expect(canonicalEditToolName("Write")).toBe("Write");
        expect(canonicalEditToolName("multiedit")).toBe("MultiEdit");
        expect(canonicalEditToolName("NOTEBOOKEDIT")).toBe("NotebookEdit");
    });
    test("passes unknown names through", () => {
        expect(canonicalEditToolName("apply_patch")).toBe("apply_patch");
        expect(canonicalEditToolName("edit_file")).toBe("edit_file");
    });
});

describe("SQL filter fragments", () => {
    test("edit filter covers names + commands and is deref-free", () => {
        expect(editToolSqlFilter).toContain("string::lowercase(name)");
        expect(editToolSqlFilter).toContain('"apply_patch"');
        expect(editToolSqlFilter).toContain("command_norm IN");
        expect(editToolSqlFilter).not.toMatch(/\bin\.|\bout\./);
    });
    test("edit-or-read filter additionally covers read names + commands", () => {
        expect(editOrReadToolSqlFilter).toContain('"read"');
        expect(editOrReadToolSqlFilter).toContain('"rg"');
        expect(editOrReadToolSqlFilter).toContain('"git grep"');
        expect(editOrReadToolSqlFilter).not.toMatch(/\bin\.|\bout\./);
    });
});
