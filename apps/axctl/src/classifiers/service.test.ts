import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ClassifierService, ClassifierServiceDefault } from "./service.ts";
import { eventWindowFromEvalFixture, type ClassifierEvalSuite } from "./eval.ts";

const suite: ClassifierEvalSuite = {
    name: "direction-event",
    cases: [
        {
            name: "tooling-preference",
            classifierKeys: ["direction-event"],
            window: {
                user: "can you use UV ?",
                previousAssistant: "pip failed while installing Python packages.",
            },
            expect: [{
                classifierKey: "direction-event",
                label: "direction",
                target: "tooling_preference",
            }],
        },
    ],
};

const runWithService = <A>(effect: Effect.Effect<A, unknown, ClassifierService>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(ClassifierServiceDefault)));

describe("ClassifierService", () => {
    test("runs fixture suites through shared registry and runner", async () => {
        const summary = await runWithService(Effect.gen(function* () {
            const classifiers = yield* ClassifierService;
            return yield* classifiers.evalSuites([suite]);
        }));

        expect(summary.total).toBe(1);
        expect(summary.failed).toBe(0);
        expect(summary.cases[0]?.actual[0]).toMatchObject({
            classifierKey: "direction-event",
            label: "direction",
            target: "tooling_preference",
        });
    });

    test("debugWindow reports selected classifiers and validated results", async () => {
        const window = eventWindowFromEvalFixture("debug-window", {
            user: "did you run the tests?",
            previousAssistant: "I changed the classifier service.",
        });

        const debug = await runWithService(Effect.gen(function* () {
            const classifiers = yield* ClassifierService;
            return yield* classifiers.debugWindow({
                window,
                classifierKeys: ["verification-event"],
            });
        }));

        expect(debug.windowKey).toBe("eval__debug-window");
        expect(debug.classifierKeys).toEqual(["verification-event"]);
        expect(debug.results[0]).toMatchObject({
            classifierKey: "verification-event",
            label: "verification_request",
            target: "test_required",
        });
    });
});
