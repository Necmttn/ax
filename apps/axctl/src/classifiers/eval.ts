import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
    ClassifierRunner,
    ClassifierRunnerLive,
    type ClassifierDefinition,
    type ClassifierResult,
    type EventWindow,
} from "./core.ts";
import { builtInClassifiers } from "./registry.ts";
import { registeredClassifiers } from "./registry.ts";

export interface ClassifierEvalExpectation {
    readonly classifierKey: string;
    readonly label: string;
    readonly target: string;
    readonly polarity?: string;
    readonly durability?: string;
}

export interface ClassifierEvalWindowFixture {
    readonly user: string;
    readonly previousAssistant?: string | null;
    readonly recentToolFailures?: readonly string[];
}

export interface ClassifierEvalCase {
    readonly name: string;
    readonly classifierKeys?: readonly string[];
    readonly window: ClassifierEvalWindowFixture;
    readonly expect: readonly ClassifierEvalExpectation[];
    readonly reject?: readonly ClassifierEvalExpectation[];
}

export interface ClassifierEvalSuite {
    readonly name: string;
    readonly cases: readonly ClassifierEvalCase[];
}

export interface ClassifierEvalCaseResult {
    readonly suite: string;
    readonly name: string;
    readonly passed: boolean;
    readonly expected: readonly ClassifierEvalExpectation[];
    readonly actual: readonly Pick<ClassifierResult, "classifierKey" | "label" | "target" | "polarity" | "durability" | "confidence">[];
    readonly failures: readonly string[];
}

export interface ClassifierEvalSummary {
    readonly passed: number;
    readonly failed: number;
    readonly total: number;
    readonly cases: readonly ClassifierEvalCaseResult[];
}

const defaultTs = new Date("2026-05-30T00:00:00.000Z");

export function eventWindowFromEvalFixture(name: string, fixture: ClassifierEvalWindowFixture): EventWindow {
    return {
        key: `eval__${name}`,
        subjectType: "event_window",
        subjectId: `eval__${name}`,
        sessionId: "eval",
        userTurn: {
            id: `eval__${name}__user`,
            key: `eval__${name}__user`,
            seq: 2,
            role: "user",
            text: fixture.user,
            ts: defaultTs,
        },
        previousAssistantTurn: fixture.previousAssistant
            ? {
                id: `eval__${name}__assistant`,
                key: `eval__${name}__assistant`,
                seq: 1,
                role: "assistant",
                text: fixture.previousAssistant,
                ts: defaultTs,
            }
            : null,
        recentToolCalls: [],
        recentToolFailures: (fixture.recentToolFailures ?? []).map((text, index) => ({
            id: `eval__${name}__tool_${index}`,
            text,
            ts: defaultTs,
        })),
        recentFiles: [],
        existingLabels: [],
    };
}

const expectationKey = (value: ClassifierEvalExpectation): string =>
    [
        value.classifierKey,
        value.label,
        value.target,
        value.polarity ?? "*",
        value.durability ?? "*",
    ].join("|");

const resultKey = (value: Pick<ClassifierResult, "classifierKey" | "label" | "target" | "polarity" | "durability">): string =>
    [value.classifierKey, value.label, value.target, value.polarity, value.durability].join("|");

export const resultMatchesExpectation = (result: ClassifierResult, expected: ClassifierEvalExpectation): boolean =>
    result.classifierKey === expected.classifierKey &&
    result.label === expected.label &&
    result.target === expected.target &&
    (expected.polarity === undefined || result.polarity === expected.polarity) &&
    (expected.durability === undefined || result.durability === expected.durability);

export async function runClassifierEvalSuites(
    suites: readonly ClassifierEvalSuite[],
    classifiers: readonly ClassifierDefinition[] = builtInClassifiers,
): Promise<ClassifierEvalSummary> {
    const program = Effect.gen(function* () {
        const runner = yield* ClassifierRunner;
        const cases: ClassifierEvalCaseResult[] = [];
        for (const suite of suites) {
            for (const testCase of suite.cases) {
                const selected = testCase.classifierKeys
                    ? classifiers.filter((classifier) => testCase.classifierKeys?.includes(classifier.key))
                    : classifiers;
                const results = yield* runner.runWindow({
                    window: eventWindowFromEvalFixture(testCase.name, testCase.window),
                    classifiers: selected,
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
    return Effect.runPromise(program.pipe(Effect.provide(ClassifierRunnerLive)));
}

export function loadClassifierEvalSuites(path: string): readonly ClassifierEvalSuite[] {
    const stat = statSync(path);
    const files = stat.isDirectory()
        ? readdirSync(path).filter((file) => file.endsWith(".json")).sort().map((file) => join(path, file))
        : [path];
    return files.map((file) => JSON.parse(readFileSync(file, "utf8")) as ClassifierEvalSuite);
}

export const defaultClassifierEvalPaths = (): readonly string[] =>
    registeredClassifiers.flatMap((entry) => entry.fixturePaths);

export function loadDefaultClassifierEvalSuites(): readonly ClassifierEvalSuite[] {
    return defaultClassifierEvalPaths().flatMap((path) => loadClassifierEvalSuites(path));
}

export function formatClassifierEvalSummary(summary: ClassifierEvalSummary, opts: { readonly json?: boolean } = {}): string {
    if (opts.json) return JSON.stringify(summary, null, 2);
    const lines = [`classifier eval: ${summary.passed}/${summary.total} passed`];
    for (const result of summary.cases) {
        const marker = result.passed ? "PASS" : "FAIL";
        lines.push(`${marker} ${result.suite} / ${result.name}`);
        for (const failure of result.failures) lines.push(`  ${failure}`);
        if (!result.passed) {
            const actual = result.actual.map(resultKey).join(", ") || "(none)";
            lines.push(`  actual: ${actual}`);
        }
    }
    return lines.join("\n");
}
