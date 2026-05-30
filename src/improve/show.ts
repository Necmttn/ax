/**
 * Pretty-print one experiment's evidence trail (proposal + experiment +
 * recent checkpoints). Drives `axctl improve show` and the eventual
 * dashboard detail view.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { surrealLiteral } from "../lib/json.ts";
import type { DbError } from "../lib/errors.ts";
import {
    type InterventionSafetyContract,
    interventionSafetyMessage,
    missingInterventionSafetyGates,
} from "./lifecycle.ts";

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
): Effect.Effect<ShowResult | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const idLit = surrealLiteral(input.sigOrId);
        const db = yield* SurrealClient;
        const pRows = yield* db.query<[ReadonlyArray<{
            dedupe_sig: string; title: string; form: string; hypothesis: string;
            status: string; confidence: string; frequency: number; updated_at: string;
            hook_payload?: {
                recovery_path?: string | null;
                smoke_test_command?: string | null;
                disable_command?: string | null;
                failure_mode?: string | null;
            } | null;
            automation_payload?: {
                recovery_path?: string | null;
                smoke_test_command?: string | null;
                disable_command?: string | null;
                failure_mode?: string | null;
            } | null;
        }>]>(`SELECT dedupe_sig, title, form, hypothesis, status, confidence, frequency,
                type::string(updated_at) AS updated_at,
                (SELECT recovery_path, smoke_test_command, disable_command, failure_mode FROM hook_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS hook_payload,
                (SELECT recovery_path, smoke_test_command, disable_command, failure_mode FROM automation_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS automation_payload
            FROM proposal WHERE dedupe_sig = ${idLit} OR id = ${idLit} LIMIT 1;`);
        const prow = (pRows?.[0] ?? [])[0];
        if (!prow) return null;
        const rawSafety = prow.form === "hook"
            ? prow.hook_payload
            : prow.form === "automation"
                ? prow.automation_payload
                : null;
        const proposal: ShowProposal = {
            shortId: prow.dedupe_sig, title: prow.title, form: prow.form,
            hypothesis: prow.hypothesis, status: prow.status,
            confidence: prow.confidence, frequency: prow.frequency,
            updatedAt: prow.updated_at,
            safety: rawSafety === null ? null : {
                recoveryPath: rawSafety?.recovery_path ?? null,
                smokeTestCommand: rawSafety?.smoke_test_command ?? null,
                disableCommand: rawSafety?.disable_command ?? null,
                failureMode: rawSafety?.failure_mode ?? null,
            },
        };
        const eRows = yield* db.query<[ReadonlyArray<{
            id: string; status: string; artifact_path: string | null;
            task_path: string | null; locked_verdict: string | null;
        }>]>(`SELECT type::string(id) AS id, status, artifact_path, task_path, locked_verdict
            FROM experiment WHERE proposal.dedupe_sig = ${idLit} LIMIT 1;`);
        const erow = (eRows?.[0] ?? [])[0];
        const experiment: ShowExperiment | null = erow ? {
            id: erow.id, status: erow.status,
            artifactPath: erow.artifact_path, taskPath: erow.task_path,
            lockedVerdict: erow.locked_verdict,
        } : null;
        let checkpoints: ShowCheckpoint[] = [];
        if (experiment) {
            const cRows = yield* db.query<[ReadonlyArray<{
                kind: string; observed_at: string; measured: Record<string, unknown>;
                suggested: string | null; user_verdict: string | null;
            }>]>(`SELECT kind, type::string(observed_at) AS observed_at, measured, suggested, user_verdict
                FROM checkpoint WHERE experiment = ${experiment.id}
                ORDER BY observed_at DESC LIMIT 10;`);
            checkpoints = (cRows?.[0] ?? []).map((r) => ({
                kind: r.kind, observedAt: r.observed_at, measured: r.measured,
                suggested: r.suggested, userVerdict: r.user_verdict,
            }));
        }
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
