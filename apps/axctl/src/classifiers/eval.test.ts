import { describe, expect, test } from "bun:test";
import {
    formatClassifierEvalSummary,
    runClassifierEvalSuites,
    type ClassifierEvalSuite,
} from "./eval.ts";

const passingSuite: ClassifierEvalSuite = {
    name: "reaction-event",
    cases: [
        {
            name: "uv-direction",
            window: {
                user: "can you use UV ?",
                previousAssistant: "I am installing Python dependencies with pip.",
                recentToolFailures: ["ERROR: dependency resolution failed"],
            },
            expect: [{
                classifierKey: "reaction-event",
                label: "direction",
                target: "environment_setup",
                polarity: "revise",
                durability: "repo_preference",
            }],
        },
    ],
};

describe("classifier eval harness", () => {
    test("passes golden classifier expectations", async () => {
        const summary = await runClassifierEvalSuites([passingSuite]);

        expect(summary.total).toBe(1);
        expect(summary.failed).toBe(0);
        expect(summary.cases[0]?.actual[0]).toMatchObject({
            classifierKey: "reaction-event",
            label: "direction",
            target: "environment_setup",
        });
    });

    test("reports missing expected labels", async () => {
        const summary = await runClassifierEvalSuites([{
            name: "bad-suite",
            cases: [{
                ...passingSuite.cases[0]!,
                expect: [{
                    classifierKey: "reaction-event",
                    label: "approval",
                    target: "unknown",
                }],
            }],
        }]);

        expect(summary.failed).toBe(1);
        expect(summary.cases[0]?.failures[0]).toContain("missing reaction-event|approval|unknown");
    });

    test("reports rejected labels that appear", async () => {
        const summary = await runClassifierEvalSuites([{
            name: "reject-suite",
            cases: [{
                ...passingSuite.cases[0]!,
                reject: [{
                    classifierKey: "reaction-event",
                    label: "direction",
                    target: "environment_setup",
                }],
            }],
        }]);

        expect(summary.failed).toBe(1);
        expect(summary.cases[0]?.failures[0]).toContain("unexpected reaction-event|direction|environment_setup");
    });

    test("formats a compact human summary", async () => {
        const summary = await runClassifierEvalSuites([passingSuite]);
        const output = formatClassifierEvalSummary(summary);

        expect(output).toContain("classifier eval: 1/1 passed");
        expect(output).toContain("PASS reaction-event / uv-direction");
    });
});
