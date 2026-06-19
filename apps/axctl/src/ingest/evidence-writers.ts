import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { SkillName } from "@ax/lib/brands";
import type { DbError } from "@ax/lib/errors";
import { skillRecordKey } from "@ax/lib/skill-id";
import { executeStatements, executeStatementsWith } from "@ax/lib/shared/statement-exec";
import {
    editedRelationRecordKey,
    toolCallRecordKey,
    toolFileRelationRecordKey,
    toolRecordKey,
} from "./record-keys.ts";
import { localPathFileRecordKey } from "@ax/lib/ids";
import {
    surrealString,
    surrealDate,
    surrealObject,
    surrealSet,
    surrealOptionString,
    surrealOptionInt,
    surrealOptionDate,
    surrealOptionRecord,
    surrealJsonText,
    surrealJsonTextOption,
    recordRef,
} from "@ax/lib/shared/surql";
import { nonEmptyString } from "@ax/lib/shared/derive-keys";
import type { ToolFileEvidence } from "./tool-file-evidence.ts";

export { recordRef } from "@ax/lib/shared/surql";

type JsonInput = unknown;
type TimestampInput = Date | string;

export interface ToolCallWrite {
    readonly sessionId: string;
    readonly turnKey?: string | null;
    readonly agentEventKey?: string | null;
    readonly provider: string;
    readonly toolName: string;
    readonly toolKind: string;
    readonly seq: number;
    readonly callId?: string | null;
    readonly ts: TimestampInput;
    readonly cwd?: string | null;
    readonly inputJson?: JsonInput;
    readonly outputJson?: JsonInput;
    readonly rawJson?: JsonInput;
    readonly commandText?: string | null;
    readonly commandNorm?: string | null;
    readonly commandToolName?: string | null;
    readonly outputExcerpt?: string | null;
    readonly errorText?: string | null;
    readonly exitCode?: number | null;
    readonly durationMs?: number | null;
    readonly hasError: boolean;
}

export interface ToolCallSkillRelationWrite {
    readonly toolCallKey: string;
    readonly skillName: SkillName;
    readonly ts: TimestampInput;
    readonly labels?: JsonInput;
    readonly metrics?: JsonInput;
    readonly reason?: string | null;
}

export interface PlanSnapshotItemWrite {
    readonly key: string;
    readonly externalId?: string | null;
    readonly seq: number;
    readonly content: string;
    readonly activeForm?: string | null;
    readonly status?: string | null;
}

export interface PlanSnapshotWrite {
    readonly planKey: string;
    readonly sessionId: string;
    readonly source: string;
    readonly status: string;
    readonly createdAt: TimestampInput;
    readonly updatedAt?: TimestampInput | null;
    readonly snapshotKey: string;
    readonly toolCallKey?: string | null;
    readonly itemsJson: JsonInput;
    readonly explanation?: string | null;
    readonly ts: TimestampInput;
    readonly items: readonly PlanSnapshotItemWrite[];
}

export type ToolFileEvidenceWrite = ToolFileEvidence;

const toolIdentity = (provider: string, kind: string, name: string): string =>
    `${provider}:${kind}:${name}`;

const buildToolStatement = (input: {
    readonly key: string;
    readonly provider: string;
    readonly kind: string;
    readonly name: string;
}): string =>
    `UPSERT ${recordRef("tool", input.key)} MERGE ${surrealObject([
        ["name", surrealString(input.name)],
        ["provider", surrealOptionString(input.provider)],
        ["identity", surrealOptionString(toolIdentity(input.provider, input.kind, input.name))],
        ["kind", surrealOptionString(input.kind)],
        ["updated_at", "time::now()"],
    ])};`;

export function buildToolCallStatements(calls: readonly ToolCallWrite[]): string[] {
    const statements: string[] = [];
    const seenToolKeys = new Set<string>();

    for (const call of calls) {
        const toolKey = toolRecordKey({
            provider: call.provider,
            kind: call.toolKind,
            name: call.toolName,
        });

        if (!seenToolKeys.has(toolKey)) {
            seenToolKeys.add(toolKey);
            statements.push(
                buildToolStatement({
                    key: toolKey,
                    provider: call.provider,
                    kind: call.toolKind,
                    name: call.toolName,
                }),
            );
        }

        const commandToolName = nonEmptyString(call.commandToolName);
        let commandToolKey: string | null = null;
        if (commandToolName !== null) {
            commandToolKey = toolRecordKey({
                provider: "local",
                kind: "cli",
                name: commandToolName,
            });

            if (!seenToolKeys.has(commandToolKey)) {
                seenToolKeys.add(commandToolKey);
                statements.push(
                    buildToolStatement({
                        key: commandToolKey,
                        provider: "local",
                        kind: "cli",
                        name: commandToolName,
                    }),
                );
            }
        }

        const toolCallKey = toolCallRecordKey({
            sessionId: call.sessionId,
            seq: call.seq,
            callId: call.callId ?? null,
        });

        statements.push(
            `UPSERT ${recordRef("tool_call", toolCallKey)} CONTENT ${surrealObject([
                ["session", recordRef("session", call.sessionId)],
                ["turn", surrealOptionRecord("turn", call.turnKey)],
                ["agent_event", surrealOptionRecord("agent_event", call.agentEventKey)],
                ["tool", recordRef("tool", toolKey)],
                ["name", surrealString(call.toolName)],
                ["seq", call.seq.toString(10)],
                ["call_id", surrealOptionString(call.callId)],
                ["ts", surrealDate(call.ts)],
                ["status", surrealString(call.hasError ? "error" : "ok")],
                ["input_json", surrealJsonTextOption(call.inputJson)],
                ["output_json", surrealJsonTextOption(call.outputJson)],
                ["raw", surrealJsonTextOption(call.rawJson)],
                ["duration_ms", surrealOptionInt(call.durationMs)],
                ["cwd", surrealOptionString(call.cwd)],
                ["command_text", surrealOptionString(call.commandText)],
                ["command_norm", surrealOptionString(call.commandNorm)],
                ["command_tool", surrealOptionRecord("tool", commandToolKey)],
                ["output_excerpt", surrealOptionString(call.outputExcerpt)],
                ["error_text", surrealOptionString(call.errorText)],
                ["exit_code", surrealOptionInt(call.exitCode)],
                ["has_error", call.hasError ? "true" : "false"],
            ])};`,
        );
    }

    return statements;
}

export function buildRelateToolCallSkillStatements(
    input: ToolCallSkillRelationWrite,
): string[] {
    const skillKey = skillRecordKey(input.skillName);
    const toolCallRef = recordRef("tool_call", input.toolCallKey);
    const skillRef = recordRef("skill", skillKey);
    const edgeKey = Bun.hash(`${input.toolCallKey}|${skillKey}|invoked_skill`)
        .toString(16)
        .padStart(16, "0");

    return [
        `RELATE ${toolCallRef}->concerns:\`${edgeKey}\`->${skillRef} SET ${surrealSet([
            ["kind", surrealString("invoked_skill")],
            ["ts", surrealDate(input.ts)],
            ["labels", surrealJsonTextOption(input.labels)],
            ["metrics", surrealJsonTextOption(input.metrics)],
            ["reason", surrealOptionString(input.reason)],
        ])};`,
    ];
}

export function toolEvidenceFileRecordKey(path: string): string {
    // Canonical derivation lives in @ax/lib/ids so derive-time consumers
    // (fragility-cascade's namespace bridge) compute the SAME key.
    return localPathFileRecordKey(path);
}

export function buildToolFileEvidenceStatements(
    evidence: readonly ToolFileEvidenceWrite[],
): string[] {
    const statements: string[] = [];
    const seenFiles = new Set<string>();

    for (const item of evidence) {
        const fileKey = toolEvidenceFileRecordKey(item.path);
        if (!seenFiles.has(fileKey)) {
            seenFiles.add(fileKey);
            statements.push(
                `UPSERT ${recordRef("file", fileKey)} CONTENT ${surrealObject([
                    ["repo", "NONE"],
                    ["path", surrealString(item.path)],
                    ["identity_scope", surrealString("local_path")],
                ])};`,
            );
        }

        if (item.kind === "edited") {
            if (!item.turnKey) continue;
            const edgeKey = editedRelationRecordKey({
                turnKey: item.turnKey,
                fileKey,
                tool: item.toolName,
            });
            statements.push(
                `RELATE ${recordRef("turn", item.turnKey)}->edited:\`${edgeKey}\`->${recordRef("file", fileKey)} SET ${surrealSet([
                    ["tool", surrealString(item.toolName)],
                    ["ts", surrealDate(item.ts)],
                    ["path_seen", surrealOptionString(item.pathSeen)],
                    ["absolute_path_seen", surrealOptionString(item.path)],
                    ["edit_kind", surrealOptionString(item.editKind)],
                ])};`,
            );
            continue;
        }

        const edgeKey = toolFileRelationRecordKey({
            toolCallKey: item.toolCallKey,
            fileKey,
            kind: item.kind,
        });
        statements.push(
            `RELATE ${recordRef("tool_call", item.toolCallKey)}->${item.kind}:\`${edgeKey}\`->${recordRef("file", fileKey)} SET ${surrealSet([
                ["evidence", surrealOptionString(item.evidence)],
                ["path_seen", surrealOptionString(item.pathSeen)],
                ["absolute_path_seen", surrealOptionString(item.path)],
                ["excerpt", surrealOptionString(item.excerpt)],
                ["ts", surrealDate(item.ts)],
            ])};`,
        );
    }

    return statements;
}

export function buildSkillPlaceholderStatements(skillName: SkillName): string[] {
    const skillRef = recordRef("skill", skillRecordKey(skillName));

    return [
        `UPSERT ${skillRef} CONTENT ${surrealObject([
            ["name", surrealString(skillName)],
            ["scope", surrealString("unknown")],
            ["dir_path", surrealString("(unknown)")],
            ["content_hash", surrealString("unknown")],
        ])};`,
    ];
}

const planItemRaw = (item: PlanSnapshotItemWrite): Record<string, unknown> => ({
    key: item.key,
    externalId: item.externalId ?? null,
    seq: item.seq,
    content: item.content,
    activeForm: item.activeForm ?? null,
    status: item.status ?? null,
});

const snapshotSummary = (snapshot: PlanSnapshotWrite): string =>
    snapshot.explanation ??
    snapshot.items[0]?.content ??
    `${snapshot.items.length.toString(10)} plan items`;

const planItemDeleteStatement = (snapshot: PlanSnapshotWrite, item: PlanSnapshotItemWrite): string | null => {
    const itemRef = recordRef("plan_item", item.key);
    const planRef = recordRef("plan", snapshot.planKey);
    if (snapshot.source === "claude_task" || snapshot.source === "claude_sidecar_task") {
        if (item.externalId && item.externalId.trim().length > 0) {
            return `DELETE plan_item WHERE plan = ${planRef} AND external_id = ${surrealString(item.externalId)} AND id != ${itemRef};`;
        }
        return null;
    }
    return `DELETE plan_item WHERE plan = ${planRef} AND seq = ${item.seq.toString(10)} AND id != ${itemRef};`;
};

export function buildPlanSnapshotStatements(snapshot: PlanSnapshotWrite): string[] {
    const summary = snapshotSummary(snapshot);
    const title =
        snapshot.source.trim().length > 0 ? `${snapshot.source} plan` : "agent plan";
    const lastSeenAt = snapshot.updatedAt ?? snapshot.ts;

    const statements = [
        `UPSERT ${recordRef("plan", snapshot.planKey)} CONTENT ${surrealObject([
            ["session", recordRef("session", snapshot.sessionId)],
            ["source", surrealOptionString(snapshot.source)],
            ["title", surrealOptionString(title)],
            ["summary", surrealOptionString(summary)],
            ["status", surrealOptionString(snapshot.status)],
            ["items", surrealJsonText(snapshot.itemsJson)],
            ["created_at", surrealDate(snapshot.createdAt)],
            ["updated_at", surrealOptionDate(snapshot.updatedAt)],
        ])};`,
        `UPSERT ${recordRef("plan_snapshot", snapshot.snapshotKey)} CONTENT ${surrealObject([
            ["plan", recordRef("plan", snapshot.planKey)],
            ["session", recordRef("session", snapshot.sessionId)],
            ["tool_call", surrealOptionRecord("tool_call", snapshot.toolCallKey)],
            ["source", surrealOptionString(snapshot.source)],
            ["items", surrealJsonText(snapshot.itemsJson)],
            ["summary", surrealOptionString(summary)],
            ["explanation", surrealOptionString(snapshot.explanation)],
            ["ts", surrealDate(snapshot.ts)],
        ])};`,
    ];

    for (const item of snapshot.items) {
        const deleteStatement = planItemDeleteStatement(snapshot, item);
        if (deleteStatement) statements.push(deleteStatement);
        statements.push(
            `UPSERT ${recordRef("plan_item", item.key)} CONTENT ${surrealObject([
                ["plan", recordRef("plan", snapshot.planKey)],
                ["external_id", surrealOptionString(item.externalId)],
                ["seq", item.seq.toString(10)],
                ["text", surrealString(item.content)],
                ["active_form", surrealOptionString(item.activeForm)],
                ["status", surrealOptionString(item.status)],
                ["raw", surrealJsonText(planItemRaw(item))],
                ["created_at", surrealDate(snapshot.createdAt)],
                ["updated_at", surrealOptionDate(snapshot.updatedAt)],
                ["first_seen_at", surrealDate(snapshot.createdAt)],
                ["last_seen_at", surrealDate(lastSeenAt)],
            ])};`,
        );
    }

    return statements;
}

const skillExists = (
    db: SurrealClientShape,
    skillName: SkillName,
): Effect.Effect<boolean, DbError> =>
    Effect.gen(function* () {
        const skillRef = recordRef("skill", skillRecordKey(skillName));
        const result = yield* db.query<[unknown[]]>(`SELECT VALUE id FROM ${skillRef};`);
        return (result[0] ?? []).length > 0;
    });

export const writeToolCalls = (
    calls: readonly ToolCallWrite[],
): Effect.Effect<{ count: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* executeStatements(buildToolCallStatements(calls));
        return { count: calls.length };
    });

export const relateToolCallSkill = (
    input: ToolCallSkillRelationWrite,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const placeholderStatements = (yield* skillExists(db, input.skillName))
            ? []
            : buildSkillPlaceholderStatements(input.skillName);
        yield* executeStatementsWith(db, [
            ...placeholderStatements,
            ...buildRelateToolCallSkillStatements(input),
        ]);
    });

export const writePlanSnapshot = (
    snapshot: PlanSnapshotWrite,
): Effect.Effect<{ items: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* executeStatements(buildPlanSnapshotStatements(snapshot));
        return { items: snapshot.items.length };
    });
