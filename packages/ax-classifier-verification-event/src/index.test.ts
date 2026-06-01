import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    ClassifierRunner,
    ClassifierRunnerLive,
} from "../../../apps/axctl/src/classifiers/core.ts";
import { windowFixture } from "../../../apps/axctl/src/classifiers/test-fixtures.ts";
import { verificationEventClassifier } from "./index.ts";

const run = (user: string) =>
    Effect.runPromise(Effect.gen(function* () {
        const runner = yield* ClassifierRunner;
        return yield* runner.runWindow({
            window: windowFixture({ user }),
            classifiers: [verificationEventClassifier],
        });
    }).pipe(Effect.provide(ClassifierRunnerLive)));

describe("verification-event package classifier", () => {
    test("classifies test required requests", async () => {
        const results = await run("did you run the tests?");

        expect(results[0]).toMatchObject({
            classifierKey: "verification-event",
            label: "verification_request",
            target: "test_required",
        });
    });

    test("classifies output required requests", async () => {
        const results = await run("I want to see the actual results and output");

        expect(results[0]).toMatchObject({
            target: "output_required",
        });
    });

    test("classifies regression guard requests", async () => {
        const results = await run("we need a test mechanism so we don't fuck up the trained models");

        expect(results[0]).toMatchObject({
            target: "regression_guard",
            durability: "repo_preference",
        });
    });

    test("ignores subagent notification wrappers", async () => {
        const results = await run("<subagent_notification>\n{\"completed\":\"typecheck passed\"}");

        expect(results).toEqual([]);
    });
});
