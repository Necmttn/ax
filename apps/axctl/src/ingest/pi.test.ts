import { describe, expect, test } from "bun:test";
import { SkillName } from "@ax/lib/brands";
import {
    agentEventRecordKey,
} from "./provider-events.ts";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import {
    __testExtractPiJsonlLines,
    OMP_PROVIDER,
    ompStage,
    piStage,
    textFromPiContent,
    toPiNormalizedBatch,
} from "./pi.ts";

const normalizedPiBatch = (
    extract: Parameters<typeof toPiNormalizedBatch>[0],
    desc?: Parameters<typeof toPiNormalizedBatch>[1],
) => toPiNormalizedBatch(extract, desc);

// Fixture skill names are plain string literals; brand via the schema constructor.
const sn = (s: string): SkillName => SkillName.make(s);

describe("Pi JSONL extraction", () => {
    const extractAgentEventKeysAndSeqs = (
        batch: ReturnType<typeof normalizedPiBatch>,
    ): { key: string; seq: number }[] => batch.events.map((event) => ({
        key: agentEventRecordKey({
            provider: event.provider,
            providerSessionId: event.providerSessionId,
            ...(event.providerEventId == null ? {} : { providerEventId: event.providerEventId }),
            seq: event.seq,
        }),
        seq: event.seq,
    }));

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
        const keysByProviderId = new Map(extracted.providerEvents.flatMap((event) =>
            event.providerEventId ? [[event.providerEventId, agentEventRecordKey(event)] as const] : []));
        const edges = extracted.providerEvents.flatMap((event) =>
            [...new Set([event.parentProviderEventId, ...(event.parentProviderEventIds ?? [])])]
                .filter((id): id is string => id !== null && id !== undefined && keysByProviderId.has(id))
                .map((id) => ({ parent: keysByProviderId.get(id)!, child: agentEventRecordKey(event) })));

        expect(edges).toHaveLength(5);
        expect(edges).toContainEqual({ parent: customEventKey, child: userEventKey });
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

    test("bad session timestamp clamps started_at to the earliest valid body timestamp", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-bad-header-valid-body",
                timestamp: "not-a-date",
                cwd: "/tmp/project",
            }),
            JSON.stringify({
                type: "message",
                id: "user-later",
                parentId: null,
                timestamp: "2026-05-29T06:00:03.000Z",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "Later entry first." }],
                },
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-earliest",
                parentId: "user-later",
                timestamp: "2026-05-29T06:00:01.000Z",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Earlier entry second." }],
                },
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-latest",
                parentId: "assistant-earliest",
                timestamp: "2026-05-29T06:00:05.000Z",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Latest entry last." }],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.session.started_at).toBe("2026-05-29T06:00:01.000Z");
        expect(extracted.session.started_at).not.toBe("1970-01-01T00:00:00.000Z");
        expect(extracted.session.ended_at).toBe("2026-05-29T06:00:05.000Z");
        expect(
            new Date(extracted.session.ended_at).getTime() -
                new Date(extracted.session.started_at).getTime(),
        ).toBe(4_000);
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
                skill: sn("pi:read"),
                args: { path: "src/ingest/pi.ts" },
            },
        ]);
        expect(extracted.skillRelations).toEqual([
            {
                toolCallKey,
                skillName: sn("pi:read"),
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

        const batch = normalizedPiBatch(extracted);
        expect(batch.toolCalls).toHaveLength(1);
        expect(batch.syntheticSkillInvocations[0]).toMatchObject({
            sessionId: "pi-tools",
            skillName: "pi:read",
            skillScope: "pi-tool",
        });
        expect(batch.toolCallSkillRelations).toHaveLength(1);
        expect(extracted.usage).toMatchObject({
            input: 12,
            output: 7,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 19,
        });
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

        const firstEvents = extractAgentEventKeysAndSeqs(normalizedPiBatch(first));
        const secondEvents = extractAgentEventKeysAndSeqs(normalizedPiBatch(second));

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

        const evidence = normalizedPiBatch(extracted).toolFileEvidence;
        expect(evidence).toContainEqual(expect.objectContaining({
            kind: "read_file",
            pathSeen: "src/ingest/pi.ts",
            path: "/Users/necmttn/Projects/ax/src/ingest/pi.ts",
            evidence: "tool_name:read",
        }));
        expect(evidence).toContainEqual(expect.objectContaining({
            kind: "searched_file",
            pathSeen: "src/ingest",
            path: "/Users/necmttn/Projects/ax/src/ingest",
            evidence: "tool_name:grep",
        }));
    });

    test("turn rows keep unsafe session ids as bound values", () => {
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

        const turn = normalizedPiBatch(extracted).turns[0];
        expect(turn?.sessionId).toBe("pi`session\nunsafe");
        expect(turn?.ts).toBe("2026-05-29T06:00:01.000Z");
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

describe("omp (oh-my-pi) provider parity", () => {
    // omp is a Pi fork with an identical transcript format, so the SAME
    // extractor/builders run under the OMP descriptor - only the provider
    // identity differs (#636).
    const lines = [
        JSON.stringify({
            type: "session",
            version: 1,
            id: "omp-session",
            timestamp: "2026-06-30T06:00:00.000Z",
            cwd: "/tmp/omp",
        }),
        JSON.stringify({
            type: "message",
            id: "assistant-1",
            parentId: null,
            timestamp: "2026-06-30T06:00:01.000Z",
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: "Run a search." },
                    { type: "toolCall", id: "call-1", name: "exec_command", input: { command: "rg foo" } },
                ],
                model: "gpt-5.5",
                usage: { input: 10, output: 5, totalTokens: 15 },
            },
        }),
    ];

    test("stage keys are provider-distinct", () => {
        expect(piStage.meta.key).toBe("pi");
        expect(ompStage.meta.key).toBe("omp");
    });

    test("extractor + builders stamp omp identity, not pi", () => {
        const extracted = __testExtractPiJsonlLines(lines, OMP_PROVIDER);
        expect(extracted).not.toBeNull();
        // Synthetic provider-tool skill is omp:<tool>, not pi:<tool>.
        expect(extracted!.invocations[0]?.skill).toBe(sn("omp:exec_command"));
        // Provider events carry the omp provider.
        expect(extracted!.providerEvents.every((e) => e.provider === "omp")).toBe(true);

        const batch = normalizedPiBatch(extracted!, OMP_PROVIDER);
        expect(batch.sessions[0]?.provider).toBe("omp");
        expect(batch.sessions[0]?.labels).toMatchObject({ source: "omp" });
        expect(batch.syntheticSkillInvocations[0]?.skillScope).toBe("omp-tool");
        expect(batch.events.every((event) => event.provider !== "pi")).toBe(true);
    });

    test("default descriptor still ingests as pi (back-compat)", () => {
        const extracted = __testExtractPiJsonlLines(lines);
        expect(extracted!.invocations[0]?.skill).toBe(sn("pi:exec_command"));
        expect(extracted!.providerEvents.every((e) => e.provider === "pi")).toBe(true);
    });
});
