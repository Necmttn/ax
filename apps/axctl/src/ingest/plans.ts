import { decodeJsonOrNull } from "@ax/lib/decode";
import { nonEmptyString } from "@ax/lib/shared/derive-keys";
import type { PlanSnapshotWrite } from "./evidence-writers.ts";
import type { AgentProviderName } from "./provider-events.ts";

export type PlanStatus = "pending" | "in_progress" | "completed" | "abandoned";

export type PlanSource = "claude_todowrite" | "claude_task" | "codex_update_plan";

export type ProviderPlanSignalStatus = "available" | "unavailable";

export type ProviderPlanSignalAvailability = {
    readonly provider: AgentProviderName;
    readonly status: ProviderPlanSignalStatus;
    readonly planSources: readonly PlanSource[];
    readonly toolNames: readonly string[];
    readonly evidence: string;
};

export type ProviderPlanDetector = {
    readonly provider: AgentProviderName;
    readonly source: PlanSource;
    readonly toolName: string;
    readonly normalize: (input: NormalizeProviderPlanInput) => NormalizedPlanSnapshot;
};

export type NormalizedPlanItem = {
    readonly externalId: string | null;
    readonly seq: number;
    readonly content: string;
    readonly activeForm: string | null;
    readonly status: PlanStatus;
};

export type NormalizedPlanSnapshot = {
    readonly provider: AgentProviderName;
    readonly sessionId: string;
    readonly source: PlanSource;
    readonly ts: string;
    readonly explanation: string | null;
    readonly items: readonly NormalizedPlanItem[];
};

type ClaudeTodoWriteItemInput = {
    readonly content?: string | null;
    readonly activeForm?: string | null;
    readonly status?: string | null;
};

type ClaudeTodoWriteInput = {
    readonly todos?: readonly ClaudeTodoWriteItemInput[];
};

type CodexUpdatePlanItemInput = {
    readonly step?: string | null;
    readonly status?: string | null;
};

type CodexUpdatePlanInput = {
    readonly explanation?: string | null;
    readonly plan?: readonly CodexUpdatePlanItemInput[];
};

type NormalizeClaudeTodoWriteInput = {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
};

type NormalizeClaudeTaskInput = {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
};

type NormalizeCodexUpdatePlanInput = {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
};

export type NormalizeProviderPlanInput = {
    readonly provider: AgentProviderName;
    readonly toolName: string;
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
};

export type PlanSnapshotWriteInput = {
    readonly snapshot: NormalizedPlanSnapshot;
    readonly snapshotSeq: number;
    readonly createdAt: string;
    readonly toolCallKey: string;
};

function stableHash(input: string): string {
    return Bun.hash(input).toString(16).padStart(16, "0");
}

function recordKeyPart(input: string, fallback = "_"): string {
    const sanitized = input
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : fallback;
}

function normalizeStatus(status: string | null | undefined): PlanStatus {
    if (status === "in_progress" || status === "completed" || status === "abandoned") {
        return status;
    }
    return "pending";
}

function normalizeClaudeTaskStatus(status: string | null | undefined): PlanStatus {
    if (status === "deleted") return "abandoned";
    if (status === "active") return "in_progress";
    return normalizeStatus(status);
}

function parseMaybeJsonObject(input: unknown): Record<string, unknown> {
    if (typeof input === "string") {
        const parsed = decodeJsonOrNull(input);
        return isRecord(parsed) ? parsed : {};
    }
    return isRecord(input) ? input : {};
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function asRecordArray(input: unknown): Record<string, unknown>[] {
    if (!Array.isArray(input)) return [];
    return input.filter(isRecord);
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" ? value : null;
}

function recordField(input: Record<string, unknown>, field: string): Record<string, unknown> | null {
    const value = input[field];
    return isRecord(value) ? value : null;
}

function firstNonEmptyString(...values: readonly (string | null | undefined)[]): string | null {
    for (const value of values) {
        const normalized = nonEmptyString(value ?? null);
        if (normalized) return normalized;
    }
    return null;
}

function claudeTaskResultRecord(raw: Record<string, unknown>): Record<string, unknown> | null {
    return recordField(recordField(raw, "toolUseResult") ?? {}, "task");
}

function claudeTaskResultRecords(raw: Record<string, unknown>): Record<string, unknown>[] {
    const result = recordField(raw, "toolUseResult");
    return result ? asRecordArray(result.tasks) : [];
}

function normalizeClaudeTaskItem(
    raw: Record<string, unknown>,
    resultTask: Record<string, unknown> | null,
    seq: number,
): NormalizedPlanItem | null {
    const task = resultTask ?? {};
    const taskId = firstNonEmptyString(
        stringField(task, "id"),
        stringField(task, "taskId"),
        stringField(task, "task_id"),
        stringField(raw, "taskId"),
        stringField(raw, "id"),
        stringField(raw, "task_id"),
    );
    const subject = firstNonEmptyString(stringField(raw, "subject"), stringField(task, "subject"));
    const description = firstNonEmptyString(
        stringField(raw, "description"),
        stringField(task, "description"),
    );
    const content = subject ?? description ?? taskId;
    if (!content) return null;

    return {
        externalId: taskId,
        seq,
        content,
        activeForm: firstNonEmptyString(
            stringField(raw, "activeForm"),
            stringField(raw, "active_form"),
            stringField(task, "activeForm"),
            stringField(task, "active_form"),
        ),
        status: normalizeClaudeTaskStatus(stringField(task, "status") ?? stringField(raw, "status")),
    };
}

function normalizeClaudeTodoWritePayload({
    sessionId,
    ts,
    input,
}: NormalizeClaudeTodoWriteInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input) as ClaudeTodoWriteInput;

    for (const todo of asRecordArray(raw.todos)) {
        const content = nonEmptyString(typeof todo.content === "string" ? todo.content : null);
        if (!content) continue;

        items.push({
            externalId: null,
            seq: items.length + 1,
            content,
            activeForm: nonEmptyString(
                typeof todo.activeForm === "string" ? todo.activeForm : null,
            ),
            status: normalizeStatus(typeof todo.status === "string" ? todo.status : null),
        });
    }

    return {
        provider: "claude",
        sessionId,
        source: "claude_todowrite",
        ts,
        explanation: null,
        items,
    };
}

function normalizeClaudeTaskCreatePayload({
    sessionId,
    ts,
    input,
}: NormalizeClaudeTaskInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input);
    const item = normalizeClaudeTaskItem(raw, claudeTaskResultRecord(raw), 1);
    if (item) items.push(item);

    return {
        provider: "claude",
        sessionId,
        source: "claude_task",
        ts,
        explanation: "TaskCreate",
        items,
    };
}

function normalizeClaudeTaskUpdatePayload({
    sessionId,
    ts,
    input,
}: NormalizeClaudeTaskInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input);
    const item = normalizeClaudeTaskItem(raw, claudeTaskResultRecord(raw), 1);
    if (item) items.push(item);

    return {
        provider: "claude",
        sessionId,
        source: "claude_task",
        ts,
        explanation: "TaskUpdate",
        items,
    };
}

function normalizeClaudeTaskGetPayload({
    sessionId,
    ts,
    input,
}: NormalizeClaudeTaskInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input);
    const item = normalizeClaudeTaskItem(raw, claudeTaskResultRecord(raw), 1);
    if (item) items.push(item);

    return {
        provider: "claude",
        sessionId,
        source: "claude_task",
        ts,
        explanation: "TaskGet",
        items,
    };
}

function normalizeClaudeTaskListPayload({
    sessionId,
    ts,
    input,
}: NormalizeClaudeTaskInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input);

    for (const task of claudeTaskResultRecords(raw)) {
        const item = normalizeClaudeTaskItem(raw, task, items.length + 1);
        if (item) items.push(item);
    }

    return {
        provider: "claude",
        sessionId,
        source: "claude_task",
        ts,
        explanation: "TaskList",
        items,
    };
}

function normalizeCodexUpdatePlanPayload({
    sessionId,
    ts,
    input,
}: NormalizeCodexUpdatePlanInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input) as CodexUpdatePlanInput;

    for (const planItem of asRecordArray(raw.plan)) {
        const content = nonEmptyString(typeof planItem.step === "string" ? planItem.step : null);
        if (!content) continue;

        items.push({
            externalId: null,
            seq: items.length + 1,
            content,
            activeForm: null,
            status: normalizeStatus(typeof planItem.status === "string" ? planItem.status : null),
        });
    }

    return {
        provider: "codex",
        sessionId,
        source: "codex_update_plan",
        ts,
        explanation: nonEmptyString(typeof raw.explanation === "string" ? raw.explanation : null),
        items,
    };
}

export const providerPlanDetectors: readonly ProviderPlanDetector[] = [
    {
        provider: "claude",
        source: "claude_todowrite",
        toolName: "TodoWrite",
        normalize: ({ sessionId, ts, input }) =>
            normalizeClaudeTodoWritePayload({ sessionId, ts, input }),
    },
    {
        provider: "claude",
        source: "claude_task",
        toolName: "TaskCreate",
        normalize: ({ sessionId, ts, input }) =>
            normalizeClaudeTaskCreatePayload({ sessionId, ts, input }),
    },
    {
        provider: "claude",
        source: "claude_task",
        toolName: "TaskUpdate",
        normalize: ({ sessionId, ts, input }) =>
            normalizeClaudeTaskUpdatePayload({ sessionId, ts, input }),
    },
    {
        provider: "claude",
        source: "claude_task",
        toolName: "TaskGet",
        normalize: ({ sessionId, ts, input }) =>
            normalizeClaudeTaskGetPayload({ sessionId, ts, input }),
    },
    {
        provider: "claude",
        source: "claude_task",
        toolName: "TaskList",
        normalize: ({ sessionId, ts, input }) =>
            normalizeClaudeTaskListPayload({ sessionId, ts, input }),
    },
    {
        provider: "codex",
        source: "codex_update_plan",
        toolName: "update_plan",
        normalize: ({ sessionId, ts, input }) =>
            normalizeCodexUpdatePlanPayload({ sessionId, ts, input }),
    },
];

export const providerPlanSignalAvailability: Readonly<Record<AgentProviderName, ProviderPlanSignalAvailability>> = {
    claude: {
        provider: "claude",
        status: "available",
        planSources: ["claude_todowrite", "claude_task"],
        toolNames: ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList"],
        evidence: "Claude transcript tool_use and tool_result blocks expose TodoWrite todos and Task tool plan signals.",
    },
    codex: {
        provider: "codex",
        status: "available",
        planSources: ["codex_update_plan"],
        toolNames: ["update_plan"],
        evidence: "Codex session JSONL exposes update_plan function call arguments.",
    },
    pi: {
        provider: "pi",
        status: "unavailable",
        planSources: [],
        toolNames: [],
        evidence: "Current Pi JSONL fixtures expose message, custom, and generic toolCall blocks; no raw plan snapshot payload equivalent is present.",
    },
    opencode: {
        provider: "opencode",
        status: "unavailable",
        planSources: [],
        toolNames: [],
        evidence: "Current OpenCode SQLite fixtures expose sessions/messages/parts only; no tool-call or plan snapshot rows are ingested yet.",
    },
    cursor: {
        provider: "cursor",
        status: "unavailable",
        planSources: [],
        toolNames: [],
        evidence: "Current Cursor state.vscdb fixtures expose composer messages/bubbles only; no raw plan snapshot payload equivalent is present.",
    },
    otel: {
        provider: "otel",
        status: "unavailable",
        planSources: [],
        toolNames: [],
        evidence: "OTLP telemetry spans carry no plan/todo snapshot payload; plan signal is unavailable for this provider.",
    },
};

export function normalizeProviderPlanSnapshot(
    input: NormalizeProviderPlanInput,
): NormalizedPlanSnapshot | null {
    const detector = providerPlanDetectors.find((candidate) =>
        candidate.provider === input.provider && candidate.toolName === input.toolName
    );
    return detector?.normalize(input) ?? null;
}

export function normalizeClaudeTodoWrite(
    input: NormalizeClaudeTodoWriteInput,
): NormalizedPlanSnapshot {
    const normalized = normalizeProviderPlanSnapshot({
        provider: "claude",
        toolName: "TodoWrite",
        ...input,
    });
    if (normalized === null) {
        throw new Error("missing Claude TodoWrite plan detector");
    }
    return normalized;
}

export function normalizeClaudeTaskCreate(
    input: NormalizeClaudeTaskInput,
): NormalizedPlanSnapshot {
    const normalized = normalizeProviderPlanSnapshot({
        provider: "claude",
        toolName: "TaskCreate",
        ...input,
    });
    if (normalized === null) {
        throw new Error("missing Claude TaskCreate plan detector");
    }
    return normalized;
}

export function normalizeClaudeTaskUpdate(
    input: NormalizeClaudeTaskInput,
): NormalizedPlanSnapshot {
    const normalized = normalizeProviderPlanSnapshot({
        provider: "claude",
        toolName: "TaskUpdate",
        ...input,
    });
    if (normalized === null) {
        throw new Error("missing Claude TaskUpdate plan detector");
    }
    return normalized;
}

export function normalizeCodexUpdatePlan(
    input: NormalizeCodexUpdatePlanInput,
): NormalizedPlanSnapshot {
    const normalized = normalizeProviderPlanSnapshot({
        provider: "codex",
        toolName: "update_plan",
        ...input,
    });
    if (normalized === null) {
        throw new Error("missing Codex update_plan detector");
    }
    return normalized;
}

export function planKey(sessionId: string, provider: AgentProviderName, source: string): string {
    return [
        provider,
        recordKeyPart(sessionId, "session").slice(0, 80),
        recordKeyPart(source, "source"),
        stableHash(`${sessionId}:${source}`).slice(0, 16),
    ].join("__");
}

export function planSnapshotKey(input: {
    readonly provider: AgentProviderName;
    readonly sessionId: string;
    readonly source: string;
    readonly snapshotSeq: number;
    readonly toolCallKey: string;
}): string {
    return [
        planKey(input.sessionId, input.provider, input.source),
        `snapshot_${input.snapshotSeq.toString(10).padStart(6, "0")}`,
        stableHash(input.toolCallKey).slice(0, 12),
    ].join("__");
}

export function planItemKey(input: {
    readonly provider: AgentProviderName;
    readonly sessionId: string;
    readonly source: string;
    readonly seq: number;
    readonly externalId?: string | null;
    readonly toolCallKey?: string | null;
}): string {
    const key = planKey(input.sessionId, input.provider, input.source);
    if (input.source === "claude_task") {
        const externalId = nonEmptyString(input.externalId ?? null);
        if (externalId) {
            return [
                key,
                "item_external",
                recordKeyPart(externalId, "task").slice(0, 80),
                stableHash(externalId).slice(0, 12),
            ].join("__");
        }
        const toolCallKey = nonEmptyString(input.toolCallKey ?? null);
        if (toolCallKey) {
            return [
                key,
                "item_tool_call",
                stableHash(toolCallKey).slice(0, 12),
                `seq_${input.seq.toString(10).padStart(3, "0")}`,
            ].join("__");
        }
    }
    return [
        key,
        `item_${input.seq.toString(10).padStart(3, "0")}`,
    ].join("__");
}

export function planStatus(items: readonly { status: PlanStatus }[]): PlanStatus {
    if (items.some((item) => item.status === "in_progress")) return "in_progress";
    if (items.length > 0 && items.every((item) => item.status === "completed")) {
        return "completed";
    }
    if (items.some((item) => item.status === "pending")) return "pending";
    if (items.length > 0 && items.every((item) => item.status === "abandoned")) {
        return "abandoned";
    }
    return "pending";
}

export function toPlanSnapshotWrite({
    snapshot,
    snapshotSeq,
    createdAt,
    toolCallKey,
}: PlanSnapshotWriteInput): PlanSnapshotWrite {
    const items = snapshot.items.map((item) => ({
        key: planItemKey({
            provider: snapshot.provider,
            sessionId: snapshot.sessionId,
            source: snapshot.source,
            seq: item.seq,
            externalId: item.externalId,
            toolCallKey,
        }),
        externalId: item.externalId,
        seq: item.seq,
        content: item.content,
        activeForm: item.activeForm,
        status: item.status,
    }));

    return {
        planKey: planKey(snapshot.sessionId, snapshot.provider, snapshot.source),
        sessionId: snapshot.sessionId,
        source: snapshot.source,
        status: planStatus(snapshot.items),
        createdAt,
        updatedAt: snapshot.ts,
        snapshotKey: planSnapshotKey({
            provider: snapshot.provider,
            sessionId: snapshot.sessionId,
            source: snapshot.source,
            snapshotSeq,
            toolCallKey,
        }),
        toolCallKey,
        itemsJson: snapshot.items,
        explanation: snapshot.explanation,
        ts: snapshot.ts,
        items,
    };
}
