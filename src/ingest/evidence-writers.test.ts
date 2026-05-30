import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildSkillPlaceholderStatements,
    buildToolFileEvidenceStatements,
    buildToolCallStatements,
    recordRef,
    relateToolCallSkill,
} from "./evidence-writers.ts";

const TOOL_CALL_SCHEMA_FIELDS = new Set([
    "session",
    "turn",
    "agent_event",
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

function unescapedBacktickCount(value: string): number {
    let count = 0;
    let backslashes = 0;

    for (const char of value) {
        if (char === "\\") {
            backslashes += 1;
            continue;
        }

        if (char === "`" && backslashes % 2 === 0) {
            count += 1;
        }
        backslashes = 0;
    }

    return count;
}

function fakeClientForQueries(queries: string[]): SurrealClientShape {
    return {
        query: <T extends unknown[]>(sql: string) =>
            Effect.sync(() => {
                queries.push(sql);
                return (sql.startsWith("SELECT VALUE id") ? [[{ id: "skill:known" }]] : []) as T;
            }),
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
}

describe("evidence writer statement builders", () => {
    test("record refs escape unsafe key characters", () => {
        expect(recordRef("session", "session\na")).toBe("session:`session\\na`");
        expect(recordRef("session", "bad`key")).toBe("session:`bad\\`key`");
        expect(recordRef("session", "bad\\key")).toBe("session:`bad\\\\key`");
        expect(unescapedBacktickCount(recordRef("session", "bad`key"))).toBe(2);
    });

    test("tool call statements write hot command fields without schemafull extras", () => {
        const statements = buildToolCallStatements([
            {
                sessionId: "session-1\nunsafe",
                turnKey: "session1_`3",
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
        expect(sql).toContain("session: session:`session-1\\nunsafe`");
        expect(sql).toContain("turn: turn:`session1_\\`3`");
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

        expect(sql).not.toContain("DELETE concerns WHERE");
        expect(sql).toContain(`RELATE tool_call:\`session__call\`->concerns:\``);
        expect(sql).toContain(`->skill:\`${skillRecordKey("superpowers:test-driven-development")}\``);
        expect(sql).toContain("kind = \"invoked_skill\"");
        expect(sql).toContain("labels = \"{\\\"source\\\":\\\"codex\\\"}\"");
        expect(sql).toContain("metrics = \"{\\\"confidence\\\":1}\"");
        expect(sql).not.toContain("UPSERT skill:");
        expect(sql).not.toContain("scope: \"unknown\"");
        expect(sql).not.toContain("->invoked->");
    });

    test("tool file evidence statements share local file identity across edit read and search edges", () => {
        const statements = buildToolFileEvidenceStatements([
            {
                kind: "edited",
                sessionId: "session-1",
                turnKey: "turn-key",
                toolCallKey: "tool-call-edit",
                toolName: "apply_patch",
                ts: "2026-05-29T06:00:00.000Z",
                path: "/repo/src/a.ts",
                pathSeen: "src/a.ts",
                evidence: "tool_name:apply_patch",
            },
            {
                kind: "read_file",
                sessionId: "session-1",
                turnKey: "turn-key",
                toolCallKey: "tool-call-read",
                toolName: "Read",
                ts: "2026-05-29T06:00:01.000Z",
                path: "/repo/src/a.ts",
                pathSeen: "src/a.ts",
                evidence: "tool_name:Read",
                excerpt: "export const a = 1;",
            },
            {
                kind: "searched_file",
                sessionId: "session-1",
                turnKey: "turn-key",
                toolCallKey: "tool-call-grep",
                toolName: "Grep",
                ts: "2026-05-29T06:00:02.000Z",
                path: "/repo/src",
                pathSeen: "src",
                evidence: "tool_name:Grep",
            },
        ]);

        const sql = statements.join("\n");

        expect(sql.match(/UPSERT file:`/g)).toHaveLength(2);
        expect(sql).toContain('identity_scope: "local_path"');
        expect(sql).toContain("->edited:`");
        expect(sql).toContain("tool = \"apply_patch\"");
        expect(sql).toContain("path_seen = \"src/a.ts\"");
        expect(sql).toContain("absolute_path_seen = \"/repo/src/a.ts\"");
        expect(sql).toContain("->read_file:`");
        expect(sql).toContain("evidence = \"tool_name:Read\"");
        expect(sql).toContain("excerpt = \"export const a = 1;\"");
        expect(sql).toContain("->searched_file:`");
        expect(sql).toContain("evidence = \"tool_name:Grep\"");
    });

    test("placeholder skill statements are separate from relation statements", () => {
        const placeholderSql = buildSkillPlaceholderStatements(
            "superpowers:test-driven-development",
        ).join("\n");
        const relationSql = buildRelateToolCallSkillStatements({
            toolCallKey: "session__call",
            skillName: "superpowers:test-driven-development",
            ts: "2026-05-09T10:00:00.000Z",
        }).join("\n");

        expect(placeholderSql).toContain(
            `UPSERT skill:\`${skillRecordKey("superpowers:test-driven-development")}\` CONTENT`,
        );
        expect(placeholderSql).toContain("scope: \"unknown\"");
        expect(relationSql).not.toContain("scope: \"unknown\"");
        expect(relationSql).not.toContain("content_hash: \"unknown\"");
    });

    test("relateToolCallSkill skips placeholder creation for existing skills", async () => {
        const queries: string[] = [];
        const client = fakeClientForQueries(queries);

        await Effect.runPromise(
            relateToolCallSkill({
                toolCallKey: "session__call",
                skillName: "superpowers:test-driven-development",
                ts: "2026-05-09T10:00:00.000Z",
            }).pipe(Effect.provide(Layer.succeed(SurrealClient, client))),
        );

        expect(queries[0]).toContain(`SELECT VALUE id FROM skill:\`${skillRecordKey("superpowers:test-driven-development")}\``);
        expect(queries.slice(1).join("\n")).not.toContain("UPSERT skill:");
        expect(queries.slice(1).join("\n")).toContain("->concerns:");
    });

    test("plan snapshot statements persist snapshot items and item raw JSON", () => {
        const statements = buildPlanSnapshotStatements({
            planKey: "session-1__codex_update_plan`unsafe",
            sessionId: "session-1\nunsafe",
            source: "codex_update_plan",
            status: "in_progress",
            createdAt: "2026-05-09T10:00:00.000Z",
            updatedAt: "2026-05-09T10:01:00.000Z",
            snapshotKey: "session-1__plan__001`unsafe",
            toolCallKey: "session__call`unsafe",
            itemsJson: [{ content: "Inspect schema", status: "completed" }],
            explanation: "Following the statement-builder contract.",
            ts: "2026-05-09T10:01:00.000Z",
            items: [
                {
                    key: "session-1__item__001`unsafe",
                    externalId: "todo-1",
                    seq: 1,
                    content: "Inspect schema",
                    activeForm: "Inspecting schema",
                    status: "completed",
                },
            ],
        });

        const sql = statements.join("\n");

        expect(sql).toContain("UPSERT plan_snapshot:`session-1__plan__001\\`unsafe` CONTENT");
        expect(sql).toContain("session: session:`session-1\\nunsafe`");
        expect(sql).toContain("tool_call: tool_call:`session__call\\`unsafe`");
        expect(sql).toContain("items: \"[{\\\"content\\\":\\\"Inspect schema\\\",\\\"status\\\":\\\"completed\\\"}]\"");
        expect(sql).toContain("explanation: \"Following the statement-builder contract.\"");
        expect(sql).toContain("UPSERT plan_item:`session-1__item__001\\`unsafe` CONTENT");
        expect(sql).toContain("text: \"Inspect schema\"");
        expect(sql).toContain("raw: \"{\\\"key\\\":\\\"session-1__item__001`unsafe\\\",\\\"externalId\\\":\\\"todo-1\\\"");
    });

    test("plan snapshot statements remove legacy item ids that conflict on plan sequence", () => {
        const statements = buildPlanSnapshotStatements({
            planKey: "plan-key",
            sessionId: "session-1",
            source: "codex_update_plan",
            status: "in_progress",
            createdAt: "2026-05-09T10:00:00.000Z",
            updatedAt: "2026-05-09T10:00:00.000Z",
            snapshotKey: "snapshot-key",
            itemsJson: [],
            explanation: null,
            ts: "2026-05-09T10:00:00.000Z",
            items: [
                {
                    key: "plan-key__item_001",
                    seq: 1,
                    content: "Run tests again",
                    status: "in_progress",
                },
            ],
        });

        const sql = statements.join("\n");

        expect(sql).toContain(
            "DELETE plan_item WHERE plan = plan:`plan-key` AND seq = 1 AND id != plan_item:`plan-key__item_001`;",
        );
    });
});
