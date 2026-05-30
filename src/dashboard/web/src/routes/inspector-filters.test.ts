import { describe, expect, test } from "bun:test";
import type { InspectSpanDto, InspectSpanKind, InspectTurnDto } from "../../../../lib/shared/dashboard-types.ts";
import {
    childrenByAnchorTurn,
    isCorrectionTurn,
    isRoleTurn,
    isSpawnAnchorTurn,
    matchesSearch,
    matchingSeqs,
    nextMatchAfter,
    spawnAnchorSet,
    turnText,
} from "./inspector-filters.ts";

const span = (kind: InspectSpanKind, text: string): InspectSpanDto => ({ kind, text });

const turn = (
    seq: number,
    semantic_role: InspectSpanKind,
    spans: InspectSpanDto[],
): InspectTurnDto => ({
    seq,
    role: semantic_role === "user_input" ? "user" : "assistant",
    semantic_role,
    ts: null,
    char_count: spans.reduce((n, s) => n + s.text.length, 0),
    spans,
});

describe("turnText", () => {
    test("concatenates every span", () => {
        expect(turnText(turn(0, "user_input", [span("user_input", "hello "), span("user_input", "world")])))
            .toBe("hello world");
    });

    test("prefers raw_text so content-block offsets stay anchored to provider text", () => {
        const t = {
            ...turn(0, "system_context", [
                span("system_context", "<skills_instructions>x</skills_instructions>"),
                span("system_context", "<plugins_instructions>y</plugins_instructions>"),
            ]),
            raw_text: "<skills_instructions>x</skills_instructions>\n<plugins_instructions>y</plugins_instructions>",
        };
        expect(turnText(t)).toContain("</skills_instructions>\n<plugins_instructions>");
    });
});

describe("isCorrectionTurn", () => {
    test("flags short user_input matching correction regex", () => {
        const t = turn(1, "user_input", [span("user_input", "No, that's wrong - don't add tests there.")]);
        expect(isCorrectionTurn(t)).toBe(true);
    });

    test("does not flag assistant turns even if text matches", () => {
        const t = turn(2, "assistant_text", [span("assistant_text", "No, that's wrong.")]);
        expect(isCorrectionTurn(t)).toBe(false);
    });

    test("does not flag long bodies (>= CORRECTION_MAX_LENGTH)", () => {
        const long = "No, " + "x".repeat(600);
        const t = turn(3, "user_input", [span("user_input", long)]);
        expect(isCorrectionTurn(t)).toBe(false);
    });

    test("does not flag generic user input", () => {
        const t = turn(4, "user_input", [span("user_input", "Please add a new test for this case.")]);
        expect(isCorrectionTurn(t)).toBe(false);
    });

    test("does not flag empty turns", () => {
        const t = turn(5, "user_input", [span("user_input", "   ")]);
        expect(isCorrectionTurn(t)).toBe(false);
    });
});

describe("isRoleTurn", () => {
    test("matches semantic_role exactly", () => {
        const t = turn(1, "tool_use", [span("tool_use", "Bash")]);
        expect(isRoleTurn(t, "tool_use")).toBe(true);
        expect(isRoleTurn(t, "tool_result")).toBe(false);
    });
});

describe("isSpawnAnchorTurn / spawnAnchorSet", () => {
    test("collects non-null anchor seqs into a set", () => {
        const set = spawnAnchorSet([
            { anchor_turn_seq: 10 },
            { anchor_turn_seq: null },
            { anchor_turn_seq: 42 },
            { anchor_turn_seq: 10 },
        ]);
        expect([...set].sort((a, b) => a - b)).toEqual([10, 42]);
    });

    test("isSpawnAnchorTurn uses the anchor set", () => {
        const set = new Set([10, 42]);
        expect(isSpawnAnchorTurn(turn(10, "tool_use", [span("tool_use", "Task")]), set)).toBe(true);
        expect(isSpawnAnchorTurn(turn(11, "tool_use", [span("tool_use", "Bash")]), set)).toBe(false);
    });

    test("childrenByAnchorTurn groups spawned children by parent turn", () => {
        const grouped = childrenByAnchorTurn([
            { session_id: "a", anchor_turn_seq: 10 },
            { session_id: "orphan", anchor_turn_seq: null },
            { session_id: "b", anchor_turn_seq: 42 },
            { session_id: "c", anchor_turn_seq: 10 },
        ]);

        expect(grouped.get(10)?.map((child) => child.session_id)).toEqual(["a", "c"]);
        expect(grouped.get(42)?.map((child) => child.session_id)).toEqual(["b"]);
        expect(grouped.has(0)).toBe(false);
    });
});

describe("matchesSearch", () => {
    test("case-insensitive substring match", () => {
        const t = turn(1, "assistant_text", [span("assistant_text", "Refactor the WidgetService.")]);
        expect(matchesSearch(t, "widget")).toBe(true);
        expect(matchesSearch(t, "WIDGETSERVICE")).toBe(true);
        expect(matchesSearch(t, "tractor")).toBe(false);
    });

    test("matches across multiple spans (per-span substring)", () => {
        const t = turn(2, "user_input", [
            span("user_input", "First half "),
            span("user_input", "second half"),
        ]);
        // Per-span - needle living entirely inside one span matches.
        expect(matchesSearch(t, "second half")).toBe(true);
        // Cross-span boundary is NOT supported; documenting current behavior.
        expect(matchesSearch(t, "First half second")).toBe(false);
    });

    test("matches text that only exists across raw_text whitespace gaps", () => {
        const t = {
            ...turn(2, "system_context", [
                span("system_context", "<skills_instructions>x</skills_instructions>"),
                span("system_context", "<plugins_instructions>y</plugins_instructions>"),
            ]),
            raw_text: "<skills_instructions>x</skills_instructions>\n<plugins_instructions>y</plugins_instructions>",
        };
        expect(matchesSearch(t, "</skills_instructions>\n<plugins_instructions>")).toBe(true);
    });

    test("empty / whitespace queries never match", () => {
        const t = turn(3, "assistant_text", [span("assistant_text", "anything")]);
        expect(matchesSearch(t, "")).toBe(false);
        expect(matchesSearch(t, "   ")).toBe(false);
    });
});

describe("matchingSeqs", () => {
    test("returns ordered seqs satisfying the predicate", () => {
        const turns = [
            turn(0, "user_input", [span("user_input", "hi")]),
            turn(1, "tool_use", [span("tool_use", "Bash")]),
            turn(2, "tool_result", [span("tool_result", "ok")]),
            turn(3, "tool_use", [span("tool_use", "Read")]),
        ];
        expect(matchingSeqs(turns, (t) => t.semantic_role === "tool_use")).toEqual([1, 3]);
    });
});

describe("nextMatchAfter", () => {
    test("returns first match when currentSeq is null", () => {
        expect(nextMatchAfter([5, 10, 15], null)).toBe(5);
    });

    test("returns the first seq strictly greater than current", () => {
        expect(nextMatchAfter([5, 10, 15], 5)).toBe(10);
        expect(nextMatchAfter([5, 10, 15], 9)).toBe(10);
    });

    test("wraps to first match when no later match exists", () => {
        expect(nextMatchAfter([5, 10, 15], 15)).toBe(5);
        expect(nextMatchAfter([5, 10, 15], 99)).toBe(5);
    });

    test("returns null on empty seq list", () => {
        expect(nextMatchAfter([], null)).toBeNull();
        expect(nextMatchAfter([], 5)).toBeNull();
    });
});
