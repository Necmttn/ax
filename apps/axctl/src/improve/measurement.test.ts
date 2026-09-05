import { describe, expect, test } from "bun:test";
import {
    currentCheckpointProjection,
    detectorSupport,
    measurementEligibility,
    parseSkillTriggerTool,
    readMeasurementVersion,
} from "./measurement.ts";

const subject = (overrides: Record<string, unknown> = {}) => ({
    proposalStatus: "accepted",
    experimentStatus: "scaffolded",
    lockedVerdict: null,
    artifactPath: "/tmp/CLAUDE.md",
    scaffoldedAt: "2026-01-01T00:00:00Z",
    ...overrides,
}) as Parameters<typeof measurementEligibility>[0];

describe("measurementEligibility", () => {
    test("accepted + scaffolded + unlocked + installed artifact is eligible", () => {
        expect(measurementEligibility(subject())).toEqual({ eligible: true });
    });

    test("a rejected or open proposal is excluded", () => {
        expect(measurementEligibility(subject({ proposalStatus: "open" })))
            .toEqual({ eligible: false, reason: "not_accepted" });
        expect(measurementEligibility(subject({ proposalStatus: "rejected" })))
            .toEqual({ eligible: false, reason: "not_accepted" });
    });

    test("task_emitted, retired and regressed experiments are excluded by lifecycle", () => {
        expect(measurementEligibility(subject({ experimentStatus: "task_emitted" })))
            .toEqual({ eligible: false, reason: "not_started" });
        expect(measurementEligibility(subject({ experimentStatus: "retired" })))
            .toEqual({ eligible: false, reason: "retired" });
        expect(measurementEligibility(subject({ experimentStatus: "regressed" })))
            .toEqual({ eligible: false, reason: "regressed" });
    });

    test("a locked verdict outranks every other reason", () => {
        expect(measurementEligibility(subject({ lockedVerdict: "adopted", experimentStatus: "retired" })))
            .toEqual({ eligible: false, reason: "locked" });
    });

    test("a missing artifact path or install time is unavailable evidence, not a verdict", () => {
        expect(measurementEligibility(subject({ artifactPath: null })))
            .toEqual({ eligible: false, reason: "artifact_unavailable" });
        expect(measurementEligibility(subject({ artifactPath: "   " })))
            .toEqual({ eligible: false, reason: "artifact_unavailable" });
        expect(measurementEligibility(subject({ scaffoldedAt: null })))
            .toEqual({ eligible: false, reason: "artifact_unavailable" });
    });

    test("accepts a Date install time as well as an ISO string", () => {
        expect(measurementEligibility(subject({ scaffoldedAt: new Date("2026-01-01T00:00:00Z") })))
            .toEqual({ eligible: true });
    });
});

describe("parseSkillTriggerTool", () => {
    test("reads the supported tool=<name> form only", () => {
        expect(parseSkillTriggerTool("tool=Bash")).toBe("Bash");
        expect(parseSkillTriggerTool("  tool=Edit  ")).toBe("Edit");
        expect(parseSkillTriggerTool("when the agent edits schema")).toBeNull();
        expect(parseSkillTriggerTool("tool=")).toBeNull();
    });
});

describe("detectorSupport", () => {
    const detector = (overrides: Record<string, unknown> = {}) => ({
        form: "guidance",
        skillTrigger: null,
        hasSkillCandidate: false,
        hookTargetTool: null,
        hookEventName: null,
        dedupeSig: "74da7418",
        artifactPath: "/tmp/CLAUDE.md",
        ...overrides,
    }) as Parameters<typeof detectorSupport>[0];

    test("guidance is supported by its reconciled artifact path", () => {
        expect(detectorSupport(detector())).toEqual({ supported: true });
        expect(detectorSupport(detector({ artifactPath: null })))
            .toEqual({ supported: false, reason: "artifact_unavailable" });
    });

    test("hooks need target tool, event name and a usable marker identity", () => {
        const hook = { form: "hook", hookTargetTool: "Bash", hookEventName: "PreToolUse" };
        expect(detectorSupport(detector(hook))).toEqual({ supported: true });
        expect(detectorSupport(detector({ ...hook, hookTargetTool: null })))
            .toEqual({ supported: false, reason: "detector_unavailable" });
        expect(detectorSupport(detector({ ...hook, hookEventName: null })))
            .toEqual({ supported: false, reason: "detector_unavailable" });
        expect(detectorSupport(detector({ ...hook, dedupeSig: "" })))
            .toEqual({ supported: false, reason: "detector_unavailable" });
    });

    test("skills need a resolvable candidate or the tool=<name> trigger", () => {
        expect(detectorSupport(detector({ form: "skill", hasSkillCandidate: true })))
            .toEqual({ supported: true });
        expect(detectorSupport(detector({ form: "skill", skillTrigger: "tool=Bash" })))
            .toEqual({ supported: true });
        expect(detectorSupport(detector({ form: "skill", skillTrigger: "agent edits schema files" })))
            .toEqual({ supported: false, reason: "detector_unavailable" });
        expect(detectorSupport(detector({ form: "skill" })))
            .toEqual({ supported: false, reason: "detector_unavailable" });
    });

    test("automation, subagent and harness_check forms have no detector", () => {
        for (const form of ["automation", "subagent", "harness_check"]) {
            expect(detectorSupport(detector({ form }))).toEqual({
                supported: false,
                reason: "detector_unavailable",
            });
        }
    });
});

describe("readMeasurementVersion", () => {
    test("reads the numeric version, or null when absent or malformed", () => {
        expect(readMeasurementVersion({ measurement_version: 2 })).toBe(2);
        expect(readMeasurementVersion({ opportunities: 3 })).toBeNull();
        expect(readMeasurementVersion({ measurement_version: "2" })).toBeNull();
        expect(readMeasurementVersion(null)).toBeNull();
    });
});

describe("currentCheckpointProjection", () => {
    const measured = (overrides: Record<string, unknown> = {}) => ({
        opportunities: 12, addressed: 8, ratio: 8 / 12, built: true,
        measurement_status: "measured", measurement_version: 2,
        ...overrides,
    });

    test("a current measured suggestion is the recommendation", () => {
        expect(currentCheckpointProjection(subject(), {
            suggested: "adopted", user_verdict: null, measured: measured(),
        })).toEqual({ suggested: "adopted", reason: null });
    });

    test("no checkpoint yet reports no_checkpoint, not a verdict", () => {
        expect(currentCheckpointProjection(subject(), null))
            .toEqual({ suggested: null, reason: "no_checkpoint" });
    });

    test("an ineligible experiment reports its lifecycle state, never an old suggestion", () => {
        expect(currentCheckpointProjection(subject({ experimentStatus: "retired" }), {
            suggested: "adopted", user_verdict: null, measured: measured(),
        })).toEqual({ suggested: null, reason: "retired" });
        expect(currentCheckpointProjection(subject({ experimentStatus: "task_emitted" }), {
            suggested: "adopted", user_verdict: null, measured: measured(),
        })).toEqual({ suggested: null, reason: "not_started" });
    });

    test("a locked experiment keeps the human decision visible", () => {
        expect(currentCheckpointProjection(subject({ lockedVerdict: "adopted" }), {
            suggested: "adopted", user_verdict: "adopted", measured: measured(),
        })).toEqual({ suggested: "adopted", reason: null });
    });

    test("an insufficient-data row surfaces its own reason", () => {
        expect(currentCheckpointProjection(subject(), {
            suggested: null,
            user_verdict: null,
            measured: measured({
                opportunities: 0, addressed: 0, ratio: 0,
                measurement_status: "insufficient_data", reason: "no_opportunities",
            }),
        })).toEqual({ suggested: null, reason: "no_opportunities" });
    });

    test("a pre-version-2 row awaits explicit refresh instead of reporting its suggestion", () => {
        expect(currentCheckpointProjection(subject(), {
            suggested: "adopted",
            user_verdict: null,
            measured: { opportunities: 12, addressed: 8, ratio: 8 / 12, built: true },
        })).toEqual({ suggested: null, reason: "refresh_required" });
    });

    test("a missing or unknown measurement status never authorizes a suggestion", () => {
        for (const status of [undefined, "estimated", "insufficient_data", 2]) {
            expect(currentCheckpointProjection(subject(), {
                suggested: "adopted",
                user_verdict: null,
                measured: {
                    opportunities: 12, addressed: 8, ratio: 8 / 12, built: true,
                    measurement_version: 2,
                    ...(status === undefined ? {} : { measurement_status: status }),
                },
            })).toEqual({ suggested: null, reason: "refresh_required" });
        }
    });

    test("a missing or malformed opportunity count asks for a refresh, not a verdict", () => {
        for (const opportunities of [undefined, "12", null, Number.NaN, Number.POSITIVE_INFINITY, -3]) {
            expect(currentCheckpointProjection(subject(), {
                suggested: "adopted",
                user_verdict: null,
                measured: {
                    addressed: 8, ratio: 8 / 12, built: true,
                    measurement_status: "measured", measurement_version: 2,
                    ...(opportunities === undefined ? {} : { opportunities }),
                },
            })).toEqual({ suggested: null, reason: "refresh_required" });
        }
    });

    test("an insufficient-data row keeps its own reason ahead of the status gate", () => {
        expect(currentCheckpointProjection(subject(), {
            suggested: null,
            user_verdict: null,
            measured: measured({
                opportunities: 12,
                measurement_status: "insufficient_data", reason: "detector_unavailable",
            }),
        })).toEqual({ suggested: null, reason: "detector_unavailable" });
    });

    test("zero opportunities never reads as a substantive verdict", () => {
        expect(currentCheckpointProjection(subject(), {
            suggested: "no_longer_needed",
            user_verdict: null,
            measured: measured({ opportunities: 0, addressed: 0, ratio: 0 }),
        })).toEqual({ suggested: null, reason: "no_opportunities" });
    });
});
