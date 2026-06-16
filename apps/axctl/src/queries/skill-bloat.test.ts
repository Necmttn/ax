/**
 * Tests for skill-bloat.ts
 *
 * Mirrors skill-hygiene.test.ts: canned skill rows + invocation counts,
 * exercises token estimation, budget filter, synthetic/null drops, prioritise
 * by invocations, sort + limit.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { estimateTokens, fetchSkillBloat } from "./skill-bloat.ts";

type QueryResult = Array<unknown>;

const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) =>
            Effect.succeed(results as unknown as [QueryResult, ...QueryResult[]]),
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(
    eff: Effect.Effect<A, unknown, SurrealClient>,
    layer: Layer.Layer<SurrealClient>,
) => Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("estimateTokens", () => {
    it("estimates ~4 bytes per token, rounded", () => {
        expect(estimateTokens(4000)).toBe(1000);
        expect(estimateTokens(4002)).toBe(1001); // 1000.5 -> 1001
        expect(estimateTokens(0)).toBe(0);
    });
});

describe("fetchSkillBloat", () => {
    it("flags only skills over the token budget, with overBy + estTokens", async () => {
        const rows = await run(
            fetchSkillBloat({ budgetTokens: 2000, limit: 10 }),
            makeMockDb([
                // statement 1: skill rows (bytes)
                [
                    { id: "skill:fat", name: "fat", bytes: 12000, dir_path: "/s/fat" },     // 3000 tok
                    { id: "skill:lean", name: "lean", bytes: 4000, dir_path: "/s/lean" },   // 1000 tok
                ],
                // statement 2: invocation counts
                [{ sid: "skill:fat", invocations: 7 }],
            ]),
        );
        expect(rows).toEqual([
            { name: "fat", bytes: 12000, estTokens: 3000, overBy: 1000, invocations: 7 },
        ]);
    });

    it("skips synthetic shims and null-bytes skills", async () => {
        const rows = await run(
            fetchSkillBloat({ budgetTokens: 100, limit: 10 }),
            makeMockDb([
                [
                    { id: "skill:syn", name: "codex:exec", bytes: 99999, dir_path: "(synthetic)" },
                    { id: "skill:nob", name: "nobytes", bytes: null, dir_path: "/s/nob" },
                    { id: "skill:real", name: "real", bytes: 800, dir_path: "/s/real" }, // 200 tok
                ],
                [],
            ]),
        );
        expect(rows).toEqual([
            { name: "real", bytes: 800, estTokens: 200, overBy: 100, invocations: 0 },
        ]);
    });

    it("sorts by estTokens desc and respects limit", async () => {
        const rows = await run(
            fetchSkillBloat({ budgetTokens: 0, limit: 2 }),
            makeMockDb([
                [
                    { id: "skill:a", name: "a", bytes: 400, dir_path: "/s/a" },   // 100
                    { id: "skill:b", name: "b", bytes: 1200, dir_path: "/s/b" },  // 300
                    { id: "skill:c", name: "c", bytes: 800, dir_path: "/s/c" },   // 200
                ],
                [],
            ]),
        );
        expect(rows.map((r) => r.name)).toEqual(["b", "c"]);
    });

    it("collapses plugin-namespace twins (same content_hash), keeps bare name, sums invocations", async () => {
        const rows = await run(
            fetchSkillBloat({ budgetTokens: 100, limit: 10 }),
            makeMockDb([
                [
                    { id: "skill:bare", name: "review", bytes: 800, dir_path: "/s/review", content_hash: "h1" },
                    { id: "skill:ns", name: "necmttn:review", bytes: 800, dir_path: "/s/review", content_hash: "h1" },
                ],
                [
                    { sid: "skill:bare", invocations: 4 },
                    { sid: "skill:ns", invocations: 3 },
                ],
            ]),
        );
        expect(rows).toEqual([
            { name: "review", bytes: 800, estTokens: 200, overBy: 100, invocations: 7 },
        ]);
    });

    it("does NOT collapse distinct skills that lack a content_hash", async () => {
        const rows = await run(
            fetchSkillBloat({ budgetTokens: 100, limit: 10 }),
            makeMockDb([
                [
                    { id: "skill:a", name: "a", bytes: 800, dir_path: "/s/a", content_hash: null },
                    { id: "skill:b", name: "b", bytes: 800, dir_path: "/s/b", content_hash: null },
                ],
                [],
            ]),
        );
        expect(rows.map((r) => r.name).sort()).toEqual(["a", "b"]);
    });

    it("returns empty when every skill is within budget", async () => {
        const rows = await run(
            fetchSkillBloat({ budgetTokens: 2000, limit: 10 }),
            makeMockDb([
                [{ id: "skill:lean", name: "lean", bytes: 4000, dir_path: "/s/lean" }],
                [],
            ]),
        );
        expect(rows).toEqual([]);
    });

    it("returns empty when no data", async () => {
        const rows = await run(
            fetchSkillBloat({ budgetTokens: 2000, limit: 10 }),
            makeMockDb([[], []]),
        );
        expect(rows).toEqual([]);
    });
});
