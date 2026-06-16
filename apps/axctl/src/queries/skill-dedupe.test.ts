import { describe, expect, it } from "bun:test";
import {
    bareSkillName,
    dedupeByContentHash,
    isPluginNamespaced,
    preferCanonicalName,
} from "./skill-dedupe.ts";

describe("isPluginNamespaced / bareSkillName", () => {
    it("detects and strips the owner namespace", () => {
        expect(isPluginNamespaced("necmttn:foo")).toBe(true);
        expect(isPluginNamespaced("foo")).toBe(false);
        expect(bareSkillName("necmttn:foo")).toBe("foo");
        expect(bareSkillName("foo")).toBe("foo");
        expect(bareSkillName("a:b:c")).toBe("b:c"); // strips only leading owner
    });
});

describe("preferCanonicalName", () => {
    it("bare beats namespaced regardless of order", () => {
        expect(preferCanonicalName("foo", "necmttn:foo")).toBe("foo");
        expect(preferCanonicalName("necmttn:foo", "foo")).toBe("foo");
    });
    it("on tie, shorter then lexicographically smaller", () => {
        expect(preferCanonicalName("bbb", "aa")).toBe("aa");
        expect(preferCanonicalName("bbb", "aaa")).toBe("aaa");
    });
});

interface Row {
    name: string;
    hash: string | null;
    n: number;
}
const dedupe = (rows: Row[]) =>
    dedupeByContentHash<Row>(
        rows,
        (r) => r.hash,
        (r) => r.name,
        (r, name) => ({ ...r, name }),
        (kept, dup) => ({ ...kept, n: kept.n + dup.n }),
    );

describe("dedupeByContentHash", () => {
    it("collapses same-hash rows, keeps bare name, merges numeric field", () => {
        expect(
            dedupe([
                { name: "necmttn:review", hash: "h1", n: 3 },
                { name: "review", hash: "h1", n: 4 },
            ]),
        ).toEqual([{ name: "review", hash: "h1", n: 7 }]);
    });

    it("preserves first-appearance order", () => {
        const out = dedupe([
            { name: "a", hash: "h1", n: 1 },
            { name: "b", hash: "h2", n: 1 },
            { name: "necmttn:a", hash: "h1", n: 1 },
        ]);
        expect(out.map((r) => r.name)).toEqual(["a", "b"]);
    });

    it("leaves null/empty-hash rows distinct", () => {
        const out = dedupe([
            { name: "x", hash: null, n: 1 },
            { name: "y", hash: null, n: 1 },
            { name: "z", hash: "", n: 1 },
        ]);
        expect(out.map((r) => r.name).sort()).toEqual(["x", "y", "z"]);
    });

    it("handles three-way twins (rare but possible)", () => {
        const out = dedupe([
            { name: "necmttn:foo", hash: "h", n: 2 },
            { name: "owner2:foo", hash: "h", n: 3 },
            { name: "foo", hash: "h", n: 5 },
        ]);
        expect(out).toEqual([{ name: "foo", hash: "h", n: 10 }]);
    });
});
