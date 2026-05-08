import { describe, expect, test } from "bun:test";
import { extractInstructionMatches, packageSignals } from "./stack.ts";

describe("packageSignals", () => {
    test("detects Bun, TypeScript, Effect, and SurrealDB", () => {
        const signals = packageSignals({
            packageJsonPath: "/repo/package.json",
            packageManager: "bun@1.3.8",
            scripts: { typecheck: "tsc --noEmit", test: "bun test" },
            dependencies: ["effect", "surrealdb"],
            devDependencies: ["typescript"],
        });

        expect(signals.map((signal) => signal.name)).toEqual([
            "bun",
            "typescript",
            "effect",
            "surrealdb",
        ]);
    });
});

describe("extractInstructionMatches", () => {
    test("keeps only agent-relevant rules", () => {
        const matches = extractInstructionMatches(
            "CLAUDE.md",
            [
                "# Project",
                "Always run bun typecheck after TypeScript edits.",
                "Use effect-solutions before writing Effect code.",
                "This marketing paragraph is not a rule.",
                "Never commit directly to main.",
            ].join("\n"),
        );

        expect(matches).toEqual([
            {
                file: "CLAUDE.md",
                line: 2,
                text: "Always run bun typecheck after TypeScript edits.",
                reason: "verification",
            },
            {
                file: "CLAUDE.md",
                line: 3,
                text: "Use effect-solutions before writing Effect code.",
                reason: "effect",
            },
            {
                file: "CLAUDE.md",
                line: 5,
                text: "Never commit directly to main.",
                reason: "git",
            },
        ]);
    });
});
