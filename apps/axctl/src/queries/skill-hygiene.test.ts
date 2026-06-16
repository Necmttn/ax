/**
 * Tests for skill-hygiene.ts
 *
 * Uses makeMockDb (canned invocation counts / skill rows / classified ids)
 * to exercise deref-free join logic, filtering, sorting, and limit.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { fetchSkillHygiene } from "./skill-hygiene.ts";

// ---------------------------------------------------------------------------
// Mock DB helper (mirrors dispatch-analytics.test.ts idiom exactly)
// ---------------------------------------------------------------------------

// Allow unknown[] so SELECT VALUE results (bare strings) typecheck alongside
// the normal Record<string,unknown>[] statement results.
type QueryResult = Array<unknown>;

const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) => {
            return Effect.succeed(results as unknown as [QueryResult, ...QueryResult[]]);
        },
        // biome-ignore lint: other methods not needed
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(
    eff: Effect.Effect<A, unknown, SurrealClient>,
    layer: Layer.Layer<SurrealClient>,
) => Effect.runPromise(eff.pipe(Effect.provide(layer)));

// ---------------------------------------------------------------------------
// fetchSkillHygiene
// ---------------------------------------------------------------------------

describe("fetchSkillHygiene", () => {
    it("joins counts to names, drops synthetic + classified + low-count", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 3, limit: 10 }),
            makeMockDb([
                // statement 1: invocation counts by skill id
                [
                    { sid: "skill:composto", invocations: 41 },
                    { sid: "skill:codex_exec", invocations: 39545 },
                    { sid: "skill:tagged", invocations: 12 },
                    { sid: "skill:rare", invocations: 2 },
                ],
                // statement 2: skill rows
                [
                    { id: "skill:composto", name: "composto", dir_path: "/skills/composto" },
                    { id: "skill:codex_exec", name: "codex:exec_command", dir_path: "(synthetic)" },
                    { id: "skill:tagged", name: "tagged", dir_path: "/skills/tagged" },
                    { id: "skill:rare", name: "rare", dir_path: "/skills/rare" },
                ],
                // statement 3: classified skill ids (SELECT VALUE -> bare values)
                ["skill:tagged"],
            ]),
        );
        expect(rows).toEqual([{ name: "composto", invocations: 41 }]);
    });

    it("respects limit and sorts by invocations desc", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 3, limit: 1 }),
            makeMockDb([
                [
                    { sid: "skill:a", invocations: 5 },
                    { sid: "skill:b", invocations: 9 },
                ],
                [
                    { id: "skill:a", name: "a", dir_path: "/s/a" },
                    { id: "skill:b", name: "b", dir_path: "/s/b" },
                ],
                [],
            ]),
        );
        expect(rows).toEqual([{ name: "b", invocations: 9 }]);
    });

    it("returns empty when all skills are synthetic", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 1, limit: 10 }),
            makeMockDb([
                [{ sid: "skill:codex_exec", invocations: 999 }],
                [{ id: "skill:codex_exec", name: "codex:exec_command", dir_path: "(synthetic)" }],
                [],
            ]),
        );
        expect(rows).toEqual([]);
    });

    it("returns empty when all skills are classified", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 1, limit: 10 }),
            makeMockDb([
                [{ sid: "skill:foo", invocations: 10 }],
                [{ id: "skill:foo", name: "foo", dir_path: "/skills/foo" }],
                ["skill:foo"],
            ]),
        );
        expect(rows).toEqual([]);
    });

    it("returns empty when all skills are below minInvocations threshold", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 5, limit: 10 }),
            makeMockDb([
                [{ sid: "skill:rare", invocations: 2 }],
                [{ id: "skill:rare", name: "rare", dir_path: "/skills/rare" }],
                [],
            ]),
        );
        expect(rows).toEqual([]);
    });

    it("collapses plugin-namespace twins: sums invocations, keeps bare name", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 3, limit: 10 }),
            makeMockDb([
                [
                    { sid: "skill:bare", invocations: 2 },
                    { sid: "skill:ns", invocations: 3 },
                ],
                [
                    { id: "skill:bare", name: "foo", dir_path: "/s/foo", content_hash: "h1" },
                    { id: "skill:ns", name: "necmttn:foo", dir_path: "/s/foo", content_hash: "h1" },
                ],
                [],
            ]),
        );
        // merged 2+3=5 >= 3 threshold, bare name kept
        expect(rows).toEqual([{ name: "foo", invocations: 5 }]);
    });

    it("twin is classified if EITHER member is classified", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 1, limit: 10 }),
            makeMockDb([
                [
                    { sid: "skill:bare", invocations: 4 },
                    { sid: "skill:ns", invocations: 4 },
                ],
                [
                    { id: "skill:bare", name: "foo", dir_path: "/s/foo", content_hash: "h1" },
                    { id: "skill:ns", name: "necmttn:foo", dir_path: "/s/foo", content_hash: "h1" },
                ],
                ["skill:ns"], // only the namespaced twin is classified
            ]),
        );
        // collapsed -> classified -> dropped entirely
        expect(rows).toEqual([]);
    });

    it("returns empty when no data", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 3, limit: 10 }),
            makeMockDb([[], [], []]),
        );
        expect(rows).toEqual([]);
    });

    it("handles missing skill rows gracefully (count with no matching skill)", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 1, limit: 10 }),
            makeMockDb([
                [{ sid: "skill:orphan", invocations: 10 }],
                [],  // no skill rows
                [],
            ]),
        );
        // orphan count has no skill metadata -> silently skipped
        expect(rows).toEqual([]);
    });
});
