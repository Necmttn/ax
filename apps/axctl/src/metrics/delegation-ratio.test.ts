import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { computeDelegationRatio as computeDelegationRatioWithRead } from "./delegation-ratio.ts";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { makeTestCacheRead } from "@ax/lib/testing/cache";

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
    makeTestCacheRead({ fallback: (sql, params) => {
            if (/FROM spawned/.test(sql)) {
                return opts.spawnEdges
                    .filter((e) => params?.includes(e.parent))
                    .map((e) => ({ parent: e.parent, child: e.child }));
            }
            if (/FROM produced/.test(sql)) {
                const rootIds = new Set(opts.direct.map((row) => String(row.session)));
                if (params?.some((value) => typeof value === "string" && rootIds.has(value))) return opts.direct;
                const childIds = new Set(opts.spawnEdges.map((edge) => edge.child));
                if (params?.some((value) => typeof value === "string" && childIds.has(value))) return opts.childProduced;
                return opts.direct;
            }
            return [];
        } }).layer;
const computeDelegationRatio = (ids: readonly string[]) => Effect.gen(function* () {
    return yield* computeDelegationRatioWithRead(yield* CacheRead, ids);
});

describe("computeDelegationRatio", () => {
    test("ratio = sub / (direct + sub)", async () => {
        const out = await Effect.runPromise(
            computeDelegationRatio(["session:`p1`"]).pipe(
                Effect.provide(db({
                    direct: [{ session: "session:`p1`", produced: 1 }],
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
                    direct: [{ session: "session:`A`", produced: 0 }],
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
                    direct: [{ session: "session:`p2`", produced: 3 }],
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
                    direct: [{ session: "session:`r`", produced: 1 }],
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
