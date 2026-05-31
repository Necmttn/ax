import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ClassifierRunner, ClassifierRunnerLive } from "../../../src/classifiers/core.ts";
import { windowFixture } from "../../../src/classifiers/test-fixtures.ts";
import { directionEventClassifier } from "./index.ts";

const run = (user: string) =>
    Effect.runPromise(Effect.gen(function* () {
        const runner = yield* ClassifierRunner;
        return yield* runner.runWindow({
            window: windowFixture({ user }),
            classifiers: [directionEventClassifier],
        });
    }).pipe(Effect.provide(ClassifierRunnerLive)));

describe("direction-event package classifier", () => {
    test("classifies tooling preference directions", async () => {
        const results = await run("can you us UV ?");

        expect(results[0]).toMatchObject({
            classifierKey: "direction-event",
            label: "direction",
            target: "tooling_preference",
            durability: "repo_preference",
        });
    });

    test("classifies review requests", async () => {
        const results = await run("Can you ask Fabijons to review this plan and roast it?");

        expect(results[0]).toMatchObject({
            target: "review_request",
            polarity: "explore",
        });
    });

    test("classifies dev environment directions", async () => {
        const results = await run("start Surreal through docker compose so we have a predictable dev environment");

        expect(results[0]).toMatchObject({
            target: "dev_environment",
            durability: "repo_preference",
        });
    });

    test("ignores subagent notification wrappers", async () => {
        const results = await run("<subagent_notification>\n{\"completed\":\"use uv next\"}");

        expect(results).toEqual([]);
    });
});
