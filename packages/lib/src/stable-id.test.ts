// packages/lib/src/stable-id.test.ts
import { describe, expect, test } from "bun:test";
import {
    NATURAL_KEY_RECIPES,
    agentEventRowId,
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
        // The three below specifically die if the `s:${part.length}:${part}` length
        // prefix in encodePart degenerates to `s:${part}`. Mutation-verified: see
        // task-1-report.md fix-round-1 section for red/green evidence.
        expect(stableId("t", ["a|s:b"])).not.toBe(stableId("t", ["a", "b"]));
        expect(stableId("t", ["ab", "c"])).not.toBe(stableId("t", ["a", "bc"]));
        expect(stableId("t", ["s:1:x"])).not.toBe(stableId("t", ["x"]));
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

describe("encodePart branch coverage", () => {
    test("booleans encode distinctly from each other and from numbers", () => {
        expect(stableId("t", [true])).not.toBe(stableId("t", [false]));
        expect(stableId("t", [true])).not.toBe(stableId("t", [1]));
        expect(stableId("t", [false])).not.toBe(stableId("t", [0]));
    });

    test("bigint and number share the same natural key by design (see encodePart doc)", () => {
        expect(stableId("t", [1])).toBe(stableId("t", [1n]));
    });

    test("bigint encodes distinctly per value", () => {
        expect(stableId("t", [1n])).not.toBe(stableId("t", [2n]));
    });

    test("throws on non-finite number parts", () => {
        expect(() => stableId("t", [Number.POSITIVE_INFINITY])).toThrow(/non-finite/i);
        expect(() => stableId("t", [Number.NaN])).toThrow(/non-finite/i);
    });

    test("non-integer numbers encode deterministically and distinctly from their integer part", () => {
        expect(stableId("t", [1.5])).toBe(stableId("t", [1.5]));
        expect(stableId("t", [1.5])).not.toBe(stableId("t", [1]));
    });
});

describe("determinism property", () => {
    test("two derives of the identical fixture are byte-identical", () => {
        const first = derive();
        const second = derive();
        expect(second).toEqual(first);
        expect(second.join("\n")).toBe(first.join("\n"));
    });

    // Golden values, computed once via:
    //   bun -e 'import { stableId, sessionRowId, turnRowId, toolCallRowId, edgeRowId, derivedRowId }
    //     from "./packages/lib/src/stable-id.ts"; console.log(...)'
    // These are LITERAL pins, not delegated computations: a `helper() === stableId(...)`
    // check moves both sides together under a hash-algorithm swap, an ID_HEX_LENGTH change,
    // or a dropped length prefix - it proves nothing about the actual bytes. Only these
    // literal expectations catch that class of regression. Change them ONLY with a
    // deliberate cache-version bump - doing so invalidates every cached row.
    test("golden row ids are pinned as literals - a regression here breaks every cached row", () => {
        expect(stableId("turn", ["a", 1])).toBe("95e2451f95fb1c6e49bf93c263fa43b6");
        expect(sessionRowId("claude", "abc")).toBe("3a73bc66bd73afd6c665b1eaa73ec88c");
        expect(turnRowId("s1", 7)).toBe("fcfa5ac272f770611d02bbb6c810c19f");
        expect(toolCallRowId("s1", 7, "toolu_01")).toBe("66bf0a24fcc3183c997303c1f65a2db1");
        expect(edgeRowId("invoked", "t1", "s1", "argsA")).toBe("8e470a01d6b0ec99d010ae2ddfd7e687");
        expect(derivedRowId("x", { path: "/a.jsonl", contentHash: "h1" }, ["k"])).toBe(
            "6e09b8d2783bb0028cc5d43b57ca031b",
        );
    });

    test("delegation: helpers compute exactly stableId(table, parts)", () => {
        expect(sessionRowId("claude", "abc")).toBe(stableId("session", ["claude", "abc"]));
        expect(turnRowId("s1", 7)).toBe(stableId("turn", ["s1", 7]));
    });

    test("500 keys from a genuinely varied 32-bit PRNG collide never and repeat always", () => {
        // mulberry32: a real 32-bit generator (every intermediate stays inside int32 range
        // via Math.imul). The previous LCG (`seed * 1103515245`) overflowed the 53-bit
        // double mantissa and produced only ~11 distinct low bytes across 500 steps, which
        // silently made this property test tautological.
        const mulberry32 = (seed: number) => {
            let a = seed | 0;
            return () => {
                a = (a + 0x6d2b79f5) | 0;
                let t = Math.imul(a ^ (a >>> 15), 1 | a);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        };
        const rnd = mulberry32(0x2f6e2b1);
        const keys = new Set<string>();
        const seen = new Map<string, string>();
        for (let i = 0; i < 500; i++) {
            const parts = [`p${Math.floor(rnd() * 1e6)}`, Math.floor(rnd() * 1e6)];
            const key = encodeNaturalKey(parts);
            keys.add(key);
            const id = stableId("turn", parts);
            expect(stableId("turn", parts)).toBe(id);
            const prior = seen.get(id);
            if (prior !== undefined) expect(prior).toBe(key);
            seen.set(id, key);
        }
        // Fail loudly if the generator degenerates: 500 distinct natural keys must
        // produce 500 distinct ids, which is the actual "collide never" claim.
        expect(keys.size).toBe(500);
        expect(seen.size).toBe(500);
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

    test("agentEventRowId delegates to stableId and varies by its arguments", () => {
        expect(agentEventRowId("as1", 3, "evt_1")).toBe(stableId("agent_event", ["as1", 3, "evt_1"]));
        expect(agentEventRowId("as1", 3, "evt_1")).not.toBe(agentEventRowId("as1", 3, "evt_2"));
        expect(agentEventRowId("as1", 3, null)).not.toBe(agentEventRowId("as1", 3, "evt_1"));
    });
});

describe("NATURAL_KEY_RECIPES", () => {
    test("documents every id helper's table", () => {
        for (const t of ["session", "turn", "tool_call", "agent_event"]) {
            expect(NATURAL_KEY_RECIPES[t]).toBeTruthy();
        }
    });
});
