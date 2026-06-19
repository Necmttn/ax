import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { executeStatements } from "@ax/lib/shared/statement-exec";
import {
    buildAgentEventStatements,
    type AgentEventBatchWrite,
    type AgentEventWrite,
    type AgentSessionWrite,
} from "../ingest/provider-events.ts";

import type {
    BuildAgentEventStatementsOptions,
} from "../ingest/provider-events.ts";

type JsonInput = unknown;
type TimestampInput = Date | string;
type LabelRecord = Record<string, unknown>;

export const CLAUDE_SDK_ENTRYPOINT = "sdk" as const;
export const AX_SESSION_STORE_KEY_VERSION = 1 as const;

const COMPONENT_RE = /^[A-Za-z0-9._:@=-]+$/;
const SUBPATH_SEGMENT_RE = /^[A-Za-z0-9._=-]+$/;

export class AxSessionStoreKeyError extends Error {
    constructor(message: string) {
        super(`Invalid ax SessionStore key: ${message}`);
        this.name = "AxSessionStoreKeyError";
    }
}

export type AxSessionStoreSubpathInput = string | readonly string[];

export interface AxSessionStoreKeyInput {
    readonly projectKey: string;
    readonly sessionId: string;
    readonly subpath?: AxSessionStoreSubpathInput;
}

export interface AxSessionStoreKeyParts {
    readonly projectKey: string;
    readonly sessionId: string;
    readonly subpath?: string;
}

export interface ClaudeSdkSessionLabels extends LabelRecord {
    readonly entrypoint: typeof CLAUDE_SDK_ENTRYPOINT;
    readonly sdkLanguage?: string;
    readonly sdkName?: string;
    readonly sdkVersion?: string;
    readonly sdkMetadata?: LabelRecord;
    readonly sessionStore: {
        readonly projectKey: string;
        readonly subpath?: string;
    };
}

export interface ClaudeSdkAppendEventPayload {
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
    readonly labels?: LabelRecord | null;
    readonly metrics?: JsonInput;
}

export interface ClaudeSdkSessionAppendPayload {
    readonly key: string | AxSessionStoreKeyInput;
    readonly axSessionId?: string | null;
    readonly cwd?: string | null;
    readonly project?: string | null;
    readonly title?: string | null;
    readonly model?: string | null;
    readonly sourcePath?: string | null;
    readonly raw?: JsonInput;
    readonly labels?: LabelRecord | null;
    readonly metrics?: JsonInput;
    readonly startedAt?: TimestampInput | null;
    readonly endedAt?: TimestampInput | null;
    readonly sdkLanguage?: string | null;
    readonly sdkName?: string | null;
    readonly sdkVersion?: string | null;
    readonly sdkMetadata?: LabelRecord | null;
    readonly events: readonly ClaudeSdkAppendEventPayload[];
}

const fail = (message: string): never => {
    throw new AxSessionStoreKeyError(message);
};

const requireString = (field: string, value: unknown): string => {
    if (typeof value === "string") return value;
    return fail(`${field} must be a string`);
};

const requireKeyRecord = (value: unknown): Record<string, unknown> => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return fail("key must be a JSON object");
};

const normalizeComponent = (field: "projectKey" | "sessionId", value: unknown): string => {
    const trimmed = requireString(field, value).trim();
    if (trimmed === "") fail(`${field} must not be empty`);
    if (trimmed === "." || trimmed === "..") fail(`${field} must not be a path segment`);
    if (!COMPONENT_RE.test(trimmed)) fail(`${field} contains unsupported characters`);
    return trimmed;
};

const normalizeSubpathSegment = (segment: unknown): string => {
    const trimmed = requireString("subpath segment", segment).trim();
    if (trimmed === "") fail("subpath must not contain empty segments");
    if (trimmed === "." || trimmed === "..") fail("subpath must not contain traversal segments");
    if (!SUBPATH_SEGMENT_RE.test(trimmed)) fail("subpath segment contains unsupported characters");
    return trimmed;
};

const subpathSegmentsFromString = (subpath: string): readonly string[] => {
    const trimmed = subpath.trim();
    if (trimmed === "") fail("subpath must not be empty");
    if (trimmed.startsWith("/") || trimmed.startsWith("\\")) fail("subpath must be relative");
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) fail("subpath must not be absolute");
    if (trimmed.includes("\\")) fail("subpath must use forward slashes");
    return trimmed.split("/");
};

const normalizeSubpath = (subpath: AxSessionStoreSubpathInput): string => {
    const segments = typeof subpath === "string"
        ? subpathSegmentsFromString(subpath)
        : Array.isArray(subpath)
        ? subpath
        : fail("subpath must be a string or array of path segments");
    if (segments.length === 0) fail("subpath must not be empty");
    return segments.map((segment) => normalizeSubpathSegment(segment)).join("/");
};

export const axSessionStoreSubpath = (...segments: readonly string[]): string =>
    normalizeSubpath(segments);

export const axSessionStoreKey = (input: AxSessionStoreKeyInput): string => {
    const projectKey = normalizeComponent("projectKey", input.projectKey);
    const sessionId = normalizeComponent("sessionId", input.sessionId);
    const key: {
        v: typeof AX_SESSION_STORE_KEY_VERSION;
        projectKey: string;
        sessionId: string;
        subpath?: string;
    } = {
        v: AX_SESSION_STORE_KEY_VERSION,
        projectKey,
        sessionId,
    };

    if (input.subpath !== undefined) {
        key.subpath = normalizeSubpath(input.subpath);
    }

    return JSON.stringify(key);
};

export const parseAxSessionStoreKey = (key: string): AxSessionStoreKeyParts => {
    if (typeof key !== "string" || key.trim() === "") fail("key must be a non-empty JSON string");

    let parsed: unknown;
    try {
        parsed = JSON.parse(key) as unknown;
    } catch {
        fail("key must be valid JSON");
    }

    const record = requireKeyRecord(parsed);
    if (record.v !== AX_SESSION_STORE_KEY_VERSION) {
        fail(`key version must be ${AX_SESSION_STORE_KEY_VERSION}`);
    }

    const projectKey = normalizeComponent("projectKey", record.projectKey);
    const sessionId = normalizeComponent("sessionId", record.sessionId);

    const rawSubpath = record.subpath;
    if (rawSubpath === undefined) {
        return { projectKey, sessionId };
    }
    const subpath = requireString("subpath", rawSubpath);

    return {
        projectKey,
        sessionId,
        subpath: normalizeSubpath(subpath),
    };
};

const stringMetadata = (value: string | null | undefined): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
};

const sessionStoreLabel = (key: AxSessionStoreKeyParts): ClaudeSdkSessionLabels["sessionStore"] => {
    if (key.subpath === undefined) return { projectKey: key.projectKey };
    return { projectKey: key.projectKey, subpath: key.subpath };
};

const sdkSessionLabels = (
    key: AxSessionStoreKeyParts,
    payload: ClaudeSdkSessionAppendPayload,
): ClaudeSdkSessionLabels => {
    const sdkLanguage = stringMetadata(payload.sdkLanguage);
    const sdkName = stringMetadata(payload.sdkName);
    const sdkVersion = stringMetadata(payload.sdkVersion);

    return {
        ...(payload.labels ?? {}),
        entrypoint: CLAUDE_SDK_ENTRYPOINT,
        ...(sdkLanguage !== undefined ? { sdkLanguage } : {}),
        ...(sdkName !== undefined ? { sdkName } : {}),
        ...(sdkVersion !== undefined ? { sdkVersion } : {}),
        ...(payload.sdkMetadata !== null && payload.sdkMetadata !== undefined
            ? { sdkMetadata: payload.sdkMetadata }
            : {}),
        sessionStore: sessionStoreLabel(key),
    };
};

const sdkEventLabels = (labels: LabelRecord | null | undefined): LabelRecord => ({
    ...(labels ?? {}),
    entrypoint: CLAUDE_SDK_ENTRYPOINT,
});

const parsePayloadKey = (key: string | AxSessionStoreKeyInput): AxSessionStoreKeyParts =>
    typeof key === "string" ? parseAxSessionStoreKey(key) : parseAxSessionStoreKey(axSessionStoreKey(key));

export const claudeSdkAppendPayloadToAgentEventBatch = (
    payload: ClaudeSdkSessionAppendPayload,
): AgentEventBatchWrite => {
    const key = parsePayloadKey(payload.key);
    const session: AgentSessionWrite = {
        provider: "claude",
        providerSessionId: key.sessionId,
        ...(payload.axSessionId !== undefined ? { axSessionId: payload.axSessionId } : {}),
        ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
        ...(payload.project !== undefined ? { project: payload.project } : {}),
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.sourcePath !== undefined ? { sourcePath: payload.sourcePath } : {}),
        ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
        labels: sdkSessionLabels(key, payload),
        ...(payload.metrics !== undefined ? { metrics: payload.metrics } : {}),
        ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
        ...(payload.endedAt !== undefined ? { endedAt: payload.endedAt } : {}),
    };

    const events: AgentEventWrite[] = payload.events.map((event) => {
        const axSessionId = event.axSessionId !== undefined ? event.axSessionId : payload.axSessionId;
        return {
            provider: "claude",
            providerSessionId: key.sessionId,
            ...(event.providerEventId !== undefined ? { providerEventId: event.providerEventId } : {}),
            ...(event.parentProviderEventId !== undefined
                ? { parentProviderEventId: event.parentProviderEventId }
                : {}),
            ...(event.parentProviderEventIds !== undefined
                ? { parentProviderEventIds: event.parentProviderEventIds }
                : {}),
            ...(event.parentKind !== undefined ? { parentKind: event.parentKind } : {}),
            ...(axSessionId !== undefined ? { axSessionId } : {}),
            seq: event.seq,
            ts: event.ts,
            type: event.type,
            ...(event.role !== undefined ? { role: event.role } : {}),
            ...(event.text !== undefined ? { text: event.text } : {}),
            ...(event.textExcerpt !== undefined ? { textExcerpt: event.textExcerpt } : {}),
            ...(event.raw !== undefined ? { raw: event.raw } : {}),
            labels: sdkEventLabels(event.labels),
            ...(event.metrics !== undefined ? { metrics: event.metrics } : {}),
        };
    });

    return {
        sessions: [session],
        events,
    };
};

export const buildClaudeSdkAppendStatements = (
    payload: ClaudeSdkSessionAppendPayload,
    options?: Omit<BuildAgentEventStatementsOptions, "clearExisting">,
): string[] =>
    buildAgentEventStatements(claudeSdkAppendPayloadToAgentEventBatch(payload), {
        ...options,
        clearExisting: false,
    });

export const writeClaudeSdkAppendPayload = (
    payload: ClaudeSdkSessionAppendPayload,
): Effect.Effect<{ sessions: number; events: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const batch = claudeSdkAppendPayloadToAgentEventBatch(payload);
        yield* executeStatements(buildAgentEventStatements(batch, { clearExisting: false }));
        return { sessions: batch.sessions.length, events: batch.events.length };
    });
