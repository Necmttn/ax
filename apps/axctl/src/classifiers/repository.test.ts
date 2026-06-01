import { describe, expect, test } from "bun:test";
import { buildClassifierPersistenceStatements, classifierRunKey } from "./repository.ts";
import { reactionEventClassifier } from "./reaction-event/index.ts";
import type { ClassifierResult } from "./core.ts";

const result: ClassifierResult = {
    key: "reaction_event__0_1_0__event_window__abc",
    classifierKey: "reaction-event",
    classifierVersion: "0.1.0",
    subjectType: "event_window",
    subjectId: "u1",
    sessionId: "s1",
    turnId: "u1",
    label: "direction",
    target: "environment_setup",
    polarity: "revise",
    durability: "repo_preference",
    confidence: 0.9,
    method: "heuristic",
    evidenceJson: JSON.stringify({ userText: "can you use UV ?" }),
    signals: ["tooling:uv"],
    ts: new Date("2026-05-30T00:03:00Z"),
};

describe("classifier repository statements", () => {
    test("builds definition, run, result and graph edge statements", () => {
        const runKey = classifierRunKey(new Date("2026-05-30T00:00:00Z"), [reactionEventClassifier]);
        const sql = buildClassifierPersistenceStatements({
            runKey,
            startedAt: new Date("2026-05-30T00:00:00Z"),
            finishedAt: new Date("2026-05-30T00:00:01Z"),
            classifiers: [reactionEventClassifier],
            results: [result],
            evidenceRefs: [
                {
                    resultKey: result.key,
                    table: "turn",
                    key: "a1",
                    kind: "previous_assistant",
                    ts: new Date("2026-05-30T00:01:00Z"),
                },
                {
                    resultKey: result.key,
                    table: "tool_call",
                    key: "tc1",
                    kind: "recent_tool_failure",
                    ts: new Date("2026-05-30T00:02:00Z"),
                },
                {
                    resultKey: result.key,
                    table: "file",
                    key: "src_app_ts",
                    kind: "previous_assistant_file",
                    ts: new Date("2026-05-30T00:02:30Z"),
                },
            ],
            sinceDays: 1,
        }).join("\n");

        expect(sql).toContain("UPSERT classifier_definition:`reaction_event__0_1_0`");
        expect(sql).toContain("UPSERT classifier_run:");
        expect(sql).toContain("UPSERT classifier_result:`reaction_event__0_1_0__event_window__abc`");
        expect(sql).toContain("classifier_definition: classifier_definition:`reaction_event__0_1_0`");
        expect(sql).toContain("DELETE cites_evidence WHERE in = classifier_result:`reaction_event__0_1_0__event_window__abc`");
        expect(sql).toContain("RELATE turn:`u1`->has_classification:");
        expect(sql).toContain("RELATE classifier_result:`reaction_event__0_1_0__event_window__abc`->cites_evidence:");
        expect(sql).toContain("->turn:`u1`");
        expect(sql).toContain("->turn:`a1`");
        expect(sql).toContain("previous_assistant");
        expect(sql).toContain("->tool_call:`tc1`");
        expect(sql).toContain("recent_tool_failure");
        expect(sql).toContain("->file:`src_app_ts`");
        expect(sql).toContain("previous_assistant_file");
    });
});
