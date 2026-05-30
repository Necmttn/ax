import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ClassifierRunner, ClassifierRunnerLive } from "../core.ts";
import { windowFixture } from "../test-fixtures.ts";
import { correctionEventClassifier } from "./index.ts";

const run = (user: string) =>
    Effect.runPromise(Effect.gen(function* () {
        const runner = yield* ClassifierRunner;
        return yield* runner.runWindow({
            window: windowFixture({ user }),
            classifiers: [correctionEventClassifier],
        });
    }).pipe(Effect.provide(ClassifierRunnerLive)));

describe("correction-event classifier", () => {
    test("classifies wrong artifact corrections", async () => {
        const results = await run("i dont want just html i want to see the results");

        expect(results[0]).toMatchObject({
            classifierKey: "correction-event",
            label: "correction",
            target: "wrong_artifact",
        });
    });

    test("classifies missing context corrections", async () => {
        const results = await run("we needed previous context, not only the user message but what agent was done");

        expect(results[0]).toMatchObject({
            target: "missing_context",
            durability: "repo_preference",
        });
    });

    test("classifies misclassified intent corrections", async () => {
        const results = await run("that was actually a direction thing, not a correction");

        expect(results[0]).toMatchObject({
            target: "misclassified_intent",
        });
    });
});
