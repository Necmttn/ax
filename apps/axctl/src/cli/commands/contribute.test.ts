import { describe, expect, test } from "bun:test";
import {
    buildFreshPattern,
    patternChoiceLabel,
    selectProfilePattern,
    type FreshPatternInput,
} from "./contribute.ts";
import type { TastePattern } from "../../profile/schema.ts";

const patterns: TastePattern[] = [
    {
        category: "workflow",
        name: "small-review-loops",
        summary: "Review the diff in small increments before expanding scope.",
        evidence: { sessions: 4, confidence: 0.8 },
    },
    {
        category: "stack-choice",
        slot: "state-management",
        name: "effect-atom",
        over: ["redux"],
        context: "react apps",
        evidence: { sessions: 5, confidence: 0.9 },
    },
];

describe("pattern picker helpers", () => {
    test("labels profile taste patterns with stable picker indexes", () => {
        expect(patternChoiceLabel(patterns[0]!, 0)).toBe("1. workflow/small-review-loops - 4 sessions, confidence 0.8");
        expect(patternChoiceLabel(patterns[1]!, 1)).toBe("2. stack-choice/state-management/effect-atom - 5 sessions, confidence 0.9");
    });

    test("selects a profile pattern by index, category/name, or bare name", () => {
        expect(selectProfilePattern(patterns, "1")).toEqual(patterns[0]);
        expect(selectProfilePattern(patterns, "stack-choice/effect-atom")).toEqual(patterns[1]);
        expect(selectProfilePattern(patterns, "small-review-loops")).toEqual(patterns[0]);
    });
});

describe("buildFreshPattern", () => {
    test("builds a schema-valid prose pattern from guided fields", () => {
        const input: FreshPatternInput = {
            category: "workflow",
            name: "Small Review Loops",
            summary: "Review the diff in small increments before expanding scope.",
            sessions: 4,
            confidence: 0.8,
        };

        expect(buildFreshPattern(input)).toEqual({
            category: "workflow",
            name: "small-review-loops",
            summary: "Review the diff in small increments before expanding scope.",
            evidence: { sessions: 4, confidence: 0.8 },
        });
    });

    test("builds a schema-valid stack-choice pattern from guided fields", () => {
        const input: FreshPatternInput = {
            category: "stack-choice",
            name: "Effect Atom",
            slot: "state management",
            over: "redux, zustand",
            context: "react apps",
            sessions: 5,
            confidence: 0.9,
        };

        expect(buildFreshPattern(input)).toEqual({
            category: "stack-choice",
            name: "effect-atom",
            slot: "state-management",
            over: ["redux", "zustand"],
            context: "react apps",
            evidence: { sessions: 5, confidence: 0.9 },
        });
    });

    test("reports schema-guidance errors instead of opening a blank editor", () => {
        expect(() => buildFreshPattern({
            category: "workflow",
            name: "Small Review Loops",
            sessions: 4,
            confidence: 0.8,
        })).toThrow(/summary/);
    });
});
