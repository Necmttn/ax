/**
 * Parser Toolkit - the shared ToolCallWrite mapping every provider parser
 * (codex, pi, opencode, cursor) previously copy-pasted: provider + tool
 * identity, the turn/agent_event record keys, and the exec-command field
 * triple. Provider-specific interpretation (which raw fields hold the call
 * id, input, output, errors) stays in each parser; only the common write
 * shape lives here.
 */
import type { ToolCallWrite } from "../evidence-writers.ts";
import { agentEventRecordKey, type AgentProviderName } from "../provider-events.ts";
import { turnRecordKey } from "../record-keys.ts";
import { extractCommandTool, normalizeCommand, toolKindForName } from "../tool-calls.ts";
import { isRecord, stringField } from "./toolkit.ts";

/** Locally-mutable ToolCallWrite: parsers fill result fields as the matching
 *  tool output arrives later in the stream. */
export type MutableToolCallWrite = {
    -readonly [Key in keyof ToolCallWrite]: ToolCallWrite[Key];
};

export interface BaseToolCallWriteInput {
    readonly provider: AgentProviderName;
    readonly toolName: string;
    readonly sessionId: string;
    /** Turn sequence the call belongs to - drives both the persisted `seq`
     *  and the turn record key. */
    readonly seq: number;
    readonly callId: string;
    /** agent_event identity override: defaults to `callId` when the provider
     *  keys its tool-call event by call id (codex, pi, cursor); opencode keys
     *  it by the part row id instead. */
    readonly providerEventId?: string;
    /** agent_event seq override: defaults to `seq`; providers that emit
     *  synthetic per-block events (pi, opencode, cursor) pass their offset
     *  event seq here. */
    readonly eventSeq?: number;
    readonly ts: string;
    /** Omitted entirely from the write when undefined (cursor has no cwd). */
    readonly cwd?: string | null;
    readonly inputJson: unknown;
    readonly rawJson: unknown;
}

/**
 * Build the cross-provider ToolCallWrite base: identity, record keys, and
 * payloads, with `hasError: false` until a result arrives. Callers layer
 * provider-specific result fields on top (spread or {@link applyCommandFields}).
 */
export const makeToolCallWrite = (input: BaseToolCallWriteInput): MutableToolCallWrite => ({
    provider: input.provider,
    toolName: input.toolName,
    toolKind: toolKindForName(input.toolName),
    sessionId: input.sessionId,
    seq: input.seq,
    turnKey: turnRecordKey(input.sessionId, input.seq),
    agentEventKey: agentEventRecordKey({
        provider: input.provider,
        providerSessionId: input.sessionId,
        providerEventId: input.providerEventId ?? input.callId,
        seq: input.eventSeq ?? input.seq,
    }),
    callId: input.callId,
    ts: input.ts,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    inputJson: input.inputJson,
    rawJson: input.rawJson,
    hasError: false,
});

/**
 * Fill the `commandText` / `commandToolName` / `commandNorm` triple from a
 * record input's `command` (or `cmd`) field. No-op when the input is not a
 * record or carries no command - exactly the guard every parser repeated.
 */
export const applyCommandFields = (call: MutableToolCallWrite, inputJson: unknown): void => {
    if (!isRecord(inputJson)) return;
    const command = stringField(inputJson, "command") ?? stringField(inputJson, "cmd");
    if (!command) return;
    call.commandText = command;
    call.commandToolName = extractCommandTool(command);
    call.commandNorm = normalizeCommand(command);
};
