import { decodeJsonOrNull } from "@ax/lib/decode";
import type { AgentProviderName } from "./provider-events.ts";

export type ProviderDelegationSignalStatus = "available" | "unavailable";

export type ProviderDelegationSignalAvailability = {
    readonly provider: AgentProviderName;
    readonly status: ProviderDelegationSignalStatus;
    readonly rawSignals: readonly string[];
    readonly sharedRecords: readonly "spawned"[];
    readonly evidence: string;
};

export type DelegationToolCallInput = {
    readonly provider: AgentProviderName;
    readonly toolCallId: string;
    readonly parentSessionId: string;
    readonly ts: string;
    readonly toolName: string;
    readonly outputExcerpt: string | null;
    /** Tool-call arguments JSON. Codex spawn_agent: `{agent_type, message, fork_context}`. */
    readonly inputJson?: string | null;
};

export type NormalizedDelegationSpawn = {
    readonly provider: AgentProviderName;
    readonly toolCallId: string;
    readonly parentSessionId: string;
    readonly ts: string;
    readonly childSessionId: string | null;
    readonly nickname: string | null;
    readonly toolName: string;
    /** Subagent role from the spawn args (codex `agent_type`); null when absent. */
    readonly agentType: string | null;
    /** Dispatch prompt from the spawn args (codex `message`), capped; null when absent. */
    readonly description: string | null;
};

/** Cap stored dispatch descriptions - routing matches look at the first sentence. */
const DESCRIPTION_MAX = 2000;

export const providerDelegationSignalAvailability: Readonly<Record<AgentProviderName, ProviderDelegationSignalAvailability>> = {
    claude: {
        provider: "claude",
        status: "available",
        rawSignals: ["subagents/agent-*.jsonl manifest"],
        sharedRecords: ["spawned"],
        evidence: "Claude subagent transcript manifests include parent session id and agent id; derive-claude-subagents writes spawned edges.",
    },
    codex: {
        provider: "codex",
        status: "available",
        rawSignals: ["spawn_agent tool output"],
        sharedRecords: ["spawned"],
        evidence: "Codex spawn_agent output includes agent_id and nickname; derive-spawned writes spawned edges after the child session exists.",
    },
    pi: {
        provider: "pi",
        status: "unavailable",
        rawSignals: [],
        sharedRecords: ["spawned"],
        evidence: "Current Pi JSONL fixtures expose generic toolCall blocks but no child-session id or delegation relation payload.",
    },
    opencode: {
        provider: "opencode",
        status: "unavailable",
        rawSignals: [],
        sharedRecords: ["spawned"],
        evidence: "Current OpenCode SQLite fixtures expose messages/parts only; no child-session id or delegation relation payload is ingested.",
    },
    cursor: {
        provider: "cursor",
        status: "unavailable",
        rawSignals: [],
        sharedRecords: ["spawned"],
        evidence: "Current Cursor state.vscdb fixtures expose composer messages/bubbles only; no child-session id or delegation relation payload is present.",
    },
    otel: {
        provider: "otel",
        status: "unavailable",
        rawSignals: [],
        sharedRecords: ["spawned"],
        evidence: "OTLP telemetry spans are ingested as spans/traces; no child-session delegation relation is defined yet.",
    },
};

const isRecord = (input: unknown): input is Record<string, unknown> =>
    typeof input === "object" && input !== null && !Array.isArray(input);

const stringField = (input: Record<string, unknown>, field: string): string | null => {
    const value = input[field];
    return typeof value === "string" && value.length > 0 ? value : null;
};

export function normalizeDelegationToolCall(
    input: DelegationToolCallInput,
): NormalizedDelegationSpawn {
    const parsed = input.outputExcerpt ? decodeJsonOrNull(input.outputExcerpt) : null;
    const payload = isRecord(parsed) ? parsed : null;

    // Dispatch metadata (role + prompt) lives in the spawn-call ARGUMENTS, not
    // the output. Codex spawn_agent args: { agent_type, message, fork_context }.
    const args = input.inputJson ? decodeJsonOrNull(input.inputJson) : null;
    const argsRecord = isRecord(args) ? args : null;
    const message = argsRecord ? stringField(argsRecord, "message") : null;

    return {
        provider: input.provider,
        toolCallId: input.toolCallId,
        parentSessionId: input.parentSessionId,
        ts: input.ts,
        childSessionId: payload ? stringField(payload, "agent_id") : null,
        nickname: payload ? stringField(payload, "nickname") : null,
        toolName: input.toolName,
        agentType: argsRecord ? stringField(argsRecord, "agent_type") : null,
        description: message ? message.slice(0, DESCRIPTION_MAX) : null,
    };
}
