import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    ClassifierRunner,
    ClassifierRunnerLive,
    definePatternClassifier,
    type ClassifierPattern,
    type EventWindow,
} from "./core.ts";
import { windowFixture } from "./test-fixtures.ts";

const run = (window: EventWindow, classifier: ReturnType<typeof definePatternClassifier>) =>
    Effect.runPromise(
        Effect.gen(function* () {
            const runner = yield* ClassifierRunner;
            return yield* runner.runWindow({ window, classifiers: [classifier] });
        }).pipe(Effect.provide(ClassifierRunnerLive)),
    );

const basePattern = (overrides: Partial<ClassifierPattern> & Pick<ClassifierPattern, "test">): ClassifierPattern => ({
    label: "direction",
    target: "tooling_preference",
    matched: "tooling_preference",
    polarity: "revise",
    durability: "repo_preference",
    confidence: 0.8,
    ...overrides,
});

describe("definePatternClassifier", () => {
    test("derives deduped labels and targets from patterns in stable order", () => {
        const classifier = definePatternClassifier({
            key: "derive-test",
            version: "0.1.0",
            description: "derive",
            patterns: [
                basePattern({ test: /a/, label: "alpha", target: "one" }),
                basePattern({ test: /b/, label: "beta", target: "two" }),
                basePattern({ test: /c/, label: "alpha", target: "one" }),
            ],
        });
        // Labels/targets are DERIVED - hand-maintained arrays can never drift from
        // emitted values, so validateResult can no longer throw on a mismatch.
        expect(classifier.labels).toEqual(["alpha", "beta"]);
        expect(classifier.targets).toEqual(["one", "two"]);
        expect(classifier.kind).toBe("heuristic");
        expect(classifier.input).toBe("event_window");
    });

    test("emitting an undeclared label is impossible - every emitted result is declared", async () => {
        const patterns = [
            basePattern({ test: /aaa/, label: "alpha", target: "one" }),
            basePattern({ test: /bbb/, label: "beta", target: "two" }),
        ];
        const classifier = definePatternClassifier({
            key: "declared-test",
            version: "0.1.0",
            description: "declared",
            patterns,
        });
        for (const text of ["aaa", "bbb"]) {
            const results = await run(windowFixture({ user: text }), classifier);
            for (const result of results) {
                expect(classifier.labels).toContain(result.label);
                expect(classifier.targets).toContain(result.target);
            }
        }
    });

    test("first mode (default) returns only the first matching pattern", async () => {
        const classifier = definePatternClassifier({
            key: "first-mode",
            version: "0.1.0",
            description: "first",
            patterns: [
                basePattern({ test: /shared/, label: "alpha", target: "one", matched: "first" }),
                basePattern({ test: /shared/, label: "beta", target: "two", matched: "second" }),
            ],
        });
        const results = await run(windowFixture({ user: "shared token" }), classifier);
        expect(results).toHaveLength(1);
        expect(results[0].label).toBe("alpha");
    });

    test("all mode collects every matching pattern", async () => {
        const classifier = definePatternClassifier({
            key: "all-mode",
            version: "0.1.0",
            description: "all",
            mode: "all",
            patterns: [
                basePattern({ test: /shared/, label: "alpha", target: "one" }),
                basePattern({ test: /shared/, label: "beta", target: "two" }),
                basePattern({ test: /nomatch/, label: "gamma", target: "three" }),
            ],
        });
        const results = await run(windowFixture({ user: "shared token" }), classifier);
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.label)).toEqual(["alpha", "beta"]);
    });

    test("skipControlText off (default) classifies control wrappers", async () => {
        const classifier = definePatternClassifier({
            key: "skip-off",
            version: "0.1.0",
            description: "skip off",
            patterns: [basePattern({ test: /subagent/, label: "alpha", target: "one" })],
        });
        const results = await run(
            windowFixture({ user: "<subagent_notification> subagent done" }),
            classifier,
        );
        expect(results).toHaveLength(1);
    });

    test("skipControlText on drops control wrappers", async () => {
        const classifier = definePatternClassifier({
            key: "skip-on",
            version: "0.1.0",
            description: "skip on",
            skipControlText: true,
            patterns: [basePattern({ test: /subagent/, label: "alpha", target: "one" })],
        });
        const results = await run(
            windowFixture({ user: "<subagent_notification> subagent done" }),
            classifier,
        );
        expect(results).toEqual([]);
    });

    test("empty text always yields no results", async () => {
        const classifier = definePatternClassifier({
            key: "empty-test",
            version: "0.1.0",
            description: "empty",
            patterns: [basePattern({ test: /.*/, label: "alpha", target: "one" })],
        });
        const results = await run(windowFixture({ user: "   " }), classifier);
        expect(results).toEqual([]);
    });

    test("function-valued confidence resolves against the window and lowered text", async () => {
        const classifier = definePatternClassifier({
            key: "fn-confidence",
            version: "0.1.0",
            description: "fn confidence",
            patterns: [
                basePattern({
                    test: /failing/,
                    label: "alpha",
                    target: "one",
                    confidence: (window) => (window.recentToolFailures.length > 0 ? 0.9 : 0.5),
                }),
            ],
        });
        const withFailure = await run(
            windowFixture({ user: "this is failing", recentToolFailure: "boom" }),
            classifier,
        );
        expect(withFailure[0].confidence).toBe(0.9);
        const noFailure = await run(windowFixture({ user: "this is failing" }), classifier);
        expect(noFailure[0].confidence).toBe(0.5);
    });

    test("function-valued signals resolve against the lowered text", async () => {
        const classifier = definePatternClassifier({
            key: "fn-signals",
            version: "0.1.0",
            description: "fn signals",
            patterns: [
                basePattern({
                    test: /token/,
                    label: "alpha",
                    target: "one",
                    signals: (_window, lower) => (lower.includes("uv") ? ["tooling:uv"] : ["plain"]),
                }),
            ],
        });
        const results = await run(windowFixture({ user: "use uv token" }), classifier);
        expect(results[0].signals).toEqual(["tooling:uv"]);
    });

    test("default evidence carries user, previousAssistant, matched", async () => {
        const classifier = definePatternClassifier({
            key: "ev-default",
            version: "0.1.0",
            description: "ev default",
            patterns: [basePattern({ test: /hit/, label: "alpha", target: "one", matched: "tag" })],
        });
        const results = await run(
            windowFixture({ user: "hit it", previousAssistant: "prior reply" }),
            classifier,
        );
        const evidence = JSON.parse(results[0].evidenceJson) as Record<string, unknown>;
        expect(evidence).toEqual({ user: "hit it", previousAssistant: "prior reply", matched: "tag" });
    });

    test("evidence override replaces the default shape", async () => {
        const classifier = definePatternClassifier({
            key: "ev-override",
            version: "0.1.0",
            description: "ev override",
            evidence: (window, matched) => ({ custom: window.userTurn.text, matched }),
            patterns: [basePattern({ test: /hit/, label: "alpha", target: "one", matched: "tag" })],
        });
        const results = await run(windowFixture({ user: "hit it" }), classifier);
        const evidence = JSON.parse(results[0].evidenceJson) as Record<string, unknown>;
        expect(evidence).toEqual({ custom: "hit it", matched: "tag" });
    });
});
