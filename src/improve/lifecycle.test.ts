import { describe, expect, test } from "bun:test";
import {
    acceptedExperimentStatus,
    acceptanceFormError,
    interventionObservationStatus,
    interventionStrengthForConfidence,
    isAcceptedProposalForm,
    missingInterventionSafetyGates,
    planAcceptCandidate,
    planLockVerdict,
    planRejectCandidate,
    planRetroPlanRegistration,
    planTaskScaffolded,
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

    test("plans accept transitions before callers touch persistence", () => {
        expect(planAcceptCandidate({ form: "skill", proposalStatus: "open", autoScaffold: true })).toEqual({
            status: "ok",
            experimentStatus: "scaffolded",
        });
        expect(planAcceptCandidate({ form: "hook", proposalStatus: "open", autoScaffold: false })).toEqual({
            status: "unsupported_form",
            message: "accept supports form=guidance and form=skill (got hook); subagent/hook/automation land in later phases",
        });
        expect(planAcceptCandidate({ form: "skill", proposalStatus: "accepted", autoScaffold: false })).toEqual({
            status: "wrong_status",
            message: "proposal already accepted",
        });
    });

    test("plans reject transitions with the default reject reason", () => {
        expect(planRejectCandidate({ proposalStatus: "open" })).toEqual({
            status: "ok",
            reason: "not_worth_packaging",
        });
        expect(planRejectCandidate({ proposalStatus: "accepted", reason: "dupe" })).toEqual({
            status: "wrong_status",
            message: "proposal already accepted",
        });
    });

    test("plans marker reconciliation without hiding regressed verdicts", () => {
        expect(planTaskScaffolded({ experimentStatus: "task_emitted", lockedVerdict: null })).toEqual({
            status: "scaffold",
            nextStatus: "scaffolded",
            regressed: false,
        });
        expect(planTaskScaffolded({ experimentStatus: "scaffolded", lockedVerdict: "regressed" })).toEqual({
            status: "noop",
            regressed: true,
        });
    });

    test("validates final experiment verdict vocabulary with stable CLI message", () => {
        expect(validateLifecycleVerdict("adopted")).toEqual({ valid: true, verdict: "adopted" });
        expect(validateLifecycleVerdict("better")).toEqual({
            valid: false,
            message: "verdict must be one of: adopted, ignored, no_longer_needed, partial, regressed",
        });
        expect(planLockVerdict({ requestedVerdict: "adopted", lockedVerdict: null })).toEqual({
            status: "ok",
            verdict: "adopted",
        });
        expect(planLockVerdict({ requestedVerdict: "adopted", lockedVerdict: "ignored" })).toEqual({
            status: "verdict_locked",
            message: "experiment already locked: ignored",
        });
        expect(planLockVerdict({ requestedVerdict: "better", lockedVerdict: null })).toEqual({
            status: "invalid_verdict",
            message: "verdict must be one of: adopted, ignored, no_longer_needed, partial, regressed",
        });
    });

    test("plans retro plan registration with safety-gated accepted forms", () => {
        expect(planRetroPlanRegistration({ form: "skill", leaveOpen: false })).toEqual({
            proposalStatus: "accepted",
            createExperiment: true,
            experimentStatus: "scaffolded",
            safetyMessage: null,
        });
        expect(planRetroPlanRegistration({ form: "hook", leaveOpen: false })).toEqual({
            proposalStatus: "open",
            createExperiment: false,
            experimentStatus: null,
            safetyMessage: "hook proposals stay open until safety gates are modeled: Recovery Path, smoke test, disable switch, failure mode",
        });
        expect(planRetroPlanRegistration({ form: "skill", leaveOpen: true })).toEqual({
            proposalStatus: "open",
            createExperiment: false,
            experimentStatus: null,
            safetyMessage: null,
        });
    });

    test("models missing safety gates for candidate-only intervention forms", () => {
        expect(missingInterventionSafetyGates(null)).toEqual([
            "Recovery Path",
            "smoke test",
            "disable switch",
            "failure mode",
        ]);
        expect(missingInterventionSafetyGates({
            recoveryPath: "Move hook out of .claude/hooks",
            smokeTestCommand: "bun test",
            disableCommand: "chmod -x hook.sh",
            failureMode: "fail_open",
        })).toEqual([]);
        expect(missingInterventionSafetyGates({
            recoveryPath: "Revert launchd plist",
            smokeTestCommand: "",
            disableCommand: "launchctl unload x",
            failureMode: "block",
        })).toEqual(["smoke test", "failure mode"]);
    });

    test("derives harness intervention strength and observation status from lifecycle evidence", () => {
        expect(interventionStrengthForConfidence("medium")).toBe("workflow");
        expect(interventionStrengthForConfidence("low")).toBe("advisory");
        expect(interventionObservationStatus({ currentRisk: false, graphRisk: false })).toBe("needs_more_evidence");
        expect(interventionObservationStatus({ currentRisk: true, graphRisk: false })).toBe("observed");
        expect(interventionObservationStatus({ currentRisk: false, graphRisk: true })).toBe("observed");
    });
});
