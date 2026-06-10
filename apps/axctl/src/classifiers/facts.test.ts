import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeTestSurrealClient, type TestSurrealClient } from "@ax/lib/testing/surreal";
import { ClassifierFactsService, ClassifierFactsServiceLive } from "./facts.ts";

function clientWithRows(rows: readonly Record<string, unknown>[]): TestSurrealClient {
    return makeTestSurrealClient({ denyWrites: true, fallback: [rows] });
}

const provideFacts = (client: TestSurrealClient) =>
    Effect.provide(ClassifierFactsServiceLive.pipe(
        Layer.provide(client.layer),
    ));

describe("ClassifierFactsService", () => {
    test("forTurn reads classifier facts with evidence refs", async () => {
        const rows = [{
            id: "classifier_result:r1",
            classifier_key: "correction-event",
            classifier_version: "0.1.0",
            label: "correction",
            target: "wrong_output",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.82,
            subject_type: "event_window",
            subject_id: "turn1",
            evidence: [{ kind: "previous_assistant", evidence: "turn:a1" }],
            ts: "2026-05-30T00:00:00Z",
        }];

        const tc = clientWithRows(rows);
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forTurn("turn:turn1");
            }).pipe(provideFacts(tc)),
        );

        expect(result).toEqual(rows);
        expect(tc.captured.at(-1)).toContain("FROM classifier_result");
        expect(tc.captured.at(-1)).toContain("turn = turn:`turn1`");
        expect(tc.captured.at(-1)).toContain("FROM cites_evidence");
        expect(tc.captured.at(-1)).toContain("type::table(out) AS evidence_table");
    });

    test("forSession scopes by session id and honors limit", async () => {
        const tc = clientWithRows([]);

        await Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forSession("session:s1", 7);
            }).pipe(provideFacts(tc)),
        );

        expect(tc.captured.at(-1)).toContain("session = session:`s1`");
        expect(tc.captured.at(-1)).toContain("LIMIT 7");
    });

    test("forRepo scopes by linked session repository", async () => {
        const tc = clientWithRows([]);

        await Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forRepo("repo1", 5);
            }).pipe(provideFacts(tc)),
        );

        expect(tc.captured.at(-1)).toContain("session.repository = repository:`repo1`");
        expect(tc.captured.at(-1)).toContain("LIMIT 5");
    });

    test("forSession rejects invalid limits before querying", async () => {
        const tc = clientWithRows([]);

        await expect(Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forSession("session:s1", 0);
            }).pipe(provideFacts(tc)),
        )).rejects.toThrow("positive integer");
        expect(tc.captured.at(-1)).toBeUndefined();
    });
});
