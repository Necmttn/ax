import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { toolCallRecordKey, toolRecordKey } from "./record-keys.ts";
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
} from "../lib/shared/surql.ts";

export { recordRef } from "../lib/shared/surql.ts";

const STATEMENT_CHUNK_SIZE = 250;

type JsonInput = unknown;
type TimestampInput = Date | string;

export interface ToolCallWrite {
    readonly sessionId: string;
    readonly turnKey?: string | null;
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
    readonly skillName: string;
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

const toolIdentity = (provider: string, kind: string, name: string): string =>
    `${provider}:${kind}:${name}`;

const nonEmptyString = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
};

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

export function buildSkillPlaceholderStatements(skillName: string): string[] {
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
        statements.push(
            `DELETE plan_item WHERE plan = ${recordRef("plan", snapshot.planKey)} AND seq = ${item.seq.toString(10)} AND id != ${recordRef("plan_item", item.key)};`,
        );
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

const queryStatementsWithClient = (
    db: SurrealClientShape,
    statements: readonly string[],
): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
        if (statements.length === 0) return;

        for (let i = 0; i < statements.length; i += STATEMENT_CHUNK_SIZE) {
            yield* db.query(statements.slice(i, i + STATEMENT_CHUNK_SIZE).join(""));
        }
    });

const queryStatements = (
    statements: readonly string[],
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* queryStatementsWithClient(db, statements);
    });

const skillExists = (
    db: SurrealClientShape,
    skillName: string,
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
        yield* queryStatements(buildToolCallStatements(calls));
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
        yield* queryStatementsWithClient(db, [
            ...placeholderStatements,
            ...buildRelateToolCallSkillStatements(input),
        ]);
    });

export const writePlanSnapshot = (
    snapshot: PlanSnapshotWrite,
): Effect.Effect<{ items: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* queryStatements(buildPlanSnapshotStatements(snapshot));
        return { items: snapshot.items.length };
    });
