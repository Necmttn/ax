import { describe, expect, test } from "bun:test";
import type { WrappedProfile } from "@ax/lib/shared/dashboard-types";
import {
    choosePrimaryArchetype,
    computeStreaks,
    makeInterestingFacts,
    sanitizeWrappedProfile,
} from "./wrapped.ts";

describe("computeStreaks", () => {
    test("computes current and longest day streaks", () => {
        const result = computeStreaks(
            ["2026-05-10", "2026-05-11", "2026-05-13", "2026-05-14", "2026-05-15"],
            new Date("2026-05-15T12:00:00Z"),
        );
        expect(result).toEqual({ currentStreakDays: 3, longestStreakDays: 3 });
    });
});

describe("choosePrimaryArchetype", () => {
    test("chooses The Verifier when verification calls dominate", () => {
        const result = choosePrimaryArchetype({
            verificationCalls: 42,
            toolFailures: 4,
            recoveredFailures: 0,
            distinctSkills: 8,
            distinctTools: 7,
            repositories: 2,
            spawnedAgents: 0,
            contextCalls: 3,
            refactorSignals: 1,
        });
        expect(result.primary.id).toBe("verifier");
        expect(result.primary.confidence).toBe("high");
    });

    test("uses Observer when no archetype has evidence", () => {
        const result = choosePrimaryArchetype({
            verificationCalls: 0,
            toolFailures: 0,
            recoveredFailures: 0,
            distinctSkills: 0,
            distinctTools: 0,
            repositories: 0,
            spawnedAgents: 0,
            contextCalls: 0,
            refactorSignals: 0,
        });
        expect(result.primary.id).toBe("observer");
        expect(result.primary.evidence).toEqual([]);
        expect(result.secondary).toEqual([]);
    });
});

describe("makeInterestingFacts", () => {
    test("emits Token Maxxing for high token totals", () => {
        const facts = makeInterestingFacts({
            sessions: 100,
            messages: 200_000,
            totalTokens: 2_000_000,
            activeDays: 12,
            currentStreakDays: 8,
            longestStreakDays: 10,
            peakHour: 19,
            favoriteModel: "Opus 4.7",
            toolCalls: 50_000,
            toolFailures: 1_000,
            contextCalls: 2_000,
            verificationCalls: 10,
            distinctSkills: 12,
            distinctTools: 20,
            spawnedAgents: 0,
            repositories: 2,
            topTool: { label: "exec_command", count: 12_345 },
            topSkill: { label: "systematic-debugging", count: 42 },
        });
        expect(facts.map((f) => f.id)).toContain("token-maxxing");
        expect(facts.map((f) => f.id)).toContain("context-maxxing");
        expect(facts.map((f) => f.id)).toContain("tool-call-maxxing");
        expect(facts.map((f) => f.id)).toContain("main-skill-energy");
    });
});

describe("sanitizeWrappedProfile", () => {
    test("removes sensitive evidence labels from public profile", () => {
        const profile: WrappedProfile = {
            generatedAt: "2026-05-15T00:00:00.000Z",
            period: {
                label: "Last 365 days",
                startedAt: "2025-05-15T00:00:00.000Z",
                endedAt: "2026-05-15T00:00:00.000Z",
            },
            usage: {
                sessions: 1,
                messages: 2,
                totalTokens: 1000,
                activeDays: 1,
                currentStreakDays: 1,
                longestStreakDays: 1,
                peakHour: 19,
                favoriteModel: "Opus 4.7",
                tokenComparison: "You've used ~16x more tokens than The Great Gatsby.",
                days: [{ date: "2026-05-15", sessions: 1, turns: 2, tokens: null }],
            },
            primaryArchetype: {
                id: "context-curator",
                label: "The Context Curator",
                score: 9,
                confidence: "medium",
                publicLine: "You ground the agent before making it move.",
                internalExplanation: "Sensitive project /Users/necmttn/Projects/ax appeared often.",
                evidence: [
                    { kind: "project", label: "/Users/necmttn/Projects/ax", href: "/project/ax", sensitive: true },
                    { kind: "query", label: "12 context calls", href: "/query/context", count: 12 },
                ],
            },
            secondaryArchetypes: [
                {
                    id: "verifier",
                    label: "The Verifier",
                    score: 4,
                    confidence: "low",
                    publicLine: "You test before declaring victory.",
                    internalExplanation: "Internal verifier explanation.",
                    evidence: [{ kind: "tool", label: "test command", href: "/tools/test", count: 1 }],
                },
            ],
            facts: [
                {
                    id: "safe-fact",
                    title: "Safe Fact",
                    publicText: "Safe aggregate.",
                    internalText: "Internal safe fact text.",
                    sensitivity: "aggregate",
                    evidence: [{ kind: "query", label: "aggregate evidence", href: "/query/aggregate", count: 1 }],
                },
                {
                    id: "sensitive-fact",
                    title: "Sensitive Fact",
                    publicText: "Should not ship.",
                    internalText: "Sensitive internal fact text.",
                    sensitivity: "sensitive",
                    evidence: [{ kind: "project", label: "/private/project", href: "/project/private", sensitive: true }],
                },
            ],
            metrics: {
                toolCalls: 2,
                toolFailures: 0,
                distinctTools: 1,
                distinctSkills: 1,
                repositories: 1,
                verificationCalls: 0,
                spawnedAgents: 0,
            },
            privacy: { publicSafe: false, redactedFields: [] },
        };

        const publicProfile = sanitizeWrappedProfile(profile);
        expect(publicProfile.primaryArchetype.internalExplanation).toBe("");
        expect(publicProfile.primaryArchetype.evidence).toEqual([
            { kind: "query", label: "12 context calls", count: 12 },
        ]);
        expect(publicProfile.secondaryArchetypes[0]?.internalExplanation).toBe("");
        expect(publicProfile.secondaryArchetypes[0]?.evidence).toEqual([
            { kind: "tool", label: "test command", count: 1 },
        ]);
        expect(publicProfile.facts).toHaveLength(1);
        expect(publicProfile.facts[0]?.internalText).toBe("");
        expect(publicProfile.facts[0]?.evidence).toEqual([
            { kind: "query", label: "aggregate evidence", count: 1 },
        ]);
        expect(publicProfile.privacy.publicSafe).toBe(true);
        expect(publicProfile.privacy.redactedFields).toContain("sensitive evidence");
    });
});
