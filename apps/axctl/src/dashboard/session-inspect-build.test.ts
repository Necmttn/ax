import { describe, expect, test } from "bun:test";
import type { InspectTurnContentDto, InspectTurnDto, SpawnMeta, ToolCallDto } from "@ax/lib/shared/dashboard-types";
import { assembleInspectPayload, buildInspectChildren, buildInspectTurn } from "./session-inspect.ts";

const toolCall = (over: Partial<ToolCallDto> = {}): ToolCallDto => ({
    seq: 0,
    name: "Bash",
    category: "sh",
    input: null,
    command: "bun test",
    output_excerpt: null,
    has_error: false,
    tokens: null,
    ...over,
});

const emptyContent = new Map<number, InspectTurnContentDto>();

describe("buildInspectTurn", () => {
    test("assistant text → assistant_text semantic role, char_count, contributions sum to text length", () => {
        const text = "Here is the plan and the result.";
        const { dto, contributions } = buildInspectTurn({
            seq: 3,
            role: "assistant",
            text,
            ts: "2026-06-10T00:00:00.000Z",
            tokenUsage: null,
            turnContent: emptyContent,
        });
        expect(dto.seq).toBe(3);
        expect(dto.role).toBe("assistant");
        expect(dto.semantic_role).toBe("assistant_text");
        expect(dto.char_count).toBe(text.length);
        expect(dto.raw_text).toBe(text);
        expect(dto.spans.length).toBeGreaterThan(0);
        const contribSum = Object.values(contributions).reduce((s, n) => s + (n ?? 0), 0);
        expect(contribSum).toBe(text.length);
        expect(dto.content).toBeNull();
        expect(dto.tool_calls).toBeUndefined();
    });

    test("user role defaults to user_input fallback kind", () => {
        const { dto } = buildInspectTurn({
            seq: 0,
            role: "user",
            text: "fix the bug",
            ts: null,
            tokenUsage: null,
            turnContent: emptyContent,
        });
        expect(dto.semantic_role).toBe("user_input");
    });

    test("tool-call seqs are rewritten to the display seq", () => {
        const { dto } = buildInspectTurn({
            seq: 7,
            role: "assistant",
            text: "running tools",
            ts: null,
            toolCalls: [toolCall({ seq: 0, name: "Bash" }), toolCall({ seq: 99, name: "Read", command: null })],
            tokenUsage: null,
            turnContent: emptyContent,
        });
        expect(dto.tool_calls?.map((c) => c.seq)).toEqual([7, 7]);
        expect(dto.tool_calls?.map((c) => c.name)).toEqual(["Bash", "Read"]);
    });

    test("empty toolCalls array does not attach a tool_calls field", () => {
        const { dto } = buildInspectTurn({
            seq: 1,
            role: "assistant",
            text: "x",
            ts: null,
            toolCalls: [],
            tokenUsage: null,
            turnContent: emptyContent,
        });
        expect(dto.tool_calls).toBeUndefined();
    });

    test("token usage is passed through verbatim", () => {
        const usage = { input_tokens: 10, output_tokens: 20 } as unknown as InspectTurnDto["token_usage"];
        const { dto } = buildInspectTurn({
            seq: 0,
            role: "assistant",
            text: "y",
            ts: null,
            tokenUsage: usage ?? null,
            turnContent: emptyContent,
        });
        expect(dto.token_usage).toBe(usage ?? null);
    });
});

describe("buildInspectChildren", () => {
    const turns: InspectTurnDto[] = [];
    const stats = new Map([["session:child", { turns: 5, tool_calls: 9, est_tokens: 1000, cost_usd: 0.5, duration_ms: 1234 }]]);

    test("maps edges + stats; metaForChild supplies meta (graph passes () => null)", () => {
        const edges = [{ session_id: "session:child", ts: null, tool: "Task", nickname: "Turing" }];
        const graph = buildInspectChildren(edges, stats, turns, () => null);
        expect(graph[0]).toMatchObject({
            session_id: "session:child",
            tool: "Task",
            nickname: "Turing",
            meta: null,
            turns: 5,
            tool_calls: 9,
            est_tokens: 1000,
            cost_usd: 0.5,
            duration_ms: 1234,
        });

        const meta: SpawnMeta = { provider: "claude", agent_type: "Explore", fork_context: null, reasoning_effort: null, brief: "go" };
        const jsonl = buildInspectChildren(edges, stats, turns, () => meta);
        expect(jsonl[0]?.meta).toBe(meta);
    });

    test("missing stats degrade every metric to null", () => {
        const edges = [{ session_id: "session:unknown", ts: null, tool: null, nickname: null }];
        const out = buildInspectChildren(edges, stats, turns, () => null);
        expect(out[0]).toMatchObject({ turns: null, tool_calls: null, est_tokens: null, cost_usd: null, duration_ms: null });
    });
});

describe("assembleInspectPayload", () => {
    test("maps args onto the wire payload shape (parent + turn_window)", () => {
        const payload = assembleInspectPayload({
            sessionId: "session:s1",
            sourcePath: "graph:session:s1",
            project: "ax",
            cwd: "/repo",
            totalChars: 42,
            tokenUsage: null,
            totalTurns: 10,
            turnOffset: 0,
            turnLimit: 2000,
            turns: [],
            totalsByKind: { assistant_text: 42 },
            parent: { parent_session: "session:parent", parent_nickname: "Pauli" },
            children: [],
            hookFires: [],
            totalHookFires: 3,
        });
        expect(payload.session_id).toBe("session:s1");
        expect(payload.total_turns).toBe(10);
        expect(payload.turn_window).toEqual({ offset: 0, limit: 2000 });
        expect(payload.parent_session).toBe("session:parent");
        expect(payload.parent_nickname).toBe("Pauli");
        expect(payload.total_hook_fires).toBe(3);
        expect(payload.totals_by_kind).toEqual({ assistant_text: 42 });
    });
});
