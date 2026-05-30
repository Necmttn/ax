import { Context, Effect, Layer } from "effect";
import {
    ClassifierRegistry,
    ClassifierRegistryLive,
    ClassifierRunner,
    ClassifierRunnerLive,
    type ClassifierDefinition,
    type ClassifierInputError,
    type ClassifierNotFound,
    type ClassifierResult,
    type EventWindow,
} from "./core.ts";
import {
    eventWindowFromEvalFixture,
    resultMatchesExpectation,
    type ClassifierEvalCaseResult,
    type ClassifierEvalExpectation,
    type ClassifierEvalSuite,
    type ClassifierEvalSummary,
} from "./eval.ts";
import { builtInClassifiers } from "./registry.ts";

export interface ClassifierDebugResult {
    readonly windowKey: string;
    readonly classifierKeys: readonly string[];
    readonly results: readonly ClassifierResult[];
}

export interface ClassifierServiceShape {
    readonly all: Effect.Effect<readonly ClassifierDefinition[]>;
    readonly select: (keys?: readonly string[]) => Effect.Effect<readonly ClassifierDefinition[], ClassifierNotFound>;
    readonly runWindow: (input: {
        readonly window: EventWindow;
        readonly classifierKeys?: readonly string[];
    }) => Effect.Effect<readonly ClassifierResult[], ClassifierNotFound | ClassifierInputError>;
    readonly runBatch: (input: {
        readonly windows: readonly EventWindow[];
        readonly classifierKeys?: readonly string[];
    }) => Effect.Effect<readonly ClassifierResult[], ClassifierNotFound | ClassifierInputError>;
    readonly debugWindow: (input: {
        readonly window: EventWindow;
        readonly classifierKeys?: readonly string[];
    }) => Effect.Effect<ClassifierDebugResult, ClassifierNotFound | ClassifierInputError>;
    readonly evalSuites: (suites: readonly ClassifierEvalSuite[]) => Effect.Effect<ClassifierEvalSummary, ClassifierNotFound | ClassifierInputError>;
}

export class ClassifierService extends Context.Service<ClassifierService, ClassifierServiceShape>()(
    "ax/ClassifierService",
) {}

const expectationKey = (value: ClassifierEvalExpectation): string =>
    [
        value.classifierKey,
        value.label,
        value.target,
        value.polarity ?? "*",
        value.durability ?? "*",
    ].join("|");

export const ClassifierServiceLive: Layer.Layer<ClassifierService, never, ClassifierRegistry | ClassifierRunner> =
    Layer.effect(
        ClassifierService,
        Effect.gen(function* () {
            const registry = yield* ClassifierRegistry;
            const runner = yield* ClassifierRunner;

            const select = (keys?: readonly string[]) =>
                keys && keys.length > 0 ? registry.select(keys) : Effect.succeed(registry.all());

            const runWindow = (input: {
                readonly window: EventWindow;
                readonly classifierKeys?: readonly string[];
            }) =>
                Effect.gen(function* () {
                    const classifiers = yield* select(input.classifierKeys);
                    return yield* runner.runWindow({ window: input.window, classifiers });
                });

            const runBatch = (input: {
                readonly windows: readonly EventWindow[];
                readonly classifierKeys?: readonly string[];
            }) =>
                Effect.gen(function* () {
                    const classifiers = yield* select(input.classifierKeys);
                    return yield* runner.runBatch({ windows: input.windows, classifiers });
                });

            const debugWindow = (input: {
                readonly window: EventWindow;
                readonly classifierKeys?: readonly string[];
            }) =>
                Effect.gen(function* () {
                    const classifiers = yield* select(input.classifierKeys);
                    const results = yield* runner.runWindow({ window: input.window, classifiers });
                    return {
                        windowKey: input.window.key,
                        classifierKeys: classifiers.map((classifier) => classifier.key),
                        results,
                    };
                });

            const evalSuites = (suites: readonly ClassifierEvalSuite[]) =>
                Effect.gen(function* () {
                    const cases: ClassifierEvalCaseResult[] = [];
                    for (const suite of suites) {
                        for (const testCase of suite.cases) {
                            const results = yield* runWindow({
                                window: eventWindowFromEvalFixture(testCase.name, testCase.window),
                                ...(testCase.classifierKeys ? { classifierKeys: testCase.classifierKeys } : {}),
                            });
                            const missingFailures = testCase.expect
                                .filter((expected) => !results.some((result) => resultMatchesExpectation(result, expected)))
                                .map((expected) => `missing ${expectationKey(expected)}`);
                            const rejectedFailures = (testCase.reject ?? [])
                                .filter((rejected) => results.some((result) => resultMatchesExpectation(result, rejected)))
                                .map((rejected) => `unexpected ${expectationKey(rejected)}`);
                            const failures = [...missingFailures, ...rejectedFailures];
                            cases.push({
                                suite: suite.name,
                                name: testCase.name,
                                passed: failures.length === 0,
                                expected: testCase.expect,
                                actual: results.map((result) => ({
                                    classifierKey: result.classifierKey,
                                    label: result.label,
                                    target: result.target,
                                    polarity: result.polarity,
                                    durability: result.durability,
                                    confidence: result.confidence,
                                })),
                                failures,
                            });
                        }
                    }
                    const failed = cases.filter((result) => !result.passed).length;
                    return {
                        passed: cases.length - failed,
                        failed,
                        total: cases.length,
                        cases,
                    };
                });

            return ClassifierService.of({
                all: Effect.succeed(registry.all()),
                select,
                runWindow,
                runBatch,
                debugWindow,
                evalSuites,
            });
        }),
    );

export const ClassifierServiceDefault: Layer.Layer<ClassifierService> =
    ClassifierServiceLive.pipe(
        Layer.provideMerge(ClassifierRegistryLive(builtInClassifiers)),
        Layer.provideMerge(ClassifierRunnerLive),
    );
