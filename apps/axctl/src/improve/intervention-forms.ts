/**
 * Closed set of Acceptable Intervention Forms. The registry carries only
 * cross-cutting dispatch metadata; each caller still owns its local behavior.
 */

export const INTERVENTION_FORMS = [
    "guidance",
    "skill",
    "harness_check",
    "subagent",
    "hook",
    "automation",
] as const;

export type InterventionForm = (typeof INTERVENTION_FORMS)[number];

export type InterventionMarkerStrategy =
    | "inline"
    | "frontmatter"
    | "hook_command"
    | "automation";

export type InterventionImpactModel = "guidance" | "skill" | "fallback";

export type InterventionSafetyPayloadKey = "hook_payload" | "automation_payload";

export type InterventionNextActionImpactChip = "frequency" | "routing_savings" | "none";
export type InterventionNextActionFixKind =
    | "edit_guidance"
    | "new skill"
    | "new subagent"
    | "new hook"
    | "automation"
    | "harness check";

export interface InterventionFormSpec {
    readonly form: InterventionForm;
    readonly markerStrategy: InterventionMarkerStrategy;
    readonly requiresSafetyContract: boolean;
    readonly safetyPayloadKey: InterventionSafetyPayloadKey | null;
    readonly impactModel: InterventionImpactModel;
    readonly nextActionImpactChip: InterventionNextActionImpactChip;
    readonly nextActionFixKind: InterventionNextActionFixKind;
    readonly acceptsManualTask: true;
}

export const INTERVENTION_FORM_REGISTRY = {
    guidance: {
        form: "guidance",
        markerStrategy: "inline",
        requiresSafetyContract: false,
        safetyPayloadKey: null,
        impactModel: "guidance",
        nextActionImpactChip: "frequency",
        nextActionFixKind: "edit_guidance",
        acceptsManualTask: true,
    },
    skill: {
        form: "skill",
        markerStrategy: "frontmatter",
        requiresSafetyContract: false,
        safetyPayloadKey: null,
        impactModel: "skill",
        nextActionImpactChip: "frequency",
        nextActionFixKind: "new skill",
        acceptsManualTask: true,
    },
    harness_check: {
        form: "harness_check",
        markerStrategy: "frontmatter",
        requiresSafetyContract: false,
        safetyPayloadKey: null,
        impactModel: "fallback",
        nextActionImpactChip: "none",
        nextActionFixKind: "harness check",
        acceptsManualTask: true,
    },
    subagent: {
        form: "subagent",
        markerStrategy: "frontmatter",
        requiresSafetyContract: false,
        safetyPayloadKey: null,
        impactModel: "fallback",
        nextActionImpactChip: "none",
        nextActionFixKind: "new subagent",
        acceptsManualTask: true,
    },
    hook: {
        form: "hook",
        markerStrategy: "hook_command",
        requiresSafetyContract: true,
        safetyPayloadKey: "hook_payload",
        impactModel: "fallback",
        nextActionImpactChip: "routing_savings",
        nextActionFixKind: "new hook",
        acceptsManualTask: true,
    },
    automation: {
        form: "automation",
        markerStrategy: "automation",
        requiresSafetyContract: true,
        safetyPayloadKey: "automation_payload",
        impactModel: "fallback",
        nextActionImpactChip: "none",
        nextActionFixKind: "automation",
        acceptsManualTask: true,
    },
} satisfies Record<InterventionForm, InterventionFormSpec>;

export const isInterventionForm = (form: string): form is InterventionForm =>
    Object.prototype.hasOwnProperty.call(INTERVENTION_FORM_REGISTRY, form);

export const interventionFormSpec = (form: string): InterventionFormSpec | null =>
    isInterventionForm(form) ? INTERVENTION_FORM_REGISTRY[form] : null;
