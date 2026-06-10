import { Effect } from "effect";
import { RecordId, SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import {
    recordRef,
    surrealDate,
    surrealObject,
    surrealSet,
    surrealString,
} from "@ax/lib/shared/surql";
import {
    agentEventRecordKey,
    buildAgentEventParentEdgeStatement,
    buildAgentEventStatements,
    buildAgentProviderStatements,
    type AgentEventParentEdgeWrite,
    type AgentEventWrite,
    type AgentProviderName,
    type AgentProviderWrite,
    type AgentSessionWrite,
} from "../provider-events.ts";
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildToolCallStatements,
    buildToolFileEvidenceStatements,
    type PlanSnapshotWrite,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
    type ToolFileEvidenceWrite,
} from "../evidence-writers.ts";
import { buildCompactionStatements, type CompactionWrite } from "../compaction.ts";
import { skillRecordKey } from "@ax/lib/skill-id";
import { invokedRelationRecordKey, turnRecordKey } from "../record-keys.ts";

export interface NormalizedSessionWrite {
    readonly id: string;
    readonly provider: AgentProviderName;
    readonly providerSessionId?: string | null;
    readonly project?: string | null;
    readonly cwd?: string | null;
    readonly title?: string | null;
    readonly model?: string | null;
    readonly sourcePath?: string | null;
    readonly rawFile?: string | null;
    readonly raw?: unknown;
    readonly labels?: unknown;
    readonly metrics?: unknown;
    readonly startedAt?: string | Date | null;
    readonly endedAt?: string | Date | null;
}

export interface NormalizedTurnAgentEventRef {
    readonly provider: AgentProviderName;
    readonly providerSessionId: string;
    readonly providerEventId?: string | null;
    readonly seq: number;
}

export interface NormalizedTurnWrite {
    readonly sessionId: string;
    readonly seq: number;
    readonly ts: string | Date;
    readonly role: string;
    readonly messageKind: string;
    readonly intentKind: string;
    readonly text: string | null;
    readonly textExcerpt: string | null;
    readonly hasToolUse: boolean;
    readonly hasError: boolean;
    readonly agentEvent?: NormalizedTurnAgentEventRef | null;
}

export interface NormalizedSyntheticSkillInvocationWrite {
    readonly sessionId: string;
    readonly seq: number;
    readonly ts: string | Date;
    readonly skillName: string;
    readonly args?: unknown;
    readonly turnHasError?: boolean;
    readonly turnIndex?: number;
    readonly skillScope?: string;
    readonly skillDirPath?: string;
    readonly skillContentHash?: string;
}

export interface NormalizedTranscriptBatch {
    readonly providers?: readonly AgentProviderWrite[];
    readonly sessions: readonly NormalizedSessionWrite[];
    readonly events?: readonly AgentEventWrite[];
    readonly turns: readonly NormalizedTurnWrite[];
    readonly toolCalls?: readonly ToolCallWrite[];
    readonly toolFileEvidence?: readonly ToolFileEvidenceWrite[];
    /** Cross-batch agent_event parent edges (streaming parsers resolve parents
     *  flushed in an earlier batch themselves; within-batch edges are derived
     *  by buildAgentEventStatements). */
    readonly agentEventParentEdges?: readonly AgentEventParentEdgeWrite[];
    readonly syntheticSkillInvocations?: readonly NormalizedSyntheticSkillInvocationWrite[];
    readonly toolCallSkillRelations?: readonly ToolCallSkillRelationWrite[];
    readonly planSnapshots?: readonly PlanSnapshotWrite[];
    readonly compactions?: readonly CompactionWrite[];
}

export interface BuildNormalizedTranscriptStatementsOptions {
    /** Forwarded to buildAgentEventStatements. Streaming parsers (codex) pass
     *  true on the FIRST batch per session, false afterwards. Default true. */
    readonly clearExisting?: boolean;
}

const optionalDate = (value: string | Date | null | undefined): Date | undefined => {
    if (value === null || value === undefined) return undefined;
    return value instanceof Date ? value : new Date(value);
};

const toAgentSession = (session: NormalizedSessionWrite): AgentSessionWrite => ({
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? session.id,
    axSessionId: session.id,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.project === undefined ? {} : { project: session.project }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.sourcePath === undefined && session.rawFile === undefined
        ? {}
        : { sourcePath: session.sourcePath ?? session.rawFile }),
    ...(session.raw === undefined ? {} : { raw: session.raw }),
    ...(session.labels === undefined ? {} : { labels: session.labels }),
    ...(session.metrics === undefined ? {} : { metrics: session.metrics }),
    ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
});

export const upsertNormalizedSessions = (
    sessions: readonly NormalizedSessionWrite[],
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* Effect.forEach(
            sessions,
            (session) =>
                db.upsert(new RecordId("session", session.id), {
                    project: session.project ?? undefined,
                    cwd: session.cwd ?? undefined,
                    model: session.model ?? undefined,
                    source: session.provider,
                    started_at: optionalDate(session.startedAt),
                    ended_at: optionalDate(session.endedAt),
                    raw_file: session.rawFile ?? session.sourcePath ?? undefined,
                }),
            { concurrency: 4, discard: true },
        );
    });

export const buildNormalizedTurnStatements = (
    turns: readonly NormalizedTurnWrite[],
): string[] =>
    turns.map((turn) => {
        const agentEventField = turn.agentEvent
            ? `agent_event: ${recordRef("agent_event", agentEventRecordKey(turn.agentEvent))}, `
            : "";
        return `UPSERT ${recordRef("turn", turnRecordKey(turn.sessionId, turn.seq))} CONTENT { session: ${recordRef("session", turn.sessionId)}, ${agentEventField}seq: ${turn.seq}, ts: ${surrealDate(turn.ts)}, role: ${surrealString(turn.role)}, message_kind: ${surrealString(turn.messageKind)}, intent_kind: ${surrealString(turn.intentKind)}, text: ${turn.text === null ? "NONE" : surrealString(turn.text)}, text_excerpt: ${turn.textExcerpt === null ? "NONE" : surrealString(turn.textExcerpt)}, has_tool_use: ${turn.hasToolUse}, has_error: ${turn.hasError} };`;
    });

export const buildNormalizedSyntheticSkillInvocationStatements = (
    invocations: readonly NormalizedSyntheticSkillInvocationWrite[],
): string[] => {
    if (invocations.length === 0) return [];

    const skills = new Map<string, NormalizedSyntheticSkillInvocationWrite>();
    for (const invocation of invocations) {
        if (!skills.has(invocation.skillName)) skills.set(invocation.skillName, invocation);
    }

    const skillStatements = [...skills.values()].map((invocation) =>
        `UPSERT ${recordRef("skill", skillRecordKey(invocation.skillName))} MERGE ${surrealObject([
            ["name", surrealString(invocation.skillName)],
            ["scope", surrealString(invocation.skillScope ?? "unknown")],
            ["dir_path", surrealString(invocation.skillDirPath ?? "(synthetic)")],
            ["content_hash", surrealString(invocation.skillContentHash ?? "synthetic")],
        ])};`
    );

    const invocationStatements = invocations.map((invocation) => {
        const turnKey = turnRecordKey(invocation.sessionId, invocation.seq);
        const skillKey = skillRecordKey(invocation.skillName);
        const args = JSON.stringify(invocation.args ?? {});
        const edgeKey = invokedRelationRecordKey({ turnKey, skillKey, args });

        return `RELATE ${recordRef("turn", turnKey)}->invoked:\`${edgeKey}\`->${recordRef("skill", skillKey)} SET ${surrealSet([
            ["session", recordRef("session", invocation.sessionId)],
            ["ts", surrealDate(invocation.ts)],
            ["args", surrealString(args)],
            ["turn_has_error", invocation.turnHasError ? "true" : "false"],
            ["turn_index", (invocation.turnIndex ?? invocation.seq).toString(10)],
        ])};`;
    });

    return [...skillStatements, ...invocationStatements];
};

export const buildNormalizedTranscriptStatements = (
    batch: NormalizedTranscriptBatch,
    options?: BuildNormalizedTranscriptStatementsOptions,
): string[] => [
    ...buildAgentProviderStatements(batch.providers ?? []),
    ...buildAgentEventStatements(
        { sessions: batch.sessions.map(toAgentSession), events: batch.events ?? [] },
        { clearExisting: options?.clearExisting ?? true },
    ),
    ...buildNormalizedTurnStatements(batch.turns),
    ...buildToolCallStatements(batch.toolCalls ?? []),
    ...buildToolFileEvidenceStatements(batch.toolFileEvidence ?? []),
    ...(batch.agentEventParentEdges ?? []).map(buildAgentEventParentEdgeStatement),
    ...buildNormalizedSyntheticSkillInvocationStatements(batch.syntheticSkillInvocations ?? []),
    ...(batch.toolCallSkillRelations ?? []).flatMap((relation) =>
        buildRelateToolCallSkillStatements(relation)
    ),
    ...(batch.planSnapshots ?? []).flatMap((snapshot) =>
        buildPlanSnapshotStatements(snapshot)
    ),
    ...buildCompactionStatements(batch.compactions ?? []),
];

export const writeNormalizedTranscriptBatch = (
    batch: NormalizedTranscriptBatch,
    options?: BuildNormalizedTranscriptStatementsOptions,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* upsertNormalizedSessions(batch.sessions);
        yield* executeStatements(buildNormalizedTranscriptStatements(batch, options), {
            chunkSize: 500,
        });
    });
