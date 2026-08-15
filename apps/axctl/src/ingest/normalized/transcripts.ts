import { Effect } from "effect";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
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
    writeAgentEvents,
    writeAgentProviders,
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
    relateToolCallSkill,
    writePlanSnapshot,
    writeToolCalls,
    writeToolFileEvidence,
} from "../evidence-writers.ts";
import { buildCompactionStatements, type CompactionWrite } from "../compaction.ts";
import type { SkillName } from "@ax/lib/brands";
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
    /** Thinking content-block count for assistant turns; omitted when the
     *  provider has no thinking representation (codex effort lives on the
     *  session instead). */
    readonly thinkingBlocks?: number | null;
    /** output_tokens of thinking-only assistant turns (transcripts strip
     *  thinking text, so the event's own usage is the signal). */
    readonly thinkingTokens?: number | null;
    readonly agentEvent?: NormalizedTurnAgentEventRef | null;
}

export interface NormalizedSyntheticSkillInvocationWrite {
    readonly sessionId: string;
    readonly seq: number;
    readonly ts: string | Date;
    readonly skillName: SkillName;
    readonly args?: unknown;
    readonly turnHasError?: boolean;
    readonly turnIndex?: number;
    readonly skillScope?: string;
    readonly skillDirPath?: string;
    readonly skillContentHash?: string;
    /**
     * How to write the `skill` row this invocation points at.
     *
     * `"merge"` (default, and the only pre-#746 behavior) overwrites
     * scope/dir_path/content_hash - correct for SYNTHETIC provider-tool skills,
     * which this batch is the sole author of.
     *
     * `"if_missing"` creates the row only when absent and leaves an existing
     * one untouched. Required when the invocation names a REAL catalog skill
     * (OpenCode's `skill` tool loads one by name): merging would stamp the
     * on-disk skill with `dir_path = "(opencode)"`, and every view that
     * excludes synthetic rows would then drop a genuine skill.
     */
    readonly skillUpsert?: "merge" | "if_missing";
}

/**
 * Every array field is REQUIRED: a parser with no such data passes an
 * explicit empty array, so "this provider emits none of X" is a visible
 * decision at each `to*NormalizedBatch` converter rather than an implicit
 * `?? []` fallback inside the seam.
 */
export interface NormalizedTranscriptBatch {
    readonly providers: readonly AgentProviderWrite[];
    readonly sessions: readonly NormalizedSessionWrite[];
    readonly events: readonly AgentEventWrite[];
    readonly turns: readonly NormalizedTurnWrite[];
    readonly toolCalls: readonly ToolCallWrite[];
    readonly toolFileEvidence: readonly ToolFileEvidenceWrite[];
    /** Cross-batch agent_event parent edges (streaming parsers resolve parents
     *  flushed in an earlier batch themselves; within-batch edges are derived
     *  by buildAgentEventStatements). */
    readonly agentEventParentEdges: readonly AgentEventParentEdgeWrite[];
    readonly syntheticSkillInvocations: readonly NormalizedSyntheticSkillInvocationWrite[];
    readonly toolCallSkillRelations: readonly ToolCallSkillRelationWrite[];
    readonly planSnapshots: readonly PlanSnapshotWrite[];
    readonly compactions: readonly CompactionWrite[];
}

export interface BuildNormalizedTranscriptStatementsOptions {
    /** Forwarded to buildAgentEventStatements. Streaming parsers (codex) pass
     *  true on the FIRST batch per session, false afterwards. Default true. */
    readonly clearExisting?: boolean;
}

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
    write: CacheWriteService,
    sessions: readonly NormalizedSessionWrite[],
): Effect.Effect<void, CacheWriteError> =>
    write.putMany("session", sessions.map((session) => cacheRow({
        id: session.id,
        project: session.project ?? null,
        cwd: session.cwd ?? null,
        model: session.model ?? null,
        reasoning_effort: null,
        source: session.provider,
        started_at: tsParam(session.startedAt),
        ended_at: tsParam(session.endedAt),
        raw_file: session.rawFile ?? session.sourcePath ?? null,
        labels: jsonParam(session.labels),
        repository: null,
        checkout: null,
        workspace: null,
    })));

export const buildNormalizedTurnStatements = (
    turns: readonly NormalizedTurnWrite[],
): string[] =>
    turns.map((turn) => {
        const agentEventField = turn.agentEvent
            ? `agent_event: ${recordRef("agent_event", agentEventRecordKey(turn.agentEvent))}, `
            : "";
        const thinkingFields =
            turn.thinkingBlocks === undefined || turn.thinkingBlocks === null
                ? ""
                : `, thinking_blocks: ${Math.trunc(turn.thinkingBlocks)}, thinking_tokens: ${Math.trunc(turn.thinkingTokens ?? 0)}`;
        return `UPSERT ${recordRef("turn", turnRecordKey(turn.sessionId, turn.seq))} CONTENT { session: ${recordRef("session", turn.sessionId)}, ${agentEventField}seq: ${turn.seq}, ts: ${surrealDate(turn.ts)}, role: ${surrealString(turn.role)}, message_kind: ${surrealString(turn.messageKind)}, intent_kind: ${surrealString(turn.intentKind)}, text: ${turn.text === null ? "NONE" : surrealString(turn.text)}, text_excerpt: ${turn.textExcerpt === null ? "NONE" : surrealString(turn.textExcerpt)}, has_tool_use: ${turn.hasToolUse}, has_error: ${turn.hasError}${thinkingFields} };`;
    });

export const buildNormalizedSyntheticSkillInvocationStatements = (
    invocations: readonly NormalizedSyntheticSkillInvocationWrite[],
): string[] => {
    if (invocations.length === 0) return [];

    const skills = new Map<string, NormalizedSyntheticSkillInvocationWrite>();
    for (const invocation of invocations) {
        if (!skills.has(invocation.skillName)) skills.set(invocation.skillName, invocation);
    }

    const skillStatements = [...skills.values()].map((invocation) => {
        const ref = recordRef("skill", skillRecordKey(invocation.skillName));
        const fields: ReadonlyArray<readonly [string, string]> = [
            ["name", surrealString(invocation.skillName)],
            ["scope", surrealString(invocation.skillScope ?? "unknown")],
            ["dir_path", surrealString(invocation.skillDirPath ?? "(synthetic)")],
            ["content_hash", surrealString(invocation.skillContentHash ?? "synthetic")],
        ];
        if (invocation.skillUpsert === "if_missing") {
            // Create-if-absent, never clobber: `ON DUPLICATE KEY UPDATE name =
            // name` is a no-op on an existing row, so a catalog skill keeps its
            // real scope/dir_path/content_hash (#746).
            return `INSERT INTO skill ${surrealObject([["id", ref], ...fields])} ON DUPLICATE KEY UPDATE name = name;`;
        }
        return `UPSERT ${ref} MERGE ${surrealObject(fields)};`;
    });

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
    ...buildAgentProviderStatements(batch.providers),
    ...buildAgentEventStatements(
        { sessions: batch.sessions.map(toAgentSession), events: batch.events },
        { clearExisting: options?.clearExisting ?? true },
    ),
    ...buildNormalizedTurnStatements(batch.turns),
    ...buildToolCallStatements(batch.toolCalls),
    ...buildToolFileEvidenceStatements(batch.toolFileEvidence),
    ...batch.agentEventParentEdges.map(buildAgentEventParentEdgeStatement),
    ...buildNormalizedSyntheticSkillInvocationStatements(batch.syntheticSkillInvocations),
    ...batch.toolCallSkillRelations.flatMap((relation) =>
        buildRelateToolCallSkillStatements(relation)
    ),
    ...batch.planSnapshots.flatMap((snapshot) =>
        buildPlanSnapshotStatements(snapshot)
    ),
    ...buildCompactionStatements(batch.compactions),
];

export const writeNormalizedTranscriptBatch = (
    write: CacheWriteService,
    batch: NormalizedTranscriptBatch,
    options?: BuildNormalizedTranscriptStatementsOptions,
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        yield* upsertNormalizedSessions(write, batch.sessions);
        yield* writeAgentProviders(write, batch.providers);
        yield* writeAgentEvents(
            write,
            { sessions: batch.sessions.map(toAgentSession), events: batch.events },
            { clearExisting: options?.clearExisting ?? true },
        );
        yield* write.putMany("turn", batch.turns.map((turn) => cacheRow({
            id: turnRecordKey(turn.sessionId, turn.seq),
            session: turn.sessionId,
            agent_event: turn.agentEvent ? agentEventRecordKey(turn.agentEvent) : null,
            seq: turn.seq,
            ts: tsParam(turn.ts),
            role: turn.role,
            message_kind: turn.messageKind,
            intent_kind: turn.intentKind,
            text: turn.text,
            text_excerpt: turn.textExcerpt,
            has_tool_use: turn.hasToolUse,
            has_error: turn.hasError,
            thinking_blocks: turn.thinkingBlocks ?? null,
            thinking_tokens: turn.thinkingTokens ?? null,
        })));
        yield* writeToolCalls(write, batch.toolCalls);
        yield* writeToolFileEvidence(write, batch.toolFileEvidence);
        for (const edge of batch.agentEventParentEdges) {
            yield* write.put("agent_event_child", cacheRow({
                id: Bun.hash(`${edge.parentEventKey}|${edge.childEventKey}|${edge.kind}`).toString(16),
                in_id: edge.parentEventKey,
                out_id: edge.childEventKey,
                agent_session: `${edge.provider}__${edge.providerSessionId}`,
                provider: edge.provider,
                kind: edge.kind,
                ts: tsParam(edge.ts),
            }));
        }
        for (const invocation of batch.syntheticSkillInvocations) {
            const skillKey = skillRecordKey(invocation.skillName);
            if (invocation.skillUpsert === "if_missing") {
                yield* write.exec(
                    "INSERT INTO skill (id, name, scope, dir_path, content_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                    [skillKey, invocation.skillName, invocation.skillScope ?? "unknown", invocation.skillDirPath ?? "(synthetic)", invocation.skillContentHash ?? "synthetic"],
                );
            } else {
                yield* write.put("skill", cacheRow({
                    id: skillKey,
                    name: invocation.skillName,
                    scope: invocation.skillScope ?? "unknown",
                    dir_path: invocation.skillDirPath ?? "(synthetic)",
                    content_hash: invocation.skillContentHash ?? "synthetic",
                }));
            }
            const turnKey = turnRecordKey(invocation.sessionId, invocation.seq);
            const args = JSON.stringify(invocation.args ?? {});
            yield* write.put("invoked", cacheRow({
                id: invokedRelationRecordKey({ turnKey, skillKey, args }),
                in_id: turnKey,
                out_id: skillKey,
                args,
                ts: tsParam(invocation.ts),
                session: invocation.sessionId,
                turn_has_error: invocation.turnHasError ?? false,
                was_corrected: false,
                turn_index: invocation.turnIndex ?? invocation.seq,
                total_turns: null,
                is_first: null,
            }));
        }
        for (const relation of batch.toolCallSkillRelations) yield* relateToolCallSkill(write, relation);
        for (const snapshot of batch.planSnapshots) yield* writePlanSnapshot(write, snapshot);
        yield* write.putMany("compaction", batch.compactions.map((compaction) => cacheRow({
            id: compaction.compactionKey,
            session: compaction.sessionId,
            agent_event: compaction.agentEventKey ?? null,
            harness: compaction.harness,
            ts: tsParam(compaction.ts),
            trigger: compaction.trigger ?? null,
            strategy: compaction.strategy,
            source_confidence: compaction.sourceConfidence,
            summary: compaction.summary ?? null,
            tokens_before: compaction.tokensBefore ?? null,
            boundary_ref: compaction.boundaryRef ?? null,
            kept_count: compaction.keptCount ?? null,
            read_files: jsonParam(compaction.readFiles),
            modified_files: jsonParam(compaction.modifiedFiles),
            raw: jsonParam(compaction.raw),
        })));
    });
