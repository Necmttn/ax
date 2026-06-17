import { describe, expect, test } from "bun:test";
import {
    INTERVENTION_FORM_REGISTRY,
    INTERVENTION_FORMS,
    interventionFormSpec,
    isInterventionForm,
} from "./intervention-forms.ts";
import { TASK_FORM_RENDERERS } from "./task-template.ts";

describe("intervention form registry", () => {
    test("enumerates every acceptable intervention form exactly once", () => {
        expect(INTERVENTION_FORMS).toEqual([
            "guidance",
            "skill",
            "harness_check",
            "subagent",
            "hook",
            "automation",
        ]);
        expect(Object.keys(INTERVENTION_FORM_REGISTRY)).toEqual([...INTERVENTION_FORMS]);
    });

    test("carries safety, marker, and impact dispatch metadata", () => {
        expect(interventionFormSpec("hook")).toMatchObject({
            requiresSafetyContract: true,
            markerStrategy: "hook_command",
            safetyPayloadKey: "hook_payload",
            nextActionImpactChip: "routing_savings",
            nextActionFixKind: "new hook",
        });
        expect(interventionFormSpec("automation")).toMatchObject({
            requiresSafetyContract: true,
            markerStrategy: "automation",
            safetyPayloadKey: "automation_payload",
            nextActionImpactChip: "none",
            nextActionFixKind: "automation",
        });
        expect(interventionFormSpec("guidance")).toMatchObject({
            requiresSafetyContract: false,
            markerStrategy: "inline",
            impactModel: "guidance",
            nextActionImpactChip: "frequency",
            nextActionFixKind: "edit_guidance",
        });
        expect(interventionFormSpec("skill")).toMatchObject({
            markerStrategy: "frontmatter",
            impactModel: "skill",
            nextActionImpactChip: "frequency",
            nextActionFixKind: "new skill",
        });
    });

    test("task rendering is keyed by the registry, not a separate switch list", () => {
        expect(Object.keys(TASK_FORM_RENDERERS)).toEqual([...INTERVENTION_FORMS]);
        for (const form of INTERVENTION_FORMS) {
            expect(TASK_FORM_RENDERERS[form]).toBeTypeOf("function");
        }
    });

    test("narrows unknown form strings", () => {
        expect(isInterventionForm("hook")).toBe(true);
        expect(isInterventionForm("wish")).toBe(false);
    });
});
