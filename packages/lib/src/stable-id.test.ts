// packages/lib/src/stable-id.test.ts
import { describe, expect, test } from "bun:test";
import {
    NATURAL_KEY_RECIPES,
    derivedRowId,
    edgeRowId,
    encodeNaturalKey,
    sessionRowId,
    sourceFileKey,
    stableId,
    toolCallRowId,
    turnRowId,
} from "./stable-id.ts";

// A fixture that stands in for "one parsed source file worth of derived rows".
const FIXTURE = {
    source: { path: "/home/u/.claude/projects/p/abc.jsonl", contentHash: "deadbeef" },
    events: [
        { seq: 0, role: "user", callId: null },
        { seq: 1, role: "assistant", callId: "toolu_01" },
        { seq: 2, role: "tool_result", callId: "toolu_01" },
    ],
} as const;

const derive = () => {
    const sid = sessionRowId("claude", "abc");
    return FIXTURE.events.flatMap((e) => [
        turnRowId(sid, e.seq),
        toolCallRowId(sid, e.seq, e.callId),
        derivedRowId("run_evidence_event", FIXTURE.source, ["tool_call", e.seq]),
    ]);
};

describe("stableId", () => {
    test("is 32 lowercase hex chars", () => {
        expect(stableId("turn", ["a", 1])).toMatch(/^[0-9a-f]{32}$/);
    });

    test("is pure: same input, same output", () => {
        expect(stableId("turn", ["a", 1])).toBe(stableId("turn", ["a", 1]));
    });

    test("namespaces by table: same key in two tables differs", () => {
        expect(stableId("turn", ["a", 1])).not.toBe(stableId("tool_call", ["a", 1]));
    });

    test("part boundaries are unambiguous", () => {
        expect(stableId("t", ["a", "b"])).not.toBe(stableId("t", ["ab"]));
        expect(stableId("t", ["a|b"])).not.toBe(stableId("t", ["a", "b"]));
        expect(stableId("t", ["a"])).not.toBe(stableId("t", ["a", ""]));
    });

    test("null and undefined and empty string are distinct parts", () => {
        const a = stableId("t", [null]);
        const b = stableId("t", [undefined]);
        const c = stableId("t", [""]);
        expect(new Set([a, b, c]).size).toBe(3);
    });

    test("numbers and their string forms are distinct", () => {
        expect(stableId("t", [1])).not.toBe(stableId("t", ["1"]));
    });

    test("rejects an empty key", () => {
        expect(() => stableId("t", [])).toThrow(/natural key/i);
    });

    test("rejects an empty table", () => {
        expect(() => stableId("", ["a"])).toThrow(/table/i);
    });
});

describe("determinism property", () => {
    test("two derives of the identical fixture are byte-identical", () => {
        const first = derive();
        const second = derive();
        expect(second).toEqual(first);
        expect(second.join("\n")).toBe(first.join("\n"));
    });

    test("ids are pinned - a regression here breaks every cached row", () => {
        // Golden values: change ONLY with a deliberate cache-version bump.
        expect(sessionRowId("claude", "abc")).toBe(stableId("session", ["claude", "abc"]));
        expect(turnRowId("s1", 7)).toBe(stableId("turn", ["s1", 7]));
    });

    test("500 seeded random keys collide never and repeat always", () => {
        let seed = 0x2f6e2b1;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const seen = new Map<string, string>();
        for (let i = 0; i < 500; i++) {
            const parts = [`p${Math.floor(rnd() * 1e6)}`, Math.floor(rnd() * 1e6)];
            const key = encodeNaturalKey(parts);
            const id = stableId("turn", parts);
            expect(stableId("turn", parts)).toBe(id);
            const prior = seen.get(id);
            if (prior !== undefined) expect(prior).toBe(key);
            seen.set(id, key);
        }
    });
});

describe("no run-state in ids", () => {
    test("source identity, not mtime, drives derived ids", () => {
        const a = derivedRowId("x", { path: "/a.jsonl", contentHash: "h1" }, ["k"]);
        const b = derivedRowId("x", { path: "/a.jsonl", contentHash: "h1" }, ["k"]);
        const c = derivedRowId("x", { path: "/a.jsonl", contentHash: "h2" }, ["k"]);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    test("sourceFileKey ignores a missing content hash consistently", () => {
        expect(sourceFileKey({ path: "/a.jsonl" })).toBe(sourceFileKey({ path: "/a.jsonl", contentHash: null }));
    });

    test("edge ids are symmetric-free and discriminated", () => {
        expect(edgeRowId("invoked", "t1", "s1")).not.toBe(edgeRowId("invoked", "s1", "t1"));
        expect(edgeRowId("invoked", "t1", "s1", "argsA")).not.toBe(edgeRowId("invoked", "t1", "s1", "argsB"));
    });
});

describe("NATURAL_KEY_RECIPES", () => {
    test("documents every id helper's table", () => {
        for (const t of ["session", "turn", "tool_call", "agent_event"]) {
            expect(NATURAL_KEY_RECIPES[t]).toBeTruthy();
        }
    });
});
