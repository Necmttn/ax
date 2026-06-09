import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeDelegationRatio } from "./delegation-ratio.ts";
import { SurrealClient } from "@ax/lib/db";

// Route the reads. The direct query and the descendant-produced query both hit
// `FROM produced ... GROUP BY session`; they differ by which session keys are in
// the IN-list, so we disambiguate on the literal keys present in the SQL. The
// spawn query (`FROM spawned`) is issued once per frontier depth with a varying
// IN-list; the mock returns parent→child edges only when the parent key is in
// the IN-list, so the descendant walk terminates naturally.
const db = (opts: {
    direct: Array<Record<string, unknown>>;
    spawnEdges: Array<{ parent: string; child: string; parentKey: string }>;
    childProduced: Array<Record<string, unknown>>;
    childKeyPattern: RegExp;
}) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/FROM spawned/.test(sql)) {
                // Only return edges whose parent key is present in this read's IN-list.
                const rows = opts.spawnEdges
                    .filter((e) => new RegExp("`" + e.parentKey + "`").test(sql))
                    .map((e) => ({ parent: e.parent, child: e.child }));
                return Effect.succeed([rows] as unknown as T);
            }
            if (/FROM produced/.test(sql)) {
                if (opts.childKeyPattern.test(sql)) return Effect.succeed([opts.childProduced] as unknown as T);
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
                    spawnEdges: [
                        { parent: "session:`p1`", child: "session:`c1`", parentKey: "p1" },
                        { parent: "session:`p1`", child: "session:`c2`", parentKey: "p1" },
                    ],
                    childProduced: [
                        { session: "session:`c1`", produced: 2 },
                        { session: "session:`c2`", produced: 1 },
                    ],
                    childKeyPattern: /`c1`|`c2`/,
                })),
            ),
        );
        // sub=3, direct=1, total=4 → 0.75
        expect(out.get("session:`p1`")).toBe(0.75);
    });

    test("recursive: grandchild's produced commits count toward the root (A→B→C)", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`A`"]).pipe(
                Effect.provide(db({
                    direct: [{ session: "session:`A`", direct: 0 }],
                    spawnEdges: [
                        { parent: "session:`A`", child: "session:`B`", parentKey: "A" },
                        { parent: "session:`B`", child: "session:`C`", parentKey: "B" },
                    ],
                    // Only grandchild C produced a commit; B produced nothing.
                    childProduced: [{ session: "session:`C`", produced: 2 }],
                    childKeyPattern: /`C`/,
                })),
            ),
        );
        // sub=2 (from C, a grandchild), direct=0, total=2 → ratio 1.
        expect(out.get("session:`A`")).toBe(1);
    });

    test("no children, has direct commits → ratio 0 (not null)", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`p2`"]).pipe(
                Effect.provide(db({
                    direct: [{ session: "session:`p2`", direct: 3 }],
                    spawnEdges: [],
                    childProduced: [],
                    childKeyPattern: /never/,
                })),
            ),
        );
        expect(out.get("session:`p2`")).toBe(0);
    });

    test("total produced 0 → null", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`p3`"]).pipe(
                Effect.provide(db({ direct: [], spawnEdges: [], childProduced: [], childKeyPattern: /never/ })),
            ),
        );
        expect(out.get("session:`p3`")).toBeNull();
    });

    test("absent session defaults to null", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`pX`"]).pipe(
                Effect.provide(db({ direct: [], spawnEdges: [], childProduced: [], childKeyPattern: /never/ })),
            ),
        );
        expect(out.get("session:`pX`")).toBeNull();
    });

    test("empty input → empty map", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio([]).pipe(
                Effect.provide(db({ direct: [], spawnEdges: [], childProduced: [], childKeyPattern: /never/ })),
            ),
        );
        expect(out.size).toBe(0);
    });

    test("cycle-guarded: self/back spawn edge does not loop forever", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`r`"]).pipe(
                Effect.provide(db({
                    direct: [{ session: "session:`r`", direct: 1 }],
                    spawnEdges: [
                        { parent: "session:`r`", child: "session:`k`", parentKey: "r" },
                        // k spawns back to r (cycle) and to itself.
                        { parent: "session:`k`", child: "session:`r`", parentKey: "k" },
                        { parent: "session:`k`", child: "session:`k`", parentKey: "k" },
                    ],
                    childProduced: [{ session: "session:`k`", produced: 3 }],
                    childKeyPattern: /`k`/,
                })),
            ),
        );
        // sub=3 (k, counted once), direct=1, total=4 → 0.75. Root r excluded from its own subtree.
        expect(out.get("session:`r`")).toBe(0.75);
    });
});
