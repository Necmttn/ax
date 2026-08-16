import { Effect } from "effect";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { identityPart, stableDigest } from "./record-keys.ts";

/**
 * SDK-hosted Claude sessions still use provider `claude`. Keep the provider
 * identity shared across Claude surfaces and segment embedded SDK runs with
 * `labels.entrypoint = "sdk"` plus optional SDK metadata instead.
 */
export type AgentProviderName = "claude" | "codex" | "pi" | "omp" | "opencode" | "cursor" | "otel";

type JsonInput = unknown;
type TimestampInput = Date | string;

export interface AgentProviderWrite {
    readonly name: AgentProviderName;
    readonly displayName: string;
    readonly version?: string | null;
    readonly capabilities?: JsonInput;
}

export interface AgentSessionWrite {
    readonly provider: AgentProviderName;
    readonly providerSessionId: string;
    readonly axSessionId?: string | null;
    readonly cwd?: string | null;
    readonly project?: string | null;
    readonly title?: string | null;
    readonly model?: string | null;
    readonly sourcePath?: string | null;
    readonly raw?: JsonInput;
    readonly labels?: JsonInput;
    readonly metrics?: JsonInput;
    readonly startedAt?: TimestampInput | null;
    readonly endedAt?: TimestampInput | null;
}

export interface AgentEventWrite {
    readonly provider: AgentProviderName;
    readonly providerSessionId: string;
    readonly providerEventId?: string | null;
    readonly parentProviderEventId?: string | null;
    readonly parentProviderEventIds?: readonly string[] | null;
    readonly parentKind?: string | null;
    readonly axSessionId?: string | null;
    readonly seq: number;
    readonly ts: TimestampInput;
    readonly type: string;
    readonly role?: string | null;
    readonly text?: string | null;
    readonly textExcerpt?: string | null;
    readonly labels?: JsonInput;
    readonly metrics?: JsonInput;
}

export interface AgentEventBatchWrite {
    readonly sessions: readonly AgentSessionWrite[];
    readonly events: readonly AgentEventWrite[];
}

export interface AgentEventParentEdgeWrite {
    readonly provider: AgentProviderName;
    readonly providerSessionId: string;
    readonly parentEventKey: string;
    readonly childEventKey: string;
    readonly kind: string;
    readonly ts: TimestampInput;
}

export interface AgentEventKeyInput {
    readonly provider: AgentProviderName;
    readonly providerSessionId: string;
    readonly providerEventId?: string | null;
    readonly seq: number;
}

export const agentProviderRecordKey = (provider: AgentProviderName): string => provider;

export const agentSessionRecordKey = (
    provider: AgentProviderName,
    providerSessionId: string,
): string => `${agentProviderRecordKey(provider)}__${identityPart(providerSessionId, "session")}`;

export const agentEventRecordKey = (input: AgentEventKeyInput): string => {
    const eventPart =
        input.providerEventId === null || input.providerEventId === undefined
            ? `seq_${input.seq.toString(10).padStart(6, "0")}`
            : identityPart(input.providerEventId, "event");

    return `${agentSessionRecordKey(input.provider, input.providerSessionId)}__${eventPart}`;
};

const sameBatchEventLookupKey = (
    provider: AgentProviderName,
    providerSessionId: string,
    providerEventId: string,
): string => `${provider}\0${providerSessionId}\0${providerEventId}`;

const parentEdgeRecordKey = (input: {
    readonly parentEventKey: string;
    readonly childEventKey: string;
    readonly kind: string;
}): string =>
    stableDigest(`${input.parentEventKey}|${input.childEventKey}|${input.kind}`);

const normalizedParentProviderEventIds = (
    event: AgentEventWrite,
): readonly string[] => {
    const parentIds = new Set<string>();
    if (event.parentProviderEventId !== null && event.parentProviderEventId !== undefined) {
        parentIds.add(event.parentProviderEventId);
    }
    for (const parentProviderEventId of event.parentProviderEventIds ?? []) {
        parentIds.add(parentProviderEventId);
    }
    return [...parentIds];
};

/** Control the replacement of provider events for each session. */
export interface WriteAgentEventsOptions {
    /**
     * Whether to clear each session's existing `agent_event` rows + child edges
     * before inserting this batch's events. Defaults to `true` so re-ingest is
     * idempotent. Streaming ingest (codex) must pass `false` for every batch
     * after the first one for a given session, otherwise later batches would
     * delete the events written by earlier batches of the same ingest.
     */
    readonly clearExisting?: boolean;
}

const agentProviderRows = (
    providers: readonly AgentProviderWrite[],
): ReadonlyArray<Readonly<Record<string, DuckDbParam>>> =>
    providers.map((provider) =>
        cacheRow({
            id: agentProviderRecordKey(provider.name),
            name: provider.name,
            display_name: provider.displayName,
            version: provider.version ?? null,
            capabilities: jsonParam(provider.capabilities),
            updated_at: new Date(),
        }),
    );

const agentSessionRows = (
    sessions: readonly AgentSessionWrite[],
): ReadonlyArray<Readonly<Record<string, DuckDbParam>>> =>
    sessions.map((session) =>
        cacheRow({
            id: agentSessionRecordKey(session.provider, session.providerSessionId),
            provider: agentProviderRecordKey(session.provider),
            provider_session_id: session.providerSessionId,
            ax_session: session.axSessionId ?? null,
            cwd: session.cwd ?? null,
            project: session.project ?? null,
            title: session.title ?? null,
            model: session.model ?? null,
            source_path: session.sourcePath ?? null,
            raw: jsonParam(session.raw),
            labels: jsonParam(session.labels),
            metrics: jsonParam(session.metrics),
            started_at: tsParam(session.startedAt),
            ended_at: tsParam(session.endedAt),
            updated_at: new Date(),
        }),
    );

const agentEventRows = (
    events: readonly AgentEventWrite[],
): ReadonlyArray<Readonly<Record<string, DuckDbParam>>> =>
    events.map((event) =>
        cacheRow({
            id: agentEventRecordKey(event),
            agent_session: agentSessionRecordKey(event.provider, event.providerSessionId),
            ax_session: event.axSessionId ?? null,
            provider: agentProviderRecordKey(event.provider),
            provider_event_id: event.providerEventId ?? null,
            parent_provider_event_id: normalizedParentProviderEventIds(event)[0] ?? null,
            seq: Math.trunc(event.seq),
            ts: tsParam(event.ts),
            type: event.type,
            role: event.role ?? null,
            text: event.text ?? null,
            text_excerpt: event.textExcerpt ?? null,
            labels: jsonParam(event.labels),
            metrics: jsonParam(event.metrics),
        }),
    );

const parentEdgeRows = (
    events: readonly AgentEventWrite[],
): ReadonlyArray<Readonly<Record<string, DuckDbParam>>> => {
    const eventKeysByProviderId = new Map<string, string>();
    for (const event of events) {
        if (event.providerEventId == null) continue;
        eventKeysByProviderId.set(
            sameBatchEventLookupKey(event.provider, event.providerSessionId, event.providerEventId),
            agentEventRecordKey(event),
        );
    }

    const rows: Array<Readonly<Record<string, DuckDbParam>>> = [];
    for (const event of events) {
        const childEventKey = agentEventRecordKey(event);
        const kind = event.parentKind ?? "parent";
        for (const parentProviderEventId of normalizedParentProviderEventIds(event)) {
            const parentEventKey = eventKeysByProviderId.get(
                sameBatchEventLookupKey(event.provider, event.providerSessionId, parentProviderEventId),
            );
            if (parentEventKey === undefined) continue;
            rows.push(cacheRow({
                id: parentEdgeRecordKey({ parentEventKey, childEventKey, kind }),
                in_id: parentEventKey,
                out_id: childEventKey,
                agent_session: agentSessionRecordKey(event.provider, event.providerSessionId),
                provider: agentProviderRecordKey(event.provider),
                kind,
                ts: tsParam(event.ts),
            }));
        }
    }
    return rows;
};

export const writeAgentProviders = (
    write: CacheWriteService,
    providers: readonly AgentProviderWrite[],
): Effect.Effect<{ count: number }, CacheWriteError> =>
    Effect.gen(function* () {
        yield* write.putMany("agent_provider", agentProviderRows(providers));
        return { count: providers.length };
    });

export const writeAgentEvents = (
    write: CacheWriteService,
    batch: AgentEventBatchWrite,
    options?: WriteAgentEventsOptions,
): Effect.Effect<{ sessions: number; events: number }, CacheWriteError> =>
    Effect.gen(function* () {
        yield* write.putMany("agent_session", agentSessionRows(batch.sessions));
        if (options?.clearExisting ?? true) {
            const sessionIds = [...new Set(batch.sessions.map((session) =>
                agentSessionRecordKey(session.provider, session.providerSessionId),
            ))];
            for (const sessionId of sessionIds) {
                yield* write.exec("DELETE FROM agent_event_child WHERE agent_session = ?", [sessionId]);
                yield* write.exec("DELETE FROM agent_event WHERE agent_session = ?", [sessionId]);
            }
        }
        yield* write.putMany("agent_event", agentEventRows(batch.events));
        yield* write.putMany("agent_event_child", parentEdgeRows(batch.events));
        return { sessions: batch.sessions.length, events: batch.events.length };
    });
