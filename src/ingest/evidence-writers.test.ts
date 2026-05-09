import { describe, expect, test } from "bun:test";
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildToolCallStatements,
} from "./evidence-writers.ts";

const TOOL_CALL_SCHEMA_FIELDS = new Set([
    "session",
    "turn",
    "tool",
    "name",
    "seq",
    "call_id",
    "ts",
    "status",
    "input_json",
    "output_json",
    "raw",
    "duration_ms",
    "cwd",
    "command_text",
    "command_norm",
    "command_tool",
    "output_excerpt",
    "error_text",
    "exit_code",
    "has_error",
]);

function contentFields(statement: string): string[] {
    const body = (statement.match(/CONTENT \{([\s\S]*)\};/)?.[1] ?? "").trim();
    return [...body.matchAll(/(?:^|, )([a-z_]+):/g)].map((match) => match[1]);
}

describe("evidence writer statement builders", () => {
    test("tool call statements write hot command fields without schemafull extras", () => {
        const statements = buildToolCallStatements([
            {
                sessionId: "session-1",
                turnKey: "session1_3",
                provider: "codex",
                toolName: "exec_command",
                toolKind: "builtin",
                seq: 7,
                callId: "call-abc",
                ts: "2026-05-09T10:00:00.000Z",
                cwd: "/tmp/project",
                inputJson: { cmd: "git status --short" },
                outputJson: { stdout: " M src/index.ts" },
                rawJson: { type: "function_call" },
                commandText: "git status --short",
                commandNorm: "git status",
                commandToolName: "git",
                outputExcerpt: "M src/index.ts",
                errorText: "fatal: not a git repository",
                exitCode: 128,
                durationMs: 42,
                hasError: true,
            },
        ]);

        const sql = statements.join("\n");
        const toolCallStatement = statements.find((statement) =>
            statement.startsWith("UPSERT tool_call:`"),
        );

        expect(sql).toContain("command_norm: \"git status\"");
        expect(sql).toContain("exit_code: 128");
        expect(sql).toContain("has_error: true");
        expect(sql).toContain("command_tool: tool:`");
        expect(sql).toContain("status: \"error\"");
        expect(toolCallStatement).toBeDefined();
        expect(contentFields(toolCallStatement ?? "")).toEqual(
            expect.arrayContaining([...TOOL_CALL_SCHEMA_FIELDS]),
        );
        for (const field of contentFields(toolCallStatement ?? "")) {
            expect(TOOL_CALL_SCHEMA_FIELDS.has(field)).toBe(true);
        }
    });

    test("tool-call-to-skill relation uses concerns instead of invoked", () => {
        const statements = buildRelateToolCallSkillStatements({
            toolCallKey: "session__call",
            skillName: "superpowers:test-driven-development",
            ts: "2026-05-09T10:00:00.000Z",
            reason: "Skill tool call referenced the TDD workflow.",
            labels: { source: "codex" },
            metrics: { confidence: 1 },
        });

        const sql = statements.join("\n");

        expect(sql).toContain("UPSERT skill:`superpowers__test-driven-development` MERGE");
        expect(sql).toContain("DELETE concerns WHERE");
        expect(sql).toContain("RELATE tool_call:`session__call`->concerns->skill:`superpowers__test-driven-development`");
        expect(sql).toContain("kind = \"invoked_skill\"");
        expect(sql).toContain("labels = \"{\\\"source\\\":\\\"codex\\\"}\"");
        expect(sql).toContain("metrics = \"{\\\"confidence\\\":1}\"");
        expect(sql).not.toContain("->invoked->");
    });

    test("plan snapshot statements persist snapshot items and item raw JSON", () => {
        const statements = buildPlanSnapshotStatements({
            planKey: "session-1__codex_update_plan",
            sessionId: "session-1",
            source: "codex_update_plan",
            status: "in_progress",
            createdAt: "2026-05-09T10:00:00.000Z",
            updatedAt: "2026-05-09T10:01:00.000Z",
            snapshotKey: "session-1__plan__001",
            toolCallKey: "session__call",
            itemsJson: [{ content: "Inspect schema", status: "completed" }],
            explanation: "Following the statement-builder contract.",
            ts: "2026-05-09T10:01:00.000Z",
            items: [
                {
                    key: "session-1__item__001",
                    externalId: "todo-1",
                    seq: 1,
                    content: "Inspect schema",
                    activeForm: "Inspecting schema",
                    status: "completed",
                },
            ],
        });

        const sql = statements.join("\n");

        expect(sql).toContain("UPSERT plan_snapshot:`session-1__plan__001` CONTENT");
        expect(sql).toContain("tool_call: tool_call:`session__call`");
        expect(sql).toContain("items: \"[{\\\"content\\\":\\\"Inspect schema\\\",\\\"status\\\":\\\"completed\\\"}]\"");
        expect(sql).toContain("explanation: \"Following the statement-builder contract.\"");
        expect(sql).toContain("UPSERT plan_item:`session-1__item__001` CONTENT");
        expect(sql).toContain("text: \"Inspect schema\"");
        expect(sql).toContain("raw: \"{\\\"key\\\":\\\"session-1__item__001\\\",\\\"externalId\\\":\\\"todo-1\\\"");
    });
});
