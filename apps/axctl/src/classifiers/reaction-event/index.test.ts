import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ClassifierRunner, ClassifierRunnerLive } from "../core.ts";
import { windowFixture } from "../test-fixtures.ts";
import { reactionEventClassifier } from "./index.ts";

describe("reaction-event classifier", () => {
    test("classifies uv direction with tool failure context", async () => {
        const program = Effect.gen(function* () {
            const runner = yield* ClassifierRunner;
            return yield* runner.runWindow({
                window: windowFixture({
                    user: "can you use UV ?",
                    previousAssistant: "Python package install is failing with pip.",
                    recentToolFailure: "ERROR: dependency resolution failed",
                }),
                classifiers: [reactionEventClassifier],
            });
        }).pipe(Effect.provide(ClassifierRunnerLive));

        const results = await Effect.runPromise(program);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            classifierKey: "reaction-event",
            label: "direction",
            target: "environment_setup",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.9,
        });
        expect(results[0].evidenceJson).toContain("dependency resolution failed");
        expect(results[0].signals).toEqual(expect.arrayContaining(["tooling:uv"]));
    });

    test("classifies not-just-html as prototype completeness correction", async () => {
        const program = Effect.gen(function* () {
            const runner = yield* ClassifierRunner;
            return yield* runner.runWindow({
                window: windowFixture({
                    user: "i dont want just html i want to see the results",
                    previousAssistant: "I created a static HTML page.",
                }),
                classifiers: [reactionEventClassifier],
            });
        }).pipe(Effect.provide(ClassifierRunnerLive));

        const results = await Effect.runPromise(program);
        expect(results[0]).toMatchObject({
            label: "correction",
            target: "prototype_completeness",
            durability: "repo_preference",
        });
    });

    test("ignores control and context wrappers", async () => {
        const program = Effect.gen(function* () {
            const runner = yield* ClassifierRunner;
            return yield* runner.runWindow({
                window: windowFixture({
                    user: "<subagent_notification>\n{\"status\":{\"completed\":\"tests passed\"}}",
                    previousAssistant: "I spawned a child agent.",
                }),
                classifiers: [reactionEventClassifier],
            });
        }).pipe(Effect.provide(ClassifierRunnerLive));

        const subagentResults = await Effect.runPromise(program);
        expect(subagentResults).toEqual([]);

        const goalProgram = Effect.gen(function* () {
            const runner = yield* ClassifierRunner;
            return yield* runner.runWindow({
                window: windowFixture({
                    user: "<goal_context>\nContinue working toward the active thread goal.",
                    previousAssistant: "I was working on the task.",
                }),
                classifiers: [reactionEventClassifier],
            });
        }).pipe(Effect.provide(ClassifierRunnerLive));

        const goalResults = await Effect.runPromise(goalProgram);
        expect(goalResults).toEqual([]);
    });
});
