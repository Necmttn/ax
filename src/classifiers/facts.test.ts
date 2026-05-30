import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { ClassifierFactsService, ClassifierFactsServiceLive } from "./facts.ts";

function clientWithRows(rows: readonly Record<string, unknown>[], capture: { sql?: string }): SurrealClientShape {
    return {
        query: <T extends unknown[]>(sql: string) => {
            capture.sql = sql;
            return Effect.succeed([rows] as unknown as T);
        },
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
}

const provideFacts = (client: SurrealClientShape) =>
    Effect.provide(ClassifierFactsServiceLive.pipe(
        Layer.provide(Layer.succeed(SurrealClient, client)),
    ));

describe("ClassifierFactsService", () => {
    test("forTurn reads classifier facts with evidence refs", async () => {
        const capture: { sql?: string } = {};
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

        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forTurn("turn:turn1");
            }).pipe(provideFacts(clientWithRows(rows, capture))),
        );

        expect(result).toEqual(rows);
        expect(capture.sql).toContain("FROM classifier_result");
        expect(capture.sql).toContain("turn = turn:`turn1`");
        expect(capture.sql).toContain("FROM cites_evidence");
        expect(capture.sql).toContain("type::table(out) AS evidence_table");
    });

    test("forSession scopes by session id and honors limit", async () => {
        const capture: { sql?: string } = {};

        await Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forSession("session:s1", 7);
            }).pipe(provideFacts(clientWithRows([], capture))),
        );

        expect(capture.sql).toContain("session = session:`s1`");
        expect(capture.sql).toContain("LIMIT 7");
    });

    test("forRepo scopes by linked session repository", async () => {
        const capture: { sql?: string } = {};

        await Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forRepo("repo1", 5);
            }).pipe(provideFacts(clientWithRows([], capture))),
        );

        expect(capture.sql).toContain("session.repository = repository:`repo1`");
        expect(capture.sql).toContain("LIMIT 5");
    });

    test("forSession rejects invalid limits before querying", async () => {
        const capture: { sql?: string } = {};

        await expect(Effect.runPromise(
            Effect.gen(function* () {
                const facts = yield* ClassifierFactsService;
                return yield* facts.forSession("session:s1", 0);
            }).pipe(provideFacts(clientWithRows([], capture))),
        )).rejects.toThrow("positive integer");
        expect(capture.sql).toBeUndefined();
    });
});
