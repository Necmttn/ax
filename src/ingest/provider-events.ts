import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { executeStatements } from "../lib/shared/statement-exec.ts";
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
} from "../lib/shared/surql.ts";
import { identityPart, stableDigest } from "./record-keys.ts";

export type AgentProviderName = "claude" | "codex" | "pi" | "opencode" | "cursor";

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
        const sessionKey = agentSessionRecordKey(event.provider, event.providerSessionId);
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

            statements.push(
                `RELATE ${recordRef("agent_event", parentEventKey)}->agent_event_child:\`${parentEdgeRecordKey({
                    parentEventKey,
                    childEventKey,
                    kind,
                })}\`->${recordRef("agent_event", childEventKey)} SET ${surrealSet([
                    ["agent_session", recordRef("agent_session", sessionKey)],
                    ["provider", recordRef("agent_provider", agentProviderRecordKey(event.provider))],
                    ["kind", surrealString(kind)],
                    ["ts", surrealDate(event.ts)],
                ])};`,
            );
        }
    }

    return statements;
};

export function buildAgentEventStatements(batch: AgentEventBatchWrite): string[] {
    return [
        ...batch.sessions.map(buildAgentSessionStatement),
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
