import { describe, expect, test } from "bun:test";
import { buildLearningRegistryStatements } from "./learning-registry.ts";

describe("learning registry derivation", () => {
    test("seeds gotchas, taste signals, workflows, matches, feedback, and draft adoptions", () => {
        const { statements, stats } = buildLearningRegistryStatements({
            skillCandidates: [{
                id: "skill_candidate:`schema_guard`",
                name: "SurrealDB schema change guardrail",
                trigger_pattern: "fix commits overlap SurrealDB schema files",
                suspected_gap: "Schema changes need smoke tests.",
                proposed_behavior: "Run schema import and smoke query.",
                confidence: "high",
            }],
            stacks: [{ id: "stack:`surrealdb`", name: "SurrealDB", kind: "database" }],
            harnessLearnings: [{ id: "harness_learning:`main_branch`", name: "Main branch guardrail", pattern: "block main writes" }],
        });

        expect(stats).toMatchObject({
            gotchas: 1,
            tasteSignals: 1,
            workflows: 2,
            learningFeedback: 1,
            learningMatches: 2,
            adoptions: 1,
        });
        const sql = statements.join("\n");
        expect(sql).toContain("UPSERT gotcha:");
        expect(sql).toContain("UPSERT taste_signal:");
        expect(sql).toContain("UPSERT workflow:");
        expect(sql).toContain("UPSERT learning_feedback:");
        expect(sql).toContain("UPSERT learning_match:");
        expect(sql).toContain("UPSERT adoption:");
        expect(sql).toContain("hosted_share");
        expect(sql).toContain("disabled");
    });
});
