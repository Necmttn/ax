import { describe, expect, test } from "bun:test";
import {
    CODEX_TIMELINE_EDIT_HINT_COMMANDS,
    EDIT_COMMANDS,
    EDIT_TOOL_NAMES,
    READ_COMMANDS,
    READ_TOOL_NAMES,
    canonicalEditToolName,
    editOrReadToolSqlFilter,
    editToolSqlFilter,
    isApplyPatchCall,
    isEditTool,
    isReadTool,
} from "@ax/lib/shared/tool-classes";
import { classifyToolFileEvidence, extractToolFileEvidence } from "../ingest/tool-file-evidence.ts";
import { classifyTool } from "../timeline/providers.ts";

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

// ---------------------------------------------------------------------------
// Drift guard: ingest (tool-file-evidence), timeline (providers), and metrics
// (the shared predicates) all consume @ax/lib/shared/tool-classes. These tests
// pin the BEHAVIOR of each consumer against the shared sets so a local
// override / re-fork in any consumer fails here.
// ---------------------------------------------------------------------------

/** Minimal ToolCallWrite for extractToolFileEvidence. */
const toolCallWrite = (toolName: string, commandNorm: string | null = null) => ({
    sessionId: "session-drift",
    provider: "test",
    toolName,
    toolKind: "tool",
    seq: 1,
    ts: "2026-06-10T00:00:00Z",
    inputJson: { file_path: "/tmp/drift.ts" },
    commandNorm,
    hasError: false,
});

describe("drift guard: edit sets across consumers", () => {
    test("every shared edit TOOL NAME is an edit in metrics, timeline, and ingest", () => {
        for (const name of EDIT_TOOL_NAMES) {
            // metrics predicate
            expect(isEditTool({ name })).toBe(true);
            // timeline classification (name check is source-independent)
            for (const source of ["claude", "codex", "cursor"] as const) {
                expect(classifyTool(source, { name, command_norm: null, command_text: null }).kind)
                    .toBe("file_edit");
            }
            // ingest file evidence emits an `edited` relation
            const evidence = extractToolFileEvidence([toolCallWrite(name)]);
            expect(evidence.map((e) => e.kind)).toContain("edited");
        }
    });

    test("every shared edit COMMAND is an edit in metrics, timeline, and ingest", () => {
        for (const command of EDIT_COMMANDS) {
            expect(isEditTool({ name: "exec_command", command_norm: command })).toBe(true);
            expect(
                classifyTool("codex", { name: "exec_command", command_norm: command, command_text: command }).kind,
            ).toBe("file_edit");
            const evidence = extractToolFileEvidence([toolCallWrite("exec_command", command)]);
            expect(evidence.map((e) => e.kind)).toContain("edited");
            // and never double-classified as a read by ingest
            expect(classifyToolFileEvidence({ name: "exec_command", commandNorm: command })).toEqual([]);
        }
    });

    test("timeline's edit-hint set is EXACTLY the shared edit commands + the named sed exception", () => {
        expect([...CODEX_TIMELINE_EDIT_HINT_COMMANDS].sort())
            .toEqual([...EDIT_COMMANDS, "sed"].sort());
    });

    test("THE sed DECISION: read for metrics + ingest, edit hint on the timeline only", () => {
        const sed = { name: "exec_command", command_norm: "sed" };
        // metrics boundaries: sed is a read, never an edit
        expect(isEditTool(sed)).toBe(false);
        expect(isReadTool(sed)).toBe(true);
        // ingest file evidence: read_file, not edited
        expect(classifyToolFileEvidence({ name: "exec_command", commandNorm: "sed" }))
            .toEqual(["read_file"]);
        // timeline keeps the explicit edit-hint exception
        expect(classifyTool("codex", { ...sed, command_text: "sed -i s/a/b/ x.ts" }).kind)
            .toBe("file_edit");
    });
});

describe("drift guard: read sets across consumers", () => {
    test("every shared read/search TOOL NAME is a read in metrics + ingest and noise on the timeline", () => {
        for (const name of READ_TOOL_NAMES) {
            expect(isReadTool({ name })).toBe(true);
            expect(classifyToolFileEvidence({ name }).length).toBeGreaterThan(0);
            expect(classifyTool("claude", { name, command_norm: null, command_text: null }).kind)
                .toBe("noise");
        }
    });

    test("every shared read/search COMMAND is a read in metrics + ingest", () => {
        for (const command of READ_COMMANDS) {
            expect(isReadTool({ name: "exec_command", command_norm: command })).toBe(true);
            expect(isReadTool({ name: "Bash", command_norm: command })).toBe(true);
            const kinds = classifyToolFileEvidence({ name: "exec_command", commandNorm: command });
            expect(kinds.length).toBeGreaterThan(0);
        }
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
