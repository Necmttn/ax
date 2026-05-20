import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { toolCallRecordKey, toolRecordKey } from "./record-keys.ts";
import { surrealString } from "../lib/shared/surql.ts";

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

const sqlString = surrealString;

const sqlOptionString = (value: string | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlString(value);

const sqlOptionInt = (value: number | null | undefined): string => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "NONE";
    }

    return Math.trunc(value).toString(10);
};

const sqlDate = (value: TimestampInput): string => {
    const iso = value instanceof Date ? value.toISOString() : value;
    return `d${JSON.stringify(iso)}`;
};

const sqlOptionDate = (value: TimestampInput | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlDate(value);

const escapeRecordKey = (key: string): string =>
    key
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");

export const recordRef = (table: string, key: string): string =>
    `${table}:\`${escapeRecordKey(key)}\``;

const sqlOptionRecord = (
    table: string,
    key: string | null | undefined,
): string => (key === null || key === undefined ? "NONE" : recordRef(table, key));

const encodeJsonText = (value: JsonInput): string => {
    if (typeof value === "string") return value;

    return JSON.stringify(value) ?? "null";
};

const sqlJsonString = (value: JsonInput): string => sqlString(encodeJsonText(value));

const sqlJsonOption = (value: JsonInput | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlJsonString(value);

const sqlObject = (fields: readonly (readonly [string, string])[]): string =>
    `{ ${fields.map(([name, value]) => `${name}: ${value}`).join(", ")} }`;

const sqlSet = (fields: readonly (readonly [string, string])[]): string =>
    fields.map(([name, value]) => `${name} = ${value}`).join(", ");

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
    `UPSERT ${recordRef("tool", input.key)} MERGE ${sqlObject([
        ["name", sqlString(input.name)],
        ["provider", sqlOptionString(input.provider)],
        ["identity", sqlOptionString(toolIdentity(input.provider, input.kind, input.name))],
        ["kind", sqlOptionString(input.kind)],
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
            `UPSERT ${recordRef("tool_call", toolCallKey)} CONTENT ${sqlObject([
                ["session", recordRef("session", call.sessionId)],
                ["turn", sqlOptionRecord("turn", call.turnKey)],
                ["tool", recordRef("tool", toolKey)],
                ["name", sqlString(call.toolName)],
                ["seq", call.seq.toString(10)],
                ["call_id", sqlOptionString(call.callId)],
                ["ts", sqlDate(call.ts)],
                ["status", sqlString(call.hasError ? "error" : "ok")],
                ["input_json", sqlJsonOption(call.inputJson)],
                ["output_json", sqlJsonOption(call.outputJson)],
                ["raw", sqlJsonOption(call.rawJson)],
                ["duration_ms", sqlOptionInt(call.durationMs)],
                ["cwd", sqlOptionString(call.cwd)],
                ["command_text", sqlOptionString(call.commandText)],
                ["command_norm", sqlOptionString(call.commandNorm)],
                ["command_tool", sqlOptionRecord("tool", commandToolKey)],
                ["output_excerpt", sqlOptionString(call.outputExcerpt)],
                ["error_text", sqlOptionString(call.errorText)],
                ["exit_code", sqlOptionInt(call.exitCode)],
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
        `RELATE ${toolCallRef}->concerns:\`${edgeKey}\`->${skillRef} SET ${sqlSet([
            ["kind", sqlString("invoked_skill")],
            ["ts", sqlDate(input.ts)],
            ["labels", sqlJsonOption(input.labels)],
            ["metrics", sqlJsonOption(input.metrics)],
            ["reason", sqlOptionString(input.reason)],
        ])};`,
    ];
}

export function buildSkillPlaceholderStatements(skillName: string): string[] {
    const skillRef = recordRef("skill", skillRecordKey(skillName));

    return [
        `UPSERT ${skillRef} CONTENT ${sqlObject([
            ["name", sqlString(skillName)],
            ["scope", sqlString("unknown")],
            ["dir_path", sqlString("(unknown)")],
            ["content_hash", sqlString("unknown")],
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
        `UPSERT ${recordRef("plan", snapshot.planKey)} CONTENT ${sqlObject([
            ["session", recordRef("session", snapshot.sessionId)],
            ["source", sqlOptionString(snapshot.source)],
            ["title", sqlOptionString(title)],
            ["summary", sqlOptionString(summary)],
            ["status", sqlOptionString(snapshot.status)],
            ["items", sqlJsonString(snapshot.itemsJson)],
            ["created_at", sqlDate(snapshot.createdAt)],
            ["updated_at", sqlOptionDate(snapshot.updatedAt)],
        ])};`,
        `UPSERT ${recordRef("plan_snapshot", snapshot.snapshotKey)} CONTENT ${sqlObject([
            ["plan", recordRef("plan", snapshot.planKey)],
            ["session", recordRef("session", snapshot.sessionId)],
            ["tool_call", sqlOptionRecord("tool_call", snapshot.toolCallKey)],
            ["source", sqlOptionString(snapshot.source)],
            ["items", sqlJsonString(snapshot.itemsJson)],
            ["summary", sqlOptionString(summary)],
            ["explanation", sqlOptionString(snapshot.explanation)],
            ["ts", sqlDate(snapshot.ts)],
        ])};`,
    ];

    for (const item of snapshot.items) {
        statements.push(
            `DELETE plan_item WHERE plan = ${recordRef("plan", snapshot.planKey)} AND seq = ${item.seq.toString(10)} AND id != ${recordRef("plan_item", item.key)};`,
        );
        statements.push(
            `UPSERT ${recordRef("plan_item", item.key)} CONTENT ${sqlObject([
                ["plan", recordRef("plan", snapshot.planKey)],
                ["external_id", sqlOptionString(item.externalId)],
                ["seq", item.seq.toString(10)],
                ["text", sqlString(item.content)],
                ["active_form", sqlOptionString(item.activeForm)],
                ["status", sqlOptionString(item.status)],
                ["raw", sqlJsonString(planItemRaw(item))],
                ["created_at", sqlDate(snapshot.createdAt)],
                ["updated_at", sqlOptionDate(snapshot.updatedAt)],
                ["first_seen_at", sqlDate(snapshot.createdAt)],
                ["last_seen_at", sqlDate(lastSeenAt)],
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
