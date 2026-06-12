import { describe, expect, test } from "bun:test";
import { deriveWorkflowArcs } from "./workflow.ts";

// Helpers
const mkEvents = (session: string, skills: string[]) =>
    skills.map((skill, i) => ({ session, skill, ts: `2026-06-13T10:${String(i).padStart(2, "0")}:00Z` }));

describe("deriveWorkflowArcs", () => {
    test("returns empty when no invocations", () => {
        expect(deriveWorkflowArcs([], new Map())).toEqual([]);
    });

    test("returns empty when count < 3", () => {
        const events = [
            ...mkEvents("s1", ["a", "b"]),
            ...mkEvents("s2", ["a", "b"]),
        ];
        expect(deriveWorkflowArcs(events, new Map())).toEqual([]);
    });

    test("mines bigrams with count >= 3", () => {
        const sessions = ["s1", "s2", "s3", "s4"].map((id) =>
            mkEvents(id, ["brainstorming", "writing-plans"]),
        );
        const events = sessions.flat();
        const arcs = deriveWorkflowArcs(events, new Map());
        expect(arcs).toHaveLength(1);
        expect(arcs[0]!.steps).toEqual(["brainstorming", "writing-plans"]);
        expect(arcs[0]!.count).toBe(4);
    });

    test("trigrams ranked above bigrams at equal count; bigrams absorbed by trigrams dropped", () => {
        // 5 sessions each with a->b->c; the bigrams a->b and b->c also appear 5x
        // Only the trigram should survive (bigrams absorbed).
        const sessions = ["s1","s2","s3","s4","s5"].map((id) =>
            mkEvents(id, ["a", "b", "c"]),
        );
        const events = sessions.flat();
        const arcs = deriveWorkflowArcs(events, new Map());
        const steps = arcs.map((a) => a.steps.join("->"));
        expect(steps).toContain("a->b->c");
        // bigram a->b or b->c must NOT appear because absorbed
        expect(steps).not.toContain("a->b");
        expect(steps).not.toContain("b->c");
    });

    test("applies publicSkillName via scopes: tool-scope skills excluded; project names stripped", () => {
        const events = [
            ...mkEvents("s1", ["proj:commit", "codex-native", "superpowers:tdd"]),
            ...mkEvents("s2", ["proj:commit", "codex-native", "superpowers:tdd"]),
            ...mkEvents("s3", ["proj:commit", "codex-native", "superpowers:tdd"]),
        ];
        const scopes = new Map([
            ["proj:commit", "project:proj"],
            ["codex-native", "codex-tool"],
            ["superpowers:tdd", "plugin:superpowers"],
        ]);
        const arcs = deriveWorkflowArcs(events, scopes);
        // codex-native is tool-scope -> excluded; proj:commit -> "commit"; superpowers:tdd stays
        // So per session the sequence is ["commit", "superpowers:tdd"] -> bigram
        const steps = arcs[0]?.steps ?? [];
        expect(steps).toEqual(["commit", "superpowers:tdd"]);
        expect(arcs[0]!.count).toBe(3);
    });

    test("collapses consecutive duplicates within session", () => {
        // a a b -> should become [a, b]
        const events = [
            ...mkEvents("s1", ["a", "a", "b"]),
            ...mkEvents("s2", ["a", "a", "b"]),
            ...mkEvents("s3", ["a", "a", "b"]),
        ];
        const arcs = deriveWorkflowArcs(events, new Map());
        expect(arcs[0]!.steps).toEqual(["a", "b"]);
    });

    test("top 5 arcs returned, ranked count desc then lexicographic", () => {
        // Create 7 distinct bigrams with enough repetitions
        const pairs = [
            ["f","g"],["e","f"],["d","e"],["c","d"],["b","c"],["a","b"],["h","i"],
        ];
        const events = pairs.flatMap(([x, y], i) =>
            Array.from({ length: 7 - i }, (_, j) => mkEvents(`s${i}-${j}`, [x!, y!])).flat(),
        );
        const arcs = deriveWorkflowArcs(events, new Map());
        expect(arcs).toHaveLength(5);
        // Must be sorted count desc
        for (let i = 0; i < arcs.length - 1; i++) {
            expect(arcs[i]!.count).toBeGreaterThanOrEqual(arcs[i + 1]!.count);
        }
    });

    test("lexicographic tiebreak is deterministic", () => {
        // Two bigrams same count 4: [a,z] and [a,b]
        const events1 = Array.from({ length: 4 }, (_, i) => mkEvents(`az-${i}`, ["a", "z"])).flat();
        const events2 = Array.from({ length: 4 }, (_, i) => mkEvents(`ab-${i}`, ["a", "b"])).flat();
        const arcs = deriveWorkflowArcs([...events1, ...events2], new Map());
        expect(arcs[0]!.steps.join(",")).toBe("a,b");
        expect(arcs[1]!.steps.join(",")).toBe("a,z");
    });
});
