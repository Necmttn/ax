import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionDate,
    surrealOptionRecord,
    surrealOptionString,
    surrealSet,
    surrealString,
} from "@ax/lib/shared/surql";
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
    readonly raw?: JsonInput;
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

export function buildAgentProviderStatements(
    providers: readonly AgentProviderWrite[],
): string[] {
    return providers.map((provider) =>
        `UPSERT ${recordRef("agent_provider", agentProviderRecordKey(provider.name))} MERGE ${surrealObject([
            ["name", surrealString(provider.name)],
            ["display_name", surrealString(provider.displayName)],
            ["version", surrealOptionString(provider.version)],
            ["capabilities", surrealJsonTextOption(provider.capabilities)],
            ["updated_at", "time::now()"],
        ])};`
    );
}

/**
 * Statements that clear a session's existing `agent_event` rows (and the
 * `agent_event_child` edges that would otherwise dangle) before a fresh batch
 * is inserted.
 *
 * Why this is required for idempotent re-ingest:
 *   `agent_event` carries a UNIQUE index on `(agent_session, seq)`. Record ids
 *   are keyed on the *stable* `provider_event_id`, but `seq` is a positional
 *   counter that is NOT guaranteed stable across ingests (older/partial ingests
 *   or seq-derivation changes leave drifted `(session, seq)` pairs). On
 *   re-ingest a fresh event can be assigned a `seq` already occupied by a
 *   *different* record id, and the per-UPSERT UNIQUE check throws mid-batch.
 *
 *   Deleting the session's events first makes the fresh batch insert cleanly
 *   regardless of seq drift OR record-id drift. Because record ids are derived
 *   from stable identifiers, the re-inserted rows reuse the same ids, so
 *   `turn.agent_event`, `tool_call.agent_event`, `plan_snapshot.agent_event` and
 *   `content_document` references continue to resolve. Clearing the
 *   `agent_event_child` edges in the same write avoids leaving edges that point
 *   at deleted rows; the batch re-emits them via the parent-edge statements.
 *
 *   The delete MUST route through the PRIMARY id, not the `(agent_session, seq)`
 *   secondary index. A long-lived DB can accumulate stale/ghost entries in the
 *   `agent_event_session_seq` UNIQUE index (observed across a SurrealDB version
 *   change / prior partial ingests: 27 codex sessions held ~19k duplicate
 *   `(agent_session, seq)` rows the index let in). A bare
 *   `DELETE ... WHERE agent_session = ...` is planned through that index and
 *   SILENTLY SKIPS the drifted rows - yet their index entries still block the
 *   fresh `(agent_session, seq)` INSERT, so the next ingest crashes with
 *   "Database index agent_event_session_seq already contains [...]". An inner
 *   `SELECT VALUE id ... WHERE agent_session = ...` reliably enumerates every
 *   row (full-table predicate); deleting that result set removes rows by
 *   primary id, which never consults the corruptible secondary index.
 *   `ax doctor` surfaces residual duplicates so the index can be rebuilt.
 *
 *   The delete targets the subquery RESULT (`DELETE (SELECT VALUE id ...)`),
 *   NOT `DELETE ... WHERE id IN (SELECT ...)`. The id-IN-subquery form is
 *   planned as a per-row membership test - the inner full-table scan
 *   re-evaluates for every candidate row, going quadratic in table size
 *   (measured: never completes at ~460k rows, pegging surreal at >100% CPU;
 *   the result-set form finishes in ~2-5s). That quadratic DELETE is what
 *   wedged every ingest pass once agent_event_child grew large enough.
 */
export function buildAgentSessionEventClearStatements(
    sessions: readonly AgentSessionWrite[],
): string[] {
    const statements: string[] = [];
    const seen = new Set<string>();
    for (const session of sessions) {
        const sessionKey = agentSessionRecordKey(session.provider, session.providerSessionId);
        if (seen.has(sessionKey)) continue;
        seen.add(sessionKey);
        const sessionRef = recordRef("agent_session", sessionKey);
        // Child edges first so no edge transiently references a deleted event.
        // Delete the subquery RESULT by primary id - never `WHERE id IN
        // (SELECT ...)`, which goes quadratic - see the doc comment above.
        statements.push(`DELETE (SELECT VALUE id FROM agent_event_child WHERE agent_session = ${sessionRef});`);
        statements.push(`DELETE (SELECT VALUE id FROM agent_event WHERE agent_session = ${sessionRef});`);
    }
    return statements;
}

const buildAgentSessionStatement = (session: AgentSessionWrite): string => {
    const sessionKey = agentSessionRecordKey(session.provider, session.providerSessionId);

    return `UPSERT ${recordRef("agent_session", sessionKey)} MERGE ${surrealObject([
        ["provider", recordRef("agent_provider", agentProviderRecordKey(session.provider))],
        ["provider_session_id", surrealString(session.providerSessionId)],
        ["ax_session", surrealOptionRecord("session", session.axSessionId)],
        ["cwd", surrealOptionString(session.cwd)],
        ["project", surrealOptionString(session.project)],
        ["title", surrealOptionString(session.title)],
        ["model", surrealOptionString(session.model)],
        ["source_path", surrealOptionString(session.sourcePath)],
        ["raw", surrealJsonTextOption(session.raw)],
        ["labels", surrealJsonTextOption(session.labels)],
        ["metrics", surrealJsonTextOption(session.metrics)],
        ["started_at", surrealOptionDate(session.startedAt)],
        ["ended_at", surrealOptionDate(session.endedAt)],
        ["updated_at", "time::now()"],
    ])};`;
};

const buildAgentEventStatement = (event: AgentEventWrite): string => {
    const sessionKey = agentSessionRecordKey(event.provider, event.providerSessionId);
    const eventKey = agentEventRecordKey(event);
    const parentProviderEventId = normalizedParentProviderEventIds(event)[0] ?? null;

    return `UPSERT ${recordRef("agent_event", eventKey)} CONTENT ${surrealObject([
        ["agent_session", recordRef("agent_session", sessionKey)],
        ["ax_session", surrealOptionRecord("session", event.axSessionId)],
        ["provider", recordRef("agent_provider", agentProviderRecordKey(event.provider))],
        ["provider_event_id", surrealOptionString(event.providerEventId)],
        ["parent_provider_event_id", surrealOptionString(parentProviderEventId)],
        ["seq", Math.trunc(event.seq).toString(10)],
        ["ts", surrealDate(event.ts)],
        ["type", surrealString(event.type)],
        ["role", surrealOptionString(event.role)],
        ["text", surrealOptionString(event.text)],
        ["text_excerpt", surrealOptionString(event.textExcerpt)],
        ["raw", surrealJsonTextOption(event.raw)],
        ["labels", surrealJsonTextOption(event.labels)],
        ["metrics", surrealJsonTextOption(event.metrics)],
    ])};`;
};

const buildParentEdgeStatements = (
    events: readonly AgentEventWrite[],
): string[] => {
    const eventKeysByProviderId = new Map<string, string>();

    for (const event of events) {
        if (event.providerEventId === null || event.providerEventId === undefined) continue;
        eventKeysByProviderId.set(
            sameBatchEventLookupKey(
                event.provider,
                event.providerSessionId,
                event.providerEventId,
            ),
            agentEventRecordKey(event),
        );
    }

    const statements: string[] = [];

    for (const event of events) {
        const childEventKey = agentEventRecordKey(event);
        const kind = event.parentKind ?? "parent";

        for (const parentProviderEventId of normalizedParentProviderEventIds(event)) {
            const parentEventKey = eventKeysByProviderId.get(
                sameBatchEventLookupKey(
                    event.provider,
                    event.providerSessionId,
                    parentProviderEventId,
                ),
            );
            if (parentEventKey === undefined) continue;

            statements.push(buildAgentEventParentEdgeStatement({
                provider: event.provider,
                providerSessionId: event.providerSessionId,
                parentEventKey,
                childEventKey,
                kind,
                ts: event.ts,
            }));
        }
    }

    return statements;
};

export function buildAgentEventParentEdgeStatement(edge: AgentEventParentEdgeWrite): string {
    const sessionKey = agentSessionRecordKey(edge.provider, edge.providerSessionId);
    return `RELATE ${recordRef("agent_event", edge.parentEventKey)}->agent_event_child:\`${parentEdgeRecordKey({
        parentEventKey: edge.parentEventKey,
        childEventKey: edge.childEventKey,
        kind: edge.kind,
    })}\`->${recordRef("agent_event", edge.childEventKey)} SET ${surrealSet([
        ["agent_session", recordRef("agent_session", sessionKey)],
        ["provider", recordRef("agent_provider", agentProviderRecordKey(edge.provider))],
        ["kind", surrealString(edge.kind)],
        ["ts", surrealDate(edge.ts)],
    ])};`;
}

export interface BuildAgentEventStatementsOptions {
    /**
     * Whether to clear each session's existing `agent_event` rows + child edges
     * before inserting this batch's events. Defaults to `true` so re-ingest is
     * idempotent. Streaming ingest (codex) must pass `false` for every batch
     * after the first one for a given session, otherwise later batches would
     * delete the events written by earlier batches of the same ingest.
     */
    readonly clearExisting?: boolean;
}

export function buildAgentEventStatements(
    batch: AgentEventBatchWrite,
    options?: BuildAgentEventStatementsOptions,
): string[] {
    const clearExisting = options?.clearExisting ?? true;
    return [
        ...batch.sessions.map(buildAgentSessionStatement),
        ...(clearExisting ? buildAgentSessionEventClearStatements(batch.sessions) : []),
        ...batch.events.map(buildAgentEventStatement),
        ...buildParentEdgeStatements(batch.events),
    ];
}

export const writeAgentProviders = (
    providers: readonly AgentProviderWrite[],
): Effect.Effect<{ count: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* executeStatements(buildAgentProviderStatements(providers));
        return { count: providers.length };
    });

export const writeAgentEvents = (
    batch: AgentEventBatchWrite,
): Effect.Effect<{ sessions: number; events: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* executeStatements(buildAgentEventStatements(batch));
        return { sessions: batch.sessions.length, events: batch.events.length };
    });
