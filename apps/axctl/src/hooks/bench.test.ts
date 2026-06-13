import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { buildRepresentativePayload, composeChain, estFiresPerDay, percentiles, renderLedger } from "./bench.ts";
import type { BenchLedger } from "./bench.ts";
import { SurrealClient } from "@ax/lib/db";

// fake-client harness (mirrors apps/axctl/src/improve/show.test.ts)
const fakeClient = (...fixtures: unknown[][]) => {
    let i = 0;
    return {
        layer: Layer.succeed(SurrealClient, {
            query: <T>(_: string) => Effect.succeed([(fixtures[i++] ?? [])] as unknown as T),
        } as never),
    };
};

describe("percentiles", () => {
    test("p50/p95/min/max/mean over samples", () => {
        const p = percentiles([10, 20, 30, 40, 100]);
        expect(p.min).toBe(10);
        expect(p.max).toBe(100);
        expect(p.p50).toBe(30); // median (nearest-rank)
        expect(p.p95).toBe(100);
        expect(p.mean).toBe(40);
    });
    test("single sample: all equal", () => {
        expect(percentiles([7])).toEqual({ min: 7, max: 7, p50: 7, p95: 7, mean: 7 });
    });
    test("empty -> zeros", () => {
        expect(percentiles([])).toEqual({ min: 0, max: 0, p50: 0, p95: 0, mean: 0 });
    });
});

describe("buildRepresentativePayload", () => {
    test("PreToolUse with a matched tool + sample input", () => {
        const json = buildRepresentativePayload(
            { name: "x", events: ["PreToolUse"], matcher: { tools: ["Bash", "Edit"] } },
            { command: "git status" },
            "/repo",
        );
        const parsed = JSON.parse(json);
        expect(parsed.hook_event_name).toBe("PreToolUse");
        expect(parsed.tool_name).toBe("Bash"); // first matched tool
        expect(parsed.tool_input).toEqual({ command: "git status" });
        expect(parsed.cwd).toBe("/repo");
    });
    test("non-tool event (no matcher) -> no tool_name/tool_input", () => {
        const json = buildRepresentativePayload(
            { name: "x", events: ["SessionStart"], matcher: undefined }, null, "/repo",
        );
        const parsed = JSON.parse(json);
        expect(parsed.hook_event_name).toBe("SessionStart");
        expect(parsed.tool_name).toBeUndefined();
    });
});

describe("renderLedger", () => {
    const ledger: BenchLedger = {
        name: "enforce-worktree",
        perFire: { p50: 72, p95: 84, min: 70, max: 140, mean: 78 },
        warmupMs: 140, spawns: 19,
        logicMs: 2,
        frequency: { perDay: 14, matched: ["Bash", "Edit"], basis: "tool_call/30d" },
        dailyCostMs: 1008,
        chain: { event: "PreToolUse", beforeMs: 198, withMs: 270, budgetMs: 250, overBudget: true,
                 hooks: ["enforce-worktree", "route-dispatch", "other"] },
    };
    test("renders headline + frequency + chain warning", () => {
        const out = renderLedger(ledger);
        expect(out).toContain("hook: enforce-worktree");
        expect(out).toContain("p50 72ms");
        expect(out).toContain("p95 84ms");
        expect(out).toContain("fires/day");
        expect(out).toContain("14");
        expect(out).toContain("chain (PreToolUse): 198ms -> 270ms");
        expect(out).toContain("over 250ms budget");
    });
    test("frequency n/a hides daily cost line", () => {
        const out = renderLedger({ ...ledger, frequency: { perDay: null, matched: [], basis: "n/a" }, dailyCostMs: null });
        expect(out).toContain("fires/day:     n/a");
        expect(out).not.toContain("daily cost:");
    });
    test("chain:null + null logicMs/warmup -> no chain line, no crash", () => {
        const out = renderLedger({ ...ledger, warmupMs: null, logicMs: null, chain: null });
        expect(out).toContain("hook: enforce-worktree");
        expect(out).not.toContain("chain (");
        expect(out).not.toContain("warmup");
        expect(out).not.toContain("logic");
    });
});

describe("composeChain", () => {
    test("sums installed costs + candidate p50; under budget", () => {
        const c = composeChain("PreToolUse", [60, 70, 68], 72, 250, ["a", "b", "c"]);
        expect(c.event).toBe("PreToolUse");
        expect(c.beforeMs).toBe(198); // 60+70+68
        expect(c.withMs).toBe(270); // 198 + 72
        expect(c.budgetMs).toBe(250);
        expect(c.overBudget).toBe(true); // 270 > 250
        expect(c.hooks).toEqual(["a", "b", "c"]);
    });
    test("empty installed chain -> beforeMs 0, withMs = rounded candidate", () => {
        const c = composeChain("PreToolUse", [], 72.4, 250, []);
        expect(c.beforeMs).toBe(0);
        expect(c.withMs).toBe(72); // round(72.4)
        expect(c.overBudget).toBe(false);
        expect(c.hooks).toEqual([]);
    });
    test("withMs strictly over budget is over; exactly == budget is NOT over", () => {
        // 200 + 51 = 251 > 250 -> over
        expect(composeChain("E", [200], 51, 250, []).overBudget).toBe(true);
        // 200 + 50 = 250 == 250 -> NOT over (strict >)
        const eq = composeChain("E", [200], 50, 250, []);
        expect(eq.withMs).toBe(250);
        expect(eq.overBudget).toBe(false);
        // 200 + 49 = 249 < 250 -> under
        expect(composeChain("E", [200], 49, 250, []).overBudget).toBe(false);
    });
});

describe("estFiresPerDay", () => {
    test("counts matched tool_calls / days", async () => {
        const client = fakeClient([{ total: 420 }]); // 420 matched over 30d
        const r = await Effect.runPromise(
            estFiresPerDay(["Bash", "Edit"], 30).pipe(Effect.provide(client.layer)),
        );
        expect(r.perDay).toBe(14);
        expect(r.matched).toEqual(["Bash", "Edit"]);
    });
    test("no tools (non-tool hook) -> perDay null, basis n/a", async () => {
        const r = await Effect.runPromise(
            estFiresPerDay([], 30).pipe(Effect.provide(fakeClient([]).layer)),
        );
        expect(r.perDay).toBeNull();
    });
    test("total=0 -> perDay 0", async () => {
        const r = await Effect.runPromise(
            estFiresPerDay(["Bash"], 30).pipe(Effect.provide(fakeClient([{ total: 0 }]).layer)),
        );
        expect(r.perDay).toBe(0);
    });
});
