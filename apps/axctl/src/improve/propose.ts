import { Effect, Schema } from "effect";
import { Judgment } from "@ax/lib/sqlite";
import { stableId } from "@ax/lib/stable-id";
import { dedupeSig, migrateProposalDedupeSigs, normalizeTitle } from "../ingest/derive-proposals.ts";

/**
 * `ax improve propose` - the agent write-path into the improve loop.
 *
 * An analysis agent (see analyze-brief.ts) mines the graph and emits one
 * JSON proposal per durable pattern; this module validates it, dedupes by
 * `dedupe_sig(form, normalized title)`, and writes:
 *   - fresh sig    -> CREATE proposal with origin 'agent' + status 'open'
 *   - existing sig -> frequency bump + hypothesis/confidence refresh
 * The per-form payload row is UPSERT-ed in both paths (mirrors the retro
 * derivation writer in ingest/derive-retro-proposals.ts).
 */

const common = {
    title: Schema.String,
    hypothesis: Schema.String,
    confidence: Schema.Literals(["high", "medium", "low"]),
    frequency: Schema.optional(Schema.Int),
    evidence: Schema.optional(Schema.String),
    /** hypothesis with {{placeholders}} hydrated at serve time - numbers stay live */
    hypothesis_template: Schema.optional(Schema.String),
    /** read-only DuckDB SELECT whose first row fills the template */
    evidence_query: Schema.optional(Schema.String),
};

const SkillPayload = Schema.Struct({
    trigger_pattern: Schema.String,
    suspected_gap: Schema.String,
    proposed_behavior: Schema.String,
    expected_impact: Schema.optional(Schema.String),
});

const SubagentPayload = Schema.Struct({
    bounded_role: Schema.String,
    delegation_trigger: Schema.String,
    example_task_patterns: Schema.optional(Schema.Array(Schema.String)),
});

const safety = {
    recovery_path: Schema.optional(Schema.String),
    smoke_test_command: Schema.optional(Schema.String),
    disable_command: Schema.optional(Schema.String),
    failure_mode: Schema.optional(Schema.Literals(["fail_open", "fail_closed"])),
};

const HookPayload = Schema.Struct({
    event_name: Schema.String,
    target_tool: Schema.optional(Schema.String),
    hook_command: Schema.String,
    ...safety,
});

const GuidancePayload = Schema.Struct({
    file_target: Schema.String,
    section: Schema.optional(Schema.String),
    suggested_text: Schema.String,
});

const AutomationPayload = Schema.Struct({
    trigger_signal: Schema.String,
    schedule: Schema.optional(Schema.String),
    action: Schema.String,
    ...safety,
});

export const ProposeInputSchema = Schema.Union([
    Schema.Struct({ form: Schema.Literal("skill"), ...common, payload: SkillPayload }),
    Schema.Struct({ form: Schema.Literal("subagent"), ...common, payload: SubagentPayload }),
    Schema.Struct({ form: Schema.Literal("hook"), ...common, payload: HookPayload }),
    Schema.Struct({ form: Schema.Literal("guidance"), ...common, payload: GuidancePayload }),
    Schema.Struct({ form: Schema.Literal("automation"), ...common, payload: AutomationPayload }),
]);

export type ProposeInput = typeof ProposeInputSchema.Type;

export interface ProposeResult {
    readonly status: "created" | "bumped";
    readonly sig: string;
    readonly form: ProposeInput["form"];
    readonly title: string;
}

/**
 * Stable record key derived from the sig - same row on re-propose. Exported so
 * callers that must reference the written proposal (e.g. `ax retro emit`
 * relating a filed proposal back to its retro) address the same record instead
 * of rebuilding the prefix.
 */
export const proposalKey = (sig: string): string => stableId("proposal", [sig]);

const PAYLOAD_TABLE: Record<ProposeInput["form"], string> = {
    skill: "skill_proposal",
    subagent: "subagent_proposal",
    hook: "hook_proposal",
    guidance: "guidance_proposal",
    automation: "automation_proposal",
};

const payloadRow = (input: ProposeInput): Readonly<Record<string, string | null>> => {
    switch (input.form) {
        case "skill":
            return {
                trigger_pattern: input.payload.trigger_pattern,
                suspected_gap: input.payload.suspected_gap,
                proposed_behavior: input.payload.proposed_behavior,
                expected_impact: input.payload.expected_impact ?? null,
            };
        case "subagent":
            return {
                bounded_role: input.payload.bounded_role,
                delegation_trigger: input.payload.delegation_trigger,
                example_task_patterns: JSON.stringify(input.payload.example_task_patterns ?? []),
            };
        case "hook":
            return {
                event_name: input.payload.event_name,
                target_tool: input.payload.target_tool ?? null,
                hook_command: input.payload.hook_command,
                recovery_path: input.payload.recovery_path ?? null,
                smoke_test_command: input.payload.smoke_test_command ?? null,
                disable_command: input.payload.disable_command ?? null,
                failure_mode: input.payload.failure_mode ?? null,
            };
        case "guidance":
            return {
                file_target: input.payload.file_target,
                section: input.payload.section ?? null,
                suggested_text: input.payload.suggested_text,
            };
        case "automation":
            return {
                trigger_signal: input.payload.trigger_signal,
                schedule: input.payload.schedule ?? null,
                action: input.payload.action,
                recovery_path: input.payload.recovery_path ?? null,
                smoke_test_command: input.payload.smoke_test_command ?? null,
                disable_command: input.payload.disable_command ?? null,
                failure_mode: input.payload.failure_mode ?? null,
            };
    }
};

export const decodeProposeInput = (raw: unknown) =>
    Schema.decodeUnknownEffect(ProposeInputSchema)(raw);

export class ImproveProposeInputError extends Schema.TaggedErrorClass<ImproveProposeInputError>(
    "ImproveProposeInputError",
)("ImproveProposeInputError", {
    message: Schema.String,
}) {}

/** Evidence hydration runs against the DuckDB cache, so only SQL SELECT is valid. */
export const isReadOnlyEvidenceQuery = (sql: string): boolean =>
    /^SELECT\b/i.test(sql.trim());

export const runPropose = Effect.fn("improve.runPropose")(function* (raw: unknown) {
    const input = yield* decodeProposeInput(raw);
    if (input.evidence_query !== undefined && !isReadOnlyEvidenceQuery(input.evidence_query)) {
        return yield* new ImproveProposeInputError({
            message: "evidence_query must be a read-only SELECT statement",
        });
    }
    if ((input.hypothesis_template === undefined) !== (input.evidence_query === undefined)) {
        return yield* new ImproveProposeInputError({
            message: "hypothesis_template and evidence_query must be provided together",
        });
    }
    const sig = dedupeSig(input.form, normalizeTitle(input.title));
    const judgment = yield* Judgment;
    yield* migrateProposalDedupeSigs(judgment);
    const id = proposalKey(sig);
    const frequency = input.frequency ?? 1;
    const now = new Date();
    const baseline = JSON.stringify({ origin: "agent", evidence: input.evidence ?? null, frequency });
    const isNew = yield* judgment.transaction((transaction) =>
        Effect.gen(function* () {
            const existing = yield* transaction.raw(
                "SELECT id FROM proposal WHERE dedupe_sig = ? LIMIT 1",
                [sig],
            );
            const fresh = existing.length === 0;
            if (fresh) {
                yield* transaction.put("proposal", {
                    id,
                    form: input.form,
                    title: input.title,
                    hypothesis: input.hypothesis,
                    dedupe_sig: sig,
                    frequency,
                    confidence: input.confidence,
                    status: "open",
                    origin: "agent",
                    hypothesis_template: input.hypothesis_template ?? null,
                    evidence_query: input.evidence_query ?? null,
                    reject_reason: null,
                    baseline,
                    created_at: now,
                    updated_at: now,
                });
            } else {
                yield* transaction.exec(
                    "UPDATE proposal SET hypothesis = ?, frequency = frequency + 1, confidence = ?, updated_at = ? WHERE dedupe_sig = ?",
                    [input.hypothesis, input.confidence, now, sig],
                );
            }
            const payloadTable = PAYLOAD_TABLE[input.form];
            yield* transaction.put(payloadTable, {
                id: stableId(payloadTable, [id]),
                proposal: id,
                ...payloadRow(input),
            });
            return fresh;
        }),
    );
    return {
        status: isNew ? "created" : "bumped",
        sig,
        form: input.form,
        title: input.title,
    } satisfies ProposeResult;
});
