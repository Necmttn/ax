import { describe, expect, test } from "bun:test";
import {
    agentEventRecordKey,
    buildAgentEventStatements,
} from "./provider-events.ts";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import {
    __testBuildPiBatchStatements,
    __testExtractPiJsonlLines,
    __testWalkJsonlFiles,
    textFromPiContent,
} from "./pi.ts";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";

describe("Pi JSONL extraction", () => {
    const extractAgentEventKeysAndSeqs = (statements: readonly string[]): { key: string; seq: number }[] =>
        statements.flatMap((statement) => {
            const match = statement.match(/^UPSERT agent_event:`([^`]+)` CONTENT \{[\s\S]*? seq: (\d+),/);
            return match ? [{ key: match[1]!, seq: Number(match[2]) }] : [];
        });

    test("textFromPiContent joins text blocks and ignores unknown blocks", () => {
        expect(textFromPiContent([
            { type: "text", text: "first" },
            { type: "thinking", thinking: "private chain" },
            { type: "toolCall", name: "bash" },
            { type: "text", text: "second" },
            { type: "image", url: "file:///tmp/image.png" },
        ])).toBe("first\nsecond");

        expect(textFromPiContent([{ type: "thinking", thinking: "hidden" }])).toBeNull();
    });

    test("extracts tree provider events, projected turns, model preference, and usage rollup", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-session",
                timestamp: "2026-05-29T06:00:00.000Z",
                cwd: "/Users/necmttn/Projects/ax",
            }),
            JSON.stringify({
                type: "model_change",
                id: "model-1",
                parentId: null,
                timestamp: "2026-05-29T06:00:01.000Z",
                provider: "openai-codex",
                modelId: "gpt-5.5",
            }),
            JSON.stringify({
                type: "custom",
                customType: "plannotator",
                data: { phase: "idle" },
                id: "custom-1",
                parentId: "model-1",
                timestamp: "2026-05-29T06:00:02.000Z",
            }),
            JSON.stringify({
                type: "message",
                id: "user-1",
                parentId: "custom-1",
                timestamp: "2026-05-29T06:00:03.000Z",
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: "Inspect the tree." },
                        { type: "unknown", value: "ignored" },
                    ],
                },
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-1",
                parentId: "user-1",
                timestamp: "2026-05-29T06:00:04.000Z",
                message: {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "hidden" },
                        { type: "text", text: "I will inspect it." },
                    ],
                    provider: "openai-codex",
                    model: "gpt-5.5",
                    usage: {
                        input: 10,
                        output: 5,
                        cacheRead: 2,
                        cacheWrite: 3,
                        totalTokens: 20,
                    },
                },
            }),
            JSON.stringify({
                type: "model_change",
                id: "model-2",
                parentId: "assistant-1",
                timestamp: "2026-05-29T06:00:05.000Z",
                provider: "anthropic",
                modelId: "claude-opus-4-7",
            }),
            JSON.stringify({
                type: "message",
                id: "tool-result-1",
                parentId: "assistant-1",
                timestamp: "2026-05-29T06:00:06.000Z",
                message: {
                    role: "toolResult",
                    toolCallId: "call-read",
                    toolName: "read",
                    content: [{ type: "text", text: "file contents" }],
                    isError: false,
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.session).toMatchObject({
            id: "pi-session",
            version: 3,
            cwd: "/Users/necmttn/Projects/ax",
            started_at: "2026-05-29T06:00:00.000Z",
            ended_at: "2026-05-29T06:00:06.000Z",
            model: "claude-opus-4-7",
        });
        expect(extracted.usage).toEqual({
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 3,
            totalTokens: 20,
        });

        expect(extracted.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            parentProviderEventId: event.parentProviderEventId,
            seq: event.seq,
            type: event.type,
            role: event.role,
            textExcerpt: event.textExcerpt,
        }))).toEqual([
            {
                providerEventId: "model-1",
                parentProviderEventId: null,
                seq: 1,
                type: "model_change",
                role: null,
                textExcerpt: null,
            },
            {
                providerEventId: "custom-1",
                parentProviderEventId: "model-1",
                seq: 2,
                type: "custom",
                role: null,
                textExcerpt: null,
            },
            {
                providerEventId: "user-1",
                parentProviderEventId: "custom-1",
                seq: 3,
                type: "message",
                role: "user",
                textExcerpt: "Inspect the tree.",
            },
            {
                providerEventId: "assistant-1",
                parentProviderEventId: "user-1",
                seq: 4,
                type: "message",
                role: "assistant",
                textExcerpt: "I will inspect it.",
            },
            {
                providerEventId: "model-2",
                parentProviderEventId: "assistant-1",
                seq: 5,
                type: "model_change",
                role: null,
                textExcerpt: null,
            },
            {
                providerEventId: "tool-result-1",
                parentProviderEventId: "assistant-1",
                seq: 6,
                type: "message",
                role: "toolResult",
                textExcerpt: "file contents",
            },
        ]);

        expect(extracted.providerEvents[3]?.metrics).toMatchObject({
            turnSeq: 4,
            usage: {
                input: 10,
                output: 5,
                cacheRead: 2,
                cacheWrite: 3,
                totalTokens: 20,
            },
        });

        expect(extracted.turns.map((turn) => ({
            seq: turn.seq,
            role: turn.role,
            message_kind: turn.message_kind,
            intent_kind: turn.intent_kind,
            text: turn.text,
            has_tool_use: turn.has_tool_use,
            has_error: turn.has_error,
        }))).toEqual([
            {
                seq: 3,
                role: "user",
                message_kind: "task",
                intent_kind: "organic_task",
                text: "Inspect the tree.",
                has_tool_use: false,
                has_error: false,
            },
            {
                seq: 4,
                role: "assistant",
                message_kind: "assistant",
                intent_kind: "assistant",
                text: "I will inspect it.",
                has_tool_use: false,
                has_error: false,
            },
            {
                seq: 6,
                role: "tool_result",
                message_kind: "tool_result",
                intent_kind: "tool_result",
                text: "file contents",
                has_tool_use: false,
                has_error: false,
            },
        ]);

        const statements = buildAgentEventStatements({
            sessions: [],
            events: extracted.providerEvents,
        });
        const customEventKey = agentEventRecordKey({
            provider: "pi",
            providerSessionId: "pi-session",
            providerEventId: "custom-1",
            seq: 2,
        });
        const userEventKey = agentEventRecordKey({
            provider: "pi",
            providerSessionId: "pi-session",
            providerEventId: "user-1",
            seq: 3,
        });
        const edgeStatements = statements.filter((statement) =>
            statement.startsWith("RELATE agent_event:"),
        );

        expect(edgeStatements).toHaveLength(5);
        expect(edgeStatements.join("\n")).toContain(
            `RELATE agent_event:\`${customEventKey}\``,
        );
        expect(edgeStatements.join("\n")).toContain(`->agent_event:\`${userEventKey}\``);
    });

    test("invalid timestamps use safe fallbacks with warnings and do not throw", () => {
        expect(() => __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-invalid-timestamps",
                timestamp: "not-a-date",
                cwd: "/tmp/project",
            }),
            JSON.stringify({
                type: "message",
                id: "user-invalid-string",
                parentId: null,
                timestamp: "also-not-a-date",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "First safe fallback." }],
                },
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-invalid-number",
                parentId: "user-invalid-string",
                message: {
                    role: "assistant",
                    timestamp: 1e100,
                    content: [{ type: "text", text: "Second safe fallback." }],
                },
            }),
        ])).not.toThrow();

        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-invalid-timestamps",
                timestamp: "not-a-date",
                cwd: "/tmp/project",
            }),
            JSON.stringify({
                type: "message",
                id: "user-invalid-string",
                parentId: null,
                timestamp: "also-not-a-date",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "First safe fallback." }],
                },
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-invalid-number",
                parentId: "user-invalid-string",
                message: {
                    role: "assistant",
                    timestamp: 1e100,
                    content: [{ type: "text", text: "Second safe fallback." }],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.session.started_at).toBe("1970-01-01T00:00:00.000Z");
        expect(extracted.session.ended_at).toBe("1970-01-01T00:00:00.000Z");
        expect(extracted.turns.map((turn) => turn.ts)).toEqual([
            "1970-01-01T00:00:00.000Z",
            "1970-01-01T00:00:00.000Z",
        ]);
        expect(extracted.providerEvents.map((event) => event.ts)).toEqual([
            "1970-01-01T00:00:00.000Z",
            "1970-01-01T00:00:00.000Z",
        ]);
        expect(extracted.warnings).toEqual([
            expect.stringContaining("invalid session timestamp"),
            expect.stringContaining("invalid entry timestamp"),
            expect.stringContaining("invalid message timestamp"),
        ]);
    });

    test("projects assistant toolCall blocks, tool results, synthetic skills, and token usage statements", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-tools",
                timestamp: "2026-05-29T07:00:00.000Z",
                cwd: "/Users/necmttn/Projects/ax",
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-tools",
                parentId: null,
                timestamp: "2026-05-29T07:00:01.000Z",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Reading the file." },
                        {
                            type: "toolCall",
                            id: "call-read",
                            name: "read",
                            input: { path: "src/ingest/pi.ts" },
                        },
                    ],
                    model: "gpt-5.5",
                    usage: {
                        input: 12,
                        output: 7,
                        cacheRead: 2,
                        cacheWrite: 1,
                    },
                },
            }),
            JSON.stringify({
                type: "message",
                id: "tool-result-read",
                parentId: "assistant-tools",
                timestamp: "2026-05-29T07:00:02.000Z",
                message: {
                    role: "toolResult",
                    toolCallId: "call-read",
                    toolName: "read",
                    content: [{ type: "text", text: "pi source" }],
                    isError: false,
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const toolCallKey = toolCallRecordKey({
            sessionId: "pi-tools",
            seq: 1,
            callId: "call-read",
        });

        expect(extracted.turns[0]).toMatchObject({
            seq: 1,
            role: "assistant",
            has_tool_use: true,
        });
        expect(extracted.toolCalls).toHaveLength(1);
        expect(extracted.toolCalls[0]).toMatchObject({
            provider: "pi",
            toolName: "read",
            toolKind: "unknown",
            sessionId: "pi-tools",
            seq: 1,
            turnKey: turnRecordKey("pi-tools", 1),
            callId: "call-read",
            inputJson: { path: "src/ingest/pi.ts" },
            outputExcerpt: "pi source",
            hasError: false,
        });
        expect(extracted.toolCalls[0]?.agentEventKey).toBe(agentEventRecordKey({
            provider: "pi",
            providerSessionId: "pi-tools",
            providerEventId: "call-read",
            seq: 1000001001,
        }));
        expect(extracted.invocations).toEqual([
            {
                session: "pi-tools",
                seq: 1,
                ts: "2026-05-29T07:00:01.000Z",
                skill: "pi:read",
                args: { path: "src/ingest/pi.ts" },
            },
        ]);
        expect(extracted.skillRelations).toEqual([
            {
                toolCallKey,
                skillName: "pi:read",
                ts: "2026-05-29T07:00:01.000Z",
                reason: "Pi tool call",
                labels: {
                    provider: "pi",
                    toolName: "read",
                    source: "pi_jsonl",
                },
                metrics: { turnSeq: 1 },
            },
        ]);

        const sql = __testBuildPiBatchStatements(extracted).join("\n");
        expect(sql).toContain("UPSERT tool_call:");
        expect(sql).toContain("name: \"pi:read\"");
        expect(sql).toContain("scope: \"pi-tool\"");
        expect(sql).toContain("->invoked:");
        expect(sql).toContain("session = session:`pi-tools`");
        expect(sql).toContain("->concerns:");
        expect(sql).toContain("UPSERT session_token_usage:`pi_tools`");
        expect(sql).toContain("prompt_tokens: 12");
        expect(sql).toContain("completion_tokens: 7");
        expect(sql).toContain("cache_read_input_tokens: 2");
        expect(sql).toContain("cache_creation_input_tokens: 1");
        expect(sql).toContain("estimated_tokens: 19");
        expect(sql).toContain('\\"token_source_quality\\":\\"explicit\\"');
        expect(sql).toContain('\\"token_source_detail\\":\\"pi_usage_fields\\"');
    });

    test("provider event keys and session seqs are stable and unique across repeated statement generation", () => {
        const lines = [
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-idempotent",
                timestamp: "2026-05-29T07:00:00.000Z",
                cwd: "/Users/necmttn/Projects/ax",
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-idempotent",
                parentId: null,
                timestamp: "2026-05-29T07:00:01.000Z",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Reading." },
                        {
                            type: "toolCall",
                            id: "call-read",
                            name: "read",
                            input: { path: "src/ingest/pi.ts" },
                        },
                    ],
                },
            }),
            JSON.stringify({
                type: "message",
                id: "tool-result-read",
                parentId: "assistant-idempotent",
                timestamp: "2026-05-29T07:00:02.000Z",
                message: {
                    role: "toolResult",
                    toolCallId: "call-read",
                    toolName: "read",
                    content: [{ type: "text", text: "pi source" }],
                },
            }),
        ];
        const first = __testExtractPiJsonlLines(lines);
        const second = __testExtractPiJsonlLines(lines);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        if (!first || !second) return;

        const firstEvents = extractAgentEventKeysAndSeqs(__testBuildPiBatchStatements(first));
        const secondEvents = extractAgentEventKeysAndSeqs(__testBuildPiBatchStatements(second));

        expect(firstEvents).toEqual(secondEvents);
        expect(new Set(firstEvents.map((event) => event.key)).size).toBe(firstEvents.length);
        expect(new Set(firstEvents.map((event) => event.seq)).size).toBe(firstEvents.length);
        expect(firstEvents.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2, 1000001001]);
    });

    test("writes shared read and search file evidence for Pi tool calls", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-file-evidence",
                timestamp: "2026-05-29T06:00:00.000Z",
                cwd: "/Users/necmttn/Projects/ax",
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-file-evidence",
                parentId: null,
                timestamp: "2026-05-29T06:00:01.000Z",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "call-read",
                            name: "read",
                            input: { path: "src/ingest/pi.ts" },
                        },
                        {
                            type: "toolCall",
                            id: "call-grep",
                            name: "grep",
                            input: { pattern: "needle", path: "src/ingest" },
                        },
                    ],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const sql = __testBuildPiBatchStatements(extracted).join("\n");
        expect(sql).toContain("->read_file:`");
        expect(sql).toContain("path_seen = \"src/ingest/pi.ts\"");
        expect(sql).toContain("absolute_path_seen = \"/Users/necmttn/Projects/ax/src/ingest/pi.ts\"");
        expect(sql).toContain("evidence = \"tool_name:read\"");
        expect(sql).toContain("->searched_file:`");
        expect(sql).toContain("path_seen = \"src/ingest\"");
        expect(sql).toContain("absolute_path_seen = \"/Users/necmttn/Projects/ax/src/ingest\"");
        expect(sql).toContain("evidence = \"tool_name:grep\"");
    });

    test("turn statements escape session ids and timestamps through shared Surreal helpers", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi`session\nunsafe",
                timestamp: "2026-05-29T06:00:00.000Z",
                cwd: "/tmp/project",
            }),
            JSON.stringify({
                type: "message",
                id: "user-1",
                parentId: null,
                timestamp: "2026-05-29T06:00:01.000Z",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "Escaped session id." }],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const turnStatement = __testBuildPiBatchStatements(extracted)
            .find((statement) => statement.startsWith("UPSERT turn:"));

        expect(turnStatement).toContain("session: session:`pi\\`session\\nunsafe`");
        expect(turnStatement).toContain('ts: d"2026-05-29T06:00:01.000Z"');
        expect(turnStatement).not.toContain("session: session:`pi`session");
    });
});

describe("Pi JSONL directory walk (no-follow symlink semantics)", () => {
    const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

    const walk = (root: string): Promise<{ path: string }[]> =>
        Effect.runPromise(__testWalkJsonlFiles(root, 0).pipe(Effect.provide(BunFsLayer)));

    // Regression: the old walk classified entries via `Dirent.isDirectory()` /
    // `isFile()` which do NOT follow symlinks. The @effect/platform migration
    // briefly used `fs.stat().type` (FOLLOWS), which would (a) recurse into a
    // symlinked dir → escape the tree / hang on a cycle, and (b) ingest a
    // symlinked `.jsonl`. classifyNoFollow restores Dirent semantics.
    test("skips a symlinked directory and a symlinked .jsonl under piDir", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-pi-walk-"));
        const piDir = join(base, "pi");
        await mkdir(piDir, { recursive: true });

        // A real .jsonl is collected.
        await writeFile(join(piDir, "real.jsonl"), "{}\n");

        // An out-of-tree dir with a .jsonl we must NOT reach via a symlinked dir.
        const outside = join(base, "outside");
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, "leak.jsonl"), "{}\n");
        await symlink(outside, join(piDir, "linked-dir"));

        // A symlinked .jsonl pointing at a real .jsonl must be skipped (the link
        // is not a real file per Dirent semantics).
        await symlink(join(outside, "leak.jsonl"), join(piDir, "linked.jsonl"));

        const found = (await walk(piDir)).map((f) => f.path).sort();

        expect(found).toEqual([join(piDir, "real.jsonl")]);
        expect(found.some((p) => p.includes("leak.jsonl"))).toBe(false);
        expect(found.some((p) => p.includes("linked.jsonl"))).toBe(false);
    });

    // A symlink CYCLE must not hang: the cycle link classifies as "SymbolicLink"
    // and is never recursed into, so the walk terminates.
    test("does not infinitely recurse on a symlink cycle", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-pi-cycle-"));
        const piDir = join(base, "pi");
        const sub = join(piDir, "sub");
        await mkdir(sub, { recursive: true });
        await writeFile(join(sub, "ok.jsonl"), "{}\n");
        // sub/loop -> piDir (a cycle).
        await symlink(piDir, join(sub, "loop"));

        const found = (await walk(piDir)).map((f) => f.path);

        expect(found).toEqual([join(sub, "ok.jsonl")]);
    });
});

describe("pi compaction", () => {
    test("type:compaction produces a compaction row (no duplicate provider event)", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({ type: "session", id: "pi-1", timestamp: 1748498738132, cwd: "/tmp" }),
            JSON.stringify({ type: "compaction", id: "c1", parentId: "p0", timestamp: 1748498800000, summary: "Goal: ship X", firstKeptEntryId: "entry-7", tokensBefore: 90000, fromHook: false, details: { readFiles: ["a.ts"], modifiedFiles: [] } }),
        ]);
        expect(extracted).not.toBeNull();
        expect(extracted!.compactions.length).toBe(1);
        const c = extracted!.compactions[0];
        expect(c.strategy).toBe("summarize");
        expect(c.summary).toBe("Goal: ship X");
        expect(c.boundaryRef).toBe("entry-7");
        expect(c.tokensBefore).toBe(90000);
        expect(c.readFiles).toEqual(["a.ts"]);
        expect(c.modifiedFiles).toEqual([]);
        expect(extracted!.providerEvents.filter((e) => e.type === "compaction").length).toBe(1);

        const eventKey = agentEventRecordKey({
            provider: "pi",
            providerSessionId: "pi-1",
            providerEventId: "c1",
            seq: 1,
        });
        expect(c.agentEventKey).toBe(eventKey);
    });
});
