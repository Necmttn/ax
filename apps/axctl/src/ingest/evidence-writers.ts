import { Effect, Option, Schema } from "effect";
import type { SkillName } from "@ax/lib/brands";
import { skillRecordKey } from "@ax/lib/skill-id";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
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
    write: CacheWriteService,
    skillName: SkillName,
): Effect.Effect<boolean, CacheWriteError> =>
    Effect.gen(function* () {
        const row = yield* write.first(
            Schema.Struct({ id: Schema.String }),
            "SELECT id FROM skill WHERE id = ? LIMIT 1",
            [skillRecordKey(skillName)],
        );
        return Option.isSome(row);
    });

const toolAndCallRows = (calls: readonly ToolCallWrite[]): {
    readonly tools: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>;
    readonly calls: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>;
} => {
    const tools = new Map<string, Readonly<Record<string, DuckDbParam>>>();
    const rows: Array<Readonly<Record<string, DuckDbParam>>> = [];
    for (const call of calls) {
        const toolKey = toolRecordKey({ provider: call.provider, kind: call.toolKind, name: call.toolName });
        tools.set(toolKey, cacheRow({
            id: toolKey,
            name: call.toolName,
            provider: call.provider,
            identity: toolIdentity(call.provider, call.toolKind, call.toolName),
            kind: call.toolKind,
            updated_at: new Date(),
        }));
        const commandToolName = nonEmptyString(call.commandToolName);
        const commandToolKey = commandToolName === null
            ? null
            : toolRecordKey({ provider: "local", kind: "cli", name: commandToolName });
        if (commandToolName !== null && commandToolKey !== null) {
            tools.set(commandToolKey, cacheRow({
                id: commandToolKey,
                name: commandToolName,
                provider: "local",
                identity: toolIdentity("local", "cli", commandToolName),
                kind: "cli",
                updated_at: new Date(),
            }));
        }
        rows.push(cacheRow({
            id: toolCallRecordKey({ sessionId: call.sessionId, seq: call.seq, callId: call.callId ?? null }),
            session: call.sessionId,
            turn: call.turnKey ?? null,
            agent_event: call.agentEventKey ?? null,
            tool: toolKey,
            name: call.toolName,
            ts: tsParam(call.ts),
            status: call.hasError ? "error" : "ok",
            input_json: jsonParam(call.inputJson),
            output_json: jsonParam(call.outputJson),
            raw: jsonParam(call.rawJson),
            duration_ms: call.durationMs ?? null,
            seq: call.seq,
            call_id: call.callId ?? null,
            cwd: call.cwd ?? null,
            command_text: call.commandText ?? null,
            command_norm: call.commandNorm ?? null,
            command_tool: commandToolKey,
            output_excerpt: call.outputExcerpt ?? null,
            error_text: call.errorText ?? null,
            exit_code: call.exitCode ?? null,
            has_error: call.hasError,
        }));
    }
    return { tools: [...tools.values()], calls: rows };
};

export const writeToolFileEvidence = (
    write: CacheWriteService,
    evidence: readonly ToolFileEvidenceWrite[],
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        const files = new Map<string, Readonly<Record<string, DuckDbParam>>>();
        const edges = new Map<string, Array<Readonly<Record<string, DuckDbParam>>>>();
        for (const item of evidence) {
            const fileKey = toolEvidenceFileRecordKey(item.path);
            files.set(fileKey, cacheRow({ id: fileKey, repo: null, path: item.path, identity_scope: "local_path" }));
            if (item.kind === "edited") {
                if (!item.turnKey) continue;
                const row = cacheRow({
                    id: editedRelationRecordKey({ turnKey: item.turnKey, fileKey, tool: item.toolName }),
                    in_id: item.turnKey,
                    out_id: fileKey,
                    tool: item.toolName,
                    ts: tsParam(item.ts),
                    checkout: null,
                    path_seen: item.pathSeen ?? null,
                    absolute_path_seen: item.path,
                    edit_kind: item.editKind ?? null,
                });
                edges.set("edited", [...(edges.get("edited") ?? []), row]);
                continue;
            }
            const row = cacheRow({
                id: toolFileRelationRecordKey({ toolCallKey: item.toolCallKey, fileKey, kind: item.kind }),
                in_id: item.toolCallKey,
                out_id: fileKey,
                evidence: item.evidence ?? null,
                path_seen: item.pathSeen ?? null,
                absolute_path_seen: item.path,
                excerpt: item.excerpt ?? null,
                ts: tsParam(item.ts),
            });
            edges.set(item.kind, [...(edges.get(item.kind) ?? []), row]);
        }
        yield* write.putMany("file", [...files.values()]);
        for (const [table, rows] of edges) yield* write.putMany(table, rows);
    });

export const writeToolCalls = (
    write: CacheWriteService,
    calls: readonly ToolCallWrite[],
): Effect.Effect<{ count: number }, CacheWriteError> =>
    Effect.gen(function* () {
        const rows = toolAndCallRows(calls);
        yield* write.putMany("tool", rows.tools);
        yield* write.putMany("tool_call", rows.calls);
        return { count: calls.length };
    });

export const relateToolCallSkill = (
    write: CacheWriteService,
    input: ToolCallSkillRelationWrite,
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        const skillKey = skillRecordKey(input.skillName);
        if (!(yield* skillExists(write, input.skillName))) {
            yield* write.put("skill", cacheRow({
                id: skillKey,
                name: input.skillName,
                scope: "unknown",
                dir_path: "(unknown)",
                content_hash: "unknown",
            }));
        }
        const edgeKey = Bun.hash(`${input.toolCallKey}|${skillKey}|invoked_skill`)
            .toString(16)
            .padStart(16, "0");
        yield* write.put("concerns", cacheRow({
            id: edgeKey,
            in_id: input.toolCallKey,
            out_id: skillKey,
            in_table: "tool_call",
            out_table: "skill",
            kind: "invoked_skill",
            weight: null,
            reason: input.reason ?? null,
            labels: jsonParam(input.labels),
            metrics: jsonParam(input.metrics),
            ts: tsParam(input.ts),
        }));
    });

export const writePlanSnapshot = (
    write: CacheWriteService,
    snapshot: PlanSnapshotWrite,
): Effect.Effect<{ items: number }, CacheWriteError> =>
    Effect.gen(function* () {
        const summary = snapshotSummary(snapshot);
        const title = snapshot.source.trim().length > 0 ? `${snapshot.source} plan` : "agent plan";
        yield* write.put("plan", cacheRow({
            id: snapshot.planKey,
            session: snapshot.sessionId,
            source: snapshot.source,
            title,
            summary,
            status: snapshot.status,
            items: jsonParam(snapshot.itemsJson),
            created_at: tsParam(snapshot.createdAt),
            updated_at: tsParam(snapshot.updatedAt),
        }));
        yield* write.put("plan_snapshot", cacheRow({
            id: snapshot.snapshotKey,
            plan: snapshot.planKey,
            session: snapshot.sessionId,
            tool_call: snapshot.toolCallKey ?? null,
            agent_event: null,
            source: snapshot.source,
            items: jsonParam(snapshot.itemsJson),
            summary,
            explanation: snapshot.explanation ?? null,
            ts: tsParam(snapshot.ts),
        }));
        const lastSeenAt = snapshot.updatedAt ?? snapshot.ts;
        for (const item of snapshot.items) {
            if (snapshot.source === "claude_task" || snapshot.source === "claude_sidecar_task") {
                if (item.externalId?.trim()) {
                    yield* write.exec(
                        "DELETE FROM plan_item WHERE plan = ? AND external_id = ? AND id <> ?",
                        [snapshot.planKey, item.externalId, item.key],
                    );
                }
            } else {
                yield* write.exec("DELETE FROM plan_item WHERE plan = ? AND seq = ? AND id <> ?", [
                    snapshot.planKey,
                    item.seq,
                    item.key,
                ]);
            }
        }
        yield* write.putMany("plan_item", snapshot.items.map((item) => cacheRow({
            id: item.key,
            plan: snapshot.planKey,
            external_id: item.externalId ?? null,
            seq: item.seq,
            text: item.content,
            active_form: item.activeForm ?? null,
            status: item.status ?? null,
            raw: jsonParam(planItemRaw(item)),
            created_at: tsParam(snapshot.createdAt),
            updated_at: tsParam(snapshot.updatedAt),
            first_seen_at: tsParam(snapshot.createdAt),
            last_seen_at: tsParam(lastSeenAt),
        })));
        return { items: snapshot.items.length };
    });
