import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeDelegationRatio } from "./delegation-ratio.ts";
import { SurrealClient } from "@ax/lib/db";

// Route the three reads. Query A (direct) and Query C (children) both hit
// `FROM produced ... GROUP BY session`; they differ by which session keys are
// in the IN-list, so we disambiguate on the literal keys present in the SQL.
const db = (opts: {
    direct: Array<Record<string, unknown>>;
    spawned: Array<Record<string, unknown>>;
    childProduced: Array<Record<string, unknown>>;
}) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/FROM spawned/.test(sql)) return Effect.succeed([opts.spawned] as unknown as T);
            if (/FROM produced/.test(sql)) {
                // Children query references child keys (c1/c2); direct query references parent keys.
                if (/`c1`|`c2`/.test(sql)) return Effect.succeed([opts.childProduced] as unknown as T);
                return Effect.succeed([opts.direct] as unknown as T);
            }
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("computeDelegationRatio", () => {
    test("ratio = sub / (direct + sub)", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`p1`"]).pipe(
                Effect.provide(db({
                    direct: [{ session: "session:`p1`", direct: 1 }],
                    spawned: [
                        { parent: "session:`p1`", child: "session:`c1`" },
                        { parent: "session:`p1`", child: "session:`c2`" },
                    ],
                    childProduced: [
                        { session: "session:`c1`", produced: 2 },
                        { session: "session:`c2`", produced: 1 },
                    ],
                })),
            ),
        );
        // sub=3, direct=1, total=4 → 0.75
        expect(out.get("session:`p1`")).toBe(0.75);
    });
    test("no children, has direct commits → ratio 0 (not null)", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`p2`"]).pipe(
                Effect.provide(db({
                    direct: [{ session: "session:`p2`", direct: 3 }],
                    spawned: [],
                    childProduced: [],
                })),
            ),
        );
        expect(out.get("session:`p2`")).toBe(0);
    });
    test("total produced 0 → null", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`p3`"]).pipe(
                Effect.provide(db({ direct: [], spawned: [], childProduced: [] })),
            ),
        );
        expect(out.get("session:`p3`")).toBeNull();
    });
    test("absent session defaults to null", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`pX`"]).pipe(
                Effect.provide(db({ direct: [], spawned: [], childProduced: [] })),
            ),
        );
        expect(out.get("session:`pX`")).toBeNull();
    });
    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio([]).pipe(Effect.provide(db({ direct: [], spawned: [], childProduced: [] }))),
        );
        expect(out.size).toBe(0);
    });
});
