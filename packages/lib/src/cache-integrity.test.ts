// packages/lib/src/cache-integrity.test.ts
import { describe, expect, test } from "bun:test";
import { type SidecarRef, buildCacheIdIndex, checkCacheIntegrity } from "./cache-integrity.ts";

const index = buildCacheIdIndex([
    { table: "session", id: "s1" },
    { table: "session", id: "s2" },
    { table: "turn", id: "t1" },
]);

const ref = (over: Partial<SidecarRef>): SidecarRef => ({
    sidecarTable: "proposal",
    sidecarId: "p1",
    column: "session",
    targetTable: "session",
    targetId: "s1",
    ...over,
});

describe("checkCacheIntegrity", () => {
    test("clean refs report ok with zero dangling", () => {
        const r = checkCacheIntegrity([ref({}), ref({ sidecarId: "p2", targetTable: "turn", targetId: "t1" })], index);
        expect(r.checked).toBe(2);
        expect(r.dangling).toBe(0);
        expect(r.ok).toBe(true);
        expect(r.samples).toEqual([]);
    });

    test("counts a ref whose target id vanished from the cache", () => {
        const r = checkCacheIntegrity([ref({ targetId: "gone" })], index);
        expect(r.dangling).toBe(1);
        expect(r.ok).toBe(false);
        expect(r.byTargetTable).toEqual({ session: 1 });
        expect(r.samples[0]?.reason).toBe("missing_id");
        expect(r.samples[0]?.sidecarId).toBe("p1");
    });

    test("a ref to a table the cache does not have is dangling as unknown_table", () => {
        const r = checkCacheIntegrity([ref({ targetTable: "ghost", targetId: "x" })], index);
        expect(r.dangling).toBe(1);
        expect(r.samples[0]?.reason).toBe("unknown_table");
        expect(r.byTargetTable).toEqual({ ghost: 1 });
    });

    test("aggregates per target table across many refs", () => {
        const refs = [
            ref({ sidecarId: "a", targetId: "gone1" }),
            ref({ sidecarId: "b", targetId: "gone2" }),
            ref({ sidecarId: "c", targetTable: "turn", targetId: "gone3" }),
            ref({ sidecarId: "d" }),
        ];
        const r = checkCacheIntegrity(refs, index);
        expect(r.checked).toBe(4);
        expect(r.dangling).toBe(3);
        expect(r.byTargetTable).toEqual({ session: 2, turn: 1 });
    });

    test("samples are capped by sampleLimit", () => {
        const refs = Array.from({ length: 30 }, (_, i) => ref({ sidecarId: `p${i}`, targetId: `gone${i}` }));
        const r = checkCacheIntegrity(refs, index, { sampleLimit: 5 });
        expect(r.dangling).toBe(30);
        expect(r.samples.length).toBe(5);
    });

    test("empty inputs are ok", () => {
        const r = checkCacheIntegrity([], buildCacheIdIndex([]));
        expect(r).toEqual({ checked: 0, dangling: 0, byTargetTable: {}, samples: [], ok: true });
    });

    test("buildCacheIdIndex groups ids by table", () => {
        const idx = buildCacheIdIndex([{ table: "a", id: "1" }, { table: "a", id: "2" }, { table: "b", id: "1" }]);
        expect(idx.get("a")?.size).toBe(2);
        expect(idx.get("b")?.has("1")).toBe(true);
        expect(idx.get("c")).toBeUndefined();
    });
});
