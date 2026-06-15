/**
 * Tests for dispatch-analytics.ts
 *
 * Uses makeMockDb (canned spawned / tool_call / usage rows) to exercise:
 *   - inherit vs explicit model resolution
 *   - candidate matching (expensive + routing-class filter)
 *   - repricing math
 *   - compile-routing JSON shape via tmp dir
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";

import {
    fetchDispatches,
    fetchDispatchCandidates,
    fetchDispatchEconomy,
    compileRouting,
    renderRoutingTableMarkdown,
    replaceSkillRoutingSection,
    ROUTING_CLASSES,
    matchRouting,
    matchRoutingWith,
    EXPENSIVE_TIER_RE,
    CHEAP_TIER_RE,
} from "./dispatch-analytics.ts";

const fsLayers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const runCompileRouting = (outPath: string) =>
    Effect.runPromise(compileRouting(outPath).pipe(Effect.provide(fsLayers)));

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

type QueryResult = Array<Record<string, unknown>>;

/**
 * Build a mock SurrealClient Layer from canned per-query results.
 * The implementation returns results[0..n] in the order the SQL queries arrive
 * (multi-statement query returns multiple result arrays).
 */
const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) => {
            return Effect.succeed(results as [QueryResult, ...QueryResult[]]);
        },
        // biome-ignore lint: other methods not needed
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

// ---------------------------------------------------------------------------
// ROUTING_CLASSES
// ---------------------------------------------------------------------------

describe("ROUTING_CLASSES", () => {
    it("has version 1", () => {
        expect(ROUTING_CLASSES.version).toBe(1);
    });

    it("has 8 classes", () => {
        expect(ROUTING_CLASSES.classes).toHaveLength(8);
    });

    it("has agentTypes for Explore, codebase-locator, codebase-pattern-finder, codebase-analyzer", () => {
        expect(ROUTING_CLASSES.agentTypes).toHaveProperty("Explore", "haiku");
        expect(ROUTING_CLASSES.agentTypes).toHaveProperty("codebase-locator", "haiku");
        expect(ROUTING_CLASSES.agentTypes).toHaveProperty("codebase-pattern-finder", "haiku");
        expect(ROUTING_CLASSES.agentTypes).toHaveProperty("codebase-analyzer", "sonnet");
    });
});

// ---------------------------------------------------------------------------
// matchRouting
// ---------------------------------------------------------------------------

describe("matchRouting", () => {
    it("matches agent-type Explore to haiku", () => {
        const m = matchRouting(null, "Explore");
        expect(m).not.toBeNull();
        expect(m!.suggest).toBe("haiku");
        expect(m!.source).toBe("agentType");
    });

    it("agent-type wins over description", () => {
        const m = matchRouting("spec review of the PR", "Explore");
        expect(m).not.toBeNull();
        expect(m!.suggest).toBe("haiku"); // agent-type wins
    });

    it("matches description 'spec review' to sonnet (spec-review)", () => {
        const m = matchRouting("spec review the implementation", null);
        expect(m).not.toBeNull();
        expect(m!.suggest).toBe("sonnet");
        expect(m!.classId).toBe("spec-review");
    });

    it("matches description 'locate all uses' to haiku (search-locate)", () => {
        const m = matchRouting("locate all uses of X", null);
        expect(m).not.toBeNull();
        expect(m!.suggest).toBe("haiku");
        expect(m!.classId).toBe("search-locate");
    });

    it("returns null for unmatched description and no agent type", () => {
        const m = matchRouting("do some analysis", null);
        expect(m).toBeNull();
    });

    it("returns null for null inputs", () => {
        const m = matchRouting(null, null);
        expect(m).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// fetchDispatches - inherit vs explicit model
// ---------------------------------------------------------------------------

describe("fetchDispatches", () => {
    it("returns empty when no spawned rows", async () => {
        const layer = makeMockDb([[], [], [], []]);
        const result = await run(fetchDispatches({ sinceDays: 14, limit: 30 }), layer);
        expect(result.total_dispatches).toBe(0);
        expect(result.rows).toHaveLength(0);
        expect(result.inherit_pct).toBe(0);
        expect(result.total_child_cost_usd).toBe(0);
    });

    it("resolves dispatch_model='inherit' when no tool_use_id", async () => {
        const spawnedRows = [
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-abc",
                ts: "2026-06-10T10:00:00Z",
                agent_type: "Explore",
                description: "find all usages",
                tool_use_id: null,
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-abc",
                model: "claude-fable-5",
                prompt_tokens: 1000,
                completion_tokens: 500,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 0.05,
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, [], []]);
        const result = await run(fetchDispatches({ sinceDays: 14, limit: 30 }), layer);

        expect(result.total_dispatches).toBe(1);
        expect(result.rows[0]?.dispatch_model).toBe("inherit");
        expect(result.rows[0]?.child_model).toBe("claude-fable-5");
        expect(result.rows[0]?.child_cost_usd).toBe(0.05);
        expect(result.inherit_pct).toBe(100);
    });

    it("resolves dispatch_model from Agent tool_call input_json when tool_use_id matches", async () => {
        const spawnedRows = [
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-def",
                ts: "2026-06-10T11:00:00Z",
                agent_type: "general-purpose",
                description: "implement task X",
                tool_use_id: "toolu_xyz123",
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-def",
                model: "claude-sonnet-4-6",
                prompt_tokens: 2000,
                completion_tokens: 800,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 0.02,
            },
        ];
        const toolCallRows = [
            {
                session_id: "session:parent-1",
                call_id: "toolu_xyz123",
                input_json: JSON.stringify({ model: "sonnet", description: "implement task X" }),
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, toolCallRows, []]);
        const result = await run(fetchDispatches({ sinceDays: 14, limit: 30 }), layer);

        expect(result.rows[0]?.dispatch_model).toBe("sonnet");
        expect(result.inherit_pct).toBe(0);
    });

    it("sorts by child_cost_usd desc", async () => {
        const spawnedRows = [
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-cheap",
                ts: "2026-06-10T10:00:00Z",
                agent_type: "Explore",
                description: "locate X",
                tool_use_id: null,
            },
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-expensive",
                ts: "2026-06-10T10:01:00Z",
                agent_type: "general-purpose",
                description: "big task",
                tool_use_id: null,
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-cheap",
                model: "claude-haiku-4-5",
                prompt_tokens: 100,
                completion_tokens: 50,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 0.001,
            },
            {
                session_id: "session:claude-subagent-expensive",
                model: "claude-fable-5",
                prompt_tokens: 5000,
                completion_tokens: 2000,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 0.50,
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, [], []]);
        const result = await run(fetchDispatches({ sinceDays: 14, limit: 30 }), layer);

        expect(result.rows[0]?.child_id).toBe("claude-subagent-expensive");
        expect(result.rows[1]?.child_id).toBe("claude-subagent-cheap");
        expect(result.total_child_cost_usd).toBeCloseTo(0.501, 3);
    });

    it("respects limit", async () => {
        const spawnedRows = Array.from({ length: 5 }, (_, i) => ({
            parent_id: "session:parent-1",
            child_id: `session:claude-subagent-${i}`,
            ts: "2026-06-10T10:00:00Z",
            agent_type: "Explore",
            description: "locate X",
            tool_use_id: null,
        }));
        const layer = makeMockDb([spawnedRows, [], [], []]);
        const result = await run(fetchDispatches({ sinceDays: 14, limit: 2 }), layer);

        expect(result.total_dispatches).toBe(5);
        expect(result.rows).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// fetchDispatchCandidates - filtering and repricing
// ---------------------------------------------------------------------------

describe("fetchDispatchCandidates", () => {
    it("returns empty when no spawned rows", async () => {
        const layer = makeMockDb([[], [], [], [], []]);
        const result = await run(fetchDispatchCandidates({ sinceDays: 14 }), layer);
        expect(result.candidates).toHaveLength(0);
        expect(result.total_est_savings_usd).toBe(0);
    });

    it("excludes dispatches with an explicit model (non-inherit)", async () => {
        const spawnedRows = [
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-abc",
                ts: "2026-06-10T10:00:00Z",
                agent_type: "Explore",
                description: "find stuff",
                tool_use_id: "tool-1",
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-abc",
                model: "claude-fable-5",
                prompt_tokens: 1000,
                completion_tokens: 500,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 0.05,
            },
        ];
        const toolCallRows = [
            {
                session_id: "session:parent-1",
                call_id: "tool-1",
                input_json: JSON.stringify({ model: "fable", description: "find stuff" }),
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, toolCallRows, [], []]);
        const result = await run(fetchDispatchCandidates({ sinceDays: 14 }), layer);

        // dispatch_model is "fable" (not inherit) - excluded
        expect(result.candidates).toHaveLength(0);
    });

    it("excludes dispatches where child model is NOT expensive (no fable/opus)", async () => {
        const spawnedRows = [
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-cheap",
                ts: "2026-06-10T10:00:00Z",
                agent_type: "Explore",
                description: "locate something",
                tool_use_id: null,
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-cheap",
                model: "claude-haiku-4-5",  // not expensive
                prompt_tokens: 1000,
                completion_tokens: 500,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 0.001,
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, [], [], []]);
        const result = await run(fetchDispatchCandidates({ sinceDays: 14 }), layer);

        expect(result.candidates).toHaveLength(0);
    });

    it("excludes dispatches that don't match any routing class", async () => {
        const spawnedRows = [
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-unmatched",
                ts: "2026-06-10T10:00:00Z",
                agent_type: "general-purpose",  // not in agentTypes table
                description: "do some random work",  // no pattern match
                tool_use_id: null,
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-unmatched",
                model: "claude-fable-5",
                prompt_tokens: 1000,
                completion_tokens: 500,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 0.10,
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, [], [], []]);
        const result = await run(fetchDispatchCandidates({ sinceDays: 14 }), layer);

        expect(result.candidates).toHaveLength(0);
    });

    it("includes candidates that match all three criteria and reprices correctly", async () => {
        const spawnedRows = [
            {
                parent_id: "session:parent-1",
                child_id: "session:claude-subagent-explore",
                ts: "2026-06-10T10:00:00Z",
                agent_type: "Explore",  // -> haiku
                description: "locate all usages of function X",
                tool_use_id: null,
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-explore",
                model: "claude-fable-5",  // expensive
                prompt_tokens: 1_000_000,   // 1M tokens -> easy math
                completion_tokens: 0,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 15.0,  // actual fable cost
            },
        ];
        // agent_model pricing: haiku at $0.80/M input
        const agentModels = [
            {
                name: "claude-haiku-4-5-20251001",
                input_per_million_usd: 0.80,
                output_per_million_usd: 4.0,
                cache_read_per_million_usd: 0.08,
                cache_creation_per_million_usd: 1.0,
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, [], [], agentModels]);
        const result = await run(fetchDispatchCandidates({ sinceDays: 14 }), layer);

        expect(result.candidates).toHaveLength(1);
        const cand = result.candidates[0]!;
        expect(cand.routing_match.suggest).toBe("haiku");
        expect(cand.suggested_model).toBe("claude-haiku-4-5-20251001");
        // repriced = 1M * 0.80/M = $0.80; savings = $15.0 - $0.80 = $14.20
        expect(cand.est_savings_usd).toBeCloseTo(14.20, 2);
        expect(result.total_est_savings_usd).toBeCloseTo(14.20, 2);
    });

    it("computes top_classes sorted by savings desc", async () => {
        const spawnedRows = [
            {
                parent_id: "session:p1",
                child_id: "session:claude-subagent-s1",
                ts: "2026-06-10T10:00:00Z",
                agent_type: "Explore",  // haiku -> big savings
                description: "locate large code",
                tool_use_id: null,
            },
            {
                parent_id: "session:p1",
                child_id: "session:claude-subagent-s2",
                ts: "2026-06-10T10:01:00Z",
                agent_type: null,
                description: "spec review the PR",  // -> spec-review -> sonnet
                tool_use_id: null,
            },
        ];
        const usageRows = [
            {
                session_id: "session:claude-subagent-s1",
                model: "claude-fable-5",
                prompt_tokens: 1_000_000,
                completion_tokens: 0,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 15.0,
            },
            {
                session_id: "session:claude-subagent-s2",
                model: "claude-opus-4",
                prompt_tokens: 500_000,
                completion_tokens: 0,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: 7.5,
            },
        ];
        const agentModels = [
            {
                name: "claude-haiku-4-5-20251001",
                input_per_million_usd: 0.80,
                output_per_million_usd: 4.0,
                cache_read_per_million_usd: 0.08,
                cache_creation_per_million_usd: 1.0,
            },
            {
                name: "claude-sonnet-4-6",
                input_per_million_usd: 3.0,
                output_per_million_usd: 15.0,
                cache_read_per_million_usd: 0.30,
                cache_creation_per_million_usd: 3.75,
            },
        ];
        const layer = makeMockDb([spawnedRows, usageRows, [], [], agentModels]);
        const result = await run(fetchDispatchCandidates({ sinceDays: 14 }), layer);

        expect(result.candidates).toHaveLength(2);
        // top_classes: agent-type:Explore has bigger savings (~14.20) vs spec-review (~6.0)
        expect(result.top_classes[0]?.classId).toBe("agent-type:Explore");
        expect(result.top_classes.length).toBeLessThanOrEqual(3);
    });
});

// ---------------------------------------------------------------------------
// compile-routing
// ---------------------------------------------------------------------------

describe("compileRouting", () => {
    it("writes valid JSON to the specified tmp path", async () => {
        const outPath = join(tmpdir(), `routing-table-test-${Date.now()}.json`);
        const res = await runCompileRouting(outPath);
        expect(res.written).toBe(true);
        expect(res.path).toBe(outPath);
        const content = readFileSync(outPath, "utf8");
        const parsed = JSON.parse(content);
        expect(parsed.version).toBe(1);
        expect(Array.isArray(parsed.classes)).toBe(true);
        expect(typeof parsed.agentTypes).toBe("object");
    });

    it("written JSON has the correct class IDs", async () => {
        const outPath = join(tmpdir(), `routing-table-ids-test-${Date.now()}.json`);
        await runCompileRouting(outPath);
        const parsed = JSON.parse(readFileSync(outPath, "utf8"));
        const ids = (parsed.classes as Array<{ id: string }>).map((c) => c.id);
        expect(ids).toContain("spec-review");
        expect(ids).toContain("search-locate");
        expect(ids).toContain("research");
        expect(ids).toContain("well-specified-impl");
    });

    it("is idempotent - overwriting with same content succeeds", async () => {
        const outPath = join(tmpdir(), `routing-table-idempotent-test-${Date.now()}.json`);
        await runCompileRouting(outPath);
        const first = readFileSync(outPath, "utf8");
        await runCompileRouting(outPath); // second write
        const second = readFileSync(outPath, "utf8");
        expect(first).toBe(second);
    });

    it("agentTypes match ROUTING_CLASSES", async () => {
        const outPath = join(tmpdir(), `routing-table-agent-types-test-${Date.now()}.json`);
        await runCompileRouting(outPath);
        const parsed = JSON.parse(readFileSync(outPath, "utf8"));
        expect(parsed.agentTypes).toMatchObject(ROUTING_CLASSES.agentTypes);
    });
});

// ---------------------------------------------------------------------------
// skill-md routing section
// ---------------------------------------------------------------------------

describe("renderRoutingTableMarkdown / replaceSkillRoutingSection", () => {
    it("renders one row per class plus an agent-types row, pipes escaped", () => {
        const md = renderRoutingTableMarkdown();
        for (const cls of ROUTING_CLASSES.classes) {
            expect(md).toContain(`| ${cls.id} |`);
        }
        expect(md).toContain("agent types");
        // Alternation pipes inside patterns must be escaped for the table.
        expect(md).toContain("\\|");
    });

    it("replaces only the marked section and is idempotent", () => {
        const doc = [
            "# heading",
            "",
            "<!-- ax:routing-table -->",
            "stale table",
            "<!-- /ax:routing-table -->",
            "",
            "tail text",
        ].join("\n");
        const once = replaceSkillRoutingSection(doc);
        expect(once).not.toBeNull();
        expect(once!).toContain("# heading");
        expect(once!).toContain("tail text");
        expect(once!).not.toContain("stale table");
        expect(once!).toContain("| spec-review |");
        const twice = replaceSkillRoutingSection(once!);
        expect(twice).toBe(once!);
    });

    it("returns null when markers are missing", () => {
        expect(replaceSkillRoutingSection("no markers here")).toBeNull();
    });

    it("the shipped efficient-dispatch skill is in sync with ROUTING_CLASSES", () => {
        const skillPath = join(import.meta.dir, "../../../../skills/efficient-dispatch/SKILL.md");
        const content = readFileSync(skillPath, "utf8");
        const regenerated = replaceSkillRoutingSection(content);
        expect(regenerated).not.toBeNull();
        expect(regenerated!).toBe(content);
    });
});

// ---------------------------------------------------------------------------
// matchRoutingWith - table-parameterized matching
// ---------------------------------------------------------------------------

describe("matchRoutingWith", () => {
    const customTable = {
        version: 1 as const,
        classes: [
            { id: "summarize", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "bulk summaries" },
        ],
        agentTypes: {},
    };

    it("matches against the supplied table, not ROUTING_CLASSES", () => {
        const m = matchRoutingWith(customTable, "Summarize the changelog", null);
        expect(m?.classId).toBe("summarize");
        // a ROUTING_CLASSES-only pattern must NOT match through the custom table
        expect(matchRoutingWith(customTable, "Implement Task 1: foo", null)).toBeNull();
    });

    it("matchRouting still delegates to the built-in table", () => {
        expect(matchRouting("Implement the parser", null)?.classId).toBe("well-specified-impl");
    });
});

describe("EXPENSIVE_TIER_RE", () => {
    it("matches fable and opus, not sonnet/haiku", () => {
        expect(EXPENSIVE_TIER_RE.test("claude-fable-5")).toBe(true);
        expect(EXPENSIVE_TIER_RE.test("claude-opus-4-8")).toBe(true);
        expect(EXPENSIVE_TIER_RE.test("claude-sonnet-4-6")).toBe(false);
    });
});

describe("fetchDispatchCandidates with a custom table", () => {
    it("uses the supplied table for matching", async () => {
        // one spawned row whose description only matches the custom table
        const spawned = [{
            parent_id: "session:p1", child_id: "session:c1", ts: "2026-06-12T00:00:00Z",
            agent_type: "general-purpose", description: "Summarize the changelog", tool_use_id: "tu1",
        }];
        const usage = [{
            session_id: "session:c1", model: "claude-fable-5",
            prompt_tokens: 1000, completion_tokens: 100,
            cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.0,
        }];
        const toolCalls = [{ session_id: "session:p1", call_id: "tu1", input_json: "{}" }];
        const layer = makeMockDb([spawned, usage, toolCalls, [], []]);
        const customTable = {
            version: 1 as const,
            classes: [{ id: "summarize", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "bulk summaries" }],
            agentTypes: {},
        };
        const result = await run(
            fetchDispatchCandidates({ sinceDays: 14, table: customTable }),
            layer,
        );
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]!.routing_match.classId).toBe("summarize");
    });
});

// ---------------------------------------------------------------------------
// CHEAP_TIER_RE
// ---------------------------------------------------------------------------

describe("CHEAP_TIER_RE", () => {
    it("matches sonnet and haiku, not fable/opus", () => {
        expect(CHEAP_TIER_RE.test("claude-sonnet-4-6")).toBe(true);
        expect(CHEAP_TIER_RE.test("claude-haiku-4-5-20251001")).toBe(true);
        expect(CHEAP_TIER_RE.test("claude-fable-5")).toBe(false);
        expect(CHEAP_TIER_RE.test("claude-opus-4-8")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// fetchDispatchEconomy - bucketing + rollup + advise-fire count
//
// Query order (6 result arrays): spawned, usage, toolCalls, parentSessions,
// agentModels, hookFires.
// ---------------------------------------------------------------------------

describe("fetchDispatchEconomy", () => {
    // Pricing catalog used across the bucketing tests. sonnet far cheaper than
    // the actual fable/opus child cost so est_savings is a clear positive delta.
    const agentModels = [
        {
            name: "claude-sonnet-4-6",
            input_per_million_usd: 3.0,
            output_per_million_usd: 15.0,
            cache_read_per_million_usd: 0.30,
            cache_creation_per_million_usd: 3.75,
        },
    ];

    it("returns zeros when no spawned rows", async () => {
        const layer = makeMockDb([[], [], [], [], [], []]);
        const result = await run(fetchDispatchEconomy({ sinceDays: 14 }), layer);
        expect(result.total_routable).toBe(0);
        expect(result.ran_cheap).toBe(0);
        expect(result.ran_expensive).toBe(0);
        expect(result.overspend_usd).toBe(0);
        expect(result.total_est_savings_usd).toBe(0);
        expect(result.by_class).toHaveLength(0);
        expect(result.days).toBe(14);
    });

    it("buckets cheap / expensive / unknown-tier matched inherit dispatches", async () => {
        // Four inherit dispatches all matching the well-specified-impl class
        // ("Implement ..."): one ran sonnet (cheap), one ran fable (expensive),
        // one ran opus (expensive), one ran an unknown-tier model (neither).
        const spawned = [
            {
                parent_id: "session:p1", child_id: "session:c-cheap",
                ts: "2026-06-12T10:00:00Z", agent_type: "general-purpose",
                description: "Implement the parser cheap", tool_use_id: null,
            },
            {
                parent_id: "session:p1", child_id: "session:c-fable",
                ts: "2026-06-12T10:01:00Z", agent_type: "general-purpose",
                description: "Implement the parser fable", tool_use_id: null,
            },
            {
                parent_id: "session:p1", child_id: "session:c-opus",
                ts: "2026-06-12T10:02:00Z", agent_type: "general-purpose",
                description: "Implement the parser opus", tool_use_id: null,
            },
            {
                parent_id: "session:p1", child_id: "session:c-unknown",
                ts: "2026-06-12T10:03:00Z", agent_type: "general-purpose",
                description: "Implement the parser unknown", tool_use_id: null,
            },
        ];
        const usage = [
            {
                session_id: "session:c-cheap", model: "claude-sonnet-4-6",
                prompt_tokens: 1000, completion_tokens: 100,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 0.10,
            },
            {
                session_id: "session:c-fable", model: "claude-fable-5",
                prompt_tokens: 1_000_000, completion_tokens: 0,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 15.0,
            },
            {
                session_id: "session:c-opus", model: "claude-opus-4-8",
                prompt_tokens: 500_000, completion_tokens: 0,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 7.5,
            },
            {
                session_id: "session:c-unknown", model: "claude-mystery-9",
                prompt_tokens: 1000, completion_tokens: 100,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 0.20,
            },
        ];
        const layer = makeMockDb([spawned, usage, [], [], agentModels, []]);
        const result = await run(fetchDispatchEconomy({ sinceDays: 14 }), layer);

        // All four matched the same route-down class.
        expect(result.total_routable).toBe(4);
        expect(result.ran_cheap).toBe(1);     // sonnet
        expect(result.ran_expensive).toBe(2); // fable + opus
        // The unknown-tier row is routable but neither cheap nor expensive.
        const other = result.total_routable - result.ran_cheap - result.ran_expensive;
        expect(other).toBe(1);

        // Per-class rollup cross-foots to the totals.
        expect(result.by_class).toHaveLength(1);
        const cls = result.by_class[0]!;
        expect(cls.classId).toBe("well-specified-impl");
        expect(cls.count).toBe(4);
        expect(cls.ran_cheap).toBe(1);
        expect(cls.ran_expensive).toBe(2);
        // count = cheap + expensive + other
        expect(cls.count).toBe(cls.ran_cheap + cls.ran_expensive + other);
    });

    it("overspend = full expensive child cost; est savings = the (smaller) delta", async () => {
        // One inherit dispatch matching the class ran fable at $15.0; repriced
        // at sonnet ($3/M input) = $3.0 → savings $12.0 < overspend $15.0.
        const spawned = [
            {
                parent_id: "session:p1", child_id: "session:c1",
                ts: "2026-06-12T10:00:00Z", agent_type: "general-purpose",
                description: "Implement the migration", tool_use_id: null,
            },
        ];
        const usage = [
            {
                session_id: "session:c1", model: "claude-fable-5",
                prompt_tokens: 1_000_000, completion_tokens: 0,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 15.0,
            },
        ];
        const layer = makeMockDb([spawned, usage, [], [], agentModels, []]);
        const result = await run(fetchDispatchEconomy({ sinceDays: 14 }), layer);

        expect(result.ran_expensive).toBe(1);
        expect(result.overspend_usd).toBeCloseTo(15.0, 4);
        // repriced sonnet = 1M * $3/M = $3.0 → savings = $12.0
        expect(result.total_est_savings_usd).toBeCloseTo(12.0, 2);
        expect(result.total_est_savings_usd).toBeLessThan(result.overspend_usd);

        const cls = result.by_class[0]!;
        expect(cls.overspend_usd).toBeCloseTo(15.0, 4);
        expect(cls.est_savings_usd).toBeCloseTo(12.0, 2);
    });

    it("ignores non-inherit and non-matching dispatches", async () => {
        const spawned = [
            // explicit model (not inherit) → excluded
            {
                parent_id: "session:p1", child_id: "session:c-explicit",
                ts: "2026-06-12T10:00:00Z", agent_type: "general-purpose",
                description: "Implement explicit", tool_use_id: "tu-explicit",
            },
            // no routing-class match → excluded
            {
                parent_id: "session:p1", child_id: "session:c-nomatch",
                ts: "2026-06-12T10:01:00Z", agent_type: "general-purpose",
                description: "do some random thing", tool_use_id: null,
            },
        ];
        const usage = [
            {
                session_id: "session:c-explicit", model: "claude-fable-5",
                prompt_tokens: 1000, completion_tokens: 100,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.0,
            },
            {
                session_id: "session:c-nomatch", model: "claude-fable-5",
                prompt_tokens: 1000, completion_tokens: 100,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.0,
            },
        ];
        const toolCalls = [
            { session_id: "session:p1", call_id: "tu-explicit", input_json: JSON.stringify({ model: "fable" }) },
        ];
        const layer = makeMockDb([spawned, usage, toolCalls, [], agentModels, []]);
        const result = await run(fetchDispatchEconomy({ sinceDays: 14 }), layer);

        expect(result.total_routable).toBe(0);
        expect(result.by_class).toHaveLength(0);
    });

    it("reports advise_fires from the hook query when present", async () => {
        const layer = makeMockDb([[], [], [], [], [], [{ n: 7 }]]);
        const result = await run(fetchDispatchEconomy({ sinceDays: 14 }), layer);
        expect(result.advise_fires).toBe(7);
        expect(result.advise_fires_available).toBe(true);
    });

    it("flags advise_fires unavailable when the hook query is empty", async () => {
        const layer = makeMockDb([[], [], [], [], [], []]);
        const result = await run(fetchDispatchEconomy({ sinceDays: 14 }), layer);
        expect(result.advise_fires).toBe(0);
        expect(result.advise_fires_available).toBe(false);
    });

    it("sorts by_class by overspend desc", async () => {
        // Two classes: well-specified-impl (big fable overspend) and spec-review
        // (smaller opus overspend). Big one must sort first.
        const spawned = [
            {
                parent_id: "session:p1", child_id: "session:c-impl",
                ts: "2026-06-12T10:00:00Z", agent_type: "general-purpose",
                description: "Implement the big feature", tool_use_id: null,
            },
            {
                parent_id: "session:p1", child_id: "session:c-review",
                ts: "2026-06-12T10:01:00Z", agent_type: null,
                description: "spec review the PR", tool_use_id: null,
            },
        ];
        const usage = [
            {
                session_id: "session:c-impl", model: "claude-fable-5",
                prompt_tokens: 1_000_000, completion_tokens: 0,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 15.0,
            },
            {
                session_id: "session:c-review", model: "claude-opus-4-8",
                prompt_tokens: 100_000, completion_tokens: 0,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 2.0,
            },
        ];
        const layer = makeMockDb([spawned, usage, [], [], agentModels, [{ n: 3 }]]);
        const result = await run(fetchDispatchEconomy({ sinceDays: 14 }), layer);

        expect(result.by_class).toHaveLength(2);
        expect(result.by_class[0]!.classId).toBe("well-specified-impl");
        expect(result.by_class[0]!.overspend_usd).toBeGreaterThan(result.by_class[1]!.overspend_usd);
        // Totals cross-foot across both classes.
        expect(result.ran_expensive).toBe(2);
        expect(result.overspend_usd).toBeCloseTo(17.0, 4);
    });
});

// ---------------------------------------------------------------------------
// compileRouting merge-preserve
// ---------------------------------------------------------------------------

describe("compileRouting merge-preserve", () => {
    it("preserves user classes across regeneration and tags defaults", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-compile-routing-"));
        const p = join(dir, "routing-table.json");
        // seed
        await runCompileRouting(p);
        // hand-add a user class (simulating a prior `ax routing tune` apply)
        const seeded = JSON.parse(readFileSync(p, "utf8"));
        seeded.classes.push({
            id: "my-mined-class", pattern: "^summarize", flags: "i",
            suggest: "haiku", reason: "mined", origin: "user",
        });
        writeFileSync(p, JSON.stringify(seeded));
        // regenerate
        const result = await runCompileRouting(p);
        expect(result.written).toBe(true);
        expect(result.preserved_user_classes).toBe(1);
        expect(result.corrupt).toBe(false);
        const after = JSON.parse(readFileSync(p, "utf8"));
        const ids = after.classes.map((c: { id: string }) => c.id);
        expect(ids).toContain("my-mined-class");
        expect(after.classes[0].origin).toBe("default");
        expect(after.classes.filter((c: { id: string }) => c.id === "spec-review")).toHaveLength(1);
    });

    it("refuses to overwrite a corrupt routing-table file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-compile-routing-corrupt-"));
        const p = join(dir, "routing-table.json");
        writeFileSync(p, "{not json");
        const result = await runCompileRouting(p);
        expect(result.corrupt).toBe(true);
        expect(result.written).toBe(false);
        expect(result.preserved_user_classes).toBe(0);
        // file content untouched
        expect(readFileSync(p, "utf8")).toBe("{not json");
    });

    it("seeds normally when the file is missing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-compile-routing-missing-"));
        const p = join(dir, "routing-table.json");
        const result = await runCompileRouting(p);
        expect(result.written).toBe(true);
        expect(result.corrupt).toBe(false);
        const parsed = JSON.parse(readFileSync(p, "utf8"));
        expect(parsed.version).toBe(1);
        expect(parsed.classes.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Model-drop detection (continuation legs)
// ---------------------------------------------------------------------------

import { computeModelDrop, legMatchesDispatchModel } from "./dispatch-analytics.ts";

describe("legMatchesDispatchModel", () => {
    it("alias family matches any model containing it", () => {
        expect(legMatchesDispatchModel("claude-sonnet-4-6", "sonnet")).toBe(true);
        expect(legMatchesDispatchModel("claude-haiku-4-5-20251001", "haiku")).toBe(true);
        expect(legMatchesDispatchModel("claude-fable-5", "sonnet")).toBe(false);
    });

    it("full model names match exactly", () => {
        expect(legMatchesDispatchModel("claude-sonnet-4-6", "claude-sonnet-4-6")).toBe(true);
        expect(legMatchesDispatchModel("claude-opus-4-8", "claude-sonnet-4-6")).toBe(false);
    });
});

describe("computeModelDrop", () => {
    it("inherit dispatches never drop", () => {
        const drop = computeModelDrop("inherit", [
            { model: "claude-fable-5", cost_usd: 10, turns: 5 },
        ], "claude-fable-5", 10);
        expect(drop.dropped).toBe(false);
        expect(drop.dropped_cost_usd).toBe(0);
    });

    it("flags off-model legs and sums their cost (the S2-T4 shape)", () => {
        // Dispatched sonnet; first leg honored, continuation legs ran fable.
        const drop = computeModelDrop("sonnet", [
            { model: "claude-sonnet-4-6", cost_usd: 1.2, turns: 44 },
            { model: "claude-fable-5", cost_usd: 116.3, turns: 290 },
        ], "claude-fable-5", 117.5);
        expect(drop.dropped).toBe(true);
        expect(drop.dropped_cost_usd).toBeCloseTo(116.3);
    });

    it("fully honored dispatches do not drop", () => {
        const drop = computeModelDrop("sonnet", [
            { model: "claude-sonnet-4-6", cost_usd: 3.1, turns: 20 },
        ], "claude-sonnet-4-6", 3.1);
        expect(drop.dropped).toBe(false);
    });

    it("falls back to session-level child model when no legs exist", () => {
        const drop = computeModelDrop("sonnet", [], "claude-fable-5", 23.4);
        expect(drop.dropped).toBe(true);
        expect(drop.dropped_cost_usd).toBeCloseTo(23.4);
    });
});

describe("fetchDispatches model-drop join", () => {
    it("joins child legs and reports drop totals", async () => {
        const spawned = [{
            parent_id: "session:p1",
            child_id: "session:`claude-subagent-c1`",
            ts: "2026-06-12T15:43:09Z",
            agent_type: "general-purpose",
            description: "Implement S2-T4: migrate mutations to bus",
            tool_use_id: "toolu_1",
        }];
        const usage = [{
            session_id: "session:`claude-subagent-c1`",
            model: "claude-fable-5",
            prompt_tokens: 1000,
            completion_tokens: 100,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            cost_usd: 117.5,
        }];
        const toolCalls = [{
            session_id: "session:p1",
            call_id: "toolu_1",
            input_json: JSON.stringify({ model: "sonnet", description: "Implement S2-T4: migrate mutations to bus" }),
        }];
        const parents = [{ session_id: "session:p1", model: "claude-fable-5" }];
        const legs = [
            { session_id: "session:`claude-subagent-c1`", model: "claude-sonnet-4-6", cost_usd: 1.2, turns: 44 },
            { session_id: "session:`claude-subagent-c1`", model: "claude-fable-5", cost_usd: 116.3, turns: 290 },
        ];

        const layer = makeMockDb([spawned, usage, toolCalls, parents, legs]);
        const result = await run(fetchDispatches({ sinceDays: 30, limit: 10 }), layer);

        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row.dispatch_model).toBe("sonnet");
        expect(row.model_dropped).toBe(true);
        expect(row.dropped_cost_usd).toBeCloseTo(116.3);
        expect(row.child_legs).toHaveLength(2);
        expect(result.dropped_count).toBe(1);
        expect(result.dropped_cost_usd).toBeCloseTo(116.3);
    });
});
