import { describe, expect, test } from "bun:test";
import { classifierPersistenceRows, classifierRunKey } from "./repository.ts";
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

describe("classifier repository rows", () => {
    test("builds definition, run, result, classification, and citation rows", () => {
        const runKey = classifierRunKey(new Date("2026-05-30T00:00:00Z"), [reactionEventClassifier]);
        const rows = classifierPersistenceRows({
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
        });

        expect(rows.definitions).toHaveLength(1);
        expect(rows.run).toMatchObject({ id: runKey, result_count: 1 });
        expect(rows.results[0]).toMatchObject({ id: result.key, classifier_run: runKey });
        expect(rows.classifications[0]).toMatchObject({ in_id: "u1", out_id: result.key });
        expect(rows.citations.map((row) => [row.out_table, row.out_id, row.kind])).toEqual([
            ["turn", "u1", "classified_turn"],
            ["turn", "a1", "previous_assistant"],
            ["tool_call", "tc1", "recent_tool_failure"],
            ["file", "src_app_ts", "previous_assistant_file"],
        ]);
    });
});
