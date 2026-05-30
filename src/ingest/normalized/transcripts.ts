import { Effect } from "effect";
import { RecordId, SurrealClient } from "../../lib/db.ts";
import type { DbError } from "../../lib/errors.ts";
import { executeStatements } from "../../lib/shared/statement-exec.ts";
import { recordRef, surrealDate, surrealString } from "../../lib/shared/surql.ts";
import {
    agentEventRecordKey,
    buildAgentEventStatements,
    buildAgentProviderStatements,
    type AgentEventWrite,
    type AgentProviderName,
    type AgentProviderWrite,
    type AgentSessionWrite,
} from "../provider-events.ts";
import { turnRecordKey } from "../record-keys.ts";

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

export interface NormalizedTranscriptBatch {
    readonly providers?: readonly AgentProviderWrite[];
    readonly sessions: readonly NormalizedSessionWrite[];
    readonly events?: readonly AgentEventWrite[];
    readonly turns: readonly NormalizedTurnWrite[];
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
        const agentEvent = turn.agentEvent
            ? recordRef("agent_event", agentEventRecordKey(turn.agentEvent))
            : "NONE";
        return `UPSERT ${recordRef("turn", turnRecordKey(turn.sessionId, turn.seq))} CONTENT { session: ${recordRef("session", turn.sessionId)}, agent_event: ${agentEvent}, seq: ${turn.seq}, ts: ${surrealDate(turn.ts)}, role: ${surrealString(turn.role)}, message_kind: ${surrealString(turn.messageKind)}, intent_kind: ${surrealString(turn.intentKind)}, text: ${turn.text === null ? "NONE" : surrealString(turn.text)}, text_excerpt: ${turn.textExcerpt === null ? "NONE" : surrealString(turn.textExcerpt)}, has_tool_use: ${turn.hasToolUse}, has_error: ${turn.hasError} };`;
    });

export const buildNormalizedTranscriptStatements = (
    batch: NormalizedTranscriptBatch,
): string[] => [
    ...buildAgentProviderStatements(batch.providers ?? []),
    ...buildAgentEventStatements({
        sessions: batch.sessions.map(toAgentSession),
        events: batch.events ?? [],
    }),
    ...buildNormalizedTurnStatements(batch.turns),
];

export const writeNormalizedTranscriptBatch = (
    batch: NormalizedTranscriptBatch,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* upsertNormalizedSessions(batch.sessions);
        yield* executeStatements(buildNormalizedTranscriptStatements(batch), { chunkSize: 500 });
    });
