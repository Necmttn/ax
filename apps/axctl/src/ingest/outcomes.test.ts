import { describe, expect, test } from "bun:test";
import { classifyCommandOutcome, deriveCommandOutcomes, deriveUserMessageNgrams } from "./outcomes.ts";

describe("classifyCommandOutcome", () => {
    test("keeps successful commands out of friction buckets", () => {
        expect(classifyCommandOutcome({ command_norm: "bun test", has_error: false, status: "ok" })).toBe("success");
    });

    test("classifies expected verification feedback", () => {
        expect(classifyCommandOutcome({
            command_norm: "bun test",
            has_error: true,
            exit_code: 1,
            output_excerpt: "expect(received).toBe(expected) failed",
        })).toBe("expected_feedback");
    });

    test("verification gate is anchored to command position, not keywords", () => {
        expect(classifyCommandOutcome({
            command_norm: "ls",
            command_text: "ls test/",
            has_error: true,
            exit_code: 2,
            output_excerpt: "ls: cannot access",
        })).toBe("unknown");
        expect(classifyCommandOutcome({
            command_norm: "bun run",
            command_text: "bun run typecheck",
            has_error: true,
            exit_code: 1,
            output_excerpt: "error TS2322: type mismatch",
        })).toBe("expected_feedback");
        expect(classifyCommandOutcome({
            command_norm: "oxlint",
            command_text: "oxlint --deny-warnings",
            has_error: true,
            exit_code: 1,
            output_excerpt: "lint warnings found",
        })).toBe("expected_feedback");
    });

    test("classifies search misses and environment blockers", () => {
        expect(classifyCommandOutcome({ command_norm: "rg", has_error: true, exit_code: 1, output_excerpt: "no matches" })).toBe("search_miss");
        expect(classifyCommandOutcome({ command_norm: "surreal", has_error: true, error_text: "connection refused" })).toBe("environment_blocker");
    });
});

describe("deriveCommandOutcomes", () => {
    test("creates stable command outcome records", () => {
        const outcomes = deriveCommandOutcomes([
            {
                id: "tool_call:`abc`",
                session: "session:`s1`",
                name: "Bash",
                command_norm: "bun typecheck",
                has_error: true,
                output_excerpt: "Type error",
                ts: "2026-05-11T12:00:00.000Z",
            },
        ]);

        expect(outcomes).toEqual([
            expect.objectContaining({
                toolCallKey: "abc",
                sessionKey: "s1",
                commandNorm: "bun typecheck",
                kind: "expected_feedback",
            }),
        ]);
    });
});

describe("deriveUserMessageNgrams", () => {
    test("extracts useful ngrams from user text", () => {
        const ngrams = deriveUserMessageNgrams([
            {
                session: "session:`s1`",
                text_excerpt: "verify main branch guardrail",
                ts: "2026-05-11T12:00:00.000Z",
            },
            {
                session: "session:`s2`",
                text_excerpt: "verify main branch again",
                ts: "2026-05-11T12:01:00.000Z",
            },
        ], [2]);

        expect(ngrams).toContainEqual(expect.objectContaining({
            ngram: "verify main",
            count: 2,
            nearVerificationCount: 2,
        }));
    });
});
