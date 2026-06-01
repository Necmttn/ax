import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { classifierExplainSql, fetchClassifierExplain, turnRecordRefFromInput } from "./classifier-explain.ts";

describe("classifier explain query", () => {
    test("normalizes raw and prefixed turn ids to record refs", () => {
        expect(turnRecordRefFromInput("u1")).toBe("turn:`u1`");
        expect(turnRecordRefFromInput("turn:u1")).toBe("turn:`u1`");
    });

    test("builds query over turn and classifier_result", () => {
        const sql = classifierExplainSql("turn:u1");

        expect(sql).toContain("FROM turn:`u1`");
        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain("WHERE turn = turn:`u1`");
        expect(sql).toContain("ORDER BY classifier_key, label, target");
    });

    test("fetches turn and classifier results", async () => {
        const stub: SurrealClientShape = {
            query: <T extends unknown[]>() => Effect.succeed([
                [{ id: "turn:u1", role: "user", text: "did you run tests?" }],
                [{
                    id: "classifier_result:r1",
                    classifier_key: "verification-event",
                    classifier_version: "0.1.0",
                    label: "verification_request",
                    target: "test_required",
                    polarity: "revise",
                    durability: "session_preference",
                    confidence: 0.86,
                    method: "heuristic",
                    evidence_json: "{}",
                    signals: "[]",
                }],
            ] as unknown as T),
            upsert: () => Effect.die("not used"),
            relate: () => Effect.die("not used"),
            putFile: () => Effect.die("not used"),
            getFile: () => Effect.die("not used"),
            raw: {} as SurrealClientShape["raw"],
        };

        const payload = await Effect.runPromise(
            fetchClassifierExplain("u1").pipe(Effect.provideService(SurrealClient, stub)),
        );

        expect(payload.turn?.id).toBe("turn:u1");
        expect(payload.results[0]?.classifier_key).toBe("verification-event");
    });
});
