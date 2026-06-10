/**
 * Smoke test: the MCP server speaks MCP over an in-memory transport, exposes
 * the `recall` tool via tools/list, and the result-wrapping helpers + registry
 * are well-formed. No seeded DB required - tools/list never touches SurrealDB,
 * and we assert the registry/envelope shape directly.
 */
import { describe, expect, it } from "bun:test";
import { ManagedRuntime } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppLayer } from "@ax/lib/layers";
import { buildServer, wrapToolError, wrapToolResult } from "./server.ts";
import { axMcpTools } from "./tools.ts";

const EXPECTED_TOOLS = [
    "recall",
    "sessions_around",
    "session_show",
    "skills_weighted",
    "skills_by_role",
    "skills_roles",
    "roles",
    "improve_recommend",
    "improve_show",
    "improve_list",
    "session_metrics",
    "signal_show",
] as const;

describe("axMcpTools registry", () => {
    it("contains a well-formed recall descriptor", () => {
        const recall = axMcpTools.find((t) => t.name === "recall");
        expect(recall).toBeDefined();
        expect(typeof recall!.description).toBe("string");
        expect(recall!.description.length).toBeGreaterThan(0);
        expect(typeof recall!.run).toBe("function");
        // inputSchema is a zod raw shape - q must be present.
        expect(recall!.inputSchema).toHaveProperty("q");
    });

    it("registers all 12 read-only tools, each well-formed", () => {
        expect(axMcpTools.map((t) => t.name).sort()).toEqual(
            [...EXPECTED_TOOLS].sort(),
        );
        for (const tool of axMcpTools) {
            expect(tool.description.length).toBeGreaterThan(0);
            expect(typeof tool.run).toBe("function");
            expect(typeof tool.inputSchema).toBe("object");
            expect(tool.inputSchema).not.toBeNull();
        }
    });

    it("marks required fields on key descriptors", () => {
        const byName = (n: string) => axMcpTools.find((t) => t.name === n)!;
        // A zod raw-shape field is required when it is NOT optional.
        const required = (shape: Record<string, unknown>, key: string): boolean => {
            const field = shape[key] as { isOptional?: () => boolean } | undefined;
            expect(field).toBeDefined();
            return field!.isOptional?.() === false;
        };
        expect(required(byName("session_show").inputSchema, "sessionId")).toBe(true);
        expect(required(byName("sessions_around").inputSchema, "date")).toBe(true);
        expect(required(byName("skills_by_role").inputSchema, "role")).toBe(true);
        expect(required(byName("skills_roles").inputSchema, "skill")).toBe(true);
        expect(required(byName("improve_show").inputSchema, "sigOrId")).toBe(true);
        // optional fields are not required
        expect(required(byName("sessions_around").inputSchema, "days")).toBe(false);
        // metrics/signal tools are fully optional-arg: no required fields.
        expect(required(byName("session_metrics").inputSchema, "sinceDays")).toBe(false);
        expect(required(byName("session_metrics").inputSchema, "limit")).toBe(false);
        expect(required(byName("session_metrics").inputSchema, "project")).toBe(false);
        expect(required(byName("signal_show").inputSchema, "id")).toBe(false);
        expect(required(byName("signal_show").inputSchema, "limit")).toBe(false);
    });
});

describe("session_metrics arg mapping", () => {
    const tool = axMcpTools.find((t) => t.name === "session_metrics")!;

    it("calls the runtime and returns its result with no args", async () => {
        let ran = false;
        const rt = {
            runPromise: () => {
                ran = true;
                return Promise.resolve([]);
            },
        } as never;
        const result = await tool.run({}, rt);
        expect(ran).toBe(true);
        expect(result).toEqual([]);
    });

    it("ignores non-numeric sinceDays/limit and non-string project", async () => {
        const rt = {
            runPromise: () => Promise.resolve([{ session: "session:x" }]),
        } as never;
        const result = await tool.run(
            { sinceDays: "7", limit: "10", project: 42 },
            rt,
        );
        expect(result).toEqual([{ session: "session:x" }]);
    });
});

describe("signal_show", () => {
    const tool = axMcpTools.find((t) => t.name === "signal_show")!;
    // These paths must resolve BEFORE any DB call - no seeded DB here.
    const unreachableRt = {
        runPromise: () => {
            throw new Error("runtime should not be reached");
        },
    } as never;

    it("lists the catalog without touching the runtime when id is omitted", async () => {
        const result = (await tool.run({}, unreachableRt)) as {
            signals: ReadonlyArray<{ id: string; kind: string }>;
        };
        expect(result.signals.length).toBeGreaterThan(0);
        expect(result.signals.map((s) => s.id)).toContain("fragility_cascade");
    });

    it("treats a blank id as a catalog listing", async () => {
        const result = (await tool.run({ id: "   " }, unreachableRt)) as {
            signals: ReadonlyArray<{ id: string }>;
        };
        expect(result.signals.map((s) => s.id)).toContain("fragility_cascade");
    });

    it("rejects an unknown id before hitting the runtime", async () => {
        await expect(tool.run({ id: "nope" }, unreachableRt)).rejects.toThrow(
            /Unknown signal "nope"/,
        );
    });

    it("runs a known relation signal, sorting edges by weight desc and applying limit", async () => {
        const rt = {
            runPromise: () =>
                Promise.resolve([
                    { origin: "session:a", downstream: "session:b", weight: 1 },
                    { origin: "session:c", downstream: "session:d", weight: 5 },
                    { origin: "session:e", downstream: "session:f", weight: 3 },
                ]),
        } as never;
        const result = (await tool.run(
            { id: "fragility_cascade", limit: 2 },
            rt,
        )) as {
            signal: { id: string };
            edges: ReadonlyArray<{ weight: number }>;
        };
        expect(result.signal.id).toBe("fragility_cascade");
        expect(result.edges.map((e) => e.weight)).toEqual([5, 3]);
    });
});

describe("sessions_around date parsing", () => {
    const tool = axMcpTools.find((t) => t.name === "sessions_around")!;
    // A runtime that throws if reached: these tests should fail at arg-mapping
    // (invalid date) BEFORE any DB call, and we don't seed a DB.
    const unreachableRt = {
        runPromise: () => {
            throw new Error("runtime should not be reached");
        },
    } as never;

    it("rejects an invalid date string before hitting the runtime", async () => {
        await expect(tool.run({ date: "not-a-date" }, unreachableRt)).rejects.toThrow(
            /Invalid date/,
        );
    });

    it("rejects a missing date", async () => {
        await expect(tool.run({}, unreachableRt)).rejects.toThrow(/Invalid date/);
    });

    it("maps a valid ISO date to a Date and returns the {sessions, next} envelope", async () => {
        const rt = {
            runPromise: (_eff: unknown) => Promise.resolve([]),
        } as never;
        const result = (await tool.run({ date: "2026-01-15" }, rt)) as {
            sessions: ReadonlyArray<unknown>;
            next: ReadonlyArray<{ description: string }>;
        };
        expect(result.sessions).toEqual([]);
        // empty window + date → errors-as-teaching widen link
        expect(result.next.length).toBeGreaterThan(0);
        // sanity: the same valid string parses to a valid Date
        expect(Number.isNaN(new Date("2026-01-15").getTime())).toBe(false);
    });
});

describe("NavLink next[] wiring", () => {
    const byName = (n: string) => axMcpTools.find((t) => t.name === n)!;

    it("recall / sessions_around / session_show descriptions teach the next protocol", () => {
        for (const name of ["recall", "sessions_around", "session_show"]) {
            expect(byName(name).description).toContain("`next`");
        }
    });

    it("recall result carries per-hit and top-level next links", async () => {
        const stub = {
            q: "timeline",
            hits: [
                {
                    turn_id: "turn:1",
                    session_id: "019e2531-b552-7b53-a029-c780adbb6560",
                    project: null,
                    source: "codex",
                    cwd: null,
                    role: "user",
                    ts: "2026-06-09T02:00:00.000Z",
                    snippet: "x",
                },
            ],
            commits: [],
            skills: [],
            truncated: false,
            total_count: 5,
            total_counts: { turn: 5, commit: 0, skill: 0 },
            window: { offset: 0, limit: 50 },
        };
        const rt = { runPromise: () => Promise.resolve(stub) } as never;
        const result = (await byName("recall").run({ q: "timeline" }, rt)) as {
            hits: ReadonlyArray<{ next?: ReadonlyArray<unknown> }>;
            next: ReadonlyArray<{ cmd?: string }>;
        };
        expect(result.hits[0]?.next).toHaveLength(1);
        expect(
            result.next.some((l) => l.cmd === "codex resume 019e2531-b552-7b53-a029-c780adbb6560"),
        ).toBe(true);
    });

    it("session_show result carries next with a resume link", async () => {
        const stub = {
            session: {
                overview: {
                    id: "019e2531-b552-7b53-a029-c780adbb6560",
                    project: null,
                    cwd: "/tmp/p",
                    model: null,
                    source: "claude",
                    started_at: null,
                    ended_at: null,
                },
                top_skills: [],
                tool_calls: [],
                children: [],
                parent: null,
                agent_delegations: [],
                token_usage: null,
            },
            expanded_subagents: [],
            by_role: null,
            compactions: [],
        };
        const rt = { runPromise: () => Promise.resolve(stub) } as never;
        const result = (await byName("session_show").run(
            { sessionId: "019e2531-b552-7b53-a029-c780adbb6560" },
            rt,
        )) as { next: ReadonlyArray<{ cmd?: string }> };
        expect(result.next.some((l) => l.cmd?.includes("claude --resume"))).toBe(true);
    });
});

describe("result wrapping", () => {
    it("wraps a raw result as a text content envelope", () => {
        const wrapped = wrapToolResult({ hello: "world" });
        expect(wrapped.content).toEqual([
            { type: "text", text: JSON.stringify({ hello: "world" }, null, 2) },
        ]);
        expect(wrapped.isError).toBeUndefined();
    });

    it("wraps a thrown error as an isError envelope", () => {
        const wrapped = wrapToolError(new Error("boom"));
        expect(wrapped.isError).toBe(true);
        expect(wrapped.content).toEqual([{ type: "text", text: "boom" }]);
    });

    it("stringifies non-Error throwables", () => {
        const wrapped = wrapToolError("nope");
        expect(wrapped.isError).toBe(true);
        expect(wrapped.content[0]).toEqual({ type: "text", text: "nope" });
    });
});

describe("MCP server over in-memory transport", () => {
    it("lists the recall tool via tools/list", async () => {
        const runtime = ManagedRuntime.make(AppLayer);
        const server = buildServer(runtime);
        const client = new Client({ name: "smoke-test", version: "0.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        try {
            await Promise.all([
                server.connect(serverTransport),
                client.connect(clientTransport),
            ]);

            const { tools } = await client.listTools();
            const recall = tools.find((t) => t.name === "recall");
            expect(recall).toBeDefined();
            expect(recall!.description).toContain("recall");
            // The zod shape was converted to a JSON schema with a `q` property.
            expect(recall!.inputSchema).toBeDefined();
            const props = (recall!.inputSchema as { properties?: Record<string, unknown> }).properties;
            expect(props).toHaveProperty("q");
        } finally {
            await client.close().catch(() => undefined);
            await server.close().catch(() => undefined);
            await runtime.dispose().catch(() => undefined);
        }
    });
});
