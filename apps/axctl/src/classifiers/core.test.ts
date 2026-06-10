import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    ClassifierRegistry,
    ClassifierRegistryLive,
    ClassifierRunner,
    ClassifierRunnerLive,
    classifierResultKey,
    defineClassifier,
    label,
    type EventWindow,
} from "./core.ts";

const windowFixture = (text: string): EventWindow => ({
    key: "window:u1",
    subjectType: "turn",
    subjectId: "turn:u1",
    sessionId: "session:s1",
    userTurn: {
        id: "turn:u1",
        key: "u1",
        seq: 2,
        role: "user",
        text,
        ts: new Date("2026-05-30T00:00:02Z"),
    },
    previousAssistantTurn: {
        id: "turn:a1",
        key: "a1",
        seq: 1,
        role: "assistant",
        text: "I will use npm for this.",
        ts: new Date("2026-05-30T00:00:01Z"),
    },
    recentToolCalls: [],
    recentToolFailures: [],
    recentFiles: [],
    existingLabels: [],
});

describe("classifier core", () => {
    test("builds deterministic result ids from classifier version and subject", () => {
        const a = classifierResultKey({
            classifierKey: "demo",
            classifierVersion: "0.1.0",
            subjectType: "turn",
            subjectId: "turn:u1",
            label: "direction",
            target: "environment_setup",
        });
        const b = classifierResultKey({
            classifierKey: "demo",
            classifierVersion: "0.1.0",
            subjectType: "turn",
            subjectId: "turn:u1",
            label: "direction",
            target: "environment_setup",
        });
        const c = classifierResultKey({
            classifierKey: "demo",
            classifierVersion: "0.2.0",
            subjectType: "turn",
            subjectId: "turn:u1",
            label: "direction",
            target: "environment_setup",
        });

        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toStartWith("demo__0_1_0__turn__");
    });

    test("runner validates emitted labels and targets against classifier definition", async () => {
        const badClassifier = defineClassifier({
            key: "bad-demo",
            version: "0.1.0",
            kind: "heuristic",
            description: "bad test classifier",
            input: "event_window",
            labels: ["allowed"],
            targets: ["known"],
            classify: (window) => Effect.succeed([
                label(window, {
                    classifierKey: "bad-demo",
                    classifierVersion: "0.1.0",
                    label: "not_declared",
                    target: "known",
                    polarity: "revise",
                    durability: "one_off",
                    confidence: 0.9,
                    evidence: { user: window.userTurn.text },
                    signals: ["test"],
                }),
            ]),
        });

        const program = Effect.gen(function* () {
            const runner = yield* ClassifierRunner;
            return yield* runner.runWindow({
                window: windowFixture("use bun instead"),
                classifiers: [badClassifier],
            });
        }).pipe(Effect.provide(ClassifierRunnerLive));

        await expect(Effect.runPromise(program)).rejects.toThrow(/not_declared/);
    });

    test("runner accepts JSON-null evidence but rejects malformed evidenceJson", async () => {
        const makeClassifier = (evidenceJson?: string) =>
            defineClassifier({
                key: "evidence-demo",
                version: "0.1.0",
                kind: "heuristic",
                description: "evidence regression classifier",
                input: "event_window",
                labels: ["direction"],
                targets: ["environment_setup"],
                classify: (window) => Effect.succeed([
                    {
                        ...label(window, {
                            classifierKey: "evidence-demo",
                            classifierVersion: "0.1.0",
                            label: "direction",
                            target: "environment_setup",
                            polarity: "revise",
                            durability: "one_off",
                            confidence: 0.9,
                            // `null` is a legal producer value for `evidence: unknown`,
                            // serialized to the valid JSON document "null".
                            evidence: null,
                            signals: ["test"],
                        }),
                        ...(evidenceJson !== undefined ? { evidenceJson } : {}),
                    },
                ]),
            });

        const run = (classifier: ReturnType<typeof defineClassifier>) =>
            Effect.gen(function* () {
                const runner = yield* ClassifierRunner;
                return yield* runner.runWindow({
                    window: windowFixture("use bun instead"),
                    classifiers: [classifier],
                });
            }).pipe(Effect.provide(ClassifierRunnerLive));

        // JSON-null evidence passes validation.
        const results = await Effect.runPromise(run(makeClassifier()));
        expect(results).toHaveLength(1);
        expect(results[0]!.evidenceJson).toBe("null");

        // Malformed evidenceJson is still a ClassifierInputError.
        await expect(Effect.runPromise(run(makeClassifier("{broken")))).rejects.toThrow(
            /evidenceJson that is not valid JSON/,
        );
    });

    test("registry selects classifiers by key", async () => {
        const classifier = defineClassifier({
            key: "demo",
            version: "0.1.0",
            kind: "heuristic",
            description: "demo classifier",
            input: "event_window",
            labels: ["direction"],
            targets: ["environment_setup"],
            classify: () => Effect.succeed([]),
        });
        const program = Effect.gen(function* () {
            const registry = yield* ClassifierRegistry;
            return yield* registry.select(["demo"]);
        }).pipe(Effect.provide(ClassifierRegistryLive([classifier])));

        const selected = await Effect.runPromise(program);
        expect(selected.map((c) => c.key)).toEqual(["demo"]);
    });
});
