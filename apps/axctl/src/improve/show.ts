/**
 * Pretty-print one experiment's evidence trail (proposal + experiment +
 * recent checkpoints). Drives `axctl improve show` and the eventual
 * dashboard detail view.
 */

import { Effect } from "effect";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import {
    type InterventionSafetyContract,
    interventionSafetyMessage,
    missingInterventionSafetyGates,
} from "./lifecycle.ts";
import { interventionFormSpec } from "./intervention-forms.ts";
import { findStoredProposal } from "./judgment-proposals.ts";

export interface ShowInput { readonly sigOrId: string; }

export interface ShowProposal {
    readonly shortId: string;
    readonly title: string;
    readonly form: string;
    readonly hypothesis: string;
    readonly status: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly updatedAt: string;
    readonly safety: InterventionSafetyContract | null;
}

export interface ShowExperiment {
    readonly id: string;
    readonly status: string;
    readonly artifactPath: string | null;
    readonly taskPath: string | null;
    readonly lockedVerdict: string | null;
}

export interface ShowCheckpoint {
    readonly kind: string;
    readonly observedAt: string;
    readonly measured: Record<string, unknown>;
    readonly suggested: string | null;
    readonly userVerdict: string | null;
}

export interface ShowResult {
    readonly proposal: ShowProposal;
    readonly experiment: ShowExperiment | null;
    readonly checkpoints: ShowCheckpoint[];
}

export const showExperiment = (
    input: ShowInput,
): Effect.Effect<ShowResult | null, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const prow = yield* findStoredProposal(input.sigOrId);
        if (!prow) return null;
        const safetyPayloadKey = interventionFormSpec(prow.form)?.safetyPayloadKey;
        const rawSafety = safetyPayloadKey === "hook_payload"
            ? prow.hook_payload
            : safetyPayloadKey === "automation_payload"
              ? prow.automation_payload
              : null;
        const proposal: ShowProposal = {
            shortId: prow.dedupe_sig, title: prow.title, form: prow.form,
            hypothesis: prow.hypothesis, status: prow.status,
            confidence: prow.confidence, frequency: prow.frequency,
            updatedAt: (prow.updated_at ?? prow.created_at).toISOString(),
            safety: rawSafety === null ? null : {
                recoveryPath: rawSafety?.recovery_path ?? null,
                smokeTestCommand: rawSafety?.smoke_test_command ?? null,
                disableCommand: rawSafety?.disable_command ?? null,
                failureMode: rawSafety?.failure_mode ?? null,
            },
        };
        const erow = prow.experiment;
        const experiment: ShowExperiment | null = erow ? {
            id: erow.id, status: erow.status,
            artifactPath: erow.artifact_path, taskPath: erow.task_path,
            lockedVerdict: erow.locked_verdict,
        } : null;
        const checkpoints: ShowCheckpoint[] = erow?.checkpoints.slice(-10).reverse().map((r) => ({
            kind: r.kind, observedAt: r.observed_at.toISOString(), measured: { ...r.measured },
            suggested: r.suggested, userVerdict: r.user_verdict,
        })) ?? [];
        return { proposal, experiment, checkpoints };
    });

export const formatShow = (r: ShowResult): string => {
    const lines: string[] = [];
    lines.push(`# ${r.proposal.shortId}  ${r.proposal.title}`);
    lines.push(`form=${r.proposal.form}  status=${r.proposal.status}  conf=${r.proposal.confidence}  freq=${r.proposal.frequency}/wk`);
    lines.push(`updated ${r.proposal.updatedAt}`);
    lines.push("");
    lines.push("## Evidence");
    lines.push(r.proposal.hypothesis);
    if (r.proposal.safety) {
        lines.push("");
        lines.push("## Safety");
        const missing = missingInterventionSafetyGates(r.proposal.safety);
        if (missing.length > 0) {
            lines.push(`Safety gates missing: ${missing.join(", ")}`);
        } else {
            lines.push(interventionSafetyMessage(r.proposal.form, r.proposal.safety));
        }
        lines.push(`Recovery Path: ${r.proposal.safety.recoveryPath ?? "-"}`);
        lines.push(`Smoke Test: ${r.proposal.safety.smokeTestCommand ?? "-"}`);
        lines.push(`Disable Switch: ${r.proposal.safety.disableCommand ?? "-"}`);
        lines.push(`Failure Mode: ${r.proposal.safety.failureMode ?? "-"}`);
    }
    if (r.experiment) {
        lines.push("");
        lines.push("## Experiment");
        lines.push(`id=${r.experiment.id}  status=${r.experiment.status}`);
        if (r.experiment.artifactPath) lines.push(`artifact: ${r.experiment.artifactPath}`);
        if (r.experiment.taskPath) lines.push(`pending task: ${r.experiment.taskPath}`);
        if (r.experiment.lockedVerdict) lines.push(`locked verdict: ${r.experiment.lockedVerdict}`);
    }
    if (r.checkpoints.length > 0) {
        lines.push("");
        lines.push("## Checkpoints");
        for (const c of r.checkpoints) {
            lines.push(`- ${c.observedAt}  kind=${c.kind}  suggested=${c.suggested ?? "-"}  user=${c.userVerdict ?? "-"}`);
        }
    }
    return lines.join("\n");
};
