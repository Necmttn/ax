import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import {
    recordRef,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import { dedupeSig, normalizeTitle } from "../ingest/derive-proposals.ts";

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

/** Stable record key derived from the sig - same row on re-propose. */
const proposalKey = (sig: string): string => `agent__${sig}`;

const PAYLOAD_TABLE: Record<ProposeInput["form"], string> = {
    skill: "skill_proposal",
    subagent: "subagent_proposal",
    hook: "hook_proposal",
    guidance: "guidance_proposal",
    automation: "automation_proposal",
};

const opt = (v: string | undefined): string => surrealOptionString(v ?? null);

const payloadFields = (input: ProposeInput): ReadonlyArray<readonly [string, string]> => {
    switch (input.form) {
        case "skill":
            return [
                ["trigger_pattern", surrealString(input.payload.trigger_pattern)],
                ["suspected_gap", surrealString(input.payload.suspected_gap)],
                ["proposed_behavior", surrealString(input.payload.proposed_behavior)],
                ["expected_impact", opt(input.payload.expected_impact)],
            ];
        case "subagent":
            return [
                ["bounded_role", surrealString(input.payload.bounded_role)],
                ["delegation_trigger", surrealString(input.payload.delegation_trigger)],
                [
                    "example_task_patterns",
                    `[${(input.payload.example_task_patterns ?? []).map(surrealString).join(", ")}]`,
                ],
            ];
        case "hook":
            return [
                ["event_name", surrealString(input.payload.event_name)],
                ["target_tool", opt(input.payload.target_tool)],
                ["hook_command", surrealString(input.payload.hook_command)],
                ["recovery_path", opt(input.payload.recovery_path)],
                ["smoke_test_command", opt(input.payload.smoke_test_command)],
                ["disable_command", opt(input.payload.disable_command)],
                ["failure_mode", opt(input.payload.failure_mode)],
            ];
        case "guidance":
            return [
                ["file_target", surrealString(input.payload.file_target)],
                ["section", opt(input.payload.section)],
                ["suggested_text", surrealString(input.payload.suggested_text)],
            ];
        case "automation":
            return [
                ["trigger_signal", surrealString(input.payload.trigger_signal)],
                ["schedule", opt(input.payload.schedule)],
                ["action", surrealString(input.payload.action)],
                ["recovery_path", opt(input.payload.recovery_path)],
                ["smoke_test_command", opt(input.payload.smoke_test_command)],
                ["disable_command", opt(input.payload.disable_command)],
                ["failure_mode", opt(input.payload.failure_mode)],
            ];
    }
};

/** Pure statement builder - testable without a DB. */
export const buildProposeStatements = (
    input: ProposeInput,
    sig: string,
    isNew: boolean,
): string[] => {
    const key = proposalKey(sig);
    const proposalRef = recordRef("proposal", key);
    const payloadRef = recordRef(PAYLOAD_TABLE[input.form], key);
    const frequency = input.frequency ?? 1;
    const baseline = JSON.stringify({
        origin: "agent",
        evidence: input.evidence ?? null,
        frequency,
    });

    const stmts: string[] = [];
    if (isNew) {
        stmts.push(
            `CREATE ${proposalRef} CONTENT ${surrealObject([
                ["form", surrealString(input.form)],
                ["title", surrealString(input.title)],
                ["hypothesis", surrealString(input.hypothesis)],
                ["dedupe_sig", surrealString(sig)],
                ["frequency", String(frequency)],
                ["confidence", surrealString(input.confidence)],
                ["status", surrealString("open")],
                ["origin", surrealString("agent")],
                ["baseline", surrealOptionString(baseline)],
                ["updated_at", "time::now()"],
            ])};`,
        );
    } else {
        stmts.push(
            `UPDATE proposal SET ${[
                ["hypothesis", surrealString(input.hypothesis)],
                ["frequency", "frequency + 1"],
                ["confidence", surrealString(input.confidence)],
                ["updated_at", "time::now()"],
            ]
                .map(([name, value]) => `${name} = ${value}`)
                .join(", ")} WHERE dedupe_sig = ${surrealString(sig)};`,
        );
    }
    stmts.push(
        `UPSERT ${payloadRef} MERGE ${surrealObject([
            ["proposal", proposalRef],
            ...payloadFields(input),
        ])};`,
    );
    return stmts;
};

export const decodeProposeInput = (raw: unknown) =>
    Schema.decodeUnknownEffect(ProposeInputSchema)(raw);

export const runPropose = Effect.fn("improve.runPropose")(function* (raw: unknown) {
    const input = yield* decodeProposeInput(raw);
    const sig = dedupeSig(input.form, normalizeTitle(input.title));
    const db = yield* SurrealClient;
    const existing = yield* db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM proposal WHERE dedupe_sig = ${surrealString(sig)} LIMIT 1;`,
    );
    const isNew = (existing[0] ?? []).length === 0;
    for (const stmt of buildProposeStatements(input, sig, isNew)) {
        yield* db.query(stmt);
    }
    return {
        status: isNew ? "created" : "bumped",
        sig,
        form: input.form,
        title: input.title,
    } satisfies ProposeResult;
});
