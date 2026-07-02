import { describe, expect, test } from "bun:test";
import { stableKeyFrom, stableStringify } from "./foresight-link.tsx";

describe("stableStringify", () => {
    test("sorts object keys regardless of insertion order", () => {
        const a = stableStringify({ b: 1, a: 2 });
        const b = stableStringify({ a: 2, b: 1 });
        expect(a).toBe(b);
        expect(a).toBe('{"a":2,"b":1}');
    });

    test("sorts nested object keys recursively", () => {
        const a = stableStringify({ z: { y: 1, x: 2 }, a: 1 });
        const b = stableStringify({ a: 1, z: { x: 2, y: 1 } });
        expect(a).toBe(b);
    });

    test("preserves array order (not sorted)", () => {
        expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    });

    test("null/undefined stringify to empty-string JSON", () => {
        expect(stableStringify(null)).toBe(JSON.stringify(""));
        expect(stableStringify(undefined)).toBe(JSON.stringify(""));
    });
});

describe("stableKeyFrom", () => {
    test("string to with no params/search returns the bare string", () => {
        expect(stableKeyFrom("/sessions", undefined, undefined)).toBe("/sessions");
    });

    test("includes params in the key", () => {
        const key = stableKeyFrom("/sessions/$sessionId", { sessionId: "abc" }, undefined);
        expect(key).toBe('/sessions/$sessionId:{"sessionId":"abc"}');
    });

    test("includes search in the key", () => {
        const key = stableKeyFrom("/sessions", undefined, { turns: true });
        expect(key).toBe('/sessions:{"turns":true}');
    });

    test("keys with same to/params but different search are distinct", () => {
        const a = stableKeyFrom("/sessions/$sessionId", { sessionId: "abc" }, { tab: "turns" });
        const b = stableKeyFrom("/sessions/$sessionId", { sessionId: "abc" }, { tab: "cost" });
        expect(a).not.toBe(b);
    });

    test("key order-independent for equivalent params/search objects", () => {
        const a = stableKeyFrom("/sessions/compare", undefined, { ids: "1,2", turns: true });
        const b = stableKeyFrom("/sessions/compare", undefined, { turns: true, ids: "1,2" });
        expect(a).toBe(b);
    });
});
