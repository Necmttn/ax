import { describe, expect, test } from "bun:test";
import {
    acceptedExperimentStatus,
    acceptanceFormError,
    interventionObservationStatus,
    interventionStrengthForConfidence,
    isAcceptedProposalForm,
    validateLifecycleVerdict,
} from "./lifecycle.ts";

describe("intervention lifecycle vocabulary", () => {
    test("accepts only v0 proposal forms that can create an experiment", () => {
        expect(isAcceptedProposalForm("guidance")).toBe(true);
        expect(isAcceptedProposalForm("skill")).toBe(true);
        expect(isAcceptedProposalForm("subagent")).toBe(false);
        expect(acceptanceFormError("hook")).toBe(
            "accept supports form=guidance and form=skill (got hook); subagent/hook/automation land in later phases",
        );
    });

    test("maps accept path to the experiment status persisted by actions", () => {
        expect(acceptedExperimentStatus({ form: "guidance", autoScaffold: false })).toBe("task_emitted");
        expect(acceptedExperimentStatus({ form: "skill", autoScaffold: false })).toBe("task_emitted");
        expect(acceptedExperimentStatus({ form: "skill", autoScaffold: true })).toBe("scaffolded");
    });

    test("validates final experiment verdict vocabulary with stable CLI message", () => {
        expect(validateLifecycleVerdict("adopted")).toEqual({ valid: true, verdict: "adopted" });
        expect(validateLifecycleVerdict("better")).toEqual({
            valid: false,
            message: "verdict must be one of: adopted, ignored, no_longer_needed, partial, regressed",
        });
    });

    test("derives harness intervention strength and observation status from lifecycle evidence", () => {
        expect(interventionStrengthForConfidence("medium")).toBe("workflow");
        expect(interventionStrengthForConfidence("low")).toBe("advisory");
        expect(interventionObservationStatus({ currentRisk: false, graphRisk: false })).toBe("needs_more_evidence");
        expect(interventionObservationStatus({ currentRisk: true, graphRisk: false })).toBe("observed");
        expect(interventionObservationStatus({ currentRisk: false, graphRisk: true })).toBe("observed");
    });
});
