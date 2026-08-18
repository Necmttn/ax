import { Effect, Schema } from "effect";
import {
    JsonArrayColumn,
    JsonObjectColumn,
    Judgment,
    NumberColumn,
    TextColumn,
    TimestampColumn,
    type JudgmentError,
    type JudgmentService,
    type SidecarParam,
} from "@ax/lib/sqlite";

const NullableText = Schema.NullOr(TextColumn);
const NullableTimestamp = Schema.NullOr(TimestampColumn);

const ProposalRow = Schema.Struct({
    id: TextColumn,
    form: TextColumn,
    title: TextColumn,
    hypothesis: TextColumn,
    dedupe_sig: TextColumn,
    frequency: NumberColumn,
    confidence: TextColumn,
    status: TextColumn,
    origin: TextColumn,
    hypothesis_template: NullableText,
    evidence_query: NullableText,
    reject_reason: NullableText,
    baseline: NullableText,
    created_at: TimestampColumn,
    updated_at: NullableTimestamp,
});

const SkillPayloadRow = Schema.Struct({
    proposal: TextColumn,
    trigger_pattern: TextColumn,
    suspected_gap: TextColumn,
    proposed_behavior: TextColumn,
    expected_impact: NullableText,
});
const SubagentPayloadRow = Schema.Struct({
    proposal: TextColumn,
    bounded_role: TextColumn,
    delegation_trigger: TextColumn,
    example_task_patterns: JsonArrayColumn(TextColumn),
});
const HookPayloadRow = Schema.Struct({
    proposal: TextColumn,
    event_name: TextColumn,
    target_tool: NullableText,
    hook_command: TextColumn,
    recovery_path: NullableText,
    smoke_test_command: NullableText,
    disable_command: NullableText,
    failure_mode: NullableText,
});
const GuidancePayloadRow = Schema.Struct({
    proposal: TextColumn,
    file_target: TextColumn,
    section: NullableText,
    suggested_text: TextColumn,
});
const AutomationPayloadRow = Schema.Struct({
    proposal: TextColumn,
    trigger_signal: TextColumn,
    schedule: NullableText,
    action: TextColumn,
    recovery_path: NullableText,
    smoke_test_command: NullableText,
    disable_command: NullableText,
    failure_mode: NullableText,
});
const ExperimentRow = Schema.Struct({
    id: TextColumn,
    proposal: TextColumn,
    artifact: NullableText,
    artifact_path: NullableText,
    scaffolded_at: NullableTimestamp,
    created_at: TimestampColumn,
    locked_verdict: NullableText,
    status: TextColumn,
    task_path: NullableText,
});
const CheckpointRow = Schema.Struct({
    id: TextColumn,
    experiment: TextColumn,
    kind: TextColumn,
    measured: JsonObjectColumn(Schema.Record(Schema.String, Schema.Unknown)),
    suggested: NullableText,
    user_verdict: NullableText,
    observed_at: TimestampColumn,
});

export type StoredSkillPayload = Omit<typeof SkillPayloadRow.Type, "proposal">;
export type StoredSubagentPayload = Omit<typeof SubagentPayloadRow.Type, "proposal">;
export type StoredHookPayload = Omit<typeof HookPayloadRow.Type, "proposal">;
export type StoredGuidancePayload = Omit<typeof GuidancePayloadRow.Type, "proposal">;
export type StoredAutomationPayload = Omit<typeof AutomationPayloadRow.Type, "proposal">;
export type StoredCheckpoint = typeof CheckpointRow.Type;
export type StoredExperiment = typeof ExperimentRow.Type & {
    readonly checkpoints: ReadonlyArray<StoredCheckpoint>;
};
export type StoredProposal = typeof ProposalRow.Type & {
    readonly skill_payload: StoredSkillPayload | null;
    readonly subagent_payload: StoredSubagentPayload | null;
    readonly hook_payload: StoredHookPayload | null;
    readonly guidance_payload: StoredGuidancePayload | null;
    readonly automation_payload: StoredAutomationPayload | null;
    readonly experiment: StoredExperiment | null;
};

export interface ListStoredProposalOptions {
    readonly limit?: number;
    readonly status?: string;
    readonly dedupePrefixes?: ReadonlyArray<string>;
    readonly search?: string;
}

const withoutProposal = <T extends { readonly proposal: string }>(row: T): Omit<T, "proposal"> => {
    const { proposal: _proposal, ...payload } = row;
    return payload;
};

const byOwner = <T extends { readonly proposal: string }>(rows: ReadonlyArray<T>) =>
    new Map(rows.map((row) => [row.proposal, withoutProposal(row)]));

const loadDetails = (
    judgment: JudgmentService,
    proposals: ReadonlyArray<typeof ProposalRow.Type>,
): Effect.Effect<ReadonlyArray<StoredProposal>, JudgmentError> =>
    Effect.gen(function* () {
        if (proposals.length === 0) return [];
        const placeholders = proposals.map(() => "?").join(", ");
        const ids = proposals.map((proposal) => proposal.id);
        const [skills, subagents, hooks, guidance, automations, experiments] = yield* Effect.all([
            judgment.rows(SkillPayloadRow, `SELECT proposal, trigger_pattern, suspected_gap, proposed_behavior, expected_impact FROM skill_proposal WHERE proposal IN (${placeholders})`, ids),
            judgment.rows(SubagentPayloadRow, `SELECT proposal, bounded_role, delegation_trigger, example_task_patterns FROM subagent_proposal WHERE proposal IN (${placeholders})`, ids),
            judgment.rows(HookPayloadRow, `SELECT proposal, event_name, target_tool, hook_command, recovery_path, smoke_test_command, disable_command, failure_mode FROM hook_proposal WHERE proposal IN (${placeholders})`, ids),
            judgment.rows(GuidancePayloadRow, `SELECT proposal, file_target, section, suggested_text FROM guidance_proposal WHERE proposal IN (${placeholders})`, ids),
            judgment.rows(AutomationPayloadRow, `SELECT proposal, trigger_signal, schedule, action, recovery_path, smoke_test_command, disable_command, failure_mode FROM automation_proposal WHERE proposal IN (${placeholders})`, ids),
            judgment.rows(ExperimentRow, `SELECT id, proposal, artifact, artifact_path, scaffolded_at, created_at, locked_verdict, status, task_path FROM experiment WHERE proposal IN (${placeholders}) ORDER BY created_at DESC`, ids),
        ], { concurrency: 6 });

        const experimentIds = experiments.map((experiment) => experiment.id);
        const checkpoints = experimentIds.length === 0
            ? []
            : yield* judgment.rows(
                CheckpointRow,
                `SELECT id, experiment, kind, measured, suggested, user_verdict, observed_at
                 FROM checkpoint WHERE experiment IN (${experimentIds.map(() => "?").join(", ")})
                 ORDER BY observed_at ASC`,
                experimentIds,
            );
        const checkpointsByExperiment = new Map<string, StoredCheckpoint[]>();
        for (const checkpoint of checkpoints) {
            const group = checkpointsByExperiment.get(checkpoint.experiment) ?? [];
            group.push(checkpoint);
            checkpointsByExperiment.set(checkpoint.experiment, group);
        }
        const experimentByProposal = new Map<string, StoredExperiment>();
        for (const experiment of experiments) {
            if (experimentByProposal.has(experiment.proposal)) continue;
            experimentByProposal.set(experiment.proposal, {
                ...experiment,
                checkpoints: checkpointsByExperiment.get(experiment.id) ?? [],
            });
        }

        const skillByProposal = byOwner(skills);
        const subagentByProposal = byOwner(subagents);
        const hookByProposal = byOwner(hooks);
        const guidanceByProposal = byOwner(guidance);
        const automationByProposal = byOwner(automations);
        return proposals.map((proposal) => ({
            ...proposal,
            skill_payload: skillByProposal.get(proposal.id) ?? null,
            subagent_payload: subagentByProposal.get(proposal.id) ?? null,
            hook_payload: hookByProposal.get(proposal.id) ?? null,
            guidance_payload: guidanceByProposal.get(proposal.id) ?? null,
            automation_payload: automationByProposal.get(proposal.id) ?? null,
            experiment: experimentByProposal.get(proposal.id) ?? null,
        }));
    });

const BASE_COLUMNS = `id, form, title, hypothesis, dedupe_sig, frequency, confidence,
    status, origin, hypothesis_template, evidence_query, reject_reason, baseline,
    created_at, updated_at`;

export const listStoredProposals = (
    input: number | ListStoredProposalOptions = 100,
): Effect.Effect<ReadonlyArray<StoredProposal>, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const options = typeof input === "number" ? { limit: input } : input;
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (options.status !== undefined && options.status !== "all") {
            clauses.push("status = ?");
            params.push(options.status);
        }
        if (options.dedupePrefixes && options.dedupePrefixes.length > 0) {
            clauses.push(`(${options.dedupePrefixes.map(() => "dedupe_sig LIKE ?").join(" OR ")})`);
            params.push(...options.dedupePrefixes.map((prefix) => `${prefix}%`));
        }
        const search = options.search?.trim().toLowerCase();
        if (search) {
            clauses.push("(lower(title) LIKE ? OR lower(hypothesis) LIKE ?)");
            params.push(`%${search}%`, `%${search}%`);
        }
        const limit = Math.max(1, options.limit ?? 100);
        params.push(limit);
        const proposals = yield* judgment.rows(
            ProposalRow,
            `SELECT ${BASE_COLUMNS} FROM proposal
             ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
             ORDER BY coalesce(updated_at, created_at) DESC, frequency DESC LIMIT ?`,
            params,
        );
        return yield* loadDetails(judgment, proposals);
    });

export const findStoredProposal = (
    sigOrId: string,
): Effect.Effect<StoredProposal | null, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const id = sigOrId.replace(/^(proposal|experiment):/, "");
        const proposals = yield* judgment.rows(
            ProposalRow,
            `SELECT ${BASE_COLUMNS} FROM proposal
             WHERE dedupe_sig = ? OR id = ? OR id = (SELECT proposal FROM experiment WHERE id = ?)
             LIMIT 1`,
            [sigOrId, id, id],
        );
        return (yield* loadDetails(judgment, proposals))[0] ?? null;
    });

/**
 * The sidecar counterpart of `@ax/lib/duckdb/row`'s `cacheRow`: drop `undefined`
 * to `null` so an absent optional field binds SQL NULL instead of widening the
 * row's column set.
 *
 * It exists because the proposal derivations write the SAME row shapes they used
 * to write to the cache, and `put` keys on `id` in both seams - only the value
 * type differs. Without it every mined-proposal writer would hand-roll the same
 * loop, and one of them would forget and produce a ragged batch.
 */
export const judgmentRow = (
    fields: Readonly<Record<string, SidecarParam | undefined>>,
): Record<string, SidecarParam> => {
    const row: Record<string, SidecarParam> = {};
    for (const [key, value] of Object.entries(fields)) row[key] = value === undefined ? null : value;
    return row;
};
