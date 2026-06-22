import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { axMcpTools, defineMcpTool } from "./tools.ts";

/**
 * Characterization: the advertised MCP surface (tool names + each tool's input
 * shape) is pinned here so the typed-factory refactor cannot silently change
 * what an MCP client sees. The keys are the zod raw-shape field names.
 */
const EXPECTED_INPUT_SHAPES: Record<string, readonly string[]> = {
    recall: ["limit", "q", "sources"],
    sessions_around: ["date", "days", "project"],
    session_show: ["byRole", "expand", "expandAll", "sessionId"],
    skills_weighted: ["limit", "windowDays"],
    skills_by_role: ["limit", "role"],
    skills_roles: ["skill"],
    roles: [],
    improve_recommend: ["agent", "forms", "limit", "sinceDays"],
    improve_show: ["sigOrId"],
    improve_list: ["form", "limit", "status"],
    session_metrics: ["limit", "project", "sinceDays"],
    signal_show: ["id", "limit"],
    cost_models: ["days"],
    cost_split: ["days"],
    cost_images: ["days", "limit"],
    cost_routability: ["days", "min_run"],
    dispatches: ["candidates", "days", "limit"],
    dojo_agenda: ["days", "spar"],
    directives_list: ["limit", "status"],
};

describe("axMcpTools advertised surface", () => {
    it("registers exactly the expected tool names", () => {
        expect(axMcpTools.map((t) => t.name).sort()).toEqual(
            Object.keys(EXPECTED_INPUT_SHAPES).sort(),
        );
    });

    it("pins each tool's input shape field names", () => {
        for (const tool of axMcpTools) {
            expect(Object.keys(tool.inputSchema).sort()).toEqual(
                [...EXPECTED_INPUT_SHAPES[tool.name]!].sort(),
            );
        }
    });

    it("exposes a register closure per tool", () => {
        for (const tool of axMcpTools) {
            expect(typeof tool.register).toBe("function");
        }
    });
});

describe("dojo_agenda MCP tool", () => {
    it("is registered with the expected name + input fields", () => {
        const t = axMcpTools.find((x) => x.name === "dojo_agenda");
        expect(t).toBeDefined();
        expect(Object.keys(t!.inputSchema).sort()).toEqual(["days", "spar"]);
    });
});

describe("defineMcpTool (typed zod factory)", () => {
    const rt = {} as never;

    it("hands the inner run validated, typed args", async () => {
        let seen: unknown;
        const tool = defineMcpTool({
            name: "echo",
            description: "echo",
            inputSchema: { n: z.number(), s: z.string().optional() },
            run: async (args) => {
                seen = args;
                return { got: args.n };
            },
        });
        const result = await tool.run({ n: 5 }, rt);
        expect(result).toEqual({ got: 5 });
        expect(seen).toEqual({ n: 5 });
    });

    it("omits absent optional keys (no undefined injected) so spread-callers hold", async () => {
        let seen: Record<string, unknown> = { sentinel: true };
        const tool = defineMcpTool({
            name: "opt",
            description: "opt",
            inputSchema: { a: z.string().optional() },
            run: async (args) => {
                seen = args as Record<string, unknown>;
                return null;
            },
        });
        await tool.run({}, rt);
        expect("a" in seen).toBe(false);
    });

    it("rejects args that violate the shape at the parse boundary", async () => {
        const tool = defineMcpTool({
            name: "strict",
            description: "strict",
            inputSchema: { n: z.number() },
            run: async () => "unreachable",
        });
        await expect(tool.run({ n: "not-a-number" }, rt)).rejects.toThrow();
    });

    it("carries name/description/inputSchema onto the descriptor", () => {
        const shape = { x: z.string() };
        const tool = defineMcpTool({
            name: "meta",
            description: "the-desc",
            inputSchema: shape,
            run: async () => null,
        });
        expect(tool.name).toBe("meta");
        expect(tool.description).toBe("the-desc");
        expect(tool.inputSchema).toBe(shape);
    });
});
