import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { fetchSkillLoaded } from "./skill-loaded.ts";

type QueryResult = Array<unknown>;
const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) =>
            Effect.succeed(results as unknown as [QueryResult, ...QueryResult[]]),
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};
const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("fetchSkillLoaded", () => {
    it("joins activation counts to skill names, sorts desc, respects limit", async () => {
        const rows = await run(
            fetchSkillLoaded({ limit: 2 }),
            makeMockDb([
                [
                    { sid: "skill:a", activations: 80 },
                    { sid: "skill:b", activations: 102 },
                    { sid: "skill:c", activations: 4 },
                ],
                [
                    { id: "skill:a", name: "a", content_hash: "ha" },
                    { id: "skill:b", name: "b", content_hash: "hb" },
                    { id: "skill:c", name: "c", content_hash: "hc" },
                ],
            ]),
        );
        expect(rows).toEqual([
            { name: "b", activations: 102 },
            { name: "a", activations: 80 },
        ]);
    });

    it("collapses plugin-namespace twins, sums activations, keeps bare name", async () => {
        const rows = await run(
            fetchSkillLoaded({ limit: 10 }),
            makeMockDb([
                [
                    { sid: "skill:bare", activations: 80 },
                    { sid: "skill:ns", activations: 80 },
                ],
                [
                    { id: "skill:bare", name: "image-to-code", content_hash: "h1" },
                    { id: "skill:ns", name: "necmttn:image-to-code", content_hash: "h1" },
                ],
            ]),
        );
        expect(rows).toEqual([{ name: "image-to-code", activations: 160 }]);
    });

    it("returns empty when no activations", async () => {
        const rows = await run(fetchSkillLoaded({ limit: 10 }), makeMockDb([[], []]));
        expect(rows).toEqual([]);
    });
});
