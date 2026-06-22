import { describe, expect, test } from "bun:test";
import { matchDirective, deriveDirectiveCandidates, scoreDirectiveCandidates } from "./directives.ts";

describe("matchDirective", () => {
    test("matches explicit standing-rule lead-ins", () => {
        expect(matchDirective("From now on, run the tests before pushing.")).toBe("from now on");
        expect(matchDirective("Going forward, open a PR for every change.")).toBe("going forward");
        expect(matchDirective("Remember to dogfood before showing me.")).toBe("remember to");
        expect(matchDirective("Make sure you use absolute paths.")).toBe("make sure you");
        expect(matchDirective("Be sure to commit each part separately.")).toBe("be sure to");
        expect(matchDirective("Whenever you edit, read the whole file first.")).toBe("whenever you");
    });

    test("matches always/never only with an imperative verb", () => {
        expect(matchDirective("Always wrap copy in code blocks.")).toBe("always-verb");
        expect(matchDirective("Never commit directly to main.")).toBe("never-verb");
    });

    test("does NOT match bare always/never in ordinary prose", () => {
        expect(matchDirective("I always thought this was tricky.")).toBeNull();
        expect(matchDirective("It's never easy to debug this.")).toBeNull();
    });

    test("does NOT match one-off tasks, questions, or pure corrections", () => {
        expect(matchDirective("Add a login button to the page.")).toBeNull();
        expect(matchDirective("What does this function do?")).toBeNull();
        expect(matchDirective("No, that's wrong.")).toBeNull();
        expect(matchDirective("Fix the failing test.")).toBeNull();
    });

    test("ignores trivially short text even if a marker appears", () => {
        expect(matchDirective("always")).toBeNull();
    });

    test("ignores long turns (dispatch prompts / pasted content) even with a marker", () => {
        const dispatch = "You are implementing ONE task in the repo. " +
            "Always run the tests. " + "x".repeat(600);
        expect(dispatch.length).toBeGreaterThan(600);
        expect(matchDirective(dispatch)).toBeNull();
    });

    test("is case-insensitive and scans only the head", () => {
        expect(matchDirective("REMEMBER TO push after every commit")).toBe("remember to");
    });
});

describe("deriveDirectiveCandidates", () => {
    const turn = (o: Partial<{ id: string; session: string; text_excerpt: string | null; ts: string }>) => ({
        id: o.id ?? "turn:abc",
        session: o.session ?? "session:s1",
        // preserve an explicit null (?? would coerce it back to the default)
        text_excerpt: "text_excerpt" in o ? (o.text_excerpt ?? null) : "Always run the tests before pushing.",
        ts: o.ts ?? "2026-06-17T10:00:00.000Z",
    });

    test("emits a candidate per matching user turn, cleaning the turn key", () => {
        const out = deriveDirectiveCandidates([
            turn({ id: "turn:`xyz`", text_excerpt: "Remember to dogfood before showing me." }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]!.turnKey).toBe("xyz");
        expect(out[0]!.pattern).toBe("remember to");
        expect(out[0]!.sessionId).toBe("session:s1");
    });

    test("skips empty-text and harness-injected turns", () => {
        const out = deriveDirectiveCandidates([
            turn({ text_excerpt: null }),
            turn({ text_excerpt: "<task-notification>\nAlways do the thing</task-notification>" }),
            turn({ text_excerpt: "What's next?" }),
        ]);
        expect(out).toHaveLength(0);
    });

    test("skips non-directive turns but keeps directive ones", () => {
        const out = deriveDirectiveCandidates([
            turn({ id: "turn:1", text_excerpt: "Add a button." }),
            turn({ id: "turn:2", text_excerpt: "From now on, always verify before claiming done." }),
        ]);
        expect(out.map((c) => c.turnKey)).toEqual(["2"]);
    });
});

describe("scoreDirectiveCandidates", () => {
    test("ranks high-lift candidates above seed-only ones", () => {
        const candidates = [
            { turnKey: "t1", sessionId: "s1", text: "from now on always dogfood before showing", pattern: "from now on", ts: "2026-06-01T00:00:00Z" },
            { turnKey: "t2", sessionId: "s2", text: "never skip the typecheck", pattern: "never-verb", ts: "2026-06-02T00:00:00Z" },
        ];
        const lift = new Map<string, number>([["always", 9.0]]); // t1 contains "always" (survives tokens() filter); t2's ngrams not in table
        const out = scoreDirectiveCandidates(candidates, lift);
        expect(out[0].turnKey).toBe("t1");          // ranked first
        expect(out[0].source).toBe("lift");
        expect(out.find((c) => c.turnKey === "t2")!.source).toBe("seed"); // no lift match → seed fallback
        expect(out[0].score).toBeGreaterThan(out.find((c) => c.turnKey === "t2")!.score);
    });

    test("cold table → all seed, original order preserved by stable sort", () => {
        const candidates = [
            { turnKey: "t1", sessionId: "s1", text: "remember to dogfood", pattern: "remember to", ts: "2026-06-01T00:00:00Z" },
        ];
        const out = scoreDirectiveCandidates(candidates, new Map());
        expect(out[0].source).toBe("seed");
    });
});
