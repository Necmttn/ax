// packages/lib/src/stable-id.test.ts
import { describe, expect, test } from "bun:test";
import {
    NATURAL_KEY_RECIPES,
    PSEUDO_RECIPE_KEYS,
    agentEventRowId,
    derivedRowId,
    edgeRowId,
    encodeNaturalKey,
    sessionRowId,
    stableId,
    toolCallRowId,
    turnRowId,
} from "./stable-id.ts";

// A fixture that stands in for "one parsed source file worth of derived rows",
// keyed ONLY on provider-native identifiers (session id, seq, call id) - never
// on the source file's path or content hash (P1-2: those are banned key parts
// because they are not append-stable).
const FIXTURE = {
    provider: "claude",
    providerSessionId: "abc",
    events: [
        { seq: 0, role: "user", callId: null },
        { seq: 1, role: "assistant", callId: "toolu_01" },
        { seq: 2, role: "tool_result", callId: "toolu_01" },
    ],
} as const;

const derive = (events: readonly { readonly seq: number; readonly callId: string | null }[]) => {
    const sid = sessionRowId(FIXTURE.provider, FIXTURE.providerSessionId);
    return events.flatMap((e) => {
        const toolCall = e.callId !== null ? { callId: e.callId } : { ordinal: e.seq };
        return [
            turnRowId(sid, e.seq),
            toolCallRowId(sid, e.seq, toolCall),
            derivedRowId("run_evidence_event", { sessionId: sid, sourceTable: "turn", sourceId: turnRowId(sid, e.seq) }, [
                "tool_call",
                e.seq,
            ]),
        ];
    });
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

    test("throws on integers beyond Number.MAX_SAFE_INTEGER (P3-2)", () => {
        expect(() => stableId("t", [Number.MAX_SAFE_INTEGER + 2])).toThrow(/MAX_SAFE_INTEGER/);
        // A large-but-safe integer under the epoch-like threshold is fine.
        expect(() => stableId("t", [999_999_999_999])).not.toThrow();
    });

    test("throws on numbers whose magnitude looks like a wall-clock epoch (P3-2)", () => {
        const nowMs = Date.now();
        expect(() => stableId("t", [nowMs])).toThrow(/wall-clock/i);
        expect(() => stableId("t", [1e13])).toThrow(/wall-clock/i);
        expect(() => stableId("t", [-1.5e13])).toThrow(/wall-clock/i);
        // Ordinary seq/offset/count-shaped numbers stay well under the threshold.
        expect(() => stableId("t", [999_999_999])).not.toThrow();
    });
});

describe("determinism property", () => {
    test("two derives of the identical fixture are byte-identical", () => {
        const first = derive(FIXTURE.events);
        const second = derive(FIXTURE.events);
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
        // session is the carve-out: its id is the provider session id VERBATIM,
        // never a hash (wave-0 finding P1-3) - so this pin is the input string.
        expect(sessionRowId("claude", "abc")).toBe("abc");
        expect(turnRowId("s1", 7)).toBe("fcfa5ac272f770611d02bbb6c810c19f");
        expect(toolCallRowId("s1", 7, { callId: "toolu_01" })).toBe("772e683e4e9b8bc61b92f1851151a875");
        expect(toolCallRowId("s1", 7, { ordinal: 0 })).toBe("95e7c99eb759ffa4fc9732136b6e11ce");
        expect(edgeRowId("invoked", "t1", "s1", "argsA")).toBe("8e470a01d6b0ec99d010ae2ddfd7e687");
        expect(
            derivedRowId("run_evidence_event", { sessionId: "s1", sourceTable: "turn", sourceId: "t1" }, ["k"]),
        ).toBe("23b33290bb41682d5d415678346b58ec");
    });

    test("delegation: helpers compute exactly stableId(table, parts)", () => {
        // session is the carve-out - its id is the raw provider id, so it does
        // NOT delegate to stableId. turn (composite key) still does.
        expect(turnRowId("s1", 7)).toBe(stableId("turn", ["s1", 7]));
    });

    test("sessionRowId is the provider session id verbatim, ignoring provider (P1-3)", () => {
        // The value OTLP correlation + Studio deeplinks join on must be the bare
        // provider id, not a hash. A raw uuid round-trips unchanged, so
        // correlate.ts's bareUuid(session.id) recovers the same uuid it matches
        // otel session_id against.
        const uuid = "019fbf3f-1a2b-4c5d-8e9f-0a1b2c3d4e5f";
        expect(sessionRowId("claude", uuid)).toBe(uuid);
        // provider does not alter the id (globally-unique ids never collide).
        expect(sessionRowId("codex", uuid)).toBe(sessionRowId("claude", uuid));
        // subagent ids (non-uuid) pass through verbatim too.
        expect(sessionRowId("claude", "claude-subagent-af3f3b45c70ccf85c"))
            .toBe("claude-subagent-af3f3b45c70ccf85c");
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
    test("edge ids are symmetric-free and discriminated", () => {
        expect(edgeRowId("invoked", "t1", "s1")).not.toBe(edgeRowId("invoked", "s1", "t1"));
        expect(edgeRowId("invoked", "t1", "s1", "argsA")).not.toBe(edgeRowId("invoked", "t1", "s1", "argsB"));
    });

    test("agentEventRowId delegates to stableId and varies by its arguments", () => {
        expect(agentEventRowId("as1", 3, "evt_1")).toBe(stableId("agent_event", ["as1", 3, "evt_1"]));
        expect(agentEventRowId("as1", 3, "evt_1")).not.toBe(agentEventRowId("as1", 3, "evt_2"));
        expect(agentEventRowId("as1", 3, null)).not.toBe(agentEventRowId("as1", 3, "evt_1"));
    });

    test("derivedRowId is keyed on provider-native identity, never a file path or content hash", () => {
        const a = derivedRowId("x", { sessionId: "s1", sourceTable: "turn", sourceId: "t1" }, ["k"]);
        const b = derivedRowId("x", { sessionId: "s1", sourceTable: "turn", sourceId: "t1" }, ["k"]);
        const c = derivedRowId("x", { sessionId: "s1", sourceTable: "turn", sourceId: "t2" }, ["k"]);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    test("toolCallRowId requires callId OR an explicit ordinal - the two never collide (P3-1)", () => {
        const withCallId = toolCallRowId("s1", 7, { callId: "toolu_01" });
        const withOrdinal = toolCallRowId("s1", 7, { ordinal: 0 });
        expect(withCallId).not.toBe(withOrdinal);
        // Two parallel calls at the SAME seq, disambiguated only by ordinal, never collide.
        expect(toolCallRowId("s1", 7, { ordinal: 0 })).not.toBe(toolCallRowId("s1", 7, { ordinal: 1 }));
    });
});

describe("append-stability property (P1-2)", () => {
    test("re-deriving ids after the source 'file' grows leaves prior ids byte-identical", () => {
        const before = derive(FIXTURE.events);

        // Simulate the transcript file growing: two more events appended after
        // the ones already derived above. A real ingest run re-parses the whole
        // (now longer) file and re-derives every row, including the ones it saw
        // last time.
        const grown = [
            ...FIXTURE.events,
            { seq: 3, role: "assistant", callId: "toolu_02" },
            { seq: 4, role: "tool_result", callId: "toolu_02" },
        ] as const;
        const after = derive(grown);

        // Every id computed the first time reappears, unchanged, in the re-derive
        // of the grown file - append-stability is the entire point of banning
        // file-hash/path key parts.
        for (const id of before) expect(after).toContain(id);

        // And the ids for the newly-appended rows are genuinely new, not reused.
        const newIds = after.filter((id) => !before.includes(id));
        expect(newIds.length).toBeGreaterThan(0);
        expect(new Set(newIds).size).toBe(newIds.length);
    });

    test("growing the fixture never mutates an already-derived id, even after many growth steps", () => {
        let ids: string[] = [];
        for (let n = 1; n <= FIXTURE.events.length; n++) {
            const prefix = FIXTURE.events.slice(0, n);
            const derived = derive(prefix);
            // Every id from the previous (shorter) derive must still be present,
            // in the same order, as a prefix of the new (longer) derive.
            expect(derived.slice(0, ids.length)).toEqual(ids);
            ids = derived;
        }
    });
});

describe("NATURAL_KEY_RECIPES", () => {
    test("documents every id helper's table", () => {
        for (const t of ["session", "turn", "tool_call", "agent_event"]) {
            expect(NATURAL_KEY_RECIPES[t]).toBeTruthy();
        }
    });

    test("the pseudo keys are exactly the rule-describing ones, and are not table names", () => {
        // `<edge>` / `<derived>` describe a RULE (edgeRowId / derivedRowId), not
        // a table. Coverage lives in packages/schema (which is where the DDL
        // is): duckdb-recipe-coverage.test.ts derives the todo set from the
        // parsed DDL minus these keys, so nothing here mirrors a table list.
        expect([...PSEUDO_RECIPE_KEYS].sort()).toEqual(["<derived>", "<edge>"]);
        for (const key of PSEUDO_RECIPE_KEYS) expect(NATURAL_KEY_RECIPES[key]).toBeTruthy();
    });
});
